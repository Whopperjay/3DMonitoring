FROM python:3.9-slim

WORKDIR /app

# Install system dependencies if needed (e.g. for sqlite3 or gcc)
# RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create volume for database
VOLUME /app/data

EXPOSE 5001

CMD ["python", "server.py"]
