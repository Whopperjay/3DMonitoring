// ==========================================
// TOAST NOTIFICATIONS SYSTEM (Phase 6.1)
// ==========================================

const toastQueue = [];
let toastIdCounter = 0;
let previousStatus = null; // Track previous status for change detection

/**
 * Show a toast notification
 * @param {string} type - 'success', 'error', 'warning', 'info'
 * @param {string} title - Toast title
 * @param {string} message - Toast message
 * @param {number} duration - Duration in ms (default: 5000)
 */
function showToast(type, title, message, duration = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toastId = toastIdCounter++;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.dataset.toastId = toastId;

    // Icon mapping
    const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠',
        info: 'ℹ'
    };

    toast.innerHTML = `
        <div class="toast-icon">${icons[type] || 'ℹ'}</div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="dismissToast(${toastId})">×</button>
        <div class="toast-progress" style="animation-duration: ${duration}ms;"></div>
    `;

    container.appendChild(toast);

    // Click to dismiss
    toast.addEventListener('click', (e) => {
        if (!e.target.classList.contains('toast-close')) {
            dismissToast(toastId);
        }
    });

    // Auto dismiss after duration
    setTimeout(() => {
        dismissToast(toastId);
    }, duration);

    return toastId;
}

/**
 * Dismiss a toast by ID
 * @param {number} toastId - ID of the toast to dismiss
 */
function dismissToast(toastId) {
    const toast = document.querySelector(`[data-toast-id="${toastId}"]`);
    if (!toast) return;

    toast.classList.add('toast-exit');
    setTimeout(() => {
        toast.remove();
    }, 300); // Match animation duration
}

/**
 * Check for alert conditions and show toasts
 * @param {object} data - Current status data
 * @param {object} oldData - Previous status data
 */
function checkForAlerts(data, oldData) {
    if (!oldData) return; // Skip on first load

    // Print finished successfully
    if (oldData.state !== 'FINISH' && data.state === 'FINISH') {
        showToast('success', 'Print Terminée', `${data.filename || 'Impression'} complétée avec succès!`, 7000);
    }

    // Print failed
    if (oldData.state !== 'FAILED' && data.state === 'FAILED') {
        showToast('error', 'Print Échouée', `${data.filename || 'Impression'} a échoué.`, 10000);
    }

    // Connection issues (state went offline)
    if (oldData.state !== 'Offline' && data.state === 'Offline') {
        showToast('error', 'Connexion Perdue', 'Impossible de se connecter à l\'imprimante.', 8000);
    }

    // Connection restored
    if (oldData.state === 'Offline' && data.state !== 'Offline') {
        showToast('success', 'Connexion Rétablie', 'Imprimante reconnectée avec succès.', 5000);
    }

    // AMS humidity critical (level > 4)
    if (data.ams && Object.keys(data.ams).length > 0) {
        for (const [unitId, unit] of Object.entries(data.ams)) {
            if (unit.humidity && parseInt(unit.humidity) >= 5) {
                // Only show once per session (check if we already warned)
                const warningKey = `ams_humidity_${unitId}`;
                if (!sessionStorage.getItem(warningKey)) {
                    showToast('warning', 'Humidité AMS Critique', `AMS ${unitId}: Niveau d'humidité très élevé (${unit.humidity}/5). Vérifiez le filament.`, 10000);
                    sessionStorage.setItem(warningKey, 'warned');
                }
            }
        }
    }

    // Temperature anomaly (delta > 10°C for nozzle or bed during print)
    if (data.state === 'RUNNING') {
        const nozzleDelta = Math.abs(parseInt(data.temp_nozzle) - parseInt(data.target_nozzle));
        const bedDelta = Math.abs(parseInt(data.temp_bed) - parseInt(data.target_bed));

        if (nozzleDelta > 10) {
            showToast('warning', 'Température Anormale', `Nozzle: écart de ${nozzleDelta}°C avec la cible.`, 8000);
        }

        if (bedDelta > 10) {
            showToast('warning', 'Température Anormale', `Bed: écart de ${bedDelta}°C avec la cible.`, 8000);
        }
    }

    // Print started
    if (oldData.state !== 'RUNNING' && data.state === 'RUNNING' && data.filename) {
        showToast('info', 'Impression Démarrée', `${data.filename} en cours d'impression...`, 5000);
    }
}

