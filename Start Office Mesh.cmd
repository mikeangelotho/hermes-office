@echo off
setlocal
pushd "%~dp0" || exit /b 1
node "%~dp0scripts\mesh.mjs"
set "office_exit=%ERRORLEVEL%"
if not "%office_exit%"=="0" pause
popd
exit /b %office_exit%
