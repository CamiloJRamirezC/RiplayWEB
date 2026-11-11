"use strict";
/* Vigila la reproducción para que no se quede parada sola:
   - una pausa que nadie pidió (ni vos, ni las teclas multimedia/Windows) se retoma;
   - si la canción se traba más de 12 s, o "termina" antes de tiempo, o da error a mitad de camino,
     se vuelve a abrir desde el mismo segundo;
   - todo queda anotado en riplay.log ("Reproductor: …") para saber qué pasó. */

const wd = { asked: 0, why: "", resumes: [], waitTimer: null, recovering: false, recoverTimes: [] };

// Toda pausa pedida desde RiPlay pasa por acá (botón, barra espaciadora, mini reproductor, pantalla completa)
const wdNativePause = audio.pause.bind(audio);
audio.pause = function pause() {
  wd.asked = performance.now();
  if (!wd.why) wd.why = "app";
  return wdNativePause();
};
if ("mediaSession" in navigator) {
  // teclas multimedia, auriculares, controles de Windows: esa pausa es a propósito y no se retoma
  navigator.mediaSession.setActionHandler("pause", () => { wd.why = "sistema"; audio.pause(); });
}

function wdSnapshot() {
  const t = state.queue[state.index] || {};
  let ahead = 0;
  for (let i = 0; i < audio.buffered.length; i++) {
    if (audio.buffered.start(i) <= audio.currentTime + 0.2 && audio.buffered.end(i) >= audio.currentTime) ahead = audio.buffered.end(i) - audio.currentTime;
  }
  return {
    cancion: t.id || t.local || "", titulo: (t.title || "").slice(0, 40), pos: +audio.currentTime.toFixed(1),
    dur: +(Number.isFinite(audio.duration) ? audio.duration : t.duration || 0).toFixed(1), cargado: +ahead.toFixed(1),
    ready: audio.readyState, red: audio.networkState, error: audio.error ? audio.error.code : 0,
    visible: document.visibilityState, pistas: typeof stems !== "undefined" && !!(stems.cur && stems.cur.active),
    audio: typeof eq !== "undefined" && eq.ctx ? eq.ctx.state : "directo",
  };
}

function wdLog(event, extra = {}) {
  api("clientlog", { method: "POST", body: { event, detail: { ...wdSnapshot(), ...extra } } }).catch(() => {});
}

// Vuelve a abrir la misma canción desde el mismo segundo
function wdRecover(reason) {
  const t = state.queue[state.index];
  if (!t || wd.recovering) return false;
  const now = Date.now();
  wd.recoverTimes = wd.recoverTimes.filter((x) => now - x < 120000);
  if (wd.recoverTimes.length >= 4) { wdLog("sin-recuperar", { motivo: reason }); return false; } // no insistir en bucle
  wd.recoverTimes.push(now);
  const pos = audio.currentTime;
  const wasPlaying = !audio.paused || reason !== "pausa";
  wdLog("recupero", { motivo: reason });
  wd.recovering = true;
  const base = srcFor(t);
  const done = () => {
    audio.removeEventListener("loadedmetadata", done);
    try { audio.currentTime = pos; } catch { /* todavía sin datos */ }
    if (wasPlaying) audio.play().catch((err) => wdLog("no-retoma", { motivo: err.name }));
    setTimeout(() => { wd.recovering = false; }, 1500);
  };
  audio.addEventListener("loadedmetadata", done);
  audio.src = base + (base.includes("?") ? "&" : "?") + "retomar=" + now;
  setTimeout(() => { wd.recovering = false; }, 20000);
  return true;
}

// ¿"Terminó" antes de tiempo? (el navegador perdió la conexión y creyó que era el final)
function wdEndedEarly() {
  const d = audio.duration;
  if (!Number.isFinite(d) || d < 20 || audio.currentTime >= d - 3) return false;
  return wdRecover("terminó antes (" + Math.round(audio.currentTime) + " de " + Math.round(d) + " s)");
}

// Error a mitad de la canción: primero se intenta retomar; si no, sigue con la próxima
function wdOnError() {
  const code = audio.error ? audio.error.code : 0;
  if (audio.currentTime < 3 || ![2, 3].includes(code)) { wdLog("error", { codigo: code }); return false; }
  return wdRecover("error " + code);
}

audio.addEventListener("pause", () => {
  const asked = performance.now() - wd.asked < 800;
  const why = wd.why;
  wd.why = "";
  if (asked) { if (why === "sistema") wdLog("pausa-sistema"); return; }
  const src = audio.src;
  setTimeout(() => {
    if (!audio.paused || audio.src !== src || audio.ended || wd.recovering) return;
    if (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration - 1) return;
    wd.resumes = wd.resumes.filter((x) => Date.now() - x < 120000);
    if (wd.resumes.length >= 3) { wdLog("pausa-sola", { retomada: false }); return; } // si se repite mucho, no se pelea
    wd.resumes.push(Date.now());
    wdLog("pausa-sola", { retomada: true });
    audio.play().catch((err) => { wdLog("no-retoma", { motivo: err.name }); wdRecover("pausa"); });
  }, 300);
});

// Trabada: esperando datos más de 12 s sin avanzar
audio.addEventListener("waiting", () => {
  clearTimeout(wd.waitTimer);
  const pos = audio.currentTime;
  wd.waitTimer = setTimeout(() => {
    if (!audio.paused && audio.readyState < 3 && Math.abs(audio.currentTime - pos) < 0.5) wdRecover("trabada");
  }, 12000);
});
["playing", "pause", "emptied", "ended"].forEach((ev) => audio.addEventListener(ev, () => clearTimeout(wd.waitTimer)));
