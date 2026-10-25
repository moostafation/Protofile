@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Run setup.bat first.
    pause
    exit /b 1
)
echo Installing NVIDIA GPU libraries (about 1.3 GB) ...
".venv\Scripts\python.exe" -m pip install -e ".[gpu]" || goto :error
echo.
echo Done. Subtitle Maker will now use your NVIDIA graphics card automatically
echo (the log says "Loading model ... on CUDA"). If the card can't be used it
echo falls back to the CPU on its own.
pause
exit /b 0

:error
echo.
echo Installation failed - see the messages above.
pause
exit /b 1
