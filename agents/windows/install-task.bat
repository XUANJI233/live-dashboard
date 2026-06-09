@echo off
REM Register a Windows Task Scheduler task to run the agent at logon.
REM Run this from the directory containing the .exe.
REM The task deliberately uses LIMITED privileges so the tray and dialogs stay
REM in the normal interactive desktop session.

set "AGENT_PATH=%~dp0live-dashboard-agent.exe"
set "TASK_NAME=LiveDashboardAgent"
set "TASK_RUN=""%AGENT_PATH%"""

if not exist "%AGENT_PATH%" (
    echo Could not find: %AGENT_PATH%
    echo Build or copy live-dashboard-agent.exe next to this script first.
    pause
    exit /b 1
)

echo Registering scheduled task: %TASK_NAME%
echo Agent path: %AGENT_PATH%
echo.

schtasks /create /tn "%TASK_NAME%" /tr "%TASK_RUN%" /sc onlogon /rl LIMITED /f

if %errorlevel% equ 0 (
    echo Task registered successfully.
    echo The agent will start automatically at next logon.
    echo.
    echo To start it now:
    echo   schtasks /run /tn "%TASK_NAME%"
    echo.
    echo To remove it later:
    echo   schtasks /delete /tn "%TASK_NAME%" /f
) else (
    echo Failed to register task. You can also enable autostart from the tray menu.
)

pause
