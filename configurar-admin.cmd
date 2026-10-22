@echo off
rem Cria o primeiro admin, ou redefine senha e autenticador de um admin.
cd /d "%~dp0"
set "PATH=%~dp0.tools\node;%PATH%"
if not exist node_modules call npm install --no-audit --no-fund
node scripts\admin-setup.js
pause
