@echo off
rem face-history: publish to the internet (Windows / Tailscale Funnel)
rem Double-click this file: updates to the latest version, then starts publishing.
chcp 65001 >nul
cd /d "%~dp0"

echo [1/3] Updating to the latest version...
git pull
if errorlevel 1 echo (git pull failed - continuing with the current version)

echo [2/3] Installing dependencies...
call npm.cmd install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto :error

echo [3/3] Starting...
call npm.cmd run public:tailscale
goto :end

:error
echo.
echo Failed. Please send a screenshot of this window.

:end
echo.
pause