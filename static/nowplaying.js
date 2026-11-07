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
  // traducción de la letra
  trOn: store.get("lyricsTranslate", false),
  trLang: store.get("lyricsLang", (navigator.language || "es").toLowerCase().startsWith("pt") ? "pt" : "es"),
  tr: null,            // { key, data, loading, error }
  trCache: new Map(),
  // pantalla completa
  fsLyrics: store.get("fsLyrics", true),
  fsIdleTimer: null,
  fsChangedAt: 0,
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
        el("div", { id: "np-stage", class: "np-stage", ondblclick: (e) => { if (!e.target.closest(".np-fs-ui")) npFullscreen(); } },
          el("img", { id: "np-cover", class: "np-cover", alt: "", referrerpolicy: "no-referrer" }),
          el("video", { id: "np-video", class: "np-video", muted: true, playsinline: true, preload: "auto", hidden: true }),
          el("button", { id: "np-fs", class: "np-fs-btn", title: "Pantalla completa (F)", "aria-label": "Ver en pantalla completa", onclick: () => npFullscreen() }, icon("expand")),
          npBuildFsUi()),
        el("p", { id: "np-art-note", class: "np-note", hidden: true }),
        el("div", { class: "np-meta" },
          el("div", { id: "np-title", class: "np-title" }),
          el("div", { id: "np-artist", class: "np-artist" }))),
      el("div", { class: "np-lyrics" },
        el("div", { class: "np-lyrics-head" },
          el("h3", { text: "Letra" }),
          el("span", { id: "np-source", class: "np-source" }),
          el("div", { id: "np-tr-ctrl", class: "np-tr-ctrl", hidden: true },
            el("button", { id: "np-tr-btn", class: "chip", "aria-pressed": "false", title: "Mostrar la traducción debajo de cada línea", onclick: () => npSetTranslate(!np.trOn) },
              icon("translate"), el("span", { text: "Traducir" })),
            el("select", { id: "np-tr-lang", class: "np-tr-lang", "aria-label": "Idioma de la traducción", onchange: (e) => npSetLang(e.target.value) },
              el("option", { value: np.trLang, text: np.trLang }))),
          el("div", { id: "np-offset", class: "np-offset", hidden: true },
            el("button", { class: "text-btn", title: "La letra va adelantada", onclick: () => npShift(-0.5) }, "−0,5 s"),
            el("span", { id: "np-offset-val" }),
            el("button", { class: "text-btn", title: "La letra va atrasada", onclick: () => npShift(0.5) }, "+0,5 s"))),
        el("p", { id: "np-tr-status", class: "np-tr-status", hidden: true }),
        el("div", { id: "np-lines", class: "np-lines", tabindex: "0" }))));
  document.body.append(panel);
  npLoadLanguages();
  const stage = $("#np-stage");
  stage.addEventListener("mousemove", npFsWake);
  stage.addEventListener("touchstart", npFsWake, { passive: true });
  document.addEventListener("fullscreenchange", npFsChanged);
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
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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
  const nice = t ? (typeof prettyTrack === "function" ? prettyTrack(t) : { title: t.title, artist: t.artist }) : null;
  $("#np-fs-title").textContent = nice ? nice.title || "Sin título" : "Nada sonando";
  $("#np-fs-artist").textContent = nice ? nice.artist || "" : "";
  $("#np-fs").hidden = !t;
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
  $("#np-stage").style.setProperty("--np-bg", big ? `url("${big.replace(/"/g, "%22")}")` : "none");
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
  if (np.cache.has(k)) {
    np.lyrics = np.cache.get(k); np.loading = false; np.error = null;
    npRenderLyrics(); npRenderTrControls();
    if (np.trOn) npLoadTranslation();
    return;
  }
  np.lyrics = null;
  np.loading = true;
  np.error = null;
  npRenderLyrics();
  npRenderTrControls();
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
  npRenderTrControls();
  if (np.trOn) npLoadTranslation();
}

