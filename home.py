"""
Inicio: lo que se arma solo con tus datos (historial, Favoritos y listas), sin internet.

Muchas canciones vienen de la búsqueda de YouTube, donde el "artista" es el canal que subió el
video (un sello, un usuario cualquiera). Por eso el artista se deduce primero del título
("Korn - Freak on a Leash") y recién después del canal, descartando los que son sellos o usuarios.
La confirmación final (que exista en YouTube Music) la hace server.py.
"""
from __future__ import annotations

import re
import time
import unicodedata
from collections import Counter, defaultdict

DAY = 86400

# Canales que son sellos, recopilaciones o usuarios: no sirven como artista
_LABELISH = re.compile(
    r"\b(records?|recordings|rec\.?|entertainment|productions?|producciones|studios?|label|media|"
    r"lyrics?|letras?|karaoke|covers?|compilations?|playlists?|mix(es)?|channel|canal|tv|radio|"
    r"fan(s|page)?|archives?|nation|official\s+videos?|music\s+(group|brasil|brazil|latino|world)|"
    r"\d+\s+more)\b|\band\s+\d+\s+more\b|\bby\b",
    re.I,
)
_TITLE_SEP = re.compile(r"\s+[-–—|~]\s+|\s*[–—]\s*|(?<=[^\W\d_])-\s+|\s{2,}")
_FEAT = re.compile(r"\s*(,|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bvs\.?\b|\bcon\b|\bwith\b)\s+", re.I)
_GENERIC_TAIL = {"metal", "official", "oficial", "vevo", "music", "musica", "topic", "band", "banda"}
_JUNK = re.compile(r"[\(\[].*?[\)\]]")


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def artist_key(name: str) -> str:
    """Clave para agrupar: 'KoRn' = 'Korn', 'Avatar Metal' = 'AVATAR', 'KornVEVO' = 'Korn'."""
    words = norm(re.sub(r"(?i)vevo$", "", str(name or "").strip())).split()
    while len(words) > 1 and words[-1] in _GENERIC_TAIL:
        words.pop()
    if words and words[0] == "the" and len(words) > 1:
        words = words[1:]
    return " ".join(words)


def _first_artist(text: str) -> str:
    return _FEAT.split(text.strip(), 1)[0].strip(" -–—\"'“”")


def clean_channel(name: str) -> str | None:
    name = re.sub(r"\s*-\s*Topic$", "", str(name or "").strip())
    name = re.sub(r"(?i)\s*(official|oficial)$", "", re.sub(r"(?i)vevo$", "", name)).strip()
    if not name or _LABELISH.search(name):
        return None
    if " " not in name and len(re.findall(r"\d", name)) >= 2:  # "PredictableClown71", "arturos6969"
        return None
    return name


def artist_from_title(title: str) -> str | None:
    title = _JUNK.sub("", str(title or "")).strip()
    parts = _TITLE_SEP.split(title, 1)
    if len(parts) != 2 or not parts[1].strip():
        return None
    cand = _first_artist(parts[0])
    if not (1 <= len(cand) <= 40) or norm(cand) in ("", "official", "lyrics", "video"):
        return None
    return cand


def track_artist(t: dict) -> tuple[str, str | None] | None:
    """(nombre, id de artista o None) de una canción, o None si no se puede saber."""
    if t.get("artistId") and t.get("artist"):
        return _first_artist(t["artist"]), t["artistId"]
    name = artist_from_title(t.get("title")) or clean_channel(_first_artist(t.get("artist") or ""))
    return (name, None) if name else None


def track_key(t: dict) -> str:
    return t.get("id") or ("local:" + t["local"] if t.get("local") else "")


def _history_weight(age: float) -> float:
    return 1.0 if age < 30 * DAY else 0.5 if age < 120 * DAY else 0.25


