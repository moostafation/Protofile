@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\subtitle-maker.exe" (
    ".venv\Scripts\subtitle-maker.exe" --uninstall
)
echo.
echo The right-click menu and shortcuts were removed.
echo You can now delete this folder. Downloaded models are in
echo %USERPROFILE%\.cache\huggingface - delete it too to free the space.
pause