function npRenderLyrics() {
  const box = $("#np-lines");
  const L = np.lyrics;
  npFsSubtitle();
  $("#np-offset").hidden = !(L && L.synced);
  $("#np-offset-val").textContent = npOffset() ? `${npOffset() > 0 ? "+" : "−"}${Math.abs(npOffset()).toString().replace(".", ",")} s` : "en hora";
  $("#np-source").textContent = L && L.source ? `Fuente: ${L.source}` : "";
  if (!npTrack()) return box.replaceChildren(el("p", { class: "np-empty", text: "Elegí una canción para ver su letra." }));
  if (np.loading) return box.replaceChildren(el("p", { class: "np-empty", text: "Buscando la letra…" }));
  if (np.error) return box.replaceChildren(el("p", { class: "np-empty", text: "No se pudo buscar la letra: " + np.error }));
  if (!L || !L.found) return box.replaceChildren(el("p", { class: "np-empty", text: "No encontramos la letra de esta canción." }));
  if (L.instrumental && !L.synced && !L.plain) return box.replaceChildren(el("p", { class: "np-empty", text: "Es instrumental: no tiene letra." }));
  const tr = npTrLines();
  if (L.synced) {
    box.replaceChildren(...L.synced.map(([time, text], i) => el("button", {
      class: "np-line" + (text ? "" : " np-gap"), "data-i": i, title: `Ir a ${fmt(time)}`,
      onclick: () => { audio.currentTime = Math.max(0, time - npOffset() + 0.05); np.userScrollAt = 0; if (audio.paused) audio.play().catch(() => {}); },
    }, el("span", { class: "np-orig", text: text || "♪" }), npTrSpan(text, tr && tr[i]))));
    np.current = -1;
    npTick(true);
    return;
  }
  box.replaceChildren(el("p", { class: "np-note", text: "Esta letra no tiene tiempos: se muestra completa." }),
    ...L.plain.split("\n").map((line, i) => el("p", { class: "np-plain" }, el("span", { class: "np-orig", text: line || " " }), npTrSpan(line, tr && tr[i]))));
  npFsSubtitle();
}

/* ------------------------------------------------------------ traducción */

const npNorm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

// La traducción de una línea, solo si dice algo distinto al original
function npTrSpan(orig, tr) {
  if (!tr || npNorm(tr) === npNorm(orig)) return null;
  return el("span", { class: "np-tr", lang: np.trLang, text: tr });
}

function npTrLines() {
  const T = np.tr;
  if (!np.trOn || !T || T.key !== npTrKey() || !T.data || T.data.same) return null;
  return T.data.lines;
}

const npTrKey = () => (np.lyricsKey ? np.lyricsKey + "|" + np.trLang : null);

async function npLoadLanguages() {
  const sel = $("#np-tr-lang");
  try {
    const langs = await api("lyrics/languages");
    sel.replaceChildren(...langs.map((l) => el("option", { value: l.code, text: l.name })));
    if (!langs.some((l) => l.code === np.trLang)) np.trLang = "es";
  } catch { sel.replaceChildren(el("option", { value: "es", text: "Español" })); np.trLang = "es"; }
  sel.value = np.trLang;
}

function npSetTranslate(on) {
  np.trOn = on;
  store.set("lyricsTranslate", on);
  npRenderTrControls();
  if (on) npLoadTranslation(); else npRenderLyrics();
}

function npSetLang(code) {
  np.trLang = code;
  store.set("lyricsLang", code);
  if (!np.trOn) return npSetTranslate(true);
  npLoadTranslation();
}

function npRenderTrControls() {
  const L = np.lyrics;
  const has = !!(L && L.found && (L.synced || L.plain));
  $("#np-tr-ctrl").hidden = !has;
  const b = $("#np-tr-btn");
  b.setAttribute("aria-pressed", String(np.trOn));
  b.classList.toggle("on", np.trOn);
  const st = $("#np-tr-status");
  const T = np.tr && np.tr.key === npTrKey() ? np.tr : null;
  let msg = "";
  if (has && np.trOn && T) {
    if (T.loading) msg = "Traduciendo la letra…";
    else if (T.error) msg = "No se pudo traducir: " + T.error;
    else if (T.data && T.data.same) msg = `La letra ya está en ${T.data.langName}.`;
  }
  st.textContent = msg;
  st.hidden = !msg;
  st.classList.toggle("error", !!(T && T.error));
}

