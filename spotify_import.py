"""
Lectura de listas de Spotify sin cuenta de desarrollador, y comparación con resultados de YouTube.

Fuentes que entiende:
  - Enlace de playlist o álbum de Spotify (open.spotify.com/... o spotify:playlist:...)
  - Enlaces de canciones de Spotify, uno por línea (lo que copia Spotify con Ctrl+A, Ctrl+C)
  - Texto "Artista - Canción", una por línea
  - CSV exportado con Exportify u otras herramientas (columnas de nombre y artista)

Spotify no ofrece esto oficialmente: se lee la página pública "embed" y, para listas largas,
la misma API interna que usa esa página con su token anónimo. Si Spotify cambia algo,
la parte que deja de andar es la paginación (se avisa y se importan las que se pudieron leer).
"""
from __future__ import annotations

import csv
import io
import json
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
URL_RE = re.compile(
    r"(?:https?://)?(?:open|play)\.spotify\.com/(?:intl-[a-z-]+/)?(?:embed/)?"
    r"(playlist|album|track)/([A-Za-z0-9]{22})"
)
URI_RE = re.compile(r"spotify:(playlist|album|track):([A-Za-z0-9]{22})")
SHORT_RE = re.compile(r"https?://spotify\.link/[A-Za-z0-9]+")
NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)

PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v1/query"
FETCH_PLAYLIST_HASH = "a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4"
MAX_TRACKS = 2000


class ImportError_(Exception):
    """Error con un mensaje listo para mostrar."""


# ------------------------------------------------------------------ red


