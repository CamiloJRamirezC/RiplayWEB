"use strict";
/* Ecualizador de 10 bandas con Web Audio.
   Usa `audio`, `api`, `toast`, `el`, `icon` y `$` definidos en app.js. */

const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_LIMIT = 12;

// Curvas en dB por banda (32 Hz … 16 kHz)
const EQ_PRESETS = [
  { id: "flat", name: "Plano", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "rock", name: "Rock", gains: [5, 4, 3, 1.5, -0.5, -1, 0.5, 2.5, 3.5, 4.5] },
  { id: "pop", name: "Pop", gains: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5] },
  { id: "jazz", name: "Jazz", gains: [4, 3, 1.5, 2.5, -1.5, -1.5, 0, 1.5, 3, 4] },
  { id: "classical", name: "Clásica", gains: [4.5, 3.5, 3, 2.5, -1.5, -1.5, 0, 2, 3, 3.5] },
  { id: "techno", name: "Techno", gains: [5, 4, 0, -3, -2.5, 0, 3, 4.5, 4.5, 4] },
  { id: "electronic", name: "Electrónica", gains: [4.5, 4, 1, 0, -2, 2, 1, 1.5, 4, 5] },
  { id: "dance", name: "Dance", gains: [3.5, 6, 4.5, 0, 1.5, 3, 4.5, 4, 3, 0] },
  { id: "hiphop", name: "Hip-hop", gains: [5, 4, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3] },
  { id: "reggaeton", name: "Reggaetón", gains: [6, 5, 2, 0, -1, 1, 2, 1, 2, 2] },
  { id: "latin", name: "Latina", gains: [4.5, 3, 0, 0, -1.5, -1.5, -1.5, 0, 3, 4.5] },
  { id: "metal", name: "Metal", gains: [4.5, 3.5, 0, -2, -1, 1, 3, 4, 4, 3] },
  { id: "acoustic", name: "Acústica", gains: [4.5, 4.5, 3.5, 1, 2, 1.5, 3, 3.5, 3, 1.5] },
  { id: "vocal", name: "Voz", gains: [-1.5, -3, -3, 1.5, 3.5, 3.5, 3, 1.5, 0, -1.5] },
  { id: "bass", name: "Más graves", gains: [6, 5, 4, 2.5, 1, 0, 0, 0, 0, 0] },
  { id: "treble", name: "Más agudos", gains: [0, 0, 0, 0, 0, 1, 2.5, 3.5, 4.5, 6] },
  { id: "night", name: "Noche", gains: [3, 1.5, 0, -1.5, -1, 1, 2.5, 3.5, 3, 1.5] },
];

const eq = {
  state: { enabled: false, preset: "flat", gains: EQ_PRESETS[0].gains.slice(), preamp: 0, custom: [] },
  ctx: null,
  source: null,
  pre: null,
  filters: [],
  limiter: null,
  wired: null, // "eq" | "bypass"
  saveTimer: null,
};

/* ------------------------------------------------------------ motor de audio */

function eqFilterSpec(i) {
  if (i === 0) return { type: "lowshelf", q: 0.7 };
  if (i === EQ_FREQS.length - 1) return { type: "highshelf", q: 0.7 };
  return { type: "peaking", q: 1.4 };
}

function eqEnsureGraph() {
  if (eq.ctx) return true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) { toast("Este navegador no permite ecualizar el audio."); return false; }
  try {
    const ctx = new Ctx();
    eq.source = ctx.createMediaElementSource(audio);
    eq.pre = ctx.createGain();
    eq.filters = EQ_FREQS.map((f, i) => {
      const node = ctx.createBiquadFilter();
      const spec = eqFilterSpec(i);
      node.type = spec.type;
      node.frequency.value = f;
      node.Q.value = spec.q;
      return node;
    });
    // Limitador suave: evita que los refuerzos saturen
    eq.limiter = ctx.createDynamicsCompressor();
    eq.limiter.threshold.value = -1;
    eq.limiter.knee.value = 0;
    eq.limiter.ratio.value = 20;
    eq.limiter.attack.value = 0.003;
    eq.limiter.release.value = 0.25;
    eq.pre.connect(eq.filters[0]);
    for (let i = 0; i < eq.filters.length - 1; i++) eq.filters[i].connect(eq.filters[i + 1]);
    eq.filters[eq.filters.length - 1].connect(eq.limiter);
    eq.limiter.connect(ctx.destination);
    eq.ctx = ctx;
    return true;
  } catch (err) {
    console.error("Ecualizador:", err);
    toast("No se pudo activar el ecualizador en este navegador.");
    return false;
  }
}

