@echo off
title Public Records Search - PC sync helper
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Download "Node.js 24 LTS" from https://nodejs.org , install it, then double-click phonelink-sync.bat again.
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
echo This helper needs Node.js 22.13 or newer. Install "Node.js 24 LTS" from https://nodejs.org .
pause
exit /b 1
:nodeok

echo.
echo Sends new Android texts from Phone Link on this PC to your Public Records Search website.
echo Keep this window open (you can minimize it). Close it to stop sending.
echo.
node agent\phonelink-sync.mjs %*
echo.
pause
