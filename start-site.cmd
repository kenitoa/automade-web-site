@echo off
setlocal

cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting Interface Auto Builder...
echo Browser will open automatically.
call npm run dev -- --port 5173 --open

if errorlevel 1 (
  echo Failed to start the site.
  pause
  exit /b 1
)
