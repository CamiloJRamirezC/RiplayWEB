"""
Integración con el escritorio para el modo en segundo plano (--background):

  - Ícono de RiPlay junto al reloj (bandeja del sistema) con su menú.
  - "Iniciar con Windows": acceso directo en la carpeta Inicio del usuario.
  - Abrir RiPlay como app instalada (PWA) si existe, o en el navegador predeterminado.
  - Actualizar yt-dlp mientras el servicio corre y reiniciarlo cuando no se está usando.

Todo lo específico de Windows está aislado acá; en otros sistemas estas funciones
devuelven False o no hacen nada.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger("riplay")

IS_WINDOWS = sys.platform.startswith("win")
NO_WINDOW = 0x08000000 if IS_WINDOWS else 0  # CREATE_NO_WINDOW
DETACHED = (0x00000008 | 0x00000200) if IS_WINDOWS else 0  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
AUTOSTART_NAME = "RiPlay (servicio).lnk"


# ------------------------------------------------------------------ rutas de Windows


def _programs_dir() -> Path | None:
    appdata = os.environ.get("APPDATA")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" if appdata else None


def startup_dir() -> Path | None:
    programs = _programs_dir()
    return programs / "Startup" if programs else None


def gui_python() -> str:
    """pythonw.exe (sin ventana) del mismo entorno, si existe."""
    exe = Path(sys.executable)
    if IS_WINDOWS and exe.name.lower() == "python.exe":
        candidate = exe.with_name("pythonw.exe")
        if candidate.exists():
            return str(candidate)
    return str(exe)


def console_python() -> str:
    """python.exe del mismo entorno (para pip)."""
    exe = Path(sys.executable)
    if IS_WINDOWS and exe.name.lower() == "pythonw.exe":
        candidate = exe.with_name("python.exe")
        if candidate.exists():
            return str(candidate)
    return str(exe)


# ------------------------------------------------------------------ iniciar con Windows


def _ps_quote(text: str) -> str:
    return "'" + str(text).replace("'", "''") + "'"


def _run_powershell(script: str, timeout: int = 30) -> bool:
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True, text=True, timeout=timeout, creationflags=NO_WINDOW,
        )
        if result.returncode != 0:
            log.warning("PowerShell falló: %s", (result.stderr or result.stdout).strip()[:300])
        return result.returncode == 0
    except Exception as exc:
        log.warning("No se pudo ejecutar PowerShell: %s", exc)
        return False


def autostart_supported() -> bool:
    return IS_WINDOWS and startup_dir() is not None


def autostart_path() -> Path | None:
    folder = startup_dir()
    return folder / AUTOSTART_NAME if folder else None


def autostart_enabled() -> bool:
    path = autostart_path()
    return bool(path and path.exists())


def set_autostart(enabled: bool, app_dir: Path) -> bool:
    path = autostart_path()
    if not path:
        return False
    if not enabled:
        try:
            path.unlink(missing_ok=True)
            log.info("Inicio con Windows desactivado")
            return True
        except OSError as exc:
            log.warning("No se pudo quitar el inicio automático: %s", exc)
            return False
    path.parent.mkdir(parents=True, exist_ok=True)
    icon = app_dir / "static" / "icons" / "riplay.ico"
    script = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut(" + _ps_quote(path) + "); "
        "$s.TargetPath = " + _ps_quote(gui_python()) + "; "
        "$s.Arguments = " + _ps_quote(f'"{app_dir / "server.py"}" --background --silent') + "; "
        "$s.WorkingDirectory = " + _ps_quote(app_dir) + "; "
        "$s.IconLocation = " + _ps_quote(f"{icon},0") + "; "
        "$s.Description = 'Servicio de RiPlay (reproductor de música)'; "
        "$s.Save()"
    )
    ok = _run_powershell(script)
    if ok:
        log.info("Inicio con Windows activado: %s", path)
    return ok


# ------------------------------------------------------------------ abrir la app


_APP_ID_MARK = "--app-id".encode("utf-16-le")


def find_installed_app() -> Path | None:
    """Acceso directo que crean Chrome/Edge al instalar RiPlay como app (PWA)."""
    programs = _programs_dir()
    if not IS_WINDOWS or not programs or not programs.exists():
        return None
    startup = startup_dir()
    for path in programs.rglob("*.lnk"):
        if startup and startup in path.parents:
            continue
        if not path.stem.lower().startswith("riplay"):
            continue
        try:
            if _APP_ID_MARK in path.read_bytes():
                return path
        except OSError:
            continue
    return None


def open_app(url: str, browser_fallback) -> None:
    """Abre la ventana de la app instalada; si no está instalada, el navegador predeterminado."""
    shortcut = find_installed_app()
    if shortcut:
        try:
            os.startfile(str(shortcut))  # type: ignore[attr-defined]
            return
        except OSError as exc:
            log.warning("No se pudo abrir la app instalada (%s); uso el navegador", exc)
    browser_fallback(url)


# ------------------------------------------------------------------ actualizar librerías


def _norm_version(text: str | None) -> tuple:
    parts = []
    for p in (text or "").split("."):
        digits = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    while parts and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def installed_version(dist: str) -> str | None:
    try:
        from importlib.metadata import version

        return version(dist)
    except Exception:
        return None


def loaded_ytdlp_version() -> str | None:
    mod = sys.modules.get("yt_dlp")
    try:
        return mod.version.__version__ if mod else None
    except Exception:
        return None


def ytdlp_needs_restart() -> bool:
    """Hay un yt-dlp más nuevo instalado que el que está cargado en memoria."""
    loaded, installed = loaded_ytdlp_version(), installed_version("yt-dlp")
    return bool(loaded and installed and _norm_version(installed) != _norm_version(loaded))


def update_libraries(requirements: Path) -> bool:
    try:
        result = subprocess.run(
            [console_python(), "-m", "pip", "install", "-q", "-U", "--disable-pip-version-check", "-r", str(requirements)],
            capture_output=True, text=True, timeout=900, creationflags=NO_WINDOW,
        )
        if result.returncode != 0:
            log.warning("Actualización de librerías falló: %s", (result.stderr or result.stdout).strip()[-400:])
            return False
        log.info("Librerías revisadas. yt-dlp instalado: %s (en uso: %s)", installed_version("yt-dlp"), loaded_ytdlp_version())
        return True
    except Exception as exc:
        log.warning("No se pudo actualizar librerías: %s", exc)
        return False


class Updater(threading.Thread):
    """Revisa actualizaciones una vez por día y pide reinicio cuando RiPlay no se está usando."""

    def __init__(self, requirements: Path, is_idle, request_restart,
                 check_every: float = 24 * 3600, poll: float = 300, first_delay: float = 30):
        super().__init__(daemon=True, name="riplay-updater")
        self.requirements = requirements
        self.is_idle = is_idle
        self.request_restart = request_restart
        self.check_every, self.poll, self.first_delay = check_every, poll, first_delay
        self.last_check = 0.0
        self.stop_event = threading.Event()

    def run(self) -> None:
        if self.stop_event.wait(self.first_delay):
            return
        while not self.stop_event.is_set():
            if time.time() - self.last_check >= self.check_every:
                self.last_check = time.time()
                update_libraries(self.requirements)
            if ytdlp_needs_restart() and self.is_idle():
                log.info("Hay una versión nueva de yt-dlp y RiPlay no se está usando: reinicio para aplicarla")
                self.request_restart()
                return
            self.stop_event.wait(self.poll)


# ------------------------------------------------------------------ reinicio


def spawn_again(app_dir: Path, args: list[str]) -> None:
    """Lanza otra instancia del servicio (se usa después de cerrar ésta)."""
    subprocess.Popen(
        [gui_python(), str(app_dir / "server.py"), *args],
        cwd=str(app_dir), close_fds=True, creationflags=DETACHED,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


# ------------------------------------------------------------------ ícono junto al reloj


def tray_available() -> bool:
    try:
        import pystray  # noqa: F401
        from PIL import Image  # noqa: F401

        return True
    except Exception as exc:
        log.warning("Ícono de bandeja no disponible: %s", exc)
        return False


class Tray:
    """Ícono con menú. run() bloquea el hilo principal hasta Salir o Reiniciar."""

    def __init__(self, *, image_path: Path, title: str, on_open, on_folder,
                 autostart_get, autostart_set, notify_text: str | None = None):
        self.image_path = image_path
        self.title = title
        self.on_open, self.on_folder = on_open, on_folder
        self.autostart_get, self.autostart_set = autostart_get, autostart_set
        self.notify_text = notify_text
        self.action = "quit"
        self.icon = None

    def stop(self, action: str) -> None:
        self.action = action
        if self.icon is not None:
            self.icon.stop()

    def run(self) -> str:
        import pystray
        from PIL import Image

        def safe(fn):
            def handler(icon, item):
                try:
                    fn()
                except Exception as exc:  # un error en el menú no tiene que tirar el servicio
                    log.error("Acción del ícono falló: %s", exc, exc_info=True)
            return handler

        menu = pystray.Menu(
            pystray.MenuItem("Abrir RiPlay", safe(self.on_open), default=True),
            pystray.MenuItem("Abrir carpeta de descargas", safe(self.on_folder)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Iniciar con Windows",
                safe(lambda: self.autostart_set(not self.autostart_get())),
                checked=lambda item: self.autostart_get(),
                visible=autostart_supported(),
            ),
            pystray.MenuItem("Reiniciar", safe(lambda: self.stop("restart"))),
            pystray.MenuItem("Salir", safe(lambda: self.stop("quit"))),
        )
        self.icon = pystray.Icon("RiPlay", Image.open(self.image_path), self.title, menu)

        def setup(icon):
            try:
                icon.visible = True
            except Exception as exc:
                log.warning("No se pudo mostrar el ícono junto al reloj: %s", exc)
                return
            if self.notify_text:
                try:
                    icon.notify(self.notify_text, "RiPlay")
                except Exception:
                    pass

        self.icon.run(setup=setup)
        return self.action
