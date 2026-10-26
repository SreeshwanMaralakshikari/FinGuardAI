@echo off
rem Double-click to run FinGuardAI fully offline (ML service + API + website). Setup: docs\OFFLINE_DEMO.md
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-offline.ps1"
