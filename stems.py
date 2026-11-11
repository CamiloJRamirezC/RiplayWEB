"""
Separar pistas (voz, batería, bajo, guitarra, piano y resto) bajo demanda, con Demucs.

El motor (PyTorch + Demucs) no va en el Python de RiPlay: se instala aparte, una sola vez, en
DATA_DIR/stems-engine, con un Python 3.12 propio que baja `uv`. Así no depende de la versión de
Python de la PC y se puede borrar sin tocar nada más.

Cada canción separada queda en DATA_DIR/stems/<clave>/ (una .m4a por pista + meta.json).
Las canciones se separan de a una, en una fila, con prioridad baja para no cortar la música.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

MODEL = "htdemucs_6s"          # 6 pistas: voz, batería, bajo, guitarra, piano y resto
ENGINE_VERSION = 1
PY_VERSION = "3.12"
TORCH_PINS = ["torch==2.8.0", "torchaudio==2.8.0"]
EXTRA_PKGS = ["demucs==4.0.1", "av>=12", "soundfile>=0.12", "numpy<3"]
SOURCES_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"]
WIN = sys.platform == "win32"

INSTALL_STAGES = ["uv", "python", "torch", "demucs", "model", "check"]


def _console_python() -> str:
    """En segundo plano RiPlay corre con pythonw.exe (sin consola): para instalar se usa python.exe."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe" and (exe.parent / "python.exe").exists():
        return str(exe.parent / "python.exe")
    return sys.executable


class StemsError(Exception):
    pass


