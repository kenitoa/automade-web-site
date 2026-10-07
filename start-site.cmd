@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if errorlevel 1 (
  echo Launch failed. Read the message above and try again.
  pause
  exit /b 1
)
