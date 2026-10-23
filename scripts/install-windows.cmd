@echo off
setlocal
if not exist "%~dp0install-windows.ps1" (
  echo install-windows.cmd: install-windows.ps1 was not found next to this file. 1>&2
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
exit /b %errorlevel%