def artist_candidates(history: list[dict], favorites: list[dict], playlists: list[list[dict]],
                      disliked: set[str], now: float | None = None) -> list[dict]:
    """Artistas ordenados por cuánto los escuchás, con tus canciones de cada uno (semillas)."""
    now = now or time.time()
    score: Counter = Counter()
    plays: Counter = Counter()
    names: dict[str, Counter] = defaultdict(Counter)
    ids: dict[str, Counter] = defaultdict(Counter)
    seed_score: dict[str, Counter] = defaultdict(Counter)
    tracks: dict[str, dict] = {}

    def add(t: dict, weight: float, play: bool = False):
        got = track_artist(t)
        k = track_key(t)
        if not got or not k:
            return
        name, aid = got
        key = artist_key(name)
        if not key:
            return
        score[key] += weight
        names[key][name] += 1
        if aid:
            ids[key][aid] += 1
        if play:
            plays[key] += 1
        if k not in disliked and t.get("id"):
            seed_score[key][k] += weight
            tracks.setdefault(k, t)

    for e in history:
        add(e["track"], _history_weight(now - e.get("at", now)), play=True)
    for t in favorites:
        add(t, 3.0)
    for pl in playlists:
        for t in pl:
            add(t, 0.4)

    out = []
    for key, s in score.most_common():
        seeds = [tracks[k] for k, _ in seed_score[key].most_common(3)]
        out.append({
            "key": key,
            # el nombre más usado, prefiriendo el que no está todo en mayúsculas
            "name": max(names[key].items(), key=lambda kv: (kv[1], not kv[0].isupper()))[0],
            "artistId": ids[key].most_common(1)[0][0] if ids[key] else None,
            "score": round(s, 2), "plays": plays[key], "seeds": seeds,
        })
    return out


def names_match(candidate: str, found: str) -> bool:
    """¿El artista que devolvió YouTube Music es el que buscábamos?"""
    a, b = artist_key(candidate), artist_key(found)
    return bool(a) and a == b


def recent_tracks(history: list[dict], limit: int = 12) -> list[dict]:
    seen, out = set(), []
    for e in reversed(history):
        k = track_key(e["track"])
        if k and k not in seen:
            seen.add(k)
            out.append(e["track"])
            if len(out) >= limit:
                break
    return out


def top_tracks(history: list[dict], days: int = 30, limit: int = 10, now: float | None = None) -> list[dict]:
    now = now or time.time()
    for window in (days, None):
        counts: Counter = Counter()
        last: dict[str, dict] = {}
        for e in history:
            if window and now - e.get("at", 0) > window * DAY:
                continue
            k = track_key(e["track"])
            if k:
                counts[k] += 1
                last[k] = e["track"]
        top = [{"track": last[k], "plays": n} for k, n in counts.most_common(limit) if n >= 2]
        if len(top) >= 3 or window is None:
            return top
    return []


def week_stats(history: list[dict], now: float | None = None) -> dict:
    now = now or time.time()
    week = [e for e in history if now - e.get("at", 0) <= 7 * DAY]
    seconds = sum(min(int(e["track"].get("duration") or 0), 900) for e in week)
    return {"plays": len(week), "seconds": seconds,
            "artists": len({artist_key(a[0]) for a in (track_artist(e["track"]) for e in week) if a})}


def interleave(lists: list[list[dict]], limit: int, skip: set[str] | None = None) -> list[dict]:
    """Mezcla varias listas tomando una de cada una por turno, sin repetir canciones."""
    seen = set(skip or ())
    titles = set()
    out = []
    iters = [iter(lst) for lst in lists if lst]
    while iters and len(out) < limit:
        for it in list(iters):
            for t in it:
                k = track_key(t)
                title = norm(_JUNK.sub("", t.get("title") or ""))
                if not k or k in seen or (title and title in titles):
                    continue
                seen.add(k)
                if title:
                    titles.add(title)
                out.append(t)
                break
            else:
                iters.remove(it)
            if len(out) >= limit:
                break
    return out


def mix_subtitle(tracks: list[dict], main: str) -> str:
    main_key = artist_key(main)
    counts: Counter = Counter()
    shown: dict[str, str] = {}
    for t in tracks:
        got = track_artist(t)
        if not got:
            continue
        k = artist_key(got[0])
        if k and k != main_key:
            counts[k] += 1
            shown.setdefault(k, got[0])
    others = [shown[k] for k, _ in counts.most_common(3)]
    if not others:
        return f"Lo mejor de {main}"
    if len(others) == 1:
        return f"{main} y {others[0]}"
    return f"{main}, {', '.join(others[:-1])} y {others[-1]}"
