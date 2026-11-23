@echo off
chcp 65001 >nul
set "ARG=%~f1"
cd /d "%~dp0"
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" -v >nul 2>nul || (
  echo Node.js not found. Use the release package, or install Node 18+ from https://nodejs.org/
  pause
  exit /b 1
)
"%NODE%" build.js export --open --ask
pause
