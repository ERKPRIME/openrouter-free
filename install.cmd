@echo off
rem Install or upgrade opencode-free-router from Command Prompt.
rem   install.cmd [--bb] [--dir PATH] [--no-rank]
rem This only finds a POSIX shell: scripts\install.sh does the work. Git for Windows ships one.
setlocal enabledelayedexpansion

set "repo=%~dp0"
set "script=%repo%scripts\install.sh"
if not exist "%script%" (
  echo install.cmd: %script% not found; run this from the repository root >&2
  exit /b 1
)

set "bash="
for %%p in (
  "%ProgramFiles%\Git\bin\bash.exe"
  "%ProgramFiles(x86)%\Git\bin\bash.exe"
  "%LocalAppData%\Programs\Git\bin\bash.exe"
) do if exist %%p if not defined bash set "bash=%%~p"

if not defined bash for /f "delims=" %%p in ('where bash 2^>nul') do if not defined bash set "bash=%%~p"

if not defined bash (
  echo install.cmd: Git Bash not found. Install Git for Windows from https://git-scm.com/download/win >&2
  echo   or run scripts\install.sh yourself with any POSIX shell. >&2
  exit /b 1
)

"%bash%" "%script%" %*
exit /b %ERRORLEVEL%
