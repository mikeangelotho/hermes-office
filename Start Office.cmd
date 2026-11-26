@echo off
setlocal
pushd "%~dp0" || exit /b 1
where node >nul 2>nul
if errorlevel 1 (
  echo This launcher needs Node.js 22.18 or newer on PATH.
  pause
  popd
  exit /b 1
)
node "%~dp0scripts\desktop.mjs" --open
set "office_exit=%ERRORLEVEL%"
if not "%office_exit%"=="0" pause
popd
exit /b %office_exit%