async function npLoadTranslation() {
  const t = npTrack();
  const L = np.lyrics;
  const k = npTrKey();
  if (!np.trOn || !t || !k || !L || !L.found) return npRenderTrControls();
  if (np.trCache.has(k)) { np.tr = { key: k, data: np.trCache.get(k) }; npRenderTrControls(); return npRenderLyrics(); }
  np.tr = { key: k, loading: true };
  npRenderTrControls();
  const params = new URLSearchParams({ id: t.id || "", title: t.title || "", artist: t.artist || "", album: t.album || "",
    duration: String(t.duration || 0), lang: np.trLang });
  try {
    const data = await api("lyrics/translate?" + params.toString(), { timeout: 60000 });
    np.trCache.set(k, data);
    if (npTrKey() !== k) return;
    np.tr = { key: k, data };
  } catch (err) {
    if (npTrKey() !== k) return;
    np.tr = { key: k, error: err.message };
  }
  npRenderTrControls();
  npRenderLyrics();
}

/* ------------------------------------------------------------ pantalla completa */

function npBuildFsUi() {
  const press = (id) => (e) => { e.stopPropagation(); const b = $(id); if (b && !b.disabled && !b.hidden) b.click(); };
  return el("div", { class: "np-fs-ui", id: "np-fs-ui" },
    el("div", { class: "np-fs-top" },
      el("div", { class: "np-fs-meta" },
        el("div", { id: "np-fs-title", class: "np-fs-title" }),
        el("div", { id: "np-fs-artist", class: "np-fs-artist" })),
      el("button", { id: "np-fs-cc", class: "np-fs-icon", "aria-pressed": String(np.fsLyrics), title: "Mostrar la letra", "aria-label": "Mostrar la letra",
        onclick: (e) => { e.stopPropagation(); np.fsLyrics = !np.fsLyrics; store.set("fsLyrics", np.fsLyrics); npFsSubtitle(); } }, icon("lyrics")),
      el("button", { class: "np-fs-icon", title: "Salir de pantalla completa (Esc)", "aria-label": "Salir de pantalla completa",
        onclick: (e) => { e.stopPropagation(); npFullscreen(false); } }, icon("shrink"))),
    el("div", { id: "np-fs-sub", class: "np-fs-sub", "aria-live": "off" },
      el("div", { id: "np-fs-line", class: "np-fs-line" }),
      el("div", { id: "np-fs-tr", class: "np-fs-tr" })),
    el("div", { class: "np-fs-bottom" },
      el("div", { id: "np-fs-prog", class: "np-fs-prog", role: "slider", "aria-label": "Posición", tabindex: "0",
        onclick: (e) => {
          e.stopPropagation();
          const d = audio.duration; if (!d) return;
          const r = e.currentTarget.getBoundingClientRect();
          audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
        } }, el("i", { id: "np-fs-fill" })),
      el("div", { class: "np-fs-row" },
        el("span", { id: "np-fs-time", class: "np-fs-time" }),
        el("div", { class: "np-fs-ctrls" },
          el("button", { id: "np-fs-dislike", class: "np-fs-icon", onclick: press("#btn-dislike") }),
          el("button", { class: "np-fs-icon", title: "Anterior", "aria-label": "Anterior", onclick: press("#btn-prev") }, icon("prev")),
          el("button", { id: "np-fs-play", class: "np-fs-play", onclick: press("#btn-play") }),
          el("button", { class: "np-fs-icon", title: "Siguiente", "aria-label": "Siguiente", onclick: press("#btn-next") }, icon("next")),
          el("button", { id: "np-fs-like", class: "np-fs-icon", onclick: press("#btn-like") })),
        el("span", { class: "np-fs-time np-fs-spacer" }))));
}

const npIsFs = () => document.fullscreenElement === $("#np-stage");

