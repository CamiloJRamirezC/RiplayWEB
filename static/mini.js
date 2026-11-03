"use strict";
/* Mini reproductor flotante: una ventanita que queda encima de las demás (Document Picture-in-Picture,
   Chrome/Edge 116+). Los botones usan los del reproductor principal, así se comporta exactamente igual,
   y se mantiene al día observando el reproductor (sirve aunque la canción se cambie desde otro lado). */

const mini = { win: null, els: null, raf: 0 };
const miniBtn = $("#btn-mini");
const MINI_SIZE = { width: 300, height: 480 };

function miniSupported() {
  return "documentPictureInPicture" in window && window.isSecureContext;
}

function miniIcon(doc, name) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = doc.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function miniCover(t) {
  if (!t || !t.thumb) return "";
  return t.thumb.replace(/=w\d+-h\d+/, "=w544-h544"); // portadas de YouTube Music en tamaño grande
}

function miniBuild(win) {
  const doc = win.document;
  doc.documentElement.lang = "es";
  doc.title = "RiPlay";
  for (const href of ["https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&display=swap",
                      location.origin + "/mini.css"]) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    doc.head.append(link);
  }
  // los íconos viven en un <svg> oculto de la página principal: se copian
  const sprite = document.querySelector("svg symbol")?.closest("svg");
  if (sprite) doc.body.append(sprite.cloneNode(true));

  const h = (tag, attrs = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  };
  const press = (id) => () => { const b = $(id); if (b && !b.disabled && !b.hidden) b.click(); };
  const els = {};
  els.cover = h("img", { class: "m-cover", alt: "", referrerpolicy: "no-referrer" });
  els.blank = h("div", { class: "m-cover m-blank" }, miniIcon(doc, "disk"));
  els.title = h("div", { class: "m-title" });
  els.artist = h("div", { class: "m-artist" });
  els.fill = h("i");
  els.prog = h("div", {
    class: "m-prog", role: "slider", "aria-label": "Posición", tabindex: "0",
    onclick: (e) => {
      const d = audio.duration;
      if (!d) return;
      const r = els.prog.getBoundingClientRect();
      audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
    },
  }, els.fill);
  els.cur = h("span");
  els.dur = h("span");
  els.dislike = h("button", { class: "m-btn", onclick: press("#btn-dislike") });
  els.prev = h("button", { class: "m-btn", title: "Anterior", "aria-label": "Anterior", onclick: press("#btn-prev") }, miniIcon(doc, "prev"));
  els.play = h("button", { class: "m-play", onclick: press("#btn-play") });
  els.next = h("button", { class: "m-btn", title: "Siguiente", "aria-label": "Siguiente", onclick: press("#btn-next") }, miniIcon(doc, "next"));
  els.like = h("button", { class: "m-btn m-like", onclick: press("#btn-like") });

  doc.body.append(h("main", { class: "m" },
    h("div", { class: "m-art" }, els.cover, els.blank),
    h("div", { class: "m-info" },
      h("div", { class: "m-text" }, els.title, els.artist),
      h("div", { class: "m-progwrap" }, els.prog, h("div", { class: "m-times" }, els.cur, els.dur))),
    h("div", { class: "m-ctrls" }, els.dislike, els.prev, els.play, els.next, els.like)));

  doc.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("button") && (e.key === " " || e.key === "Enter")) return;
    if (e.key === " ") { e.preventDefault(); press("#btn-play")(); }
    else if (e.key === "ArrowRight" && e.altKey) press("#btn-next")();
    else if (e.key === "ArrowLeft" && e.altKey) press("#btn-prev")();
  });
  return els;
}

