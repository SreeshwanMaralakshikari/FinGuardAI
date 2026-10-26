# FinGuardAI offline launcher (Windows PowerShell 5.1 or later).
# Starts the ML service, the API and the website, each in its own window, then opens the site.
# Nothing here needs internet. One-time preparation (with internet): docs/OFFLINE_DEMO.md
# Double-click start-offline.cmd instead of this file (it bypasses the "scripts are disabled" policy).

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend  = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'
$ml       = Join-Path $root 'ml-service'
$envFile  = Join-Path $backend '.env.offline'

function Stop-WithMessage([string]$message) {
  Write-Host ''
  Write-Host $message -ForegroundColor Red
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}

function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $attempt = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if (-not $attempt.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($attempt)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-Port([int]$port, [string]$label, [int]$seconds) {
  Write-Host -NoNewline "Waiting for $label "
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Test-Port $port) { Write-Host 'ready' -ForegroundColor Green; return $true }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 1
  }
  Write-Host ' not answering yet (look at its window for the error)' -ForegroundColor Yellow
  return $false
}

function Start-Window([string]$title, [string]$folder, [string]$command) {
  $full = "`$host.UI.RawUI.WindowTitle = '$title'; $command"
  Start-Process -FilePath 'powershell' -WorkingDirectory $folder -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $full) | Out-Null
}

Write-Host 'FinGuardAI offline start' -ForegroundColor Cyan
Write-Host ''

# 1. One-time preparation done?
if (-not (Test-Path $envFile)) {
  Stop-WithMessage "backend\.env.offline is missing. Run once (with internet):`n  cd backend`n  npm run offline:setup"
}
foreach ($folder in @($backend, $frontend)) {
  if (-not (Test-Path (Join-Path $folder 'node_modules'))) {
    Stop-WithMessage "$folder has no node_modules. Run once (with internet): cd $folder; npm ci"
  }
}
$python = Join-Path $ml '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
  Stop-WithMessage "ml-service\.venv is missing. Run once (with internet):`n  cd ml-service`n  py -3.13 -m venv .venv`n  .venv\Scripts\python.exe -m pip install -r requirements.txt"
}
$keyLine = Get-Content $envFile | Where-Object { $_ -match '^ML_API_KEY=' } | Select-Object -First 1
if (-not $keyLine) { Stop-WithMessage 'ML_API_KEY is missing from backend\.env.offline. Run: cd backend; npm run offline:setup -- --force' }
$mlKey = ($keyLine -replace '^ML_API_KEY=', '').Trim().Trim("'").Trim('"')

# 2. MongoDB (installed as a Windows service by the MongoDB installer)
if (-not (Test-Port 27017)) {
  Write-Host 'MongoDB is not running; trying to start the MongoDB service ...'
  try { Start-Service -Name 'MongoDB' } catch { Write-Host '  (could not start it from here)' -ForegroundColor Yellow }
  if (-not (Wait-Port 27017 'MongoDB' 15)) {
    Stop-WithMessage "MongoDB is not running on port 27017.`nOpen the Windows 'Services' app, find 'MongoDB Server (MongoDB)' and click Start. Then run this again."
  }
} else {
  Write-Host 'MongoDB is running' -ForegroundColor Green
}

# 3. The three parts (a part that is already running is left alone)
# The ML service starts first: the API checks it once at start-up, so the first payment is scored by the model.
if (Test-Port 5001) { Write-Host 'ML service already running' -ForegroundColor Green }
else { Start-Window 'FinGuardAI ML service' $ml "`$env:ML_API_KEY = '$mlKey'; & '$python' wsgi.py" }
$null = Wait-Port 5001 'ML service' 60

if (Test-Port 5000) { Write-Host 'API already running' -ForegroundColor Green }
else { Start-Window 'FinGuardAI API' $backend 'npm.cmd run start:offline' }

if (Test-Port 3000) { Write-Host 'Website already running' -ForegroundColor Green }
else { Start-Window 'FinGuardAI website' $frontend "`$env:VITE_DEV_BACKEND_URL = 'http://127.0.0.1:5000'; npm.cmd run dev" }

$null = Wait-Port 5000 'API' 60
$siteUp = Wait-Port 3000 'website' 60

Write-Host ''
if ($siteUp) {
  Write-Host 'FinGuardAI is running offline at http://localhost:3000' -ForegroundColor Green
  Start-Process 'http://localhost:3000'
}
Write-Host 'Sign in with the same accounts as on the live site.'
Write-Host 'To stop: close the three FinGuardAI windows.'
Write-Host ''
Read-Host 'Press Enter to close this window (the app keeps running)'
