@echo off
setlocal

cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo bun is not installed or not on PATH.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo node is not installed or not on PATH.
  pause
  exit /b 1
)

echo Building...
call bun run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo Starting...
node apps\server\dist\index.mjs %*
set EXIT_CODE=%errorlevel%
if not "%EXIT_CODE%"=="0" (
  echo Server exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