function miniSync() {
  mini.raf = 0;
  const els = mini.els;
  if (!mini.win || !els) return;
  const doc = mini.win.document;
  const t = state.queue[state.index];
  const nice = t ? (typeof prettyTrack === "function" ? prettyTrack(t) : { title: t.title, artist: t.artist }) : null;
  els.title.textContent = nice ? nice.title || "Sin título" : "Nada sonando";
  els.artist.textContent = nice ? nice.artist || (t.local ? "Archivo local" : "") : "Elegí una canción en RiPlay";
  const src = miniCover(t);
  if (src) { if (els.cover.getAttribute("src") !== src) els.cover.src = src; els.cover.hidden = false; els.blank.hidden = true; }
  else { els.cover.hidden = true; els.blank.hidden = false; }
  doc.title = t ? `${nice.title} — RiPlay` : "RiPlay";

  const playing = !audio.paused;
  els.play.replaceChildren(miniIcon(doc, playing ? "pause" : "play"));
  els.play.title = playing ? "Pausar" : "Reproducir";
  els.play.setAttribute("aria-label", els.play.title);
  els.play.disabled = !t;
  els.prev.disabled = els.next.disabled = !t;

  // Me gusta / No me gusta: el mismo estado que muestran los botones del reproductor
  for (const [mb, id, on, off] of [[els.like, "#btn-like", "heart-fill", "heart"], [els.dislike, "#btn-dislike", "dislike-fill", "dislike"]]) {
    const src = $(id);
    const pressed = src.getAttribute("aria-pressed") === "true";
    mb.disabled = src.hidden;
    mb.classList.toggle("on", pressed && !src.hidden);
    mb.setAttribute("aria-pressed", String(pressed));
    mb.title = src.title;
    mb.setAttribute("aria-label", src.getAttribute("aria-label") || src.title);
    mb.replaceChildren(miniIcon(doc, pressed ? on : off));
  }
  miniTime();
}

function miniTime() {
  const els = mini.els;
  if (!mini.win || !els) return;
  const d = audio.duration || (state.queue[state.index] || {}).duration || 0;
  const c = audio.currentTime || 0;
  els.fill.style.width = d ? `${Math.min(100, (c / d) * 100)}%` : "0";
  els.prog.setAttribute("aria-valuetext", `${fmt(c)} de ${fmt(d)}`);
  els.cur.textContent = fmt(c);
  els.dur.textContent = fmt(d);
}

const miniQueue = () => { if (mini.win && !mini.raf) mini.raf = requestAnimationFrame(miniSync); };

async function openMini() {
  if (mini.win) { mini.win.close(); return; }
  const size = store.get("miniSize", MINI_SIZE);
  let win;
  try {
    win = await documentPictureInPicture.requestWindow({
      width: Math.max(220, Math.min(600, size.width || MINI_SIZE.width)),
      height: Math.max(90, Math.min(800, size.height || MINI_SIZE.height)),
    });
  } catch (err) {
    toast("No se pudo abrir el mini reproductor: " + err.message);
    return;
  }
  mini.win = win;
  mini.els = miniBuild(win);
  miniBtn.setAttribute("aria-pressed", "true");
  miniBtn.classList.add("on");
  win.addEventListener("pagehide", () => {
    store.set("miniSize", { width: win.innerWidth, height: win.innerHeight });
    mini.win = null;
    mini.els = null;
    miniBtn.setAttribute("aria-pressed", "false");
    miniBtn.classList.remove("on");
  });
  miniSync();
}

if (miniSupported()) {
  miniBtn.hidden = false;
  miniBtn.addEventListener("click", openMini);
  for (const ev of ["play", "pause", "emptied", "loadedmetadata", "durationchange", "ended"]) audio.addEventListener(ev, miniQueue);
  audio.addEventListener("timeupdate", () => { if (mini.win) miniTime(); });
  // canción, me gusta y no me gusta: se siguen desde el reproductor principal
  const watch = new MutationObserver(miniQueue);
  for (const node of [$(".player .now"), $("#btn-play")]) {
    watch.observe(node, { subtree: true, childList: true, characterData: true, attributes: true,
                          attributeFilter: ["aria-pressed", "hidden", "src", "title"] });
  }
}