function eqWire() {
  if (!eq.ctx) return;
  const want = eq.state.enabled ? "eq" : "bypass";
  if (eq.wired === want) return;
  try { eq.source.disconnect(); } catch { /* no estaba conectado */ }
  eq.source.connect(want === "eq" ? eq.pre : eq.ctx.destination);
  eq.wired = want;
}

function eqApplyToGraph() {
  if (!eq.ctx) return;
  const t = eq.ctx.currentTime;
  eq.filters.forEach((node, i) => node.gain.setTargetAtTime(eq.state.gains[i], t, 0.015));
  eq.pre.gain.setTargetAtTime(Math.pow(10, eq.state.preamp / 20), t, 0.015);
  eqWire();
}

function eqResume() {
  if (eq.ctx && eq.ctx.state === "suspended") eq.ctx.resume().catch(() => {});
}

// Se arma la cadena recién cuando hace falta (al reproducir con el ecualizador encendido)
audio.addEventListener("play", () => {
  if (!eq.state.enabled && !eq.ctx) return;
  if (eqEnsureGraph()) { eqApplyToGraph(); eqResume(); }
  setTimeout(() => {
    if (eq.ctx && eq.ctx.state !== "running" && !audio.paused) {
      toast("Tocá cualquier parte de la página para activar el ecualizador.");
    }
  }, 800);
});
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, eqResume, { capture: true, passive: true }));

/* ------------------------------------------------------------ estado */

function eqPresetById(id) {
  if (id && id.startsWith("custom:")) {
    const c = eq.state.custom.find((p) => "custom:" + p.name === id);
    return c ? { id, name: c.name, gains: c.gains, preamp: c.preamp, custom: true } : null;
  }
  return EQ_PRESETS.find((p) => p.id === id) || null;
}

function eqSave() {
  clearTimeout(eq.saveTimer);
  eq.pending = true;
  eq.saveTimer = setTimeout(() => {
    eq.pending = false;
    api("eq", { method: "POST", body: eq.state }).catch((err) => toast("No se guardó el ecualizador: " + err.message));
  }, 400);
}

// Si la página se cierra o se recarga con un cambio sin guardar, se manda en ese momento
function eqFlush() {
  if (!eq.pending) return;
  clearTimeout(eq.saveTimer);
  eq.pending = false;
  try {
    fetch("/api/eq", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(eq.state) });
  } catch { /* nada más que hacer */ }
}
window.addEventListener("pagehide", eqFlush);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") eqFlush(); });

function eqSetEnabled(on) {
  eq.state.enabled = on;
  if (on && eqEnsureGraph()) eqResume();
  eqApplyToGraph();
  eqRender();
  eqSave();
}

function eqUsePreset(id) {
  const p = eqPresetById(id);
  if (!p) return;
  eq.state.preset = id;
  eq.state.gains = p.gains.slice();
  eq.state.preamp = p.preamp != null ? p.preamp : 0;
  if (!eq.state.enabled) return eqSetEnabled(true);
  eqApplyToGraph();
  eqRender();
  eqSave();
}

function eqSetBand(i, value) {
  eq.state.gains[i] = Math.max(-EQ_LIMIT, Math.min(EQ_LIMIT, Math.round(value * 2) / 2));
  eq.state.preset = "custom";
  if (!eq.state.enabled) return eqSetEnabled(true);
  eqApplyToGraph();
  eqRender({ keepSliders: true });
  eqSave();
}

function eqSetPreamp(value) {
  eq.state.preamp = Math.max(-EQ_LIMIT, Math.min(EQ_LIMIT, Math.round(value * 2) / 2));
  if (!eq.state.enabled) return eqSetEnabled(true);
  eqApplyToGraph();
  eqRender({ keepSliders: true });
  eqSave();
}

function eqSaveAsPreset() {
  const current = eqPresetById(eq.state.preset);
  const suggestion = current && current.custom ? current.name : "";
  const name = (prompt("Nombre del preset:", suggestion) || "").trim().slice(0, 40);
  if (!name) return;
  const existing = eq.state.custom.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  const entry = { name, gains: eq.state.gains.slice(), preamp: eq.state.preamp };
  if (existing >= 0) {
    if (!confirm(`Ya existe “${eq.state.custom[existing].name}”. ¿Reemplazarlo?`)) return;
    eq.state.custom[existing] = { ...entry, name: eq.state.custom[existing].name };
  } else {
    if (eq.state.custom.length >= 30) { toast("Llegaste al máximo de 30 presets propios."); return; }
    eq.state.custom.push(entry);
  }
  eq.state.preset = "custom:" + (existing >= 0 ? eq.state.custom[existing].name : name);
  eqRender();
  eqSave();
  toast(`Preset “${name}” guardado`);
}

