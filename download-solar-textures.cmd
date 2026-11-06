@echo off
setlocal EnableExtensions

rem Download NASA/SDO Sun and solar-flare JPGs into this project's textures folder.
rem Place this CMD file in the Universe Engine project root and run it.

set "ROOT=%~dp0"
set "SOLAR_DIR=%ROOT%textures\solar"
set "FLARE_DIR=%SOLAR_DIR%\flares"
set "FAILURES=0"

echo.
echo ================================================
echo   Universe Engine - NASA Solar Texture Download
echo ================================================
echo.

where curl.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: curl.exe was not found.
    echo Windows 10/11 normally includes curl.exe. Install or enable it, then retry.
    pause
    exit /b 1
)

if not exist "%SOLAR_DIR%" mkdir "%SOLAR_DIR%"
if not exist "%FLARE_DIR%" mkdir "%FLARE_DIR%"

if not exist "%SOLAR_DIR%" (
    echo ERROR: Could not create "%SOLAR_DIR%"
    pause
    exit /b 1
)
if not exist "%FLARE_DIR%" (
    echo ERROR: Could not create "%FLARE_DIR%"
    pause
    exit /b 1
)

rem SDO/HMI continuum: current full-disk photosphere images.
call :download "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_4096_HMIIC.jpg" "%SOLAR_DIR%\sun-4k.jpg"
call :download "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_2048_HMIIC.jpg" "%SOLAR_DIR%\sun-2k.jpg"

rem NASA/SDO X2.2 flare, 10 June 2014 (171 + 131 angstrom composite).
call :download "https://svs.gsfc.nasa.gov/vis/a010000/a011500/a011564/June_10_2014_X2pt2_Flare_4096.jpg" "%FLARE_DIR%\flare-x2-2-4k.jpg"
call :download "https://svs.gsfc.nasa.gov/vis/a010000/a011500/a011564/June_10_2014_X2pt2_Flare_2048.jpg" "%FLARE_DIR%\flare-x2-2-2k.jpg"

rem NASA/SDO X1.5 flare, 10 June 2014 (171 + 131 angstrom composite).
call :download "https://svs.gsfc.nasa.gov/vis/a010000/a011500/a011564/June_10_X1_Flare_4k.jpg" "%FLARE_DIR%\flare-x1-5-4k.jpg"
call :download "https://svs.gsfc.nasa.gov/vis/a010000/a011500/a011564/June_10_X1_Flare_2k.jpg" "%FLARE_DIR%\flare-x1-5-2k.jpg"

echo.
echo ================================================
if "%FAILURES%"=="0" (
    echo All downloads completed successfully.
) else (
    echo Finished with %FAILURES% download failure(s).
    echo Rerun this file to retry failed downloads.
)
echo.
echo Destination:
echo %SOLAR_DIR%
echo ================================================
echo.
pause
exit /b %FAILURES%

:download
set "URL=%~1"
set "DEST=%~2"
set "TEMP_FILE=%~2.part"

echo Downloading: %~nx2
if exist "%TEMP_FILE%" del /q "%TEMP_FILE%" >nul 2>&1
curl.exe --fail --location --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 30 --output "%TEMP_FILE%" "%URL%"
if errorlevel 1 (
    echo [FAILED] %~nx2
    if exist "%TEMP_FILE%" del /q "%TEMP_FILE%" >nul 2>&1
    set /a FAILURES+=1 >nul
    exit /b 0
)

for %%F in ("%TEMP_FILE%") do if %%~zF LEQ 0 (
    echo [FAILED] %~nx2 - downloaded file is empty.
    if exist "%TEMP_FILE%" del /q "%TEMP_FILE%" >nul 2>&1
    set /a FAILURES+=1 >nul
    exit /b 0
)

move /y "%TEMP_FILE%" "%DEST%" >nul
if errorlevel 1 (
    echo [FAILED] Could not save %~nx2
    if exist "%TEMP_FILE%" del /q "%TEMP_FILE%" >nul 2>&1
    set /a FAILURES+=1 >nul
    exit /b 0
)

echo [OK] %~nx2
exit /b 0