// ==========================================
// ORIGINAL ANIMATION UTILITIES
// ==========================================

// Animation utilities
function animateValue(element, start, end, duration) {
    const startTime = performance.now();
    const diff = end - start;

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeProgress = 1 - Math.pow(1 - progress, 3); // Ease out cubic
        const current = start + (diff * easeProgress);

        element.textContent = Math.round(current) + '%';

        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }

    requestAnimationFrame(update);
}

// Add stagger animation indices to cards
function initCardAnimations() {
    const cards = document.querySelectorAll('.card');
    cards.forEach((card, index) => {
        card.style.setProperty('--card-index', index);
    });
}

// Update circular progress gauge
function updateCircularProgress(percentage) {
    const circle = document.getElementById('progress-circle');
    const text = document.getElementById('circular-progress-text');

    if (!circle || !text) return;

    const circumference = 2 * Math.PI * 52; // radius = 52
    const offset = circumference - (percentage / 100) * circumference;

    circle.style.strokeDashoffset = offset;
    text.textContent = `${Math.round(percentage)}%`;
}

// Update fan with rotation based on speed
function updateFan(fanId, speed) {
    const fanElement = document.getElementById(fanId);
    if (!fanElement) return;

    fanElement.textContent = `${speed}%`;

    // Find parent fan-item
    const fanItem = fanElement.closest('.fan-item');
    if (!fanItem) return;

    // Set rotation speed based on percentage
    if (speed === 0) {
        fanItem.setAttribute('data-speed', '0');
    } else if (speed < 40) {
        fanItem.setAttribute('data-speed', 'low');
    } else if (speed < 75) {
        fanItem.setAttribute('data-speed', 'medium');
    } else {
        fanItem.setAttribute('data-speed', 'high');
    }
}

// Adaptive polling based on device
const isMobile = window.matchMedia("(max-width: 768px)").matches;
const pollInterval = isMobile ? 5000 : 3000;

// Touch interaction feedback
function addTouchFeedback(element) {
    element.addEventListener('touchstart', function() {
        this.style.transform = 'scale(0.95)';
    }, { passive: true });

    element.addEventListener('touchend', function() {
        this.style.transform = '';
    }, { passive: true });
}

// Initialize touch interactions for mobile
function initTouchInteractions() {
    const interactiveElements = document.querySelectorAll('.card, .ams-slot, .fan-item, .status-box, .gauge-item');
    interactiveElements.forEach(element => {
        addTouchFeedback(element);
    });

    // Add touch feedback to switch
    const switchElement = document.querySelector('.switch');
    if (switchElement) {
        addTouchFeedback(switchElement);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Initialize animations
    initCardAnimations();

    // Initialize touch interactions
    initTouchInteractions();

    // Initial fetch
    fetchStatus();
    fetchHistory();

    // Setup Auto Light Toggle Listener
    const autoLightCheck = document.getElementById('auto-light-check');
    if (autoLightCheck) {
        autoLightCheck.addEventListener('change', (e) => {
            // Mark as user interacting to prevent overwrite from status update temporarily
            autoLightCheck.dataset.userInteracting = "true";

            fetch('/api/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ auto_light_off: e.target.checked }),
            })
                .then(response => response.json())
                .then(data => {
                    console.log('Settings updated:', data);
                    setTimeout(() => { delete autoLightCheck.dataset.userInteracting; }, 2000);
                })
                .catch((error) => {
                    console.error('Error:', error);
                    delete autoLightCheck.dataset.userInteracting;
                    // Revert on error
                    autoLightCheck.checked = !autoLightCheck.checked;
                });
        });
    }

    // Polling interval with adaptive timing
    setInterval(fetchStatus, pollInterval);
});

let fetchErrorCount = 0;
const MAX_FETCH_ERRORS = 3;

function fetchStatus() {
    fetch('/api/status', { timeout: 10000 }) // 10s timeout
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            fetchErrorCount = 0; // Reset error count on success
            updateStatus(data);
        })
        .catch(error => {
            console.error('Error fetching status:', error);
            fetchErrorCount++;

            // Show toast after 3 consecutive failures
            if (fetchErrorCount === MAX_FETCH_ERRORS) {
                showToast('error', 'Erreur de Connexion', 'Impossible de récupérer le statut de l\'imprimante. Vérifiez la connexion serveur.', 10000);
            }
        });
}

