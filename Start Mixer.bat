@echo off
setlocal
title Ambient Music Mixer
cd /d "%~dp0mixer"
set "PORT=8765"
if defined MIXER_PORT set "PORT=%MIXER_PORT%"
set "OPEN=--open"
set "PSOPEN="
if defined MIXER_NOBROWSER (set "OPEN=" & set "PSOPEN=-NoBrowser")
set "LAN="
if /i "%~1"=="lan" set "LAN=--lan"
if /i "%~1"=="--lan" set "LAN=--lan"

rem Optional: set MIXER_PORT=8766 before starting to use another port.
rem --- Prefer Python 3.8+ (presets are saved in mixer\data\music_mixes.json) ---
set "PY="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul && set "PY=python"
if defined PY (
  echo Starting the Ambient Music Mixer with Python...
  %PY% mixer_server.py --port %PORT% %OPEN% %LAN%
  goto :end
)

rem --- No Python: built-in PowerShell server, presets are kept in your browser ---
if defined LAN (
  echo LAN mode needs Python 3.8 or newer: https://www.python.org/downloads/
  echo Starting in this-PC-only mode instead.
)
echo Python was not found. Starting the built-in Windows server instead.
echo Your presets will be saved in your web browser on this PC.
echo (To save presets as a file instead, install Python 3.8+ from https://www.python.org/downloads/ )
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mixer\serve.ps1" -Port %PORT% %PSOPEN%

:end
echo.
echo The mixer has stopped.
if not defined MIXER_NOBROWSER pause
