@echo off
chcp 65001 >nul
set "XLSX=%~f1"
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js not found. Install Node 18+ from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
if "%XLSX%"=="" set "XLSX=dist\卡牌表.xlsx"
node build.js import "%XLSX%" --confirm --open
pause
