@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title RiPlay Web

rem ============================================================
rem  RiPlay Web - inicio
rem  1. Busca Python 3.10 o mas nuevo. Si no hay, lo instala
rem     (solo para tu usuario, sin permisos de administrador).
rem  2. Prepara el entorno y actualiza las librerias.
rem  3. Inicia el servicio oculto (icono junto al reloj) y, cuando
rem     responde, abre RiPlay (la app instalada o el navegador).
rem
rem  "iniciar.bat consola" lo corre en esta ventana, para ver errores.
rem ============================================================

set "PY_VERSION=3.13.16"
set "PY_WINGET_ID=Python.Python.3.13"

if not exist "server.py" (
  echo No encuentro server.py en esta carpeta.
  echo Si abriste este archivo desde adentro del .zip, primero descomprimilo:
  echo clic derecho en el .zip, "Extraer todo", y abri iniciar.bat desde la carpeta extraida.
  goto :fail
)

set "RP_PORT=%RIPLAY_PORT%"
if not defined RP_PORT set "RP_PORT=8765"
set "RP_DATA=%RIPLAY_DATA%"
if not defined RP_DATA set "RP_DATA=%USERPROFILE%\RiPlayWeb"

rem ---------------------------------------------------- 0. Ya esta funcionando?
rem Si el servicio ya corre (por ejemplo, porque arranca con Windows) no se toca nada:
rem actualizar librerias en uso puede fallar en Windows. Solo se abre RiPlay.
if /i "%~1"=="consola" goto :check_python
if not exist ".venv\Scripts\pythonw.exe" goto :check_python
call :is_running 2
if errorlevel 1 goto :check_python
echo RiPlay ya esta funcionando. Lo abro.
start "" ".venv\Scripts\pythonw.exe" server.py --background
exit /b 0

:check_python
rem ---------------------------------------------------- 1. Python
call :find_python
if defined PY goto :python_ok

echo.
echo No encontre Python 3.10 o mas nuevo en esta compu.
echo Lo instalo ahora, solo para tu usuario. Tarda un par de minutos...
echo.

where winget >nul 2>nul
if errorlevel 1 goto :install_direct
echo Instalando Python con winget...
winget install --id %PY_WINGET_ID% -e --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
call :find_python
if defined PY goto :python_installed

:install_direct
echo Descargando Python %PY_VERSION% desde python.org...
set "PY_ARCH=amd64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PY_ARCH=arm64"
set "PY_URL=https://www.python.org/ftp/python/%PY_VERSION%/python-%PY_VERSION%-%PY_ARCH%.exe"
set "PY_SETUP=%TEMP%\riplay-python-%PY_VERSION%.exe"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -UseBasicParsing -Uri '%PY_URL%' -OutFile '%PY_SETUP%'; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 (
  echo No se pudo descargar Python. Revisa tu conexion a internet.
  goto :manual_python
)
echo Instalando Python %PY_VERSION%...
start "" /wait "%PY_SETUP%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 InstallLauncherAllUsers=0 Include_test=0 Include_doc=0
del "%PY_SETUP%" >nul 2>nul
call :find_python
if defined PY goto :python_installed

:manual_python
echo.
echo No pude instalar Python automaticamente.
echo Instalalo a mano desde https://www.python.org/downloads/
echo y marca la casilla "Add python.exe to PATH". Despues abri de nuevo este archivo.
start "" "https://www.python.org/downloads/"
goto :fail

:python_installed
echo Python instalado.

:python_ok
<nul set /p "=Usando " & "%PY%" --version

rem ---------------------------------------------------- 2. Entorno y librerias
if not exist ".venv\Scripts\python.exe" goto :make_venv
".venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 goto :venv_ok
echo El entorno guardado no sirve (Python viejo o desinstalado). Lo vuelvo a crear...
rmdir /s /q ".venv"

:make_venv
echo Preparando RiPlay por primera vez, tarda un minuto...
"%PY%" -m venv .venv
if errorlevel 1 (
  echo No se pudo crear el entorno de Python.
  goto :fail
)

