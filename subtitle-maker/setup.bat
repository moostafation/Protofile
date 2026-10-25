@echo off
setlocal
cd /d "%~dp0"
title Subtitle Maker - Setup

rem Find Python 3.10 - 3.14 (the "py" launcher comes with the python.org installer).
set "PY="
for %%V in (3.12 3.13 3.11 3.14 3.10) do (
    if not defined PY (
        py -%%V -c "import tkinter" >nul 2>&1 && set "PY=py -%%V"
    )
)
if not defined PY (
    python -c "import sys, tkinter; sys.exit(not (3, 10) <= sys.version_info[:2] <= (3, 14))" >nul 2>&1 && set "PY=python"
)
if not defined PY (
    echo Python 3.10 - 3.14 was not found.
    echo Install Python 3.12 from https://www.python.org/downloads/
    echo and tick "Add python.exe to PATH" in the installer, then run this file again.
    pause
    exit /b 1
)

echo [1/3] Creating a private Python environment in .venv ...
%PY% -m venv .venv || goto :error

echo [2/3] Installing libraries (about 250 MB, only the first time) ...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
".venv\Scripts\python.exe" -m pip install -e . || goto :error

echo [3/3] Adding the right-click menu and shortcuts ...
".venv\Scripts\subtitle-maker.exe" --install || goto :error

echo.
echo ============================================================
echo  Done!
echo  - Open "Subtitle Maker" from the Desktop or the Start menu, or
echo  - Right-click any video (or folder) and choose "Generate subtitles".
echo    On Windows 11 it is under "Show more options".
echo ============================================================
pause
exit /b 0

:error
echo.
echo Setup failed - see the messages above.
pause
exit /b 1
