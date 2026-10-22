@echo off
rem Abre o sistema em http://localhost:3100
cd /d "%~dp0"
set "PATH=%~dp0.tools\node;%PATH%"
if not exist node_modules call npm install --no-audit --no-fund
node server\index.js
pause
