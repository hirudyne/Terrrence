#!/bin/sh
SERVER_DIR=/workspace/server
LOG=/workspace/data/uvicorn.log

mkdir -p /workspace/data
echo "[supervisor] starting" >> "$LOG"

while true; do
    echo "[supervisor] launching uvicorn at $(date -u)" >> "$LOG"
    cd "$SERVER_DIR"
    TERRRENCE_INSECURE_COOKIES=1 PYTHONDONTWRITEBYTECODE=1 \
        python3 -m uvicorn app:app \
        --host 0.0.0.0 \
        --port 8000 \
        --log-level info \
        >> "$LOG" 2>&1
    echo "[supervisor] uvicorn exited with $? at $(date -u), restarting in 2s" >> "$LOG"
    sleep 2
done
