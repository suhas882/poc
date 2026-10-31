@echo off
title Public Records Search server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Download "Node.js 24 LTS" from https://nodejs.org , install it, then double-click start.bat again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node"') do (
  set NODE_MAJOR=%%a
  set NODE_MINOR=%%b
)
if %NODE_MAJOR% LSS 22 goto oldnode
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 13 goto oldnode
goto nodeok
:oldnode
echo.
echo This app needs Node.js 22.13 or newer. You have:
node -v
echo Install "Node.js 24 LTS" from https://nodejs.org , then double-click start.bat again.
echo.
pause
exit /b 1
:nodeok

if not exist "node_modules\pdfjs-dist" (
  echo Installing packages. This takes a minute the first time...
  call npm install
  if errorlevel 1 (
    echo.
    echo "npm install" failed. Copy the red text above and send it to Claude.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=8765
rem This PC may connect real sources. The hosted demo leaves REAL_SOURCES unset, so it stays Tier 0.
if "%REAL_SOURCES%"=="" set REAL_SOURCES=true
echo.
echo Starting the server on http://localhost:%PORT%/
echo Keep this window open while you use the website. Close it (or press Ctrl+C) to stop.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT%/"
node server.js
echo.
echo The server stopped. If there is an error above, copy it and send it to Claude.
pause
