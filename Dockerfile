FROM python:3.12-slim

# Install ffmpeg (required for trimming)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Cloud Run passes PORT as an env var (default 8080)
ENV PORT=8080

# Writable temp dir for in-progress video files
RUN mkdir -p /tmp/cliptrimmer

CMD uvicorn main:app --host 0.0.0.0 --port $PORT