async function npFullscreen(force) {
  const stage = $("#np-stage");
  const on = force != null ? force : !npIsFs();
  try {
    if (on && !npIsFs()) {
      if (stage.requestFullscreen) await stage.requestFullscreen({ navigationUI: "hide" });
      else if ($("#np-video").webkitEnterFullscreen && !$("#np-video").hidden) $("#np-video").webkitEnterFullscreen(); // iPhone
    } else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch (err) { toast("No se pudo pasar a pantalla completa: " + err.message); }
}

function npFsChanged() {
  np.fsChangedAt = Date.now();
  const fs = npIsFs();
  $("#np-fs").setAttribute("aria-label", fs ? "Salir de pantalla completa" : "Ver en pantalla completa");
  if (fs) { npFsControls(); npFsSubtitle(); npFsTime(); npFsWake(); }
  else { clearTimeout(np.fsIdleTimer); $("#np-stage").classList.remove("idle"); }
}

// Los controles se esconden a los 3 segundos sin mover el mouse
function npFsWake() {
  const stage = $("#np-stage");
  stage.classList.remove("idle");
  clearTimeout(np.fsIdleTimer);
  if (!npIsFs()) return;
  np.fsIdleTimer = setTimeout(() => { if (!audio.paused && !stage.querySelector(".np-fs-ui :focus-visible")) stage.classList.add("idle"); }, 3000);
}

function npFsControls() {
  if (!npIsFs()) return;
  const playing = !audio.paused;
  const play = $("#np-fs-play");
  play.replaceChildren(icon(playing ? "pause" : "play"));
  play.title = playing ? "Pausar" : "Reproducir";
  play.setAttribute("aria-label", play.title);
  for (const [id, src, on, off] of [["#np-fs-like", "#btn-like", "heart-fill", "heart"], ["#np-fs-dislike", "#btn-dislike", "dislike-fill", "dislike"]]) {
    const b = $(id), s = $(src);
    const pressed = s.getAttribute("aria-pressed") === "true";
    b.hidden = s.hidden;
    b.classList.toggle("on", pressed);
    b.setAttribute("aria-pressed", String(pressed));
    b.title = s.title;
    b.setAttribute("aria-label", s.getAttribute("aria-label") || s.title);
    b.replaceChildren(icon(pressed ? on : off));
  }
  if (!playing) npFsWake();
}

function npFsTime() {
  if (!npIsFs()) return;
  const d = audio.duration || (npTrack() || {}).duration || 0;
  const c = audio.currentTime || 0;
  $("#np-fs-fill").style.width = d ? `${Math.min(100, (c / d) * 100)}%` : "0";
  $("#np-fs-time").textContent = `${fmt(c)} / ${fmt(d)}`;
}

// La línea que suena (y su traducción) como subtítulo
function npFsSubtitle() {
  const sub = $("#np-fs-sub");
  if (!sub) return;
  const cc = $("#np-fs-cc");
  cc.setAttribute("aria-pressed", String(np.fsLyrics));
  cc.classList.toggle("on", np.fsLyrics);
  const L = np.lyrics;
  const idx = np.current;
  const line = L && L.synced && idx >= 0 ? L.synced[idx][1] : "";
  const tr = npTrLines();
  const trText = line && tr && tr[idx] && npNorm(tr[idx]) !== npNorm(line) ? tr[idx] : "";
  $("#np-fs-line").textContent = line;
  $("#np-fs-tr").textContent = trText;
  sub.hidden = !np.fsLyrics || !line;
}
["play", "pause"].forEach((ev) => audio.addEventListener(ev, npFsControls));
audio.addEventListener("timeupdate", npFsTime);
new MutationObserver(() => npFsControls()).observe($(".player .now"), { subtree: true, attributes: true, attributeFilter: ["aria-pressed", "hidden"] });

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
  npFsSubtitle();
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
  const ae = document.activeElement;
  const typing = /^(TEXTAREA|SELECT)$/.test(ae.tagName) || (ae.tagName === "INPUT" && !["checkbox", "radio", "range", "button"].includes(ae.type));
  if (e.key === "Escape" && np.open && !$("#pl-dialog").open && $("#menu").hidden
      && !document.fullscreenElement && Date.now() - np.fsChangedAt > 400) npToggle(false);
  if ((e.key === "f" || e.key === "F") && np.open && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && npTrack()) {
    e.preventDefault();
    npFullscreen();
  }
  if (npIsFs()) npFsWake();
});
