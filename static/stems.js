"use strict";
/* Separar pistas bajo demanda: casilla "Separar pistas" (por canción) en el panel de video y letra.
   Normalmente suena el audio de siempre. Si la casilla está marcada para una canción, se separa (una vez)
   y suena una mezcla de sus pistas (voz, batería, bajo, guitarra, piano, otros) con volumen por pista.
   El reproductor principal sigue mandando: las pistas se sincronizan con él (play, pausa, adelantar). */

const STEM_NAMES = { vocals: "Voz", drums: "Batería", bass: "Bajo", guitar: "Guitarra", piano: "Piano", other: "Otros" };
const STEM_PRESETS = [
  { id: "all", name: "Todo", keep: () => true },
  { id: "karaoke", name: "Karaoke (sin voz)", keep: (n) => n !== "vocals" },
  { id: "vocals", name: "Solo voz", keep: (n) => n === "vocals" },
  { id: "noguitar", name: "Sin guitarra", keep: (n) => n !== "guitar" },
  { id: "nodrums", name: "Sin batería", keep: (n) => n !== "drums" },
  { id: "nobass", name: "Sin bajo", keep: (n) => n !== "bass" },
];
const INSTALL_STEPS = [
  ["uv", "Preparar el instalador"],
  ["python", "Bajar un Python propio para el motor"],
  ["torch", "Bajar PyTorch (lo más pesado)"],
  ["demucs", "Instalar Demucs"],
  ["model", "Bajar el modelo de separación"],
  ["check", "Revisar que todo funcione"],
];

const stems = {
  songs: store.get("stemsSongs", {}),   // canción → casilla marcada
  mixes: store.get("stemsMix", {}),     // canción → { pista: { v, m, s } }
  status: null,                          // /api/stems
  cur: null,                             // { tkey, key, state, buffers: Map, loading, error, active }
  graph: null,                           // { ctx, input, mainGain }
  master: null,
  gains: new Map(),
  sources: [],
  startCtx: 0, startPos: 0, rate: 1,
  poll: null,
  driftTimer: null,
};

const stemsTrack = () => state.queue[state.index] || null;
const stemsCanSplit = (t) => !!(t && (t.local || (t.id && /^[\w-]{11}$/.test(t.id))));
const stemsOnFor = (t) => !!(t && stems.songs[key(t)]);

function stemsFmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}
const stemsFmtMB = (b) => b >= 1e9 ? `${(b / 1e9).toFixed(1).replace(".", ",")} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;

/* ------------------------------------------------------------ armado (dentro del panel) */

function stemsBuild() {
  const sw = el("label", { class: "switch", id: "np-stems-switch", title: "Separar esta canción en pistas (voz, batería, bajo, guitarra…)" },
    el("input", { type: "checkbox", id: "np-stems-on", role: "switch", onchange: (e) => stemsSetSong(e.target.checked) }),
    el("span", { class: "switch-track", "aria-hidden": "true" }),
    el("span", { text: "Separar pistas" }));
  $("#np-video-switch").before(sw);
  $("#np-panel .np-meta").after(el("section", { id: "np-stems", class: "np-stems", hidden: true, "aria-live": "polite" }));
}

/* ------------------------------------------------------------ casilla por canción */

function stemsSetSong(on) {
  const t = stemsTrack();
  if (!t) return;
  const k = key(t);
  if (on) stems.songs[k] = true; else delete stems.songs[k];
  store.set("stemsSongs", stems.songs);
  if (on) stemsActivate(t, true);
  else stemsDeactivate();
  stemsRender();
}

/* ------------------------------------------------------------ servidor */

async function stemsRefreshStatus() {
  try { stems.status = await api("stems"); } catch (err) { stems.status = { error: err.message }; }
  return stems.status;
}

async function stemsActivate(t, userAction) {
  stemsDeactivate();
  const tkey = key(t);
  stems.cur = { tkey, key: null, state: null, buffers: new Map(), loading: false, error: null, active: false };
  if (userAction) stemsGraph(); // el toque en la casilla permite arrancar el audio de la página
  stemsRender();
  await stemsRefreshStatus();
  if (!stems.cur || stems.cur.tkey !== tkey) return;
  if (stems.status.installed) await stemsCheckTrack(t, true);
  stemsRender();
  stemsSchedulePoll();
}

async function stemsCheckTrack(t, enqueue) {
  const c = stems.cur;
  if (!c || c.tkey !== key(t)) return;
  const qs = new URLSearchParams(t.local ? { local: t.local } : { id: t.id });
  try {
    c.state = await api("stems/track?" + qs.toString());
    c.key = c.state.key;
    if (enqueue && ["none", "error", "canceled"].includes(c.state.status) && !c.state.error) {
      c.state = await api("stems/separate", { method: "POST", body: { track: t } });
    }
  } catch (err) { c.error = err.message; }
  if (stems.cur === c && c.state && c.state.status === "ready" && !c.active && !c.loading) stemsLoadBuffers(c);
}

function stemsSchedulePoll() {
  clearTimeout(stems.poll);
  const c = stems.cur;
  const installing = stems.status && stems.status.install && !["done", "error"].includes(stems.status.install.stage);
  const working = c && c.state && ["queued", "downloading", "separating"].includes(c.state.status);
  if (!installing && !working) return;
  stems.poll = setTimeout(async () => {
    const t = stemsTrack();
    if (!c || stems.cur !== c || !t || key(t) !== c.tkey) return;
    if (installing) {
      await stemsRefreshStatus();
      if (stems.status.installed) await stemsCheckTrack(t, true);
    } else await stemsCheckTrack(t, false);
    stemsRender();
    stemsSchedulePoll();
  }, installing ? 1500 : 1000);
}

async function stemsInstall() {
  try { stems.status = await api("stems/install", { method: "POST", body: {} }); }
  catch (err) { toast(err.message); }
  stemsRender();
  stemsSchedulePoll();
}

async function stemsRetry() {
  const t = stemsTrack();
  if (!t || !stems.cur) return;
  stems.cur.error = null;
  try { stems.cur.state = await api("stems/separate", { method: "POST", body: { track: t } }); }
  catch (err) { stems.cur.error = err.message; }
  stemsRender();
  stemsSchedulePoll();
}

async function stemsCancel() {
  const c = stems.cur;
  if (!c || !c.key) return;
  try { await api("stems/cancel/" + encodeURIComponent(c.key), { method: "POST", body: {} }); } catch { /* ya terminó */ }
  stemsSetSong(false);
  $("#np-stems-on").checked = false;
}

async function stemsDelete() {
  const c = stems.cur;
  if (!c || !c.key) return;
  if (!confirm("¿Borrar las pistas separadas de esta canción? Se pueden volver a separar cuando quieras.")) return;
  try { await api("stems/" + encodeURIComponent(c.key), { method: "DELETE" }); } catch (err) { return toast(err.message); }
  stemsSetSong(false);
  $("#np-stems-on").checked = false;
  toast("Pistas borradas");
}

/* ------------------------------------------------------------ audio */

function stemsGraph() {
  if (stems.graph) { eqResume(); return stems.graph; }
  const g = eqAudioGraph();
  if (!g) return null;
  stems.graph = g;
  stems.master = g.ctx.createGain();
  stems.master.connect(g.input);
  stemsVolume();
  return g;
}

function stemsVolume() {
  if (!stems.master) return;
  stems.master.gain.setTargetAtTime(audio.muted ? 0 : audio.volume, stems.graph.ctx.currentTime, 0.02);
}

async function stemsLoadBuffers(c) {
  const g = stemsGraph();
  if (!g) { c.error = "Este navegador no permite mezclar pistas."; return stemsRender(); }
  c.loading = true;
  stemsRender();
  const meta = c.state.meta;
  try {
    for (const s of meta.sources) {
      if (!s.file) continue;
      const r = await fetch(`/api/stems/file/${encodeURIComponent(c.key)}/${encodeURIComponent(s.file)}`);
      if (!r.ok) throw new Error("No se pudo leer la pista " + (STEM_NAMES[s.name] || s.name));
      let buf;
      try { buf = await g.ctx.decodeAudioData(await r.arrayBuffer()); }
      catch { throw new Error("Este navegador no puede leer las pistas. Usá Chrome o Edge."); }
      if (stems.cur !== c) return; // cambió la canción mientras cargaba
      c.buffers.set(s.name, buf);
    }
  } catch (err) {
    c.error = err.message;
    c.loading = false;
    return stemsRender();
  }
  c.loading = false;
  const t = stemsTrack();
  if (stems.cur !== c || !t || key(t) !== c.tkey || !stemsOnFor(t)) return;
  // nodos de volumen por pista
  stems.gains.forEach((n) => n.disconnect());
  stems.gains = new Map();
  for (const name of c.buffers.keys()) {
    const gain = g.ctx.createGain();
    gain.connect(stems.master);
    stems.gains.set(name, gain);
  }
  c.active = true;
  stemsApplyMix(true);
  g.mainGain.gain.setTargetAtTime(0, g.ctx.currentTime, 0.03); // se apaga el audio normal
  stemsStart();
  clearInterval(stems.driftTimer);
  stems.driftTimer = setInterval(stemsCheckDrift, 1000);
  stemsRender();
}

function stemsStopSources() {
  for (const s of stems.sources) { try { s.stop(); } catch { /* ya paró */ } s.disconnect(); }
  stems.sources = [];
}

function stemsStart() {
  stemsStopSources();
  const c = stems.cur;
  if (!c || !c.active || audio.paused || audio.seeking) return;
  const ctx = stems.graph.ctx;
  const lead = 0.06;
  const rate = audio.playbackRate || 1;
  const when = ctx.currentTime + lead;
  const pos = audio.currentTime + lead * rate;
  for (const [name, buf] of c.buffers) {
    if (pos >= buf.duration) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(stems.gains.get(name));
    src.start(when, Math.max(0, pos));
    stems.sources.push(src);
  }
  stems.startCtx = when;
  stems.startPos = pos;
  stems.rate = rate;
}

function stemsCheckDrift() {
  const c = stems.cur;
  if (!c || !c.active || audio.paused || !stems.sources.length) return;
  const ctx = stems.graph.ctx;
  const expected = stems.startPos + (ctx.currentTime - stems.startCtx) * stems.rate;
  if (Math.abs(expected - audio.currentTime) > 0.15) stemsStart();
}

function stemsDeactivate() {
  clearTimeout(stems.poll);
  clearInterval(stems.driftTimer);
  stemsStopSources();
  stems.gains.forEach((n) => n.disconnect());
  stems.gains = new Map();
  if (stems.graph) stems.graph.mainGain.gain.setTargetAtTime(1, stems.graph.ctx.currentTime, 0.03); // vuelve el audio normal
  stems.cur = null;
}

["playing", "seeked", "ratechange"].forEach((ev) => audio.addEventListener(ev, () => { if (stems.cur && stems.cur.active) stemsStart(); }));
["pause", "waiting", "seeking", "ended", "emptied"].forEach((ev) => audio.addEventListener(ev, () => { if (stems.sources.length) stemsStopSources(); }));
audio.addEventListener("volumechange", stemsVolume);

// Cambio de canción: se vuelve al audio normal; si la nueva tiene la casilla marcada, se cargan sus pistas
let stemsLastKey = null;
audio.addEventListener("loadstart", () => {
  const t = stemsTrack();
  const k = t ? key(t) : null;
  if (k === stemsLastKey) return;
  stemsLastKey = k;
  if (stems.cur && stems.cur.tkey !== k) stemsDeactivate();
  if (t && stemsOnFor(t) && stemsCanSplit(t) && !stems.cur) stemsActivate(t, false);
  stemsRender();
});

/* ------------------------------------------------------------ mezcla */

function stemsMix() {
  const c = stems.cur;
  if (!c) return {};
  const m = stems.mixes[c.tkey] || (stems.mixes[c.tkey] = {});
  for (const name of c.buffers.keys()) if (!m[name]) m[name] = { v: 1, m: false, s: false };
  return m;
}

function stemsSaveMix() {
  const keys = Object.keys(stems.mixes);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete stems.mixes[k];
  store.set("stemsMix", stems.mixes);
}

function stemsApplyMix(instant) {
  const c = stems.cur;
  if (!c || !stems.graph) return;
  const mix = stemsMix();
  const solo = Object.entries(mix).some(([n, x]) => x.s && c.buffers.has(n));
  const t = stems.graph.ctx.currentTime;
  for (const [name, gain] of stems.gains) {
    const x = mix[name];
    const on = solo ? x.s : !x.m;
    gain.gain.setTargetAtTime(on ? x.v : 0, t, instant ? 0.001 : 0.02);
  }
}

function stemsPreset(p) {
  const mix = stemsMix();
  for (const name of Object.keys(mix)) mix[name] = { v: 1, m: !p.keep(name), s: false };
  stemsSaveMix();
  stemsApplyMix();
  stemsRender();
}

function stemsActivePreset() {
  const mix = stemsMix();
  const names = Object.keys(mix);
  return STEM_PRESETS.find((p) => names.every((n) => mix[n].v === 1 && !mix[n].s && mix[n].m === !p.keep(n)));
}

/* ------------------------------------------------------------ pantalla */

function stemsRender() {
  const sw = $("#np-stems-switch");
  const box = $("#np-stems");
  if (!sw || !box) return;
  const t = stemsTrack();
  sw.hidden = !stemsCanSplit(t);
  $("#np-stems-on").checked = stemsOnFor(t);
  const on = stemsOnFor(t) && stemsCanSplit(t);
  box.hidden = !on;
  $("#np-panel").classList.toggle("stems-on", on);
  if (!on) return box.replaceChildren();
  box.replaceChildren(...stemsBody(t));
}

function stemsHead(text, extra) {
  return el("div", { class: "stems-head" }, el("h3", { text }), extra || null);
}

function stemsBar(p) {
  return el("div", { class: "stems-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(p * 100)) },
    el("i", { style: `width:${Math.max(2, Math.round(p * 100))}%` }));
}

function stemsBody(t) {
  const st = stems.status;
  const c = stems.cur;
  if (!st) return [stemsHead("Pistas"), el("p", { class: "stems-note", text: "Revisando…" })];
  if (st.error) return [stemsHead("Pistas"), el("div", { class: "error-box", text: st.error })];

  // 1) el motor todavía no está instalado
  if (!st.installed) {
    const job = st.install;
    if (job && !["done", "error"].includes(job.stage)) {
      const idx = INSTALL_STEPS.findIndex(([id]) => id === job.stage);
      return [
        stemsHead("Instalando el motor de separación"),
        el("ol", { class: "upd-steps stems-steps" }, INSTALL_STEPS.map(([id, label], i) =>
          el("li", { class: i < idx ? "done" : i === idx ? "now" : "" }, (i < idx ? "✓ " : i === idx ? "• " : "  ") + label))),
        el("p", { class: "stems-note", text: `Lleva ${stemsFmtDur(Date.now() / 1000 - job.startedAt)}. Puede tardar de 5 a 20 minutos según tu internet. Mientras tanto la música sigue normal; podés cerrar este panel.` }),
      ];
    }
    return [
      stemsHead("Separar pistas"),
      job && job.stage === "error" ? el("div", { class: "error-box" }, el("strong", { text: "No se pudo instalar" }), el("p", { text: job.error })) : null,
      el("p", { class: "stems-note", text: "La primera vez hay que instalar el motor de separación (Demucs). Ocupa entre 1 y 3 GB y se baja una sola vez. No toca tu música ni tus listas, y se puede borrar cuando quieras." }),
      el("div", { class: "toolbar" },
        el("button", { class: "btn primary", onclick: stemsInstall }, job && job.stage === "error" ? "Reintentar" : "Instalar motor"),
        el("button", { class: "btn", onclick: () => { $("#np-stems-on").checked = false; stemsSetSong(false); } }, "Ahora no")),
    ].filter(Boolean);
  }

  if (!c || c.tkey !== key(t)) return [stemsHead("Pistas"), el("p", { class: "stems-note", text: "Preparando…" })];
  if (c.error) {
    return [stemsHead("Pistas"), el("div", { class: "error-box", text: c.error }),
      el("div", { class: "toolbar" }, el("button", { class: "btn", onclick: stemsRetry }, "Reintentar"))];
  }
  const s = c.state;
  if (!s) return [stemsHead("Pistas"), el("p", { class: "stems-note", text: "Revisando…" })];
  const job = s.job || {};

  // 2) separando
  if (["queued", "downloading", "separating"].includes(s.status)) {
    let line, p = 0;
    if (s.status === "queued") line = job.position > 1 ? `En fila: hay ${job.position - 1} ${job.position - 1 === 1 ? "canción" : "canciones"} antes.` : "Empezando…";
    else if (s.status === "downloading") { p = (job.progress || 0) * 0.05; line = `Bajando la canción… ${Math.round((job.progress || 0) * 100)}%`; }
    else {
      p = 0.05 + (job.progress || 0) * 0.95;
      line = job.progress >= 0.95 ? "Guardando las pistas…"
        : `Separando… ${Math.round((job.progress || 0) * 100)}%` + (job.eta ? ` · faltan unos ${stemsFmtDur(job.eta)}` : "");
    }
    return [
      stemsHead("Separando pistas", el("button", { class: "text-btn", onclick: stemsCancel }, "Cancelar")),
      stemsBar(p),
      el("p", { class: "stems-note", text: line }),
      el("p", { class: "stems-note small", text: "Mientras tanto suena normal. Cuando termine, pasa sola a las pistas." }),
    ];
  }
  if (s.status === "error") {
    return [stemsHead("Pistas"), el("div", { class: "error-box", text: job.error || "No se pudo separar esta canción." }),
      el("div", { class: "toolbar" }, el("button", { class: "btn", onclick: stemsRetry }, "Reintentar"))];
  }
  if (s.status !== "ready" || c.loading || !c.active) {
    return [stemsHead("Pistas"), stemsBar(1), el("p", { class: "stems-note", text: "Cargando las pistas…" })];
  }

  // 3) mezcla
  const meta = s.meta;
  const mix = stemsMix();
  const solo = Object.values(mix).some((x) => x.s);
  const active = stemsActivePreset();
  const rows = meta.sources.map((src) => {
    const name = STEM_NAMES[src.name] || src.name;
    if (!c.buffers.has(src.name)) {
      return el("li", { class: "stem-row off" }, el("span", { class: "stem-name", text: name }), el("span", { class: "stem-empty", text: "no se escucha en esta canción" }));
    }
    const x = mix[src.name];
    const audible = solo ? x.s : !x.m;
    const range = el("input", {
      type: "range", min: "0", max: "1.5", step: "0.05", value: String(x.v), "aria-label": `Volumen de ${name}`,
      oninput: (e) => { x.v = Number(e.target.value); stemsApplyMix(); out.textContent = `${Math.round(x.v * 100)}%`; },
      onchange: () => { stemsSaveMix(); stemsRender(); },
    });
    const out = el("output", { class: "stem-val", text: `${Math.round(x.v * 100)}%` });
    return el("li", { class: "stem-row" + (audible ? "" : " muted") },
      el("span", { class: "stem-name", text: name }),
      el("button", { class: "stem-btn" + (x.m ? " on" : ""), "aria-pressed": String(x.m), title: `Silenciar ${name}`, "aria-label": `Silenciar ${name}`,
        onclick: () => { x.m = !x.m; if (x.m) x.s = false; stemsSaveMix(); stemsApplyMix(); stemsRender(); } }, "M"),
      el("button", { class: "stem-btn solo" + (x.s ? " on" : ""), "aria-pressed": String(x.s), title: `Escuchar solo ${name}`, "aria-label": `Escuchar solo ${name}`,
        onclick: () => { x.s = !x.s; if (x.s) x.m = false; stemsSaveMix(); stemsApplyMix(); stemsRender(); } }, "S"),
      range, out);
  });
  const how = meta.device === "cuda" ? "con la placa de video" : "con el procesador";
  return [
    stemsHead("Pistas", el("button", { class: "text-btn", onclick: stemsDelete, title: "Borrar las pistas de esta canción" }, "Borrar")),
    el("div", { class: "chips stems-presets" }, STEM_PRESETS.map((p) =>
      el("button", { class: "chip" + (active === p ? " on" : ""), "aria-pressed": String(active === p), onclick: () => stemsPreset(p) }, p.name))),
    el("ul", { class: "stem-rows" }, rows),
    el("p", { class: "stems-note small", text: `Separada en ${stemsFmtDur(meta.wall || meta.timings.total)} ${how} (canción de ${stemsFmtDur(meta.duration)}).` }),
  ];
}

stemsBuild();
stemsRefreshStatus().then(() => {
  const t = stemsTrack();
  stemsLastKey = t ? key(t) : null;
  if (t && stemsOnFor(t) && stemsCanSplit(t)) stemsActivate(t, false);
  stemsRender();
});
// el panel se vuelve a dibujar al abrirlo o cambiar de canción
new MutationObserver(() => stemsRender()).observe($("#np-panel"), { attributes: true, attributeFilter: ["hidden"] });