:venv_ok
echo Revisando actualizaciones de yt-dlp...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -U -r requirements.txt
if errorlevel 1 echo No se pudo actualizar. Sigo con lo que ya esta instalado.
rem Icono junto al reloj (si no se puede instalar, RiPlay corre en esta ventana)
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements-windows.txt >nul 2>nul

".venv\Scripts\python.exe" -c "import yt_dlp, ytmusicapi" >nul 2>nul
if not errorlevel 1 goto :start_server
echo.
echo Faltan librerias y no se pudieron instalar. Esto es lo que dice pip:
echo.
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
echo.
echo Revisa tu conexion a internet (o si un antivirus o proxy bloquea pip) y abri de nuevo este archivo.
goto :fail

rem ---------------------------------------------------- 3. Servicio + app
:start_server
echo.
if /i "%~1"=="consola" goto :console_mode
if not exist ".venv\Scripts\pythonw.exe" goto :console_mode
".venv\Scripts\python.exe" -c "import pystray, PIL" >nul 2>nul
if errorlevel 1 goto :console_mode

echo Iniciando RiPlay en segundo plano...
start "" ".venv\Scripts\pythonw.exe" server.py --background
call :is_running 60
if errorlevel 1 goto :bg_failed
echo Listo. RiPlay queda funcionando junto al reloj: clic derecho en su icono para ver las opciones.
timeout /t 4 >nul
exit /b 0

:bg_failed
echo.
echo RiPlay no respondio. Ultimas lineas del registro (%RP_DATA%\riplay.log):
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path -LiteralPath '%RP_DATA%\riplay.log') { Get-Content -LiteralPath '%RP_DATA%\riplay.log' -Tail 15 -Encoding UTF8 }"
echo.
echo Para ver el error completo, abri:  iniciar.bat consola
goto :fail

:console_mode
rem En esta ventana, como antes: cerrala para apagar RiPlay.
".venv\Scripts\python.exe" server.py
rem 0 = cerrado normal, 3 = ya estaba abierto (solo lo mostro), otro = error
if errorlevel 3 if not errorlevel 4 (
  timeout /t 4 >nul
  exit /b 0
)
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
pause
exit /b 1


rem ============================================================
rem  :find_python  ->  deja en PY la ruta de un python.exe 3.10+
rem ============================================================
:find_python
set "PY="
rem Lanzador "py" (el instalador oficial lo agrega)
call :try_cmd py -3
if defined PY exit /b 0
rem "python" en el PATH (se descarta el acceso directo de Microsoft Store)
call :try_cmd python
if defined PY exit /b 0
rem Lanzador recien instalado que todavia no esta en el PATH de esta ventana
if exist "%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" call :try_cmd "%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" -3
if defined PY exit /b 0
rem Instalaciones conocidas
for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if not defined PY call :try_exe "%%~fd\python.exe"
if defined PY exit /b 0
for /d %%d in ("%ProgramFiles%\Python3*") do if not defined PY call :try_exe "%%~fd\python.exe"
exit /b 0

:try_cmd
rem Pregunta a ese comando donde esta su python.exe (sin for /f: rompe rutas con comillas)
set "CAND="
set "CAND_FILE=%TEMP%\riplay-python-path.txt"
del "%CAND_FILE%" >nul 2>nul
%* -c "import sys; print(sys.executable)" > "%CAND_FILE%" 2>nul
if exist "%CAND_FILE%" set /p CAND=<"%CAND_FILE%"
del "%CAND_FILE%" >nul 2>nul
if not defined CAND exit /b 0
call :try_exe "%CAND%"
exit /b 0

:try_exe
if not exist "%~1" exit /b 0
echo %~1 | find /i "\WindowsApps\" >nul && exit /b 0
"%~1" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 exit /b 0
set "PY=%~1"
exit /b 0

rem ============================================================
rem  :is_running N  ->  errorlevel 0 si RiPlay responde (espera hasta N/2 segundos)
rem ============================================================
:is_running
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = New-Object Net.WebClient; $c.Proxy = $null; for ($i = 0; $i -lt %~1; $i++) { try { $r = $c.DownloadString('http://127.0.0.1:%RP_PORT%/api/status'); if ($r -match 'yt-dlp') { exit 0 } } catch { }; Start-Sleep -Milliseconds 500 }; exit 1" >nul 2>nul
exit /b %errorlevel%