class Stems:
    def __init__(self, data_dir: Path, app_dir: Path, log, fetch_audio, local_path):
        """fetch_audio(track, dest_dir, on_progress) -> Path baja el audio; local_path(track) -> Path|None para archivos del disco."""
        self.data_dir = Path(data_dir)
        self.app_dir = Path(app_dir)
        self.log = log
        self.fetch_audio = fetch_audio
        self.local_path = local_path
        self.engine_dir = self.data_dir / "stems-engine"
        self.out_root = self.data_dir / "stems"
        self.fake = os.environ.get("RIPLAY_STEMS_FAKE") == "1"
        self.lock = threading.RLock()
        self.install_job: dict | None = None
        self.jobs: dict[str, dict] = {}      # clave → trabajo
        self.queue: list[str] = []
        self.proc: subprocess.Popen | None = None
        self.worker = threading.Thread(target=self._loop, daemon=True, name="stems")
        self.wake = threading.Event()
        self.worker.start()

    # ------------------------------------------------------------ rutas y estado del motor

    @property
    def venv_python(self) -> Path:
        v = self.engine_dir / "venv"
        return v / ("Scripts/python.exe" if WIN else "bin/python")

    def engine_info(self) -> dict | None:
        try:
            info = json.loads((self.engine_dir / "engine.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if info.get("version") != ENGINE_VERSION:
            return None
        if not info.get("fake") and not self.venv_python.exists():
            return None
        return info

    def worker_cmd(self, *args: str) -> list[str]:
        script = str(self.app_dir / "stems_worker.py")
        if self.fake:
            return [sys.executable, script, "--fake", *args]
        return [str(self.venv_python), script, *args]

    def disk_usage(self) -> dict:
        def size(p: Path) -> int:
            if not p.exists():
                return 0
            return sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
        return {"engine": size(self.engine_dir), "songs": size(self.out_root),
                "count": sum(1 for d in self.out_root.glob("*/meta.json")) if self.out_root.exists() else 0}

    def status(self) -> dict:
        with self.lock:
            info = self.engine_info()
            return {
                "installed": bool(info), "engine": info, "install": dict(self.install_job) if self.install_job else None,
                "jobs": [self._public_job(k) for k in self.jobs], "queue": list(self.queue), "usage": self.disk_usage(),
                "model": MODEL,
            }

    def busy(self) -> bool:
        """Instalando o separando: no conviene reiniciar RiPlay."""
        with self.lock:
            if self.install_job and self.install_job.get("stage") not in ("done", "error"):
                return True
            return bool(self.queue) or any(j.get("running") for j in self.jobs.values())

    # ------------------------------------------------------------ instalar el motor

    def start_install(self) -> dict:
        with self.lock:
            if self.engine_info():
                return self.status()
            if self.install_job and self.install_job.get("stage") not in ("done", "error"):
                return self.status()
            self.install_job = {"stage": "uv", "startedAt": time.time(), "error": None, "detail": ""}
        threading.Thread(target=self._install, daemon=True, name="stems-install").start()
        return self.status()

    def _set_install(self, **kw) -> None:
        with self.lock:
            if self.install_job is not None:
                self.install_job.update(kw)

    def _run(self, cmd: list[str], logf, env: dict | None = None, timeout: int = 3600) -> str:
        logf.write(f"\n$ {' '.join(cmd)}\n")
        logf.flush()
        flags = subprocess.CREATE_NO_WINDOW if WIN else 0
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                           errors="replace", env={**os.environ, **(env or {})}, timeout=timeout, creationflags=flags)
        logf.write(p.stdout or "")
        logf.flush()
        if p.returncode != 0:
            tail = "\n".join((p.stdout or "").strip().splitlines()[-6:])
            raise StemsError(f"Falló: {' '.join(cmd[:4])}…\n{tail}")
        return p.stdout or ""

    def _gpu(self) -> str | None:
        smi = shutil.which("nvidia-smi")
        if not smi or self.fake:
            return None
        try:
            out = subprocess.run([smi, "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True,
                                 timeout=15, creationflags=subprocess.CREATE_NO_WINDOW if WIN else 0).stdout.strip()
            return out.splitlines()[0].strip() if out else None
        except (OSError, subprocess.SubprocessError):
            return None

    def _install(self) -> None:
        self.engine_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.engine_dir / "install.log"
        started = time.time()
        try:
            with open(log_path, "a", encoding="utf-8") as logf:
                logf.write(f"\n===== Instalación {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")
                if self.fake:
                    for stage in INSTALL_STAGES:
                        self._set_install(stage=stage)
                        time.sleep(float(os.environ.get("RIPLAY_STEMS_FAKE_DELAY", "0.15")))
                    result = self._probe(logf)
                    gpu = None
                else:
                    uv_env = {"UV_PYTHON_INSTALL_DIR": str(self.engine_dir / "python"),
                              "UV_CACHE_DIR": str(self.engine_dir / "cache"), "UV_NO_PROGRESS": "1",
                              "UV_LINK_MODE": "copy"}
                    py = _console_python()
                    uv = [py, "-m", "uv"]
                    self._set_install(stage="uv", detail="Instalando el instalador (uv)")
                    self._run([py, "-m", "pip", "install", "--disable-pip-version-check", "-q", "--upgrade", "uv"], logf)
                    self._set_install(stage="python", detail=f"Bajando Python {PY_VERSION} solo para el motor")
                    if not self.venv_python.exists():
                        self._run(uv + ["venv", str(self.engine_dir / "venv"), "--python", PY_VERSION,
                                        "--python-preference", "only-managed"], logf, uv_env)
                    gpu = self._gpu()
                    index = "https://download.pytorch.org/whl/" + ("cu126" if gpu else "cpu")
                    self._set_install(stage="torch", gpu=gpu,
                                      detail=f"Bajando PyTorch para {'la placa ' + gpu if gpu else 'el procesador'} (es lo más pesado)")
                    try:
                        self._run(uv + ["pip", "install", "--python", str(self.venv_python), *TORCH_PINS,
                                        "--index-url", index], logf, uv_env, timeout=5400)
                    except StemsError:
                        if not gpu:
                            raise
                        logf.write("\nNo se pudo instalar la versión para placa de video: uso la del procesador\n")
                        gpu = None
                        self._run(uv + ["pip", "install", "--python", str(self.venv_python), *TORCH_PINS,
                                        "--index-url", "https://download.pytorch.org/whl/cpu"], logf, uv_env, timeout=5400)
                    self._set_install(stage="demucs", detail="Instalando Demucs")
                    self._run(uv + ["pip", "install", "--python", str(self.venv_python), *EXTRA_PKGS], logf, uv_env)
                    self._set_install(stage="model", detail="Bajando el modelo de separación")
                    self._run(self.worker_cmd("prefetch", MODEL), logf,
                              {"TORCH_HOME": str(self.engine_dir / "models")}, timeout=1800)
                    self._set_install(stage="check", detail="Revisando que todo funcione")
                    result = self._probe(logf)
                    shutil.rmtree(self.engine_dir / "cache", ignore_errors=True)  # lo bajado ya no hace falta
                info = {"version": ENGINE_VERSION, "fake": self.fake, "model": MODEL, "installedAt": time.time(),
                        "installSeconds": round(time.time() - started), "device": result.get("device", "cpu"),
                        "gpu": result.get("gpu") or gpu, "cpu": result.get("cpu"), "threads": result.get("threads"),
                        "torch": result.get("torch"), "python": result.get("python")}
                (self.engine_dir / "engine.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
            self.log.info("Motor de pistas instalado en %ds: %s", info["installSeconds"],
                          f"placa {info['gpu']}" if info["device"] == "cuda" else f"procesador {info['cpu']}")
            self._set_install(stage="done", detail="")
        except Exception as exc:  # noqa: BLE001
            self.log.error("No se pudo instalar el motor de pistas: %s", exc, exc_info=True)
            msg = str(exc)
            if "No space left" in msg or "Errno 28" in msg:
                msg = "No hay espacio suficiente en el disco (hacen falta unos 2 GB)."
            elif re.search(r"(?i)connect|resolve|timed? ?out|network|getaddrinfo", msg):
                msg = "No se pudo bajar: revisá la conexión a internet y probá de nuevo."
            self._set_install(stage="error", error=msg, log=str(log_path))

    def _probe(self, logf) -> dict:
        out = self._run(self.worker_cmd("info"), logf, timeout=300)
        return _result(out) or {}

    def uninstall(self) -> dict:
        with self.lock:
            if self.install_job and self.install_job.get("stage") not in ("done", "error"):
                raise StemsError("Se está instalando: esperá a que termine")
            self.install_job = None
        shutil.rmtree(self.engine_dir, ignore_errors=True)
        return self.status()

    # ------------------------------------------------------------ canciones

    def key(self, track: dict) -> str:
        if track.get("local"):
            return "local-" + hashlib.sha1(str(track["local"]).encode("utf-8")).hexdigest()[:12]
        vid = str(track.get("id") or "")
        if not re.fullmatch(r"[\w-]{6,20}", vid):
            raise StemsError("Esta canción no se puede separar")
        return vid

    def song_dir(self, key: str) -> Path:
        if not re.fullmatch(r"[\w-]{6,40}", key):
            raise StemsError("Clave inválida")
        return self.out_root / key

    def ready(self, key: str) -> dict | None:
        try:
            meta = json.loads((self.song_dir(key) / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        for s in meta.get("sources", []):
            if s.get("file") and not (self.song_dir(key) / s["file"]).exists():
                return None
        return meta

    def track_state(self, track: dict) -> dict:
        k = self.key(track)
        meta = self.ready(k)
        if meta:
            return {"key": k, "status": "ready", "meta": meta}
        with self.lock:
            job = self._public_job(k) if k in self.jobs else None
        return {"key": k, "status": job["stage"] if job else "none", "job": job}

    def enqueue(self, track: dict) -> dict:
        if not self.engine_info():
            raise StemsError("Primero hay que instalar el motor de separación")
        k = self.key(track)
        if self.ready(k):
            return self.track_state(track)
        with self.lock:
            job = self.jobs.get(k)
            if not job or job["stage"] in ("error", "canceled"):
                self.jobs[k] = {"key": k, "track": {f: track.get(f) for f in ("id", "local", "title", "artist", "duration")},
                                "stage": "queued", "progress": 0, "queuedAt": time.time(), "error": None}
                self.queue.append(k)
        self.wake.set()
        return self.track_state(track)

    def cancel(self, key: str) -> None:
        with self.lock:
            job = self.jobs.get(key)
            if not job:
                return
            if key in self.queue:
                self.queue.remove(key)
            job["stage"] = "canceled"
            if job.get("running") and self.proc and self.proc.poll() is None:
                self.proc.kill()

    def delete(self, key: str) -> None:
        self.cancel(key)
        with self.lock:
            self.jobs.pop(key, None)
        shutil.rmtree(self.song_dir(key), ignore_errors=True)

    def _public_job(self, k: str) -> dict:
        j = self.jobs[k]
        out = {x: j.get(x) for x in ("key", "stage", "progress", "error", "startedAt", "eta", "track")}
        out["position"] = self.queue.index(k) + 1 if k in self.queue else 0
        return out

    def _loop(self) -> None:
        while True:
            self.wake.wait()
            with self.lock:
                if not self.queue:
                    self.wake.clear()
                    continue
                k = self.queue.pop(0)
                job = self.jobs.get(k)
                if not job or job["stage"] == "canceled":
                    continue
                job.update(stage="downloading", startedAt=time.time(), running=True)
            try:
                self._process(job)
            except Exception as exc:  # noqa: BLE001
                with self.lock:
                    canceled = job["stage"] == "canceled"
                if not canceled:
                    self.log.error("Separar %s falló: %s", k, exc, exc_info=not isinstance(exc, StemsError))
                    with self.lock:
                        job.update(stage="error", error=str(exc) if isinstance(exc, StemsError)
                                   else "No se pudo separar esta canción. El detalle quedó en riplay.log.")
            finally:
                with self.lock:
                    job["running"] = False

    def _process(self, job: dict) -> None:
        k, track = job["key"], job["track"]
        dest = self.song_dir(k)
        work = dest.with_name(k + ".tmp")
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        try:
            src = self.local_path(track) if track.get("local") else None
            if src is None:
                src = self.fetch_audio(track, work, lambda p: job.update(progress=p))
            if job["stage"] == "canceled":
                return
            with self.lock:
                job.update(stage="separating", progress=0.01, sepStartedAt=time.time())
            flags = (subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS) if WIN else 0
            extra = {} if WIN else {"preexec_fn": lambda: os.nice(10)}
            info = self.engine_info() or {}
            env = {**os.environ, "TORCH_HOME": str(self.engine_dir / "models"), "PYTHONIOENCODING": "utf-8"}
            out_lines, err_lines = [], []
            proc = subprocess.Popen(
                self.worker_cmd("separate", str(src), str(work), MODEL, info.get("device", "cpu")),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                env=env, creationflags=flags, **extra)
            self.proc = proc
            threading.Thread(target=lambda: err_lines.extend(proc.stderr), daemon=True).start()
            for line in proc.stdout:
                out_lines.append(line)
                if line.startswith("PROGRESS "):
                    try:
                        p = float(line.split()[1])
                    except ValueError:
                        continue
                    with self.lock:
                        el = time.time() - job["sepStartedAt"]
                        job["progress"] = p
                        job["eta"] = round(el / p * (1 - p)) if p > 0.08 else None
            proc.wait()
            if job["stage"] == "canceled":
                return
            res = _result("".join(out_lines))
            if not res or not res.get("ok"):
                tail = "".join(err_lines[-15:])
                self.log.error("El separador falló con %s:\n%s", k, tail)
                raise StemsError(_friendly_worker_error((res or {}).get("error", ""), tail))
            meta = {**res, "key": k, "track": track, "createdAt": time.time(), "engine": ENGINE_VERSION,
                    "wall": round(time.time() - job["startedAt"], 1)}
            meta["sources"].sort(key=lambda s: SOURCES_ORDER.index(s["name"]) if s["name"] in SOURCES_ORDER else 99)
            for f in work.iterdir():
                if f.name.startswith("source") or f.suffix in (".part", ".ytdl"):
                    f.unlink(missing_ok=True)
            (work / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
            shutil.rmtree(dest, ignore_errors=True)
            work.rename(dest)
            t = meta["timings"]
            self.log.info("Pistas de %s listas: %.0f s de canción en %.0f s (%s, separar %.0f s)",
                          k, meta["duration"], meta["wall"], meta["device"], t["separate"])
            with self.lock:
                job.update(stage="done", progress=1, eta=0)
        finally:
            self.proc = None
            shutil.rmtree(work, ignore_errors=True)


def _result(text: str) -> dict | None:
    for line in reversed(text.splitlines()):
        if line.startswith("RESULT "):
            try:
                return json.loads(line[7:])
            except ValueError:
                return None
    return None


def _friendly_worker_error(err: str, tail: str) -> str:
    blob = f"{err}\n{tail}"
    if re.search(r"(?i)out of memory|CUDA error: out of memory|MemoryError|bad_alloc|DefaultCPUAllocator", blob):
        return "No alcanzó la memoria para separar esta canción. Cerrá otros programas y probá de nuevo."
    if re.search(r"(?i)No module named|ImportError|DLL load failed", blob):
        return "El motor de separación está incompleto. Reinstalalo desde el panel de pistas."
    if re.search(r"(?i)no tiene audio|Invalid data|could not open", blob):
        return "No se pudo leer el audio de esta canción."
    return "No se pudo separar esta canción. El detalle quedó en riplay.log."