def http_get(url: str, headers: dict | None = None, timeout: int = 20) -> tuple[str, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "es,en;q=0.8", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace"), resp.geturl()


def _next_data(kind: str, sid: str) -> dict:
    try:
        html, _ = http_get(f"https://open.spotify.com/embed/{kind}/{sid}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ImportError_("Spotify dice que ese enlace no existe. Revisá que esté completo.")
        raise
    match = NEXT_DATA_RE.search(html)
    if not match:
        raise ImportError_("Spotify cambió su página y no se pudo leer la lista. Probá con el archivo CSV de Exportify.")
    return json.loads(match.group(1))


def _entity(data: dict) -> dict:
    props = data.get("props", {}).get("pageProps", {})
    if "status" in props or "forbiddenReason" in props:
        raise ImportError_(
            "Spotify no deja ver esa lista. Si es tuya, en Spotify abrí sus opciones y elegí "
            "“Hacer pública” (o “Agregar al perfil”), y probá de nuevo."
        )
    entity = props.get("state", {}).get("data", {}).get("entity")
    if not isinstance(entity, dict):
        raise ImportError_("No se encontró la lista en la página de Spotify.")
    return entity


def _token(data: dict) -> str | None:
    session = data.get("props", {}).get("pageProps", {}).get("state", {}).get("settings", {}).get("session", {})
    token = session.get("accessToken")
    return token if isinstance(token, str) and token else None


def _split_artists(text) -> list[str]:
    if not isinstance(text, str):
        return []
    return [a.strip("  ") for a in text.split(",") if a.strip("  ")]


def _embed_tracks(entity: dict) -> list[dict]:
    out = []
    for row in entity.get("trackList") or []:
        if not isinstance(row, dict) or row.get("entityType") not in (None, "track"):
            continue
        title = row.get("title") or row.get("name")
        if not title:
            continue
        out.append({
            "title": title,
            "artists": _split_artists(row.get("subtitle")),
            "album": "",
            "duration": int((row.get("duration") or 0) / 1000),
        })
    return out


def _pathfinder_playlist(sid: str, token: str, on_page=None) -> tuple[list[dict], int | None]:
    tracks: list[dict] = []
    offset, total = 0, None
    while offset < MAX_TRACKS:
        variables = {"uri": f"spotify:playlist:{sid}", "offset": offset, "limit": 100, "enableWatchFeedEntrypoint": False}
        params = urllib.parse.urlencode({
            "operationName": "fetchPlaylist",
            "variables": json.dumps(variables, separators=(",", ":")),
            "extensions": json.dumps({"persistedQuery": {"version": 1, "sha256Hash": FETCH_PLAYLIST_HASH}}, separators=(",", ":")),
        })
        body, _ = http_get(f"{PATHFINDER_URL}?{params}", {"Authorization": f"Bearer {token}", "app-platform": "WebPlayer", "Accept": "application/json"})
        data = json.loads(body)
        if data.get("errors"):
            raise RuntimeError(str(data["errors"])[:200])
        content = ((data.get("data") or {}).get("playlistV2") or {}).get("content") or {}
        items = content.get("items") or []
        if total is None and isinstance(content.get("totalCount"), int):
            total = content["totalCount"]
        for item in items:
            node = ((item or {}).get("itemV2") or {}).get("data") or {}
            if node.get("__typename") != "Track" or not node.get("name"):
                continue
            artists = [
                (a.get("profile") or {}).get("name", "")
                for a in (node.get("artists") or {}).get("items") or []
            ]
            tracks.append({
                "title": node["name"],
                "artists": [a for a in artists if a],
                "album": (node.get("albumOfTrack") or {}).get("name") or "",
                "duration": int(((node.get("trackDuration") or {}).get("totalMilliseconds") or 0) / 1000),
            })
        if on_page:
            on_page(len(tracks), total)
        if not items:
            break
        offset += len(items)
        if total is not None and offset >= total:
            break
    return tracks, total


def read_collection(kind: str, sid: str, on_page=None) -> dict:
    """Playlist o álbum: {'name', 'tracks', 'warning'}."""
    data = _next_data(kind, sid)
    entity = _entity(data)
    name = entity.get("name") or entity.get("title") or "Importada de Spotify"
    embed_tracks = _embed_tracks(entity)
    warning = None
    tracks = embed_tracks
    if kind == "playlist":
        token = _token(data)
        try:
            if not token:
                raise RuntimeError("sin token")
            full, total = _pathfinder_playlist(sid, token, on_page)
            if full and len(full) >= len(embed_tracks):
                tracks = full
                if total and len(full) < total:
                    warning = f"Spotify entregó {len(full)} de {total} canciones (algunas no están disponibles en tu país)."
        except Exception as exc:  # la paginación es lo frágil: se sigue con lo que trae la página
            if len(embed_tracks) >= 100:
                warning = (
                    f"Solo se pudieron leer las primeras {len(embed_tracks)} canciones ({exc.__class__.__name__}). "
                    "Para la lista completa usá el archivo CSV de Exportify."
                )
    if not tracks:
        raise ImportError_("La lista de Spotify está vacía.")
    return {"name": name, "tracks": tracks[:MAX_TRACKS], "warning": warning}


def read_track(sid: str) -> dict:
    entity = _entity(_next_data("track", sid))
    artists = entity.get("artists") or []
    names = [a.get("name") for a in artists if isinstance(a, dict) and a.get("name")] or _split_artists(entity.get("subtitle"))
    return {
        "title": entity.get("title") or entity.get("name") or "",
        "artists": names,
        "album": "",
        "duration": int((entity.get("duration") or 0) / 1000),
    }


# ------------------------------------------------------------------ entrada


def _resolve_short(url: str) -> str:
    try:
        _, final = http_get(url)
        return final
    except Exception:
        return url


def parse_input(text: str = "", csv_text: str = "") -> dict:
    """
    Devuelve una de:
      {'type': 'collection', 'kind': 'playlist'|'album', 'id': ...}
      {'type': 'items', 'items': [ {'spotify': id} | {'title','artists','album','duration'} ], 'name': str|None}
    """
    if csv_text and csv_text.strip():
        return {"type": "items", "items": parse_csv(csv_text), "name": None}

    text = (text or "").strip()
    if not text:
        raise ImportError_("Pegá un enlace de Spotify o una lista de canciones.")

    for short in SHORT_RE.findall(text):
        text = text.replace(short, _resolve_short(short))

    lines = [l.strip() for l in text.splitlines() if l.strip()]
    found = [m for l in lines for m in (URL_RE.findall(l) or URI_RE.findall(l))]
    collections = [(k, i) for k, i in found if k in ("playlist", "album")]
    if collections:
        kind, sid = collections[0]
        return {"type": "collection", "kind": kind, "id": sid}

    items = []
    for line in lines:
        m = URL_RE.search(line) or URI_RE.search(line)
        if m:
            items.append({"spotify": m.group(2)})
            continue
        line = re.sub(r"^\s*(\d+[.)-]\s+|[-*•]\s+)", "", line)  # numeración o viñetas
        if " - " in line:
            artist, title = line.split(" - ", 1)
        elif " – " in line:
            artist, title = line.split(" – ", 1)
        else:
            artist, title = "", line
        items.append({"title": title.strip(), "artists": _split_artists(artist), "album": "", "duration": 0})
    if not items:
        raise ImportError_("No encontré canciones en el texto.")
    return {"type": "items", "items": items[:MAX_TRACKS], "name": None}


def parse_csv(csv_text: str) -> list[dict]:
    text = csv_text.lstrip("﻿")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    if len(rows) < 2:
        raise ImportError_("El archivo CSV no tiene canciones.")
    header = [h.strip().lower() for h in rows[0]]

    def col(*names, avoid=()):
        for name in names:
            for i, h in enumerate(header):
                if name in h and not any(a in h for a in avoid):
                    return i
        return None

    title_i = col("track name", "track title", "song", "title", "track", "name", "canción", "cancion", "título", "titulo", avoid=("artist", "album", "playlist", "uri", "id"))
    artist_i = col("artist", "artista", avoid=("uri", "id", "genre"))
    album_i = col("album name", "album", "álbum", avoid=("artist", "uri", "id", "image", "date", "type"))
    dur_i = col("duration (ms)", "duration_ms", "duration", "duración", "duracion")
    if title_i is None:
        raise ImportError_("No encontré la columna con el nombre de la canción en el CSV.")

    items = []
    for row in rows[1:]:
        if len(row) <= title_i or not row[title_i].strip():
            continue
        get = lambda i: row[i].strip() if i is not None and i < len(row) else ""
        duration = 0
        raw = get(dur_i)
        if raw:
            if ":" in raw:
                parts = [int(p) for p in raw.split(":") if p.isdigit()]
                for p in parts:
                    duration = duration * 60 + p
            else:
                try:
                    value = float(raw)
                    duration = int(value / 1000) if value > 10000 else int(value)
                except ValueError:
                    duration = 0
        items.append({
            "title": get(title_i),
            "artists": _split_artists(get(artist_i)),
            "album": get(album_i),
            "duration": duration,
        })
    if not items:
        raise ImportError_("El archivo CSV no tiene canciones.")
    return items[:MAX_TRACKS]


# ------------------------------------------------------------------ comparación


_NOISE = re.compile(
    r"\b(official|oficial|video|videoclip|audio|lyrics?|letra|visualizer|hd|hq|4k|remaster(ed)?|"
    r"\d{4} remaster(ed)?|explicit|clean|mv|m/v)\b"
)


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    text = text.replace("&", " and ").replace(" y ", " and ")
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_title(title: str) -> str:
    """Quita '(feat. X)', '- Remastered 2011', '[Live]' para comparar y buscar."""
    t = re.sub(r"\s*[\(\[][^\)\]]*(feat|ft\.|with|remaster|version|versión|edit|mono|stereo|deluxe|bonus)[^\)\]]*[\)\]]", "", title, flags=re.I)
    t = re.sub(r"\s+-\s+.*(remaster|version|versión|edit|mono|stereo|live|en vivo|mix).*$", "", t, flags=re.I)
    return t.strip() or title


def _tokens(text: str) -> set[str]:
    return set(_NOISE.sub(" ", norm(text)).split())


def score(src: dict, cand: dict) -> float:
    s_title = clean_title(src["title"])
    a, b = norm(s_title), norm(cand.get("title", ""))
    title_tokens, cand_tokens = _tokens(s_title), _tokens(cand.get("title", "")) | _tokens(cand.get("artist", ""))
    contain = len(title_tokens & cand_tokens) / len(title_tokens) if title_tokens else 0
    title_sim = max(SequenceMatcher(None, a, norm(clean_title(cand.get("title", "")))).ratio(), contain)

    artists = [x for x in src.get("artists") or [] if x]
    if artists:
        hay = norm(cand.get("artist", "") + " " + cand.get("title", ""))
        hits = [1.0 if norm(x) and norm(x) in hay else SequenceMatcher(None, norm(x), norm(cand.get("artist", ""))).ratio() for x in artists]
        artist_sim = max(hits)
    else:
        artist_sim = 0.6

    d1, d2 = src.get("duration") or 0, cand.get("duration") or 0
    if not d1 or not d2:
        dur = 0.5
    else:
        diff = abs(d1 - d2)
        dur = 1.0 if diff <= 3 else 0.75 if diff <= 10 else 0.35 if diff <= 30 else 0.0

    # Penaliza versiones que el original no pide (en vivo, karaoke, cover…)
    penalty = 0.0
    for word in ("live", "en vivo", "karaoke", "cover", "remix", "instrumental", "8d", "sped up", "slowed", "nightcore"):
        if word in b and word not in norm(src["title"]):
            penalty += 0.15
    return 0.5 * title_sim + 0.3 * artist_sim + 0.2 * dur - penalty


THRESHOLD = 0.62


def query_for(src: dict) -> str:
    artist = (src.get("artists") or [""])[0]
    return f"{artist} {clean_title(src['title'])}".strip()


def best_match(src: dict, searchers) -> tuple[dict | None, float]:
    """searchers: funciones query->lista de candidatos, de la más confiable a la menos."""
    best, best_score = None, 0.0
    query = query_for(src)
    for search in searchers:
        try:
            candidates = search(query)
        except Exception:
            continue
        for cand in candidates[:6]:
            s = score(src, cand)
            if s > best_score:
                best, best_score = cand, s
        if best_score >= 0.8:
            break
    return (best, best_score) if best_score >= THRESHOLD else (None, best_score)
