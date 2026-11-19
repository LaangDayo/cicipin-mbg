@echo off
title Server Cicipin MBG
cd /d "%~dp0"
echo Menyalakan server Cicipin MBG...
start "" "http://localhost:3000"
node server.js
pause