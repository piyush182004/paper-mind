# Starts PaperMind locally: ML service (port 8001) + API & website (port 8080).
# Usage: right-click > "Run with PowerShell", or in a terminal:  powershell -ExecutionPolicy Bypass -File start.ps1
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\services\ml'; .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001" -WindowStyle Minimized
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\apps\api'; npx tsx src/index.ts"

Write-Host "Starting... open http://localhost:8080 in ~15 seconds."
Write-Host "Settings (AI key, Google sign-in): $root\apps\api\.env  - restart after editing."
