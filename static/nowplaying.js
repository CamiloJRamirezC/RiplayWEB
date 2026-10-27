"use strict";
/* Panel "Reproduciendo": portada grande o video (a elección) y letra sincronizada.
   Usa `audio`, `state`, `api`, `toast`, `el`, `icon`, `$`, `likeKey`, `fmt` y `store` de app.js.
   El sonido siempre sale del <audio> (con el ecualizador); el video va sin sonido y se sincroniza. */

const np = {
  open: false,
  showVideo: store.get("showVideo", false),
  trackKey: null,
  lyrics: null,        // respuesta del servidor
  lyricsKey: null,
  loading: false,
  error: null,
  current: -1,
  userScrollAt: 0,
  offsets: store.get("lyricsOffset", {}),
  cache: new Map(),
  syncTimer: null,
  videoFailed: new Set(),
};

const npTrack = () => state.queue[state.index] || null;
const npOffset = () => (np.lyricsKey && np.offsets[np.lyricsKey]) || 0;
// Qué video puede reproducir este navegador (Chrome/Edge: H.264; otros Chromium: VP9 o AV1)
const NP_CODEC = (() => {
  const v = document.createElement("video");
  if (v.canPlayType('video/mp4; codecs="avc1.4d401f"')) return "avc1";
  if (v.canPlayType('video/webm; codecs="vp9"')) return "vp9";
  if (v.canPlayType('video/mp4; codecs="av01.0.05M.08"')) return "av01";
  return null;
})();
const canVideo = (t) => !!(NP_CODEC && t && t.id && !t.local && /^[\w-]{11}$/.test(t.id));

/* ------------------------------------------------------------ armado */

function npBuild() {
  const panel = el("section", { id: "np-panel", class: "np-panel", role: "dialog", "aria-label": "Reproduciendo", hidden: true },
    el("header", { class: "np-head" },
      el("h2", { text: "Reproduciendo" }),
      el("label", { class: "switch", id: "np-video-switch", title: "Ver el video en lugar de la portada" },
        el("input", { type: "checkbox", id: "np-video-on", role: "switch", onchange: (e) => npSetVideo(e.target.checked) }),
        el("span", { class: "switch-track", "aria-hidden": "true" }),
        el("span", { text: "Ver video" })),
      el("button", { class: "icon-btn", "aria-label": "Cerrar", onclick: () => npToggle(false) }, icon("close"))),
    el("div", { class: "np-body" },
      el("div", { class: "np-art" },
        el("img", { id: "np-cover", class: "np-cover", alt: "", referrerpolicy: "no-referrer" }),
        el("video", { id: "np-video", class: "np-video", muted: true, playsinline: true, preload: "auto", hidden: true }),
        el("p", { id: "np-art-note", class: "np-note", hidden: true }),
        el("div", { class: "np-meta" },
          el("div", { id: "np-title", class: "np-title" }),
          el("div", { id: "np-artist", class: "np-artist" }))),
      el("div", { class: "np-lyrics" },
        el("div", { class: "np-lyrics-head" },
          el("h3", { text: "Letra" }),
          el("span", { id: "np-source", class: "np-source" }),
          el("div", { id: "np-offset", class: "np-offset", hidden: true },
            el("button", { class: "text-btn", title: "La letra va adelantada", onclick: () => npShift(-0.5) }, "−0,5 s"),
            el("span", { id: "np-offset-val" }),
            el("button", { class: "text-btn", title: "La letra va atrasada", onclick: () => npShift(0.5) }, "+0,5 s"))),
        el("div", { id: "np-lines", class: "np-lines", tabindex: "0" }))));
  document.body.append(panel);
  const lines = $("#np-lines");
  ["wheel", "touchmove", "keydown"].forEach((ev) => lines.addEventListener(ev, () => { np.userScrollAt = Date.now(); }, { passive: true }));
  const video = $("#np-video");
  video.muted = true;
  video.addEventListener("error", () => {
    const t = npTrack();
    if (t && video.getAttribute("src")) {
      np.videoFailed.add(t.id);
      npRenderArt();
    }
  });
  video.addEventListener("loadeddata", () => npSyncVideo(true));
}

