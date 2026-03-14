@echo off
setlocal

cd /d "%~dp0"

set "MODE=desktop"
if /I "%~1"=="--web" (
  set "MODE=web"
  shift
) else if /I "%~1"=="web" (
  set "MODE=web"
  shift
) else if /I "%~1"=="--desktop" (
  shift
)
set "APP_ARGS=%1 %2 %3 %4 %5 %6 %7 %8 %9"

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

if /I "%MODE%"=="web" (
  echo Building web app...
  call bun run build -- --filter=@t3tools/web --filter=t3
  if errorlevel 1 (
    echo Web build failed.
    pause
    exit /b 1
  )

  echo Starting web server...
  node apps\server\dist\index.mjs %APP_ARGS%
  set EXIT_CODE=%errorlevel%
  if not "%EXIT_CODE%"=="0" (
    echo Web server exited with code %EXIT_CODE%.
    pause
  )
  exit /b %EXIT_CODE%
)

echo Building desktop app...
call bun run build:desktop
if errorlevel 1 (
  echo Desktop build failed.
  pause
  exit /b 1
)

echo Starting desktop app...
call bun run start:desktop -- %APP_ARGS%
set EXIT_CODE=%errorlevel%
if not "%EXIT_CODE%"=="0" (
  echo Desktop app exited with code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