function eqDeletePreset() {
  const p = eqPresetById(eq.state.preset);
  if (!p || !p.custom) return;
  if (!confirm(`¿Borrar el preset “${p.name}”?`)) return;
  eq.state.custom = eq.state.custom.filter((c) => c.name !== p.name);
  eq.state.preset = "custom";
  eqRender();
  eqSave();
  toast("Preset borrado");
}

/* ------------------------------------------------------------ curva */

let eqCurveNodes = null;
function eqCurveFilters() {
  // Filtros "de dibujo" en un contexto sin sonido: la curva se ve aunque no esté sonando nada
  if (eqCurveNodes) return eqCurveNodes;
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Off) return null;
  const off = new Off(1, 1, 44100);
  eqCurveNodes = EQ_FREQS.map((f, i) => {
    const n = off.createBiquadFilter();
    const spec = eqFilterSpec(i);
    n.type = spec.type; n.frequency.value = f; n.Q.value = spec.q;
    return n;
  });
  return eqCurveNodes;
}

const EQ_DB_RANGE = 15;
function eqDrawCurve() {
  const canvas = $("#eq-curve");
  if (!canvas || canvas.offsetParent === null) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue("--line").trim();
  const ink2 = css.getPropertyValue("--ink-2").trim();
  const accent = css.getPropertyValue("--accent").trim();

  const fMin = 20, fMax = 20000;
  const xOf = (f) => (Math.log10(f / fMin) / Math.log10(fMax / fMin)) * w;
  const yOf = (db) => h / 2 - (db / EQ_DB_RANGE) * (h / 2 - 6);

  g.lineWidth = 1;
  g.font = "11px " + css.getPropertyValue("--body");
  g.fillStyle = ink2;
  for (const db of [-12, -6, 0, 6, 12]) {
    g.strokeStyle = line;
    g.globalAlpha = db === 0 ? 1 : 0.55;
    g.beginPath(); g.moveTo(0, yOf(db) + 0.5); g.lineTo(w, yOf(db) + 0.5); g.stroke();
    g.globalAlpha = 1;
    if (db !== 0) g.fillText((db > 0 ? "+" : "") + db, 4, yOf(db) - 3);
  }

  const nodes = eqCurveFilters();
  const N = Math.max(64, Math.round(w));
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = fMin * Math.pow(fMax / fMin, i / (N - 1));
  const total = new Float32Array(N).fill(eq.state.preamp);
  if (nodes) {
    const mag = new Float32Array(N), phase = new Float32Array(N);
    nodes.forEach((n, i) => {
      n.gain.value = eq.state.gains[i];
      n.getFrequencyResponse(freqs, mag, phase);
      for (let k = 0; k < N; k++) total[k] += 20 * Math.log10(Math.max(mag[k], 1e-6));
    });
  }
  const pts = Array.from(freqs, (f, k) => [xOf(f), yOf(Math.max(-EQ_DB_RANGE, Math.min(EQ_DB_RANGE, total[k])))]);

  const on = eq.state.enabled;
  g.globalAlpha = on ? 0.18 : 0.08;
  g.fillStyle = accent;
  g.beginPath(); g.moveTo(pts[0][0], yOf(0));
  pts.forEach(([x, y]) => g.lineTo(x, y));
  g.lineTo(pts[pts.length - 1][0], yOf(0)); g.closePath(); g.fill();
  g.globalAlpha = on ? 1 : 0.45;
  g.strokeStyle = on ? accent : ink2;
  g.lineWidth = 2.5; g.lineJoin = "round";
  g.beginPath(); pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  g.globalAlpha = 1;
}

/* ------------------------------------------------------------ panel */

const eqLabel = (f) => (f >= 1000 ? f / 1000 + "k" : String(f));
const eqFmt = (db) => (db > 0 ? "+" : db < 0 ? "−" : "") + Math.abs(db).toString().replace(".", ",");

