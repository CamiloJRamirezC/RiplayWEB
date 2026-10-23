#!/usr/bin/env python3
"""
RiPlay Web Local
Servidor personal: busca en YouTube Music, reproduce, arma listas y descarga a una carpeta.
Escucha solo en 127.0.0.1 (tu propia compu).
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))
import spotify_import as spi  # noqa: E402
STATIC_DIR = APP_DIR / "static"
DATA_DIR = Path(os.environ.get("RIPLAY_DATA", Path.home() / "RiPlayWeb"))
HOST = "127.0.0.1"
PORT = int(os.environ.get("RIPLAY_PORT", "8765"))

AUDIO_EXT = {".m4a", ".mp3", ".webm", ".opus", ".ogg", ".flac", ".wav", ".aac"}
STREAM_CHUNK = 2 * 1024 * 1024  # YouTube limita la velocidad de peticiones grandes: se pide por bloques
AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio/best"

DATA_DIR.mkdir(parents=True, exist_ok=True)
_file_lock = threading.Lock()

LOG_FILE = DATA_DIR / "riplay.log"
log = logging.getLogger("riplay")
log.setLevel(logging.INFO)
try:
    _handler = RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(_handler)
except OSError:
    pass


# ---------------------------------------------------------------- persistencia


def _read_json(name: str, default):
    path = DATA_DIR / name
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write_json(name: str, value) -> None:
    path = DATA_DIR / name
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def get_config() -> dict:
    cfg = _read_json("config.json", {})
    cfg.setdefault("downloadDir", str(Path.home() / "Music" / "RiPlay"))
    return cfg


def download_dir() -> Path:
    path = Path(get_config()["downloadDir"]).expanduser()
    path.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------- dependencias


def _require(module: str):
    try:
        return __import__(module)
    except ImportError:
        raise RuntimeError(
            f"Falta la librería '{module}'. Instalala con: pip install -r requirements.txt"
        )


def library_status() -> dict:
    """Qué está instalado; se muestra en la página si falta algo."""
    out = {"python": sys.version.split()[0], "pythonOk": sys.version_info >= (3, 10)}
    for module, label in (("yt_dlp", "yt-dlp"), ("ytmusicapi", "ytmusicapi"), ("mutagen", "mutagen")):
        try:
            mod = __import__(module)
            version = getattr(mod, "__version__", None)
            if module == "yt_dlp":
                version = mod.version.__version__
            elif module == "mutagen":
                version = mod.version_string
            out[label] = version or "instalado"
        except Exception as exc:
            out[label] = None
            out[label + "Error"] = f"{exc.__class__.__name__}: {exc}"[:300]
    return out


_ytm = None
_ytm_lock = threading.Lock()
# Salud de YouTube Music: en algunas compus/regiones devuelve listas vacías.
_ytm_health = {"lang": "es", "tried_en": False, "empty_streak": 0, "skip_until": 0.0}


def _new_ytmusic(lang: str):
    _require("ytmusicapi")
    import requests
    from functools import partial
    from ytmusicapi import YTMusic

    session = requests.Session()
    session.request = partial(session.request, timeout=15)  # type: ignore[method-assign]
    return YTMusic(language=lang, requests_session=session)


def ytm_usable() -> bool:
    return time.time() >= _ytm_health["skip_until"]


def _ytm_record(results: list, query: str) -> None:
    with _ytm_lock:
        if results:
            _ytm_health["empty_streak"] = 0
            return
        _ytm_health["empty_streak"] += 1
        if _ytm_health["empty_streak"] >= 3 and ytm_usable():
            _ytm_health["skip_until"] = time.time() + 600
            log.warning("YouTube Music devuelve vacío seguido (último: %r): uso solo YouTube por 10 minutos", query)


def ytmusic():
    global _ytm
    with _ytm_lock:
        if _ytm is None:
            _ytm = _new_ytmusic(_ytm_health["lang"])
        return _ytm


def youtube_dl(opts: dict):
    _require("yt_dlp")
    import yt_dlp

    base = {"quiet": True, "no_warnings": True, "noplaylist": True, "noprogress": True}
    return yt_dlp.YoutubeDL({**base, **opts})


# ---------------------------------------------------------------- normalización


def _parse_duration(text) -> int:
    if not text or not isinstance(text, str):
        return 0
    seconds = 0
    for part in text.split(":"):
        if not part.isdigit():
            return 0
        seconds = seconds * 60 + int(part)
    return seconds


def _thumb(thumbs, size: int = 226):
    if not thumbs:
        return None
    url = thumbs[-1].get("url") if isinstance(thumbs, list) else None
    if not url:
        return None
    # Las portadas de YouTube Music aceptan el tamaño en la URL
    return re.sub(r"=w\d+-h\d+", f"=w{size}-h{size}", url)


def normalize(item: dict) -> dict | None:
    video_id = item.get("videoId")
    if not video_id:
        return None
    artists = ", ".join(a["name"] for a in item.get("artists") or [] if a.get("name"))
    album = item.get("album")
    album_name = album.get("name") if isinstance(album, dict) else ""
    duration = item.get("duration_seconds") or _parse_duration(
        item.get("duration") or item.get("length")
    )
    return {
        "id": video_id,
        "title": item.get("title") or "",
        "artist": artists,
        "album": album_name or "",
        "duration": int(duration or 0),
        "thumb": _thumb(item.get("thumbnails") or item.get("thumbnail")),
    }


def clean_track(track: dict) -> dict:
    """Solo los campos conocidos: lo que llega del navegador no se guarda tal cual."""
    out = {
        "id": str(track.get("id") or "")[:64],
        "title": str(track.get("title") or "")[:300],
        "artist": str(track.get("artist") or "")[:300],
        "album": str(track.get("album") or "")[:300],
        "duration": int(track.get("duration") or 0),
        "thumb": str(track.get("thumb") or "")[:1000] or None,
    }
    if track.get("local"):
        out["local"] = Path(str(track["local"])).name
    return out


# ---------------------------------------------------------------- búsqueda


def _search_ytmusic(query: str, kind: str) -> list[dict]:
    global _ytm
    if not ytm_usable():
        return []
    filt = "videos" if kind == "videos" else "songs"
    results = [t for t in (normalize(r) for r in ytmusic().search(query, filter=filt, limit=30)) if t]
    if not results and _ytm_health["lang"] == "es" and not _ytm_health["tried_en"]:
        # Puede ser un problema de idioma al interpretar la respuesta: se prueba una vez en inglés
        _ytm_health["tried_en"] = True
        en = _new_ytmusic("en")
        results = [t for t in (normalize(r) for r in en.search(query, filter=filt, limit=30)) if t]
        if results:
            log.info("YouTube Music funciona en inglés y no en español: cambio el idioma")
            with _ytm_lock:
                _ytm_health["lang"] = "en"
                _ytm = en
    _ytm_record(results, query)
    return results


def _flat_entry(entry: dict) -> dict | None:
    video_id = entry.get("id")
    if not video_id or not re.fullmatch(r"[\w-]{11}", str(video_id)):
        return None  # canales, listas, etc.
    return {
        "id": video_id,
        "title": entry.get("title") or "",
        "artist": entry.get("channel") or entry.get("uploader") or "",
        "album": "",
        "duration": int(entry.get("duration") or 0),
        "thumb": f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg",
    }


def _flat_list(url: str, limit: int = 30) -> list[dict]:
    with youtube_dl({"extract_flat": "in_playlist", "playlistend": limit, "noplaylist": False}) as ydl:
        info = ydl.extract_info(url, download=False)
    return [t for t in (_flat_entry(e) for e in info.get("entries") or [] if e) if t]


def _search_youtube(query: str, kind: str) -> list[dict]:
    """Respaldo: búsqueda normal de YouTube con yt-dlp (funciona aunque falle YouTube Music)."""
    text = query if kind == "videos" else f"{query} audio"
    return _flat_list(f"ytsearch25:{text}", 25)


def search(query: str, kind: str) -> list[dict]:
    global _ytm
    first_error = None
    try:
        results = _search_ytmusic(query, kind)
        if results:
            return results
        log.warning("YouTube Music no devolvió resultados para %r; uso búsqueda de YouTube", query)
    except Exception as exc:
        first_error = exc
        log.warning("Falló YouTube Music (%s); uso búsqueda de YouTube", exc, exc_info=True)
        with _ytm_lock:
            _ytm = None  # se vuelve a crear en el próximo intento
    try:
        return _search_youtube(query, kind)
    except Exception as exc:
        log.error("Falló también la búsqueda de YouTube: %s", exc, exc_info=True)
        raise first_error or exc


def suggestions(query: str) -> list[str]:
    try:
        return [s for s in ytmusic().get_search_suggestions(query) if isinstance(s, str)][:8]
    except Exception:
        return []


def radio(video_id: str) -> list[dict]:
    try:
        data = ytmusic().get_watch_playlist(videoId=video_id, limit=30)
        tracks = [normalize(t) for t in data.get("tracks") or []]
        tracks = [t for t in tracks if t and t["id"] != video_id]
        if tracks:
            return tracks
    except Exception as exc:
        log.warning("Radio de YouTube Music falló (%s); uso el mix de YouTube", exc)
    mix = _flat_list(f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}", 30)
    return [t for t in mix if t["id"] != video_id]


# ---------------------------------------------------------------- streaming


_streams: dict[str, dict] = {}
_streams_lock = threading.Lock()


def resolve_stream(video_id: str, force: bool = False) -> dict:
    with _streams_lock:
        cached = _streams.get(video_id)
        if cached and not force and cached["expires"] > time.time() + 120:
            return cached
    with youtube_dl({"format": AUDIO_FORMAT}) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    url = info["url"]
    query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    expires = int(query.get("expire", [0])[0] or 0) or int(time.time()) + 3 * 3600
    ext = info.get("ext") or "m4a"
    entry = {
        "url": url,
        "headers": dict(info.get("http_headers") or {}),
        "mime": "audio/mp4" if ext in ("m4a", "mp4") else f"audio/{ext}",
        "expires": expires,
    }
    with _streams_lock:
        _streams[video_id] = entry
    return entry


def _parse_range(header: str | None):
    """Devuelve (inicio, fin|None) o None si no hay Range."""
    if not header:
        return None
    match = re.match(r"bytes=(\d*)-(\d*)", header.strip())
    if not match:
        return None
    start = int(match.group(1)) if match.group(1) else 0
    end = int(match.group(2)) if match.group(2) else None
    return start, end


def _open_upstream(entry: dict, start: int, end: int):
    req = urllib.request.Request(
        entry["url"], headers={**entry["headers"], "Range": f"bytes={start}-{end}"}
    )
    return urllib.request.urlopen(req, timeout=25)


# ---------------------------------------------------------------- descargas


_downloads: dict[str, dict] = {}
_downloads_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=2)


def _safe_name(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" .")
    return name[:150] or "cancion"


def _unique_base(folder: Path, base: str) -> str:
    candidate, n = base, 2
    while any((folder / f"{candidate}{ext}").exists() for ext in AUDIO_EXT):
        candidate = f"{base} ({n})"
        n += 1
    return candidate


def _set_download(video_id: str, **fields) -> None:
    with _downloads_lock:
        _downloads.setdefault(video_id, {}).update(fields)


def _tag_file(path: Path, track: dict) -> None:
    """Escribe título, artista, álbum y portada en el archivo (solo .m4a/.mp3, requiere mutagen)."""
    try:
        import mutagen  # noqa: F401
    except ImportError:
        return
    cover = None
    if track.get("thumb"):
        try:
            url = re.sub(r"=w\d+-h\d+", "=w544-h544", track["thumb"])
            with urllib.request.urlopen(url, timeout=15) as resp:
                cover = resp.read()
        except Exception:
            cover = None
    try:
        if path.suffix == ".m4a":
            from mutagen.mp4 import MP4, MP4Cover

            audio = MP4(path)
            audio["\xa9nam"] = track["title"]
            if track["artist"]:
                audio["\xa9ART"] = track["artist"]
            if track["album"]:
                audio["\xa9alb"] = track["album"]
            if cover and cover[:3] == b"\xff\xd8\xff":
                audio["covr"] = [MP4Cover(cover, imageformat=MP4Cover.FORMAT_JPEG)]
            elif cover and cover[:4] == b"\x89PNG":
                audio["covr"] = [MP4Cover(cover, imageformat=MP4Cover.FORMAT_PNG)]
            audio.save()
        elif path.suffix == ".mp3":
            from mutagen.easyid3 import EasyID3

            audio = EasyID3(path)
            audio["title"] = track["title"]
            if track["artist"]:
                audio["artist"] = track["artist"]
            if track["album"]:
                audio["album"] = track["album"]
            audio.save()
    except Exception as exc:  # las etiquetas son un extra: no rompen la descarga
        print(f"[RiPlay] No se pudieron escribir etiquetas en {path.name}: {exc}")


def _run_download(track: dict) -> None:
    video_id = track["id"]
    try:
        folder = download_dir()
        label = f"{track['artist']} - {track['title']}" if track["artist"] else track["title"]
        base = _unique_base(folder, _safe_name(label or video_id))

        def hook(d):
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                done = d.get("downloaded_bytes") or 0
                _set_download(
                    video_id,
                    status="downloading",
                    progress=round(done / total, 3) if total else None,
                )

        _set_download(video_id, status="downloading", progress=0)
        opts = {
            "format": AUDIO_FORMAT,
            "outtmpl": str(folder / f"{base}.%(ext)s"),
            "progress_hooks": [hook],
            "retries": 5,
            "fragment_retries": 5,
            "http_chunk_size": 10 * 1024 * 1024,
        }
        with youtube_dl(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
            requested = (info.get("requested_downloads") or [{}])[0]
            path = Path(requested.get("filepath") or ydl.prepare_filename(info))

        _tag_file(path, track)
        with _file_lock:
            index = _read_json("downloads.json", {})
            index[path.name] = {**track, "savedAt": int(time.time())}
            _write_json("downloads.json", index)
        _set_download(video_id, status="done", progress=1, file=path.name)
    except Exception as exc:
        log.error("Descarga %s falló: %s", video_id, exc, exc_info=True)
        _set_download(video_id, status="error", error=_friendly_error(exc))


def start_download(track: dict) -> dict:
    video_id = track["id"]
    if not re.fullmatch(r"[\w-]{6,20}", video_id):
        raise ValueError("Identificador de canción inválido")
    with _downloads_lock:
        current = _downloads.get(video_id)
        if current and current.get("status") in ("queued", "downloading"):
            return current
    existing = _already_downloaded(video_id)
    if existing:
        _set_download(video_id, status="done", progress=1, file=existing, track=track)
        return _downloads[video_id]
    _set_download(video_id, status="queued", progress=0, track=track, error=None, file=None)
    _pool.submit(_run_download, track)
    return _downloads[video_id]


def _already_downloaded(video_id: str) -> str | None:
    index = _read_json("downloads.json", {})
    folder = download_dir()
    for name, meta in index.items():
        if meta.get("id") == video_id and (folder / name).exists():
            return name
    return None


def list_downloads() -> list[dict]:
    with _downloads_lock:
        return [{"id": k, **v} for k, v in _downloads.items()]


# ---------------------------------------------------------------- biblioteca local


def _guess_meta(path: Path) -> dict:
    meta = {"title": path.stem, "artist": "", "album": "", "duration": 0}
    if " - " in path.stem:
        meta["artist"], meta["title"] = path.stem.split(" - ", 1)
    try:
        import mutagen

        audio = mutagen.File(path, easy=True)
        if audio is not None:
            tags = audio.tags or {}
            for key in ("title", "artist", "album"):
                if tags.get(key):
                    meta[key] = tags[key][0]
            if getattr(audio, "info", None) and getattr(audio.info, "length", None):
                meta["duration"] = int(audio.info.length)
    except Exception:
        pass
    return meta


def list_local() -> list[dict]:
    folder = download_dir()
    index = _read_json("downloads.json", {})
    files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXT]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for path in files:
        meta = index.get(path.name) or _guess_meta(path)
        out.append(
            {
                "local": path.name,
                "id": meta.get("id") or "",
                "title": meta.get("title") or path.stem,
                "artist": meta.get("artist") or "",
                "album": meta.get("album") or "",
                "duration": int(meta.get("duration") or 0),
                "thumb": meta.get("thumb"),
                "size": path.stat().st_size,
            }
        )
    return out


def local_path(name: str) -> Path:
    folder = download_dir().resolve()
    path = (folder / Path(name).name).resolve()
    if path.parent != folder or not path.is_file():
        raise FileNotFoundError(name)
    return path


def open_folder(path: Path) -> None:
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


# ---------------------------------------------------------------- ecualizador

EQ_BANDS = 10
EQ_LIMIT = 12.0


def _clamp(value, low, high, default=0.0) -> float:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return default
    if value != value:  # NaN
        return default
    return round(max(low, min(high, value)), 1)


def _clean_gains(gains) -> list[float]:
    gains = list(gains or [])[:EQ_BANDS]
    gains += [0.0] * (EQ_BANDS - len(gains))
    return [_clamp(g, -EQ_LIMIT, EQ_LIMIT) for g in gains]


def _sanitize_eq(eq: dict) -> dict:
    """Solo valores válidos: lo que llega del navegador nunca se guarda tal cual."""
    eq = eq if isinstance(eq, dict) else {}
    custom, seen = [], set()
    for c in eq.get("custom") or []:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()[:40]
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        custom.append({"name": name, "gains": _clean_gains(c.get("gains")),
                       "preamp": _clamp(c.get("preamp"), -EQ_LIMIT, EQ_LIMIT)})
        if len(custom) >= 30:
            break
    return {
        "enabled": bool(eq.get("enabled", False)),
        "preset": str(eq.get("preset") or "flat")[:60],
        "gains": _clean_gains(eq.get("gains")),
        "preamp": _clamp(eq.get("preamp"), -EQ_LIMIT, EQ_LIMIT),
        "custom": custom,
    }


def load_eq() -> dict:
    return _sanitize_eq(_read_json("eq.json", {}))


def save_eq(body: dict) -> dict:
    if not isinstance(body, dict):
        raise ValueError("Configuración de ecualizador inválida")
    with _file_lock:
        current = load_eq()
        merged = {**current, **{k: body[k] for k in ("enabled", "preset", "gains", "preamp", "custom") if k in body}}
        clean = _sanitize_eq(merged)
        _write_json("eq.json", clean)
    return clean


# ---------------------------------------------------------------- listas


def load_playlists() -> list[dict]:
    return _read_json("playlists.json", [])


def save_playlists(playlists: list[dict]) -> None:
    _write_json("playlists.json", playlists)


def _find_playlist(playlists, pid):
    for p in playlists:
        if p["id"] == pid:
            return p
    raise KeyError("Lista no encontrada")


# ---------------------------------------------------------------- importar desde Spotify


_imports: dict[str, dict] = {}
_imports_lock = threading.Lock()
_import_pool = ThreadPoolExecutor(max_workers=4)
_thread_local = threading.local()


def _ytm_local():
    """Una instancia de YouTube Music por hilo: la importación busca en paralelo."""
    ytm = getattr(_thread_local, "ytm", None)
    if ytm is None or getattr(_thread_local, "lang", None) != _ytm_health["lang"]:
        ytm = _new_ytmusic(_ytm_health["lang"])
        _thread_local.ytm = ytm
        _thread_local.lang = _ytm_health["lang"]
    return ytm


def _ytm_searcher(kind: str):
    def run(query: str) -> list[dict]:
        if not ytm_usable():
            return []
        results = [t for t in (normalize(r) for r in _ytm_local().search(query, filter=kind, limit=8)) if t]
        _ytm_record(results, query)
        return results
    return run


def _yt_searcher(query: str) -> list[dict]:
    return _flat_list(f"ytsearch6:{query}", 6)


IMPORT_SEARCHERS = [_ytm_searcher("songs"), _ytm_searcher("videos"), _yt_searcher]


def _update_import(job_id: str, **fields) -> None:
    with _imports_lock:
        _imports[job_id].update(fields)


def _match_one(src: dict) -> dict | None:
    if "spotify" in src:  # enlace de canción suelta: primero se averigua qué es
        src = spi.read_track(src["spotify"])
    if not src.get("title"):
        return None
    cand, _score = spi.best_match(src, IMPORT_SEARCHERS)
    if not cand:
        return {"missing": {"title": src["title"], "artist": ", ".join(src.get("artists") or [])}}
    track = dict(cand)
    if src.get("album") and not track.get("album"):
        track["album"] = src["album"]
    return {"track": track}


def _run_import(job_id: str, parsed: dict, name: str | None) -> None:
    try:
        if parsed["type"] == "collection":
            _update_import(job_id, stage="reading")
            info = spi.read_collection(
                parsed["kind"], parsed["id"],
                on_page=lambda n, total: _update_import(job_id, readCount=n, total=total or n),
            )
            items, default_name, warning = info["tracks"], info["name"], info["warning"]
        else:
            items, default_name, warning = parsed["items"], parsed.get("name"), None
        name = (name or default_name or "Importada").strip()[:100]
        _update_import(job_id, stage="matching", total=len(items), done=0, name=name, warning=warning)

        results: list = [None] * len(items)
        missing: list[dict] = []
        done = 0
        futures = {_import_pool.submit(_match_one, src): i for i, src in enumerate(items)}
        from concurrent.futures import as_completed

        for fut in as_completed(futures):
            i = futures[fut]
            try:
                res = fut.result()
            except Exception as exc:
                log.warning("Importación: falló la canción %s: %s", items[i], exc)
                src = items[i]
                res = {"missing": {"title": src.get("title") or "Enlace de Spotify", "artist": ", ".join(src.get("artists") or [])}}
            if res and "track" in res:
                results[i] = res["track"]
            elif res and "missing" in res:
                missing.append({**res["missing"], "position": i})
            done += 1
            _update_import(job_id, done=done, found=sum(1 for r in results if r), missingCount=len(missing))

        tracks = [clean_track(t) for t in results if t]
        if not tracks:
            raise spi.ImportError_("No se encontró ninguna de las canciones en YouTube.")
        with _file_lock:
            playlists = load_playlists()
            pl = {"id": uuid.uuid4().hex[:10], "name": name, "tracks": tracks,
                  "created": int(time.time()), "source": "spotify"}
            playlists.append(pl)
            save_playlists(playlists)
        missing.sort(key=lambda m: m.pop("position"))
        _update_import(job_id, stage="done", playlistId=pl["id"], missing=missing, found=len(tracks))
        log.info("Importación %s: %d encontradas, %d sin encontrar", name, len(tracks), len(missing))
    except spi.ImportError_ as exc:
        _update_import(job_id, stage="error", error=str(exc))
    except Exception as exc:
        log.error("Importación falló: %s", exc, exc_info=True)
        _update_import(job_id, stage="error", error=_friendly_error(exc))


def start_import(body: dict) -> dict:
    parsed = spi.parse_input(str(body.get("text") or ""), str(body.get("csv") or ""))
    job_id = uuid.uuid4().hex[:10]
    with _imports_lock:
        _imports[job_id] = {"id": job_id, "stage": "queued", "done": 0, "total": 0, "found": 0, "missingCount": 0}
    threading.Thread(target=_run_import, args=(job_id, parsed, str(body.get("name") or "").strip() or None), daemon=True).start()
    return _imports[job_id]


# ---------------------------------------------------------------- errores


def _friendly_error(exc: Exception) -> str:
    text = str(exc)
    low = text.lower()
    if "sign in to confirm" in low or "not a bot" in low:
        return "YouTube pidió verificación anti-bot. Probá más tarde o actualizá yt-dlp."
    if "video unavailable" in low or "private video" in low:
        return "Este video no está disponible."
    network_hints = (
        "urlopen error", "getaddrinfo", "timed out", "max retries", "unable to connect",
        "connection", "unable to download api page", "name resolution", "proxy",
    )
    if any(h in low for h in network_hints):
        return "No se pudo conectar con YouTube. Revisá tu internet (o si un antivirus/proxy lo bloquea)."
    if "falta la librería" in low:
        return text
    return text.splitlines()[0][:300] if text else exc.__class__.__name__


# ---------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "RiPlayWeb/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silencio salvo errores
        pass

    # -- helpers
    def _json(self, value, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = 400) -> None:
        self._json({"error": message}, status)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        if length > 8_000_000:
            raise ValueError("Petición demasiado grande")
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def _same_origin(self) -> bool:
        """Bloquea peticiones de otras páginas web hacia tu servidor local."""
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        return origin in (f"http://{HOST}:{PORT}", f"http://localhost:{PORT}")

    def _route(self, method: str):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if method != "GET" and not self._same_origin():
                return self._error("Origen no permitido", 403)
            if path.startswith("/api/"):
                return self._api(method, path[5:], query)
            if method == "GET":
                return self._static(path)
            return self._error("No encontrado", 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except KeyError as exc:
            self._safe_error(str(exc).strip("'"), 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self._safe_error(str(exc), 400)
        except FileNotFoundError:
            self._safe_error("Archivo no encontrado", 404)
        except Exception as exc:
            print(f"[RiPlay] Error en {method} {path}: {exc}")
            log.error("Error en %s %s: %s", method, path, exc, exc_info=True)
            self._safe_error(_friendly_error(exc), 502)

    def _safe_error(self, msg, status):
        try:
            self._error(msg, status)
        except Exception:
            pass

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PATCH(self):
        self._route("PATCH")

    def do_DELETE(self):
        self._route("DELETE")

    # -- estáticos
    def _static(self, path: str) -> None:
        if path in ("", "/"):
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR.resolve() not in target.parents or not target.is_file():
            return self._error("No encontrado", 404)
        data = target.read_bytes()
        known = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }
        ctype = known.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # -- API
    def _api(self, method: str, path: str, query: dict) -> None:
        parts = [p for p in path.split("/") if p]
        q = lambda k, d="": (query.get(k) or [d])[0]

        if method == "GET" and parts == ["search"]:
            text = q("q").strip()
            if not text:
                return self._json([])
            return self._json(search(text, q("type", "songs")))
        if method == "GET" and parts == ["suggest"]:
            return self._json(suggestions(q("q").strip()) if q("q").strip() else [])
        if method == "GET" and len(parts) == 2 and parts[0] == "radio":
            return self._json(radio(parts[1]))
        if method == "GET" and len(parts) == 2 and parts[0] == "stream":
            return self._stream(parts[1])

        if parts == ["downloads"]:
            if method == "GET":
                return self._json(list_downloads())
            if method == "POST":
                track = clean_track(self._body().get("track") or {})
                return self._json(start_download(track))

        if len(parts) == 2 and parts[0] == "downloads" and method == "DELETE":
            with _downloads_lock:
                current = _downloads.get(parts[1])
                if current and current.get("status") in ("queued", "downloading"):
                    raise ValueError("No se puede descartar una descarga en curso")
                _downloads.pop(parts[1], None)
            return self._json({"ok": True})

        if parts == ["local"] and method == "GET":
            return self._json(list_local())
        if len(parts) == 2 and parts[0] == "local" and method == "GET":
            return self._serve_file(local_path(parts[1]))

        if parts == ["eq"]:
            if method == "GET":
                return self._json(load_eq())
            if method == "POST":
                return self._json(save_eq(self._body()))

        if parts == ["status"] and method == "GET":
            return self._json({**library_status(), "log": str(LOG_FILE)})

        if parts == ["config"]:
            if method == "GET":
                return self._json({**get_config(), "dataDir": str(DATA_DIR)})
            if method == "POST":
                body = self._body()
                new_dir = str(body.get("downloadDir") or "").strip()
                if not new_dir:
                    raise ValueError("Indicá una carpeta")
                Path(new_dir).expanduser().mkdir(parents=True, exist_ok=True)
                cfg = get_config()
                cfg["downloadDir"] = str(Path(new_dir).expanduser())
                _write_json("config.json", cfg)
                return self._json(cfg)
        if parts == ["open-folder"] and method == "POST":
            open_folder(download_dir())
            return self._json({"ok": True})

        if parts == ["import"] and method == "POST":
            try:
                return self._json(start_import(self._body()))
            except spi.ImportError_ as exc:
                return self._error(str(exc), 400)
        if len(parts) == 2 and parts[0] == "import" and method == "GET":
            with _imports_lock:
                job = _imports.get(parts[1])
                if not job:
                    raise KeyError("Importación no encontrada")
                return self._json(dict(job))

        if parts and parts[0] == "playlists":
            return self._playlists(method, parts[1:])

        return self._error("No encontrado", 404)

    def _playlists(self, method: str, rest: list[str]) -> None:
        with _file_lock:
            playlists = load_playlists()
            if not rest and method == "GET":
                return self._json(playlists)
            if not rest and method == "POST":
                name = str(self._body().get("name") or "").strip()[:100]
                if not name:
                    raise ValueError("La lista necesita un nombre")
                pl = {"id": uuid.uuid4().hex[:10], "name": name, "tracks": [], "created": int(time.time())}
                playlists.append(pl)
                save_playlists(playlists)
                return self._json(pl, 201)

            pl = _find_playlist(playlists, rest[0])
            if len(rest) == 1:
                if method == "GET":
                    return self._json(pl)
                if method == "PATCH":
                    body = self._body()
                    if "name" in body:
                        name = str(body["name"]).strip()[:100]
                        if not name:
                            raise ValueError("La lista necesita un nombre")
                        pl["name"] = name
                    if "order" in body:  # nueva posición de las canciones
                        order = [int(i) for i in body["order"]]
                        if sorted(order) != list(range(len(pl["tracks"]))):
                            raise ValueError("Orden inválido")
                        pl["tracks"] = [pl["tracks"][i] for i in order]
                    save_playlists(playlists)
                    return self._json(pl)
                if method == "DELETE":
                    playlists.remove(pl)
                    save_playlists(playlists)
                    return self._json({"ok": True})

            if len(rest) == 2 and rest[1] == "tracks" and method == "POST":
                track = clean_track(self._body().get("track") or {})
                pl["tracks"].append(track)
                save_playlists(playlists)
                return self._json(pl)
            if len(rest) == 3 and rest[1] == "tracks" and method == "DELETE":
                index = int(rest[2])
                if not 0 <= index < len(pl["tracks"]):
                    raise ValueError("Posición inválida")
                pl["tracks"].pop(index)
                save_playlists(playlists)
                return self._json(pl)
        return self._error("No encontrado", 404)

    # -- audio
    def _stream(self, video_id: str) -> None:
        if not re.fullmatch(r"[\w-]{6,20}", video_id):
            return self._error("Identificador inválido")
        rng = _parse_range(self.headers.get("Range"))
        start = rng[0] if rng else 0
        wanted_end = rng[1] if rng else None

        for attempt in range(2):
            entry = resolve_stream(video_id, force=attempt > 0)
            end = start + STREAM_CHUNK - 1
            if wanted_end is not None:
                end = min(end, wanted_end)
            try:
                upstream = _open_upstream(entry, start, end)
            except urllib.error.HTTPError as exc:
                if exc.code == 416:
                    self.send_response(416)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if exc.code in (403, 410) and attempt == 0:
                    continue  # el enlace venció: se resuelve de nuevo
                raise
            with upstream:
                content_range = upstream.headers.get("Content-Range")
                total = int(content_range.rsplit("/", 1)[1]) if content_range and "/" in content_range else None
                if rng is None and total:
                    # Sin Range (p. ej. abrir el enlace directo): se manda todo el archivo por bloques
                    self.send_response(200)
                    self.send_header("Content-Type", entry["mime"])
                    self.send_header("Content-Length", str(total))
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()
                    self._pipe(upstream)
                    pos = end + 1
                    while pos < total:
                        with _open_upstream(entry, pos, min(pos + STREAM_CHUNK - 1, total - 1)) as nxt:
                            self._pipe(nxt)
                        pos += STREAM_CHUNK
                    return
                length = upstream.headers.get("Content-Length")
                self.send_response(206 if content_range else 200)
                self.send_header("Content-Type", entry["mime"])
                self.send_header("Accept-Ranges", "bytes")
                if content_range:
                    self.send_header("Content-Range", content_range)
                if length:
                    self.send_header("Content-Length", length)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self._pipe(upstream)
                return
        self._error("No se pudo abrir el audio", 502)

    def _pipe(self, source) -> None:
        while True:
            chunk = source.read(64 * 1024)
            if not chunk:
                break
            self.wfile.write(chunk)

    def _serve_file(self, path: Path) -> None:
        size = path.stat().st_size
        ctype = {".m4a": "audio/mp4", ".webm": "audio/webm", ".opus": "audio/ogg"}.get(
            path.suffix.lower()
        ) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        rng = _parse_range(self.headers.get("Range"))
        if rng:
            start, end = rng
            end = size - 1 if end is None else min(end, size - 1)
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            start, end = 0, size - 1
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = fh.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


EXIT_ALREADY_RUNNING = 3
EXIT_PORT_BUSY = 2


def _is_riplay(url: str) -> bool:
    try:
        req = urllib.request.Request(url + "/api/status")
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=3) as resp:
            return resp.status == 200 and "yt-dlp" in json.loads(resp.read().decode("utf-8"))
    except Exception:
        return False


def open_browser(url: str) -> None:
    """Abre el navegador predeterminado del sistema."""
    try:
        if sys.platform.startswith("win"):
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            webbrowser.open(url)
    except Exception as exc:
        print(f"No pude abrir el navegador ({exc}). Abrí a mano: {url}")


def _open_when_ready(url: str) -> None:
    """Espera a que el servicio responda de verdad y recién ahí abre el navegador."""
    for _ in range(100):  # hasta ~20 segundos
        if _is_riplay(url):
            print("Servicio listo. Abriendo el navegador...")
            open_browser(url)
            return
        time.sleep(0.2)
    print(f"El servicio tarda en responder. Abrí a mano: {url}")


def main() -> None:
    url = f"http://{HOST}:{PORT}"
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        if _is_riplay(url):
            print("RiPlay ya estaba abierto. Abro el navegador.")
            if "--no-browser" not in sys.argv:
                open_browser(url)
            sys.exit(EXIT_ALREADY_RUNNING)
        print(f"El puerto {PORT} está ocupado por otro programa.")
        print("Cerralo, o usá otro puerto: set RIPLAY_PORT=8800 y abrí de nuevo iniciar.bat")
        sys.exit(EXIT_PORT_BUSY)
    server.daemon_threads = True
    status = library_status()
    log.info("Inicio. Python %s, yt-dlp %s, ytmusicapi %s, mutagen %s",
             status["python"], status["yt-dlp"], status["ytmusicapi"], status["mutagen"])
    missing = [k for k in ("yt-dlp", "ytmusicapi") if not status[k]]
    if missing:
        print("")
        print("ATENCION: faltan librerías: " + ", ".join(missing) + ". La búsqueda no va a funcionar.")
        for k in missing:
            print(f"  {k}: {status.get(k + 'Error')}")
        print("")
    print(f"RiPlay Web está corriendo en {url}")
    print(f"Descargas: {download_dir()}")
    print("Cerrá esta ventana (o Ctrl+C) para detenerlo.")
    if "--no-browser" not in sys.argv:
        threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