function updateStatus(data) {
    // Check for alerts before updating UI
    checkForAlerts(data, previousStatus);

    // Store current data for next comparison
    previousStatus = JSON.parse(JSON.stringify(data)); // Deep copy

    const statusEl = document.getElementById('status-indicator');
    const nozzleTempEl = document.getElementById('temp-nozzle');
    const bedTempEl = document.getElementById('temp-bed');
    const fileNameEl = document.getElementById('file-name');
    const timeRemainingEl = document.getElementById('time-remaining');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    // Status text (color change via CSS)
    statusEl.textContent = data.state;
    statusEl.className = 'status-indicator ' + (data.state !== 'Offline' ? 'online' : '');

    // Temperatures
    nozzleTempEl.innerHTML = `${data.temp_nozzle}<span class="temp-target">/ ${data.target_nozzle}°C</span>`;
    bedTempEl.innerHTML = `${data.temp_bed}<span class="temp-target">/ ${data.target_bed}°C</span>`;

    // Fans with rotation animation
    updateFan('fan-part', data.fan_part);
    updateFan('fan-aux', data.fan_aux);
    updateFan('fan-chamber', data.fan_chamber);

    // Job details
    fileNameEl.textContent = data.filename || '---';
    timeRemainingEl.textContent = formatTime(data.time_remaining);

    // Layers
    const layerEl = document.getElementById('layer-info');
    if (data.total_layers > 0) {
        layerEl.textContent = `Layer ${data.layer} / ${data.total_layers}`;
    } else {
        layerEl.textContent = '---';
    }

    // Speed & Light
    document.getElementById('speed-profile').textContent = data.speed_profile || 'Normal';
    const lightEl = document.getElementById('light-status');
    lightEl.textContent = data.light_state === 'on' ? '💡 ON' : '🌑 OFF';
    lightEl.className = data.light_state === 'on' ? 'light-on' : 'light-off';

    // Update Auto Light Toggle
    const autoLightCheck = document.getElementById('auto-light-check');
    if (autoLightCheck && data.auto_light_off !== undefined && !autoLightCheck.dataset.userInteracting) {
        autoLightCheck.checked = data.auto_light_off;
    }

    // Update Auto Light Off Timer
    const timerEl = document.getElementById('auto-light-timer');
    if (timerEl) {
        if (data.auto_light_off_remaining && data.auto_light_off_remaining > 0) {
            const minutes = Math.floor(data.auto_light_off_remaining / 60);
            const seconds = data.auto_light_off_remaining % 60;
            const formattedTime = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            timerEl.textContent = `Auto off in ${formattedTime}`;
            timerEl.style.display = 'block';

            // Add warning class if less than 5 minutes
            if (data.auto_light_off_remaining < 300) {
                timerEl.classList.add('warning');
            } else {
                timerEl.classList.remove('warning');
            }
        } else {
            timerEl.style.display = 'none';
            timerEl.classList.remove('warning');
        }
    }

    // Progress bar with animated counter
    const currentProgress = parseInt(progressBar.style.width) || 0;
    const newProgress = data.progress;

    progressBar.style.width = `${newProgress}%`;

    if (Math.abs(newProgress - currentProgress) > 0) {
        animateValue(progressText, currentProgress, newProgress, 800);
    } else {
        progressText.textContent = `${newProgress}%`;
    }

    // Update circular progress gauge
    updateCircularProgress(newProgress);

    // AMS
    updateAMS(data.ams);
}