function eqBuildPanel() {
  const panel = el("section", { id: "eq-panel", class: "eq-panel", role: "dialog", "aria-label": "Ecualizador", hidden: true },
    el("header", { class: "eq-head" },
      el("h2", { text: "Ecualizador" }),
      el("label", { class: "switch" },
        el("input", { type: "checkbox", id: "eq-on", role: "switch", onchange: (e) => eqSetEnabled(e.target.checked) }),
        el("span", { class: "switch-track", "aria-hidden": "true" }),
        el("span", { id: "eq-on-label", text: "Apagado" })),
      el("button", { class: "icon-btn", "aria-label": "Cerrar ecualizador", onclick: eqToggle }, icon("close"))),
    el("div", { class: "eq-presets", id: "eq-presets", role: "group", "aria-label": "Presets" }),
    el("canvas", { id: "eq-curve", class: "eq-curve", "aria-hidden": "true" }),
    el("div", { class: "eq-bands", id: "eq-bands" }),
    el("footer", { class: "eq-foot" },
      el("span", { class: "eq-current", id: "eq-current" }),
      el("button", { class: "btn", id: "eq-delete", onclick: eqDeletePreset, hidden: true }, "Borrar preset"),
      el("button", { class: "btn", onclick: () => eqUsePreset("flat") }, "Restablecer"),
      el("button", { class: "btn primary", onclick: eqSaveAsPreset }, "Guardar preset")));

  const bands = $("#eq-bands", panel);
  const column = (id, label, title, value, onInput) => {
    const out = el("output", { class: "eq-val", id: id + "-val", text: eqFmt(value) });
    const input = el("input", {
      type: "range", class: "eq-slider", id, min: -EQ_LIMIT, max: EQ_LIMIT, step: 0.5, value,
      "aria-label": title, "aria-valuetext": `${eqFmt(value)} dB`,
      oninput: (e) => onInput(+e.target.value),
      ondblclick: () => onInput(0),
      title: "Doble clic: volver a 0",
    });
    return el("div", { class: "eq-band" + (id === "eq-pre" ? " eq-pre" : "") }, out, input, el("span", { class: "eq-freq", text: label }));
  };
  bands.append(column("eq-pre", "Pre", "Preamplificador", eq.state.preamp, eqSetPreamp));
  EQ_FREQS.forEach((f, i) => bands.append(column("eq-b" + i, eqLabel(f), `${eqLabel(f)}Hz`, eq.state.gains[i], (v) => eqSetBand(i, v))));
  document.body.append(panel);
}

function eqRender(opts = {}) {
  const panel = $("#eq-panel");
  if (!panel) return;
  const s = eq.state;
  $("#eq-on").checked = s.enabled;
  $("#eq-on-label").textContent = s.enabled ? "Encendido" : "Apagado";
  panel.classList.toggle("is-off", !s.enabled);

  const chip = (id, name) => el("button", {
    class: "chip", "aria-pressed": String(s.preset === id),
    onclick: () => eqUsePreset(id),
  }, name);
  const presets = $("#eq-presets");
  presets.replaceChildren(
    ...EQ_PRESETS.map((p) => chip(p.id, p.name)),
    ...s.custom.map((c) => chip("custom:" + c.name, c.name)));
  if (s.custom.length) presets.children[EQ_PRESETS.length].classList.add("chip-first-custom");

  const sync = (id, value, label) => {
    const input = $("#" + id);
    if (!opts.keepSliders || +input.value !== value) input.value = value;
    input.setAttribute("aria-valuetext", `${eqFmt(value)} dB`);
    $("#" + id + "-val").textContent = eqFmt(value);
    input.closest(".eq-band").classList.toggle("is-zero", value === 0);
  };
  sync("eq-pre", s.preamp);
  s.gains.forEach((g, i) => sync("eq-b" + i, g));

  const p = eqPresetById(s.preset);
  $("#eq-current").textContent = p ? (p.custom ? `Preset propio: ${p.name}` : `Preset: ${p.name}`) : "Personalizado";
  $("#eq-delete").hidden = !(p && p.custom);
  const btn = $("#btn-eq");
  btn.classList.toggle("on", s.enabled);
  btn.title = s.enabled ? `Ecualizador: ${p ? p.name : "personalizado"}` : "Ecualizador (apagado)";
  eqDrawCurve();
}

function eqToggle() {
  const panel = $("#eq-panel");
  panel.hidden = !panel.hidden;
  $("#btn-eq").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) { eqRender(); $("#eq-on").focus(); }
  else $("#btn-eq").focus();
}

document.addEventListener("keydown", (e) => {
  const panel = $("#eq-panel");
  if (e.key === "Escape" && panel && !panel.hidden && !$("#pl-dialog").open) eqToggle();
});
window.addEventListener("resize", () => eqDrawCurve());
if (window.matchMedia) {
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => eqDrawCurve()); } catch { /* navegadores viejos */ }
}

(async function eqInit() {
  eqBuildPanel();
  $("#btn-eq").addEventListener("click", eqToggle);
  try {
    const saved = await api("eq");
    eq.state = { ...eq.state, ...saved };
  } catch { /* sin servidor: queda en plano */ }
  eqRender();
})();