/* ------------------------------------------------------------ abrir / cerrar */

function npToggle(force) {
  np.open = force != null ? force : !np.open;
  const panel = $("#np-panel");
  panel.hidden = !np.open;
  $("#btn-np").setAttribute("aria-expanded", String(np.open));
  $("#btn-np").classList.toggle("on", np.open);
  if (np.open) {
    npUpdate();
    $("#np-lines").focus({ preventScroll: true });
  } else {
    npStopVideo();
    $("#btn-np").focus({ preventScroll: true });
  }
}

function npSetVideo(on) {
  np.showVideo = on;
  store.set("showVideo", on);
  npRenderArt();
}

/* ------------------------------------------------------------ portada / video */

function npStopVideo() {
  const video = $("#np-video");
  clearInterval(np.syncTimer);
  np.syncTimer = null;
  if (video.getAttribute("src")) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

function npRenderArt() {
  const t = npTrack();
  const cover = $("#np-cover"), video = $("#np-video"), note = $("#np-art-note");
  const sw = $("#np-video-switch");
  $("#np-title").textContent = t ? t.title || "Sin título" : "Nada sonando";
  $("#np-artist").textContent = t ? [t.artist, t.album].filter(Boolean).join(" — ") : "";
  sw.hidden = !canVideo(t);
  $("#np-video-on").checked = np.showVideo;
  const wantVideo = np.open && np.showVideo && canVideo(t) && !np.videoFailed.has(t.id);
  note.hidden = true;
  if (wantVideo) {
    const src = "/api/video/" + encodeURIComponent(t.id) + "?codec=" + NP_CODEC;
    if (video.getAttribute("src") !== src) { video.setAttribute("src", src); video.load(); }
    video.hidden = false;
    cover.hidden = true;
    if (!np.syncTimer) np.syncTimer = setInterval(() => npSyncVideo(false), 500);
    return;
  }
  npStopVideo();
  video.hidden = true;
  const big = t && t.thumb ? t.thumb.replace(/=w\d+-h\d+/, "=w720-h720").replace("/mqdefault.jpg", "/hqdefault.jpg") : "";
  cover.hidden = !big;
  if (big && cover.getAttribute("src") !== big) cover.setAttribute("src", big);
  if (np.showVideo && t && np.videoFailed.has(t.id)) {
    note.hidden = false;
    note.textContent = "Este tema no tiene video disponible: se muestra la portada.";
  }
}

// El video va sin sonido: sigue al audio (play, pausa, posición y velocidad)
function npSyncVideo(force) {
  const video = $("#np-video");
  if (video.hidden || !video.getAttribute("src") || video.readyState < 1) return;
  video.playbackRate = audio.playbackRate;
  const drift = Math.abs(video.currentTime - audio.currentTime);
  if (force || drift > 0.3) {
    try { video.currentTime = audio.currentTime; } catch { /* todavía sin datos */ }
  }
  if (audio.paused && !video.paused) video.pause();
  if (!audio.paused && video.paused) video.play().catch(() => {});
}
["play", "pause", "seeked", "ratechange"].forEach((ev) => audio.addEventListener(ev, () => npSyncVideo(ev === "seeked")));

/* ------------------------------------------------------------ letra */

async function npLoadLyrics(t) {
  const k = likeKey(t);
  np.lyricsKey = k;
  np.current = -1;
  if (np.cache.has(k)) { np.lyrics = np.cache.get(k); np.loading = false; np.error = null; return npRenderLyrics(); }
  np.lyrics = null;
  np.loading = true;
  np.error = null;
  npRenderLyrics();
  const params = new URLSearchParams({ id: t.id || "", title: t.title || "", artist: t.artist || "", album: t.album || "", duration: String(t.duration || 0) });
  try {
    const data = await api("lyrics?" + params.toString(), { timeout: 45000 });
    np.cache.set(k, data);
    if (np.lyricsKey !== k) return;
    np.lyrics = data;
  } catch (err) {
    if (np.lyricsKey !== k) return;
    np.error = err.message;
  }
  np.loading = false;
  npRenderLyrics();
}

function npRenderLyrics() {
  const box = $("#np-lines");
  const L = np.lyrics;
  $("#np-offset").hidden = !(L && L.synced);
  $("#np-offset-val").textContent = npOffset() ? `${npOffset() > 0 ? "+" : "−"}${Math.abs(npOffset()).toString().replace(".", ",")} s` : "en hora";
  $("#np-source").textContent = L && L.source ? `Fuente: ${L.source}` : "";
  if (!npTrack()) return box.replaceChildren(el("p", { class: "np-empty", text: "Elegí una canción para ver su letra." }));
  if (np.loading) return box.replaceChildren(el("p", { class: "np-empty", text: "Buscando la letra…" }));
  if (np.error) return box.replaceChildren(el("p", { class: "np-empty", text: "No se pudo buscar la letra: " + np.error }));
  if (!L || !L.found) return box.replaceChildren(el("p", { class: "np-empty", text: "No encontramos la letra de esta canción." }));
  if (L.instrumental && !L.synced && !L.plain) return box.replaceChildren(el("p", { class: "np-empty", text: "Es instrumental: no tiene letra." }));
  if (L.synced) {
    box.replaceChildren(...L.synced.map(([time, text], i) => el("button", {
      class: "np-line" + (text ? "" : " np-gap"), "data-i": i, title: `Ir a ${fmt(time)}`,
      onclick: () => { audio.currentTime = Math.max(0, time - npOffset() + 0.05); np.userScrollAt = 0; if (audio.paused) audio.play().catch(() => {}); },
    }, text || "♪")));
    np.current = -1;
    npTick(true);
    return;
  }
  box.replaceChildren(el("p", { class: "np-note", text: "Esta letra no tiene tiempos: se muestra completa." }),
    ...L.plain.split("\n").map((line) => el("p", { class: "np-plain", text: line || " " })));
}

function npShift(delta) {
  if (!np.lyricsKey) return;
  const v = Math.round(((np.offsets[np.lyricsKey] || 0) + delta) * 10) / 10;
  if (v) np.offsets[np.lyricsKey] = v; else delete np.offsets[np.lyricsKey];
  store.set("lyricsOffset", np.offsets);
  npRenderLyrics();
}

function npTick(force = false) {
  const L = np.lyrics;
  if (!np.open || !L || !L.synced) return;
  const t = audio.currentTime + npOffset();
  let lo = 0, hi = L.synced.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (L.synced[mid][0] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  if (idx === np.current && !force) return;
  const box = $("#np-lines");
  const prev = box.querySelector(".np-line.current");
  if (prev) prev.classList.remove("current");
  box.querySelectorAll(".np-line.past").forEach((n) => { if (+n.dataset.i >= idx) n.classList.remove("past"); });
  np.current = idx;
  if (idx < 0) return;
  const line = box.querySelector(`.np-line[data-i="${idx}"]`);
  if (!line) return;
  line.classList.add("current");
  for (let i = Math.max(0, idx - 40); i < idx; i++) {
    const n = box.querySelector(`.np-line[data-i="${i}"]`);
    if (n) n.classList.add("past");
  }
  if (Date.now() - np.userScrollAt > 4000) {
    const top = line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ top, behavior: reduce || force ? "auto" : "smooth" });
  }
}
audio.addEventListener("timeupdate", () => npTick(false));
audio.addEventListener("seeked", () => npTick(true));

/* ------------------------------------------------------------ cambios de canción */

function npUpdate() {
  if (!np.open) return;
  const t = npTrack();
  const k = t ? likeKey(t) : null;
  npRenderArt();
  if (k !== np.trackKey) {
    np.trackKey = k;
    if (t) npLoadLyrics(t); else { np.lyrics = null; np.lyricsKey = null; npRenderLyrics(); }
  }
}
audio.addEventListener("loadstart", () => setTimeout(npUpdate, 0));

/* ------------------------------------------------------------ inicio */

npBuild();
$("#now-title").classList.add("now-open");
$("#btn-np").addEventListener("click", () => npToggle());
$("#now-cover").addEventListener("click", () => npToggle(true));
$("#now-title").addEventListener("click", () => { if (npTrack()) npToggle(true); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && np.open && !$("#pl-dialog").open && $("#menu").hidden) npToggle(false);
});
