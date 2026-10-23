@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0opencode-free-launcher.ps1" %*
exit /b %errorlevel%
