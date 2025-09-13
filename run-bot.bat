@echo off
cd /d "%~dp0"
echo ============================================
echo  Starting Telegram Work Hours Bot...
echo  (Press CTRL+C to stop)
echo ============================================
:loop
node index.js
echo.
echo Bot stopped with exit code %errorlevel%.
echo Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
