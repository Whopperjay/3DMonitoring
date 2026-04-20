import json
import time
import threading
import sqlite3
import ssl
import os
from datetime import datetime, timezone, timedelta
from flask import Flask, jsonify, render_template, send_from_directory, request
import paho.mqtt.client as mqtt
import config

app = Flask(__name__)

# --- Database ---
DB_FILE = os.path.join("data", "bambu.db")

def init_db():
    os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS prints
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  filename TEXT,
                  start_time REAL,
                  end_time REAL,
                  duration REAL,
                  status TEXT,
                  filament_weight REAL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS settings
                 (key TEXT PRIMARY KEY,
                  value TEXT)''')
    conn.commit()
    conn.close()

# --- Global State ---
current_status = {
    "state": "Offline",
    "temp_nozzle": 0,
    "temp_bed": 0,
    "progress": 0,
    "time_remaining": 0,
    "filename": "",
    "layer": 0,
    "total_layers": 0,
    "ams": {},
    "speed_profile": "Unknown",
    "light_state": "off",
    "fan_part": 0,
    "fan_aux": 0,
    "fan_chamber": 0
}

# Auto Light Off State
auto_light_off_enabled = False
print_finish_time = 0

# Timezone offset (in hours from UTC)
# Default to local system timezone or can be configured
try:
    # Try to get local timezone offset
    local_tz_offset = -time.timezone / 3600  # Convert seconds to hours
    if time.daylight:
        local_tz_offset = -time.altzone / 3600
except:
    local_tz_offset = 0  # Fallback to UTC

def load_settings():
    global auto_light_off_enabled, print_finish_time
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        
        # Load auto off setting
        c.execute("SELECT value FROM settings WHERE key='auto_light_off'")
        row = c.fetchone()
        if row:
            auto_light_off_enabled = (row[0] == '1')
            
        # Load print_finish_time
        c.execute("SELECT value FROM settings WHERE key='print_finish_time'")
        row = c.fetchone()
        if row:
            try:
                print_finish_time = float(row[0])
            except:
                print_finish_time = 0
                
        conn.close()
        print(f"Loaded settings: Auto Light Off = {auto_light_off_enabled}, Finish Time = {print_finish_time}")
    except Exception as e:
        print(f"Error loading settings: {e}")

def save_setting(key, value):
    try:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error saving setting {key}: {e}")

def to_local_timestamp(utc_timestamp):
    """Convert UTC timestamp to local timestamp for frontend display"""
    if not utc_timestamp:
        return utc_timestamp
    # Add local offset (in seconds)
    return utc_timestamp + (local_tz_offset * 3600)

last_state = "Offline"
current_print_start = None
current_filename = ""
mqtt_client = None

# --- MQTT ---
def on_connect(client, userdata, flags, rc):
    print("Connected with result code " + str(rc))
    # Subscribe to report topic
    report_topic = f"device/{config.PRINTER_SERIAL}/report"
    client.subscribe(report_topic)
    
    # Force a refresh by requesting "pushall"
    request_topic = f"device/{config.PRINTER_SERIAL}/request"
    payload = {
        "pushing": {
            "sequence_id": "0",
            "command": "pushall"
        }
    }
    client.publish(request_topic, json.dumps(payload))
    print("Sent pushall request")

def on_message(client, userdata, msg):
    global current_status, last_state, current_print_start, current_filename, print_finish_time
    try:
        payload = json.loads(msg.payload.decode())
        if "print" in payload:
            data = payload["print"]
            
            # Update current status
            new_state = data.get("gcode_state", current_status["state"])
            current_status["state"] = new_state
            
            # Temperatures (Current / Target) - Round to nearest degree
            current_status["temp_nozzle"] = round(float(data.get("nozzle_temper", current_status["temp_nozzle"])))
            current_status["target_nozzle"] = round(float(data.get("nozzle_target_temper", current_status.get("target_nozzle", 0))))
            
            current_status["temp_bed"] = round(float(data.get("bed_temper", current_status["temp_bed"])))
            current_status["target_bed"] = round(float(data.get("bed_target_temper", current_status.get("target_bed", 0))))
            
            current_status["progress"] = data.get("mc_percent", current_status["progress"])
            current_status["time_remaining"] = data.get("mc_remaining_time", current_status["time_remaining"])
            current_status["filename"] = data.get("subtask_name", current_status["filename"])
            
            # Layers
            current_status["layer"] = data.get("layer_num", current_status["layer"])
            current_status["total_layers"] = data.get("total_layer_num", current_status["total_layers"])
            
            # Speed Profile
            # 1: Silent, 2: Standard, 3: Sport, 4: Ludicrous
            if "spd_lvl" in data:
                spd_map = {1: "Silent 🍃", 2: "Standard 🚗", 3: "Sport 🏎️", 4: "Ludicrous 🚀"}
                spd_lvl = data.get("spd_lvl", 0)
                current_status["speed_profile"] = spd_map.get(spd_lvl, "Unknown")
            
            # Light Status (Chamber Light)
            # lights_report is often a list: [{"node": "chamber_light", "mode": "on"}]
            # or sometimes just embedded. Let's check "lights_report"
            if "lights_report" in data:
                lights = data["lights_report"]
                for light in lights:
                    if light.get("node") == "chamber_light":
                        current_status["light_state"] = light.get("mode", "off")

            # Fans (Convert to %)
            # cooling_fan_speed: Part Cooling (String or Int, usually 0-15 = 0-100% or just %)
            # big_fan1_speed: Aux Fan (0-15)
            # big_fan2_speed: Chamber Fan (0-15)
            
            def parse_fan(value, max_val=15):
                try:
                    v = int(value)
                    if max_val == 100: return v # Already %
                    return int((v / max_val) * 100)
                except:
                    return 0

            if "cooling_fan_speed" in data:
                current_status["fan_part"] = parse_fan(data["cooling_fan_speed"], 15)
            
            if "big_fan1_speed" in data:
                current_status["fan_aux"] = parse_fan(data["big_fan1_speed"], 15)
                
            if "big_fan2_speed" in data:
                current_status["fan_chamber"] = parse_fan(data["big_fan2_speed"], 15)
            
            # Parse AMS Data
            # AMS data is typically inside the 'print' object (data variable here)
            # Structure: data['ams']['ams'][0]['tray'][0]...
            if "ams" in data and "ams" in data["ams"]:
                ams_units = data["ams"]["ams"]
                ams_data = {}
                # AMS Humidity is usually global per AMS unit
                ams_humidity = "Unknown"
                
                for unit in ams_units:
                    unit_id = unit["id"]
                    # Humidity (1-5 typically, sometimes string index)
                    # We store it at the unit level
                    ams_humidity = unit.get("humidity", "Unknown") 
                    
                    ams_data[unit_id] = {
                        "humidity": ams_humidity,
                        "trays": []
                    }
                    
                    for tray in unit["tray"]:
                        # Tray might be empty context, or contain actual data
                        if "id" in tray:
                            ams_data[unit_id]["trays"].append({
                                "id": tray["id"],
                                "type": tray.get("tray_type", "Unknown"),
                                "color": tray.get("tray_color", "000000"), # Hex color without #
                                "remain": tray.get("remain", -1), # Percentage usually, -1 if unknown
                                "k": tray.get("k", 0) # flow rate?
                            })
                        else:
                            ams_data[unit_id]["trays"].append(None) # Empty slot
                current_status["ams"] = ams_data
            elif "ams" in payload and "ams" in payload["ams"]:
                 # Fallback: sometimes it IS at top level (e.g. older fw?)
                 ams_units = payload["ams"]["ams"]
                 # ... (simplified handling for fallback if needed, or just copy logic)
                 # keeping it simple: if we find it here, we parse it similarly
                 pass 

            # Detect Print Start: transition to RUNNING
            # Note: Bambu state can be 'RUNNING' or 'PREPARE'
            if last_state in ["IDLE", "FINISH", "Offline"] and new_state in ["RUNNING", "PREPARE"]:
                current_filename = current_status["filename"]
                
                # If we are just starting (or reconnecting) and progress > 1%, try to estimate ORIGINAL start time
                # mc_remaining_time is in minutes
                progress = current_status["progress"]
                remaining = current_status["time_remaining"]
                
                if progress > 1 and remaining > 0:
                    # Estimate total duration = remaining / (1 - progress/100)
                    # This is rough but better than "Now"
                    try:
                         # remaining is minutes, convert to seconds
                         rem_sec = remaining * 60
                         # progress 0-100
                         frac = progress / 100.0
                         if frac < 1:
                             total_est = rem_sec / (1.0 - frac)
                             elapsed = total_est - rem_sec
                             current_print_start = time.time() - elapsed
                             print(f"Print in progress detected. Estimating start time -{elapsed/60:.1f}m ago.")
                         else:
                             current_print_start = time.time()
                    except:
                        current_print_start = time.time()
                else:
                    current_print_start = time.time()
                
                # Clear any previous auto-off timer when starting new print
                print_finish_time = 0
                save_setting('print_finish_time', 0)
                
                print(f"Print started: {current_filename}")
            
            # Detect Print End: transition from RUNNING
            # If we were RUNNING and now we are FINISH, FAILED, or even IDLE (cancelled)
            if last_state in ["RUNNING"] and new_state in ["FINISH", "FAILED", "IDLE"]:
                end_time = time.time()
                duration = end_time - (current_print_start or end_time)
                
                status = "SUCCESS"
                if new_state == "FAILED":
                    status = "FAILED"
                elif new_state == "IDLE":
                    status = "CANCELLED"
                
                print(f"Print ended: {current_filename} ({status}) in {duration}s")
                
                # Set finish time for auto light off ONLY if successful
                if status == "SUCCESS":
                    print_finish_time = end_time
                else:
                    print_finish_time = 0 # Don't auto-off light for failed prints
                
                # Persist finish time
                save_setting('print_finish_time', print_finish_time)
                
                # Save to DB
                conn = sqlite3.connect(DB_FILE)
                c = conn.cursor()
                c.execute("INSERT INTO prints (filename, start_time, end_time, duration, status, filament_weight) VALUES (?, ?, ?, ?, ?, ?)",
                          (current_filename, current_print_start, end_time, duration, status, 0))
                conn.commit()
                conn.close()
                current_print_start = None

                # Clear job information from current status
                current_status["filename"] = ""
                current_status["progress"] = 0
                current_status["layer"] = 0
                current_status["total_layers"] = 0
                current_status["time_remaining"] = 0
            
            last_state = new_state
            
    except Exception as e:
        print(f"Error parsing message: {e}")

def on_disconnect(client, userdata, rc):
    global current_status
    if rc != 0:
        print(f"MQTT disconnected unexpectedly (rc={rc}). Will auto-reconnect...")
        current_status["state"] = "Offline"

def run_mqtt():
    global mqtt_client
    mqtt_client = mqtt.Client()
    mqtt_client.username_pw_set("bblp", config.PRINTER_ACCESS_CODE)

    # SSL/TLS is required for Bambu Lab
    mqtt_client.tls_set(cert_reqs=ssl.CERT_NONE)
    mqtt_client.tls_insecure_set(True)

    mqtt_client.on_connect = on_connect
    mqtt_client.on_message = on_message
    mqtt_client.on_disconnect = on_disconnect

    # Enable automatic reconnection
    mqtt_client.reconnect_delay_set(min_delay=1, max_delay=30)

    try:
        mqtt_client.connect(config.PRINTER_IP, config.PRINTER_PORT, 60)
        mqtt_client.loop_start() # Use loop_start to run in background
    except Exception as e:
        print(f"MQTT Connection Error: {e}")
        # loop_start + reconnect_delay_set will handle retries automatically

# --- Background Monitor for Auto Light Off ---
def monitor_thread_func():
    global print_finish_time
    while True:
        try:
            # Wait for connection before making decisions
            if current_status["state"] == "Offline":
                time.sleep(1)
                continue

            current_time = time.time()
            # Only process if we have a finish time enabled
            if print_finish_time > 0:
                
                # Check for Manual Off (Job Done)
                if current_status["light_state"] == "off":
                     # Light is already off, meaning user or logic handled it.
                     # Clear timer to prevent re-triggering later.
                     print_finish_time = 0
                     save_setting('print_finish_time', 0)
                     continue

                # Check if 20 mins (1200 seconds) have passed since finish
                # We relax the state check to allow IDLE (acknowledged print)
                if (current_time - print_finish_time >= 1200 and
                    current_status["state"] not in ["RUNNING", "PREPARE", "PAUSE"]):
                    
                    # Late Enable Logic:
                    # If enabled, execute. If disabled, wait (do NOT clear timer).
                    if auto_light_off_enabled:
                         print("Auto Light Off: Turning off chamber light...")
                         if mqtt_client:
                            request_topic = f"device/{config.PRINTER_SERIAL}/request"
                            payload = {
                                "system": {
                                    "sequence_id": "0",
                                    "command": "ledctrl",
                                    "led_node": "chamber_light",
                                    "led_mode": "off",
                                    "led_on_time": 500,
                                    "led_off_time": 500,
                                    "loop_times": 1,
                                    "interval_time": 1000
                                }
                            }
                            mqtt_client.publish(request_topic, json.dumps(payload))
                            print("Auto Light Off: Command sent")
                    
                         # Reset finish time ONLY after command sent
                         print_finish_time = 0
                         save_setting('print_finish_time', 0)

        except Exception as e:
            print(f"Monitor error: {e}")
        
        time.sleep(10) # Check every 10 seconds for better responsiveness

# --- Flask Routes ---
@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/api/status')
def get_status():
    status_with_settings = current_status.copy()
    status_with_settings["auto_light_off"] = auto_light_off_enabled

    # Calculate auto light off remaining time
    if (auto_light_off_enabled and
        print_finish_time > 0 and
        current_status.get("state") not in ["RUNNING", "PREPARE", "PAUSE"]):
        # We don't strictly require light to be ON to show the countdown
        # The user might want to know "Auto off logic is active for X more minutes"
        # even if light is currently off.
        elapsed = time.time() - print_finish_time
        remaining = max(0, 1200 - int(elapsed))  # 1200 seconds = 20 minutes
        if remaining > 0:
            status_with_settings["auto_light_off_remaining"] = remaining

    return jsonify(status_with_settings)

@app.route('/api/settings', methods=['POST'])
def update_settings():
    global auto_light_off_enabled
    data = request.json
    if "auto_light_off" in data:
        auto_light_off_enabled = bool(data["auto_light_off"])
        save_setting('auto_light_off', '1' if auto_light_off_enabled else '0')
        
        # Save to DB - Legacy block removed, now using save_setting helper
            
    return jsonify({"success": True, "auto_light_off": auto_light_off_enabled})

@app.route('/api/history')
def get_history():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT * FROM prints ORDER BY start_time DESC LIMIT 50")
    rows = c.fetchall()
    c.execute("SELECT SUM(duration) FROM prints WHERE status = 'SUCCESS'")
    total_row = c.fetchone()
    conn.close()

    total_duration = total_row[0] if total_row and total_row[0] else 0

    history = []
    for row in rows:
        history.append({
            "id": row[0],
            "filename": row[1],
            "start_time": to_local_timestamp(row[2]),  # Convert to local time
            "end_time": to_local_timestamp(row[3]),    # Convert to local time
            "duration": row[4],
            "status": row[5],
            "filament_weight": row[6]
        })
    return jsonify({"prints": history, "total_duration": total_duration})

if __name__ == '__main__':
    init_db()
    load_settings()
    
    # Start MQTT
    run_mqtt()

    # Start Monitor Thread
    scheduler = threading.Thread(target=monitor_thread_func)
    scheduler.daemon = True
    scheduler.start()
    
    port = int(os.environ.get("PORT", 5001))
    app.run(host='0.0.0.0', port=port, debug=False)
