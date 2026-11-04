@echo off
setlocal
title Music Bots - Bot 1 and Bot 2
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" %*
set "MUSIC_BOT_RESULT=%ERRORLEVEL%"
echo.
if /i not "%~1"=="-CheckOnly" pause
exit /b %MUSIC_BOT_RESULT%
