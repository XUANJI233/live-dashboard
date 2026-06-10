@echo off
setlocal
REM Build the Windows agent into a single .exe using PyInstaller
REM Run this from the agents/windows/ directory
cd /d "%~dp0"

echo Installing dependencies...
pip install -r requirements.txt pyinstaller

echo.
echo Building agent.exe...
set HIDDEN=--hidden-import=pystray._win32 --hidden-import=pycaw.pycaw --hidden-import=comtypes
if exist icon.ico (
    pyinstaller --onefile --noconsole --icon=icon.ico %HIDDEN% --name live-dashboard-agent agent.py
) else (
    pyinstaller --onefile --noconsole %HIDDEN% --name live-dashboard-agent agent.py
)
if errorlevel 1 exit /b %errorlevel%

echo.
echo Signing live-dashboard-agent.exe...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sign-windows.ps1" -FilePath "%~dp0dist\live-dashboard-agent.exe" -RequireSigning
if errorlevel 1 exit /b %errorlevel%

echo.
if /I "%WINDOWS_SKIP_SIGNING%"=="true" (
    echo Done! Unsigned debug output: dist\live-dashboard-agent.exe
) else (
    echo Done! Signed output: dist\live-dashboard-agent.exe
)
echo Copy config.json next to the .exe before running.
if /I "%WINDOWS_BUILD_PAUSE%"=="true" pause
