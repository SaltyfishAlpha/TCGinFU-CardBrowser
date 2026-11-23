@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js not found. Install Node 18+ from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
node build.js export --open
pause