function updateAMS(amsData) {
    const container = document.getElementById('ams-container');

    // Check if AMS data exists
    if (!amsData || Object.keys(amsData).length === 0) {
        container.innerHTML = '<div style="color:#777;text-align:center;">No AMS Detected</div>';
        return;
    }

    container.innerHTML = ''; // Clear existing

    // Iterate through AMS units (usually just '0')
    for (const [unitId, unit] of Object.entries(amsData)) {
        const unitDiv = document.createElement('div');
        unitDiv.className = 'ams-unit';

        // Humidity Header
        let humidityText = 'Unknown';
        let humidityClass = 'unknown';

        // Interpretation of 1-5 level (1=Dry/Best, 5=Wet/Worst usually)
        if (unit.humidity) {
            const h = parseInt(unit.humidity);
            if (!isNaN(h)) {
                if (h <= 2) { humidityText = 'Dry (Good)'; humidityClass = 'good'; }
                else if (h <= 4) { humidityText = 'Moist'; humidityClass = 'warning'; }
                else { humidityText = 'Wet (Bad)'; humidityClass = 'bad'; }
                // Also show level icon
                humidityText = `💧 Level ${h}/5`;
            }
        }

        const header = document.createElement('div');
        header.className = 'ams-header';
        header.innerHTML = `<span>AMS ${unitId}</span> <span class="humidity ${humidityClass}">${humidityText}</span>`;
        unitDiv.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'ams-grid';

        if (unit.trays) {
            unit.trays.forEach((tray, index) => {
                const slot = document.createElement('div');
                slot.className = 'ams-slot';

                if (tray) {
                    const colorDiv = document.createElement('div');
                    colorDiv.className = 'filament-color';
                    colorDiv.style.backgroundColor = `#${tray.color}`;

                    // Show Type inside color
                    const typeSpan = document.createElement('span');
                    typeSpan.className = 'filament-type';
                    typeSpan.textContent = tray.type;
                    colorDiv.appendChild(typeSpan);

                    slot.appendChild(colorDiv);

                    // Remaining Logic
                    const remainDiv = document.createElement('div');
                    remainDiv.className = 'filament-remain';

                    if (tray.remain >= 0) {
                        // It's a percentage (0-100)
                        remainDiv.textContent = `${tray.remain}%`;
                        // Visual bar at bottom of slot?
                        const bar = document.createElement('div');
                        bar.className = 'remain-bar';
                        bar.style.height = `${tray.remain}%`;
                        bar.style.backgroundColor = `#${tray.color}`;
                        slot.appendChild(bar);
                    } else {
                        remainDiv.textContent = '?';
                    }
                    slot.appendChild(remainDiv);

                } else {
                    // Empty slot style
                    slot.textContent = 'Empty';
                    slot.classList.add('empty');
                }
                grid.appendChild(slot);
            });
        }
        unitDiv.appendChild(grid);
        container.appendChild(unitDiv);
    }
}

function fetchHistory() {
    fetch('/api/history')
        .then(response => response.json())
        .then(data => updateHistory(data.prints, data.total_duration))
        .catch(error => console.error('Error fetching history:', error));
}

function updateHistory(history, totalDuration) {
    const tableBody = document.getElementById('history-body');
    tableBody.innerHTML = ''; // Clear existing rows

    const totalEl = document.getElementById('total-duration');
    if (totalEl) {
        totalEl.textContent = totalDuration ? `Total : ${formatDuration(totalDuration)}` : '';
    }

    history.forEach((item, index) => {
        const row = document.createElement('tr');
        row.style.setProperty('--row-index', index);

        const dateCell = document.createElement('td');
        dateCell.textContent = new Date(item.start_time * 1000).toLocaleString();
        row.appendChild(dateCell);

        const fileCell = document.createElement('td');
        fileCell.textContent = item.filename;
        row.appendChild(fileCell);

        const durationCell = document.createElement('td');
        durationCell.textContent = formatDuration(item.duration);
        row.appendChild(durationCell);

        const statusCell = document.createElement('td');
        statusCell.textContent = item.status;
        row.appendChild(statusCell);

        const filamentCell = document.createElement('td');
        filamentCell.textContent = item.filament_weight ? `${item.filament_weight.toFixed(2)}g` : '-';
        row.appendChild(filamentCell);

        tableBody.appendChild(row);
    });
}

function formatTime(minutes) {
    if (minutes === undefined || minutes === null) return '--';
    // Bambu Lab P1S typically reports in minutes
    const hrs = Math.floor(minutes / 60);
    const mins = Math.floor(minutes % 60);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
}

function formatDuration(seconds) {
    if (!seconds) return '-';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
}
