@echo off
rem Carrega itens de exemplo no banco local (nunca no Supabase).
cd /d "%~dp0"
set "PATH=%~dp0.tools\node;%PATH%"
node scripts\seed-demo.js
pause
