#!/bin/sh
# Starts the internal ML service, waits until it is up, then runs the API in the foreground.
set -e
# both processes share one secret; generate it when the host did not set one
export ML_SERVICE_TOKEN="${ML_SERVICE_TOKEN:-$(python -c 'import secrets; print(secrets.token_hex(24))')}"
cd /home/user/app/services/ml
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --log-level warning &
for i in $(seq 1 60); do
  python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health')" 2>/dev/null && break
  sleep 1
done
cd /home/user/app/apps/api
exec node dist/index.js
