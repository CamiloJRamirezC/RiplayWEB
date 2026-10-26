"use strict";

/* ============================================================ utilidades */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};
const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  svg.setAttribute("aria-hidden", "true");
  return svg;
};
const fmt = (s) => {
  if (!isFinite(s) || s <= 0) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("riplay." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("riplay." + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
const key = (t) => (t.local ? "local:" + t.local : t.id);

async function api(path, options = {}) {
  const { timeout = 30000, ...rest } = options;
  const opts = { ...rest, headers: { "Content-Type": "application/json", ...(rest.headers || {}) } };
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  opts.signal = ctrl.signal;
  let res;
  try {
    res = await fetch("/api/" + path, opts);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("YouTube tardó demasiado en responder. Revisá tu internet y probá de nuevo.");
    throw new Error("No hay conexión con el servidor de RiPlay. ¿Sigue abierta la ventana negra del programa?");
  }
  clearTimeout(timer);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}

/* ============================================================ estado */

const state = {
  view: ["col", "artist"].includes(store.get("view", "search")) ? "search" : store.get("view", "search"),
  query: store.get("query", ""),
  type: ["songs", "artists"].includes(store.get("type", "youtube")) ? store.get("type", "youtube") : "youtube",
  results: [],
  searchError: null,
  searched: false,
  local: null,
  config: null,
  playlists: [],
  queue: store.get("queue", []),
  index: store.get("index", -1),
  repeat: store.get("repeat", "off"), // off | all | one
  radioAuto: store.get("radioAuto", true),
  downloads: {},
};

const audio = $("#audio");
audio.volume = store.get("volume", 1);

/* ============================================================ navegación */

function setView(view) {
  state.view = view;
  store.set("view", view);
  closeMenu();
  render();
  $("#main").focus({ preventScroll: true });
  $("#main").scrollTop = 0;
}

function renderNav() {
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => {
    b.toggleAttribute("aria-current", b.dataset.view === state.view);
    if (b.dataset.view === state.view) b.setAttribute("aria-current", "page");
  });
  const nav = $("#playlist-nav");
  const fav = favoritesPl();
  const ordered = fav ? [fav, ...state.playlists.filter((p) => p !== fav)] : state.playlists;
  nav.replaceChildren(
    ...ordered.map((p) =>
      el("button", {
        class: "pl-link" + (p === fav ? " is-favorites" : ""),
        "aria-current": state.view === "pl:" + p.id ? "page" : null,
        onclick: () => setView("pl:" + p.id),
      }, icon(p === fav ? "heart-fill" : "list"), el("span", { text: p.name }), el("small", { text: String(p.tracks.length) }))
    )
  );
  const active = Object.values(state.downloads).filter((d) => d.status === "queued" || d.status === "downloading").length;
  const badge = $("#dl-badge");
  badge.hidden = !active;
  badge.textContent = active;
  badge.title = active ? `${active} descarga(s) en curso` : "";
}

function render() {
  renderNav();
  const main = $("#main");
  // Si estaba escribiendo en el buscador, se conserva el foco y el cursor al redibujar
  const typing = document.activeElement && document.activeElement.matches(".search-field input");
  const sel = typing ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  renderView(main);
  if (typing) {
    const input = main.querySelector(".search-field input");
    if (input) { input.focus({ preventScroll: true }); try { input.setSelectionRange(...sel); } catch { /* sin selección */ } }
  }
}

function renderView(main) {
  if (state.view === "search") main.replaceChildren(renderSearch());
  else if (state.view === "local") main.replaceChildren(renderLocal());
  else if (state.view === "artist") {
    if (!state.artist) { state.view = "search"; return renderView(main); }
    main.replaceChildren(renderArtist());
  }
  else if (state.view === "col") {
    if (!state.collection) { state.view = "search"; return renderView(main); }
    main.replaceChildren(renderCollection());
  }
  else if (state.view.startsWith("pl:")) {
    const pl = state.playlists.find((p) => "pl:" + p.id === state.view);
    if (!pl) { state.view = "search"; return render(); }
    main.replaceChildren(renderPlaylist(pl));
  }
}

/* ============================================================ filas */

function coverImg(t, size = 48) {
  if (t.thumb) return el("img", { class: "cover", src: t.thumb, alt: "", loading: "lazy", width: size, height: size, referrerpolicy: "no-referrer" });
  return el("div", { class: "cover blank", style: `width:${size}px;height:${size}px` }, icon("disk"));
}

/* ============================================================ me gusta / Favoritos */

const likeKey = (t) => (t.id ? t.id : t.local ? "local:" + t.local : "");
const favoritesPl = () => state.playlists.find((p) => p.special === "favorites") || null;

function isLiked(t) {
  const fav = favoritesPl();
  const k = likeKey(t);
  return !!(fav && k && fav.tracks.some((x) => likeKey(x) === k));
}

function likeButton(t) {
  if (!likeKey(t)) return null;
  const liked = isLiked(t);
  const b = el("button", {
    class: "icon-btn like-btn", "aria-pressed": String(liked),
    title: liked ? "Quitar de Favoritos" : "Me gusta",
    "aria-label": `${liked ? "Quitar de Favoritos" : "Agregar a Favoritos"}: ${t.title}`,
    onclick: (e) => { e.stopPropagation(); toggleLike(t, e.currentTarget); },
  }, icon(liked ? "heart-fill" : "heart"));
  b.dataset.like = likeKey(t);
  b._track = t;
  return b;
}

function refreshLikeButtons() {
  document.querySelectorAll(".tracks [data-like]").forEach((b) => {
    const fresh = likeButton(b._track);
    const hadFocus = b === document.activeElement;
    if (b.classList.contains("pop")) fresh.classList.add("pop");
    b.replaceWith(fresh);
    if (hadFocus) fresh.focus();
  });
  updateLikeCurrent();
}

function updateLikeCurrent() {
  const t = state.queue[state.index];
  const b = $("#btn-like");
  b.hidden = !t || !likeKey(t);
  if (b.hidden) return;
  const liked = isLiked(t);
  b.setAttribute("aria-pressed", String(liked));
  b.title = liked ? "Quitar de Favoritos" : "Me gusta";
  b.setAttribute("aria-label", liked ? "Quitar de Favoritos" : "Agregar a Favoritos");
  b.replaceChildren(icon(liked ? "heart-fill" : "heart"));
}

function setFavorites(pl) {
  if (!pl) return;
  const i = state.playlists.findIndex((p) => p.id === pl.id);
  if (i >= 0) state.playlists[i] = pl; else state.playlists.unshift(pl);
}

let likeBusy = false;
async function toggleLike(t, btn) {
  if (likeBusy || !likeKey(t)) return;
  likeBusy = true;
  const liked = isLiked(t);
  if (btn && !liked) { btn.classList.remove("pop"); void btn.offsetWidth; btn.classList.add("pop"); }
  try {
    const pl = liked
      ? await api("likes?key=" + encodeURIComponent(likeKey(t)), { method: "DELETE" })
      : await api("likes", { method: "POST", body: { track: t } });
    setFavorites(pl);
    toast(liked ? "Quitada de Favoritos" : "Agregada a Favoritos");
    const fav = favoritesPl();
    if (fav && state.view === "pl:" + fav.id) render(); else { renderNav(); refreshLikeButtons(); }
    updateLikeCurrent();
  } catch (err) { toast(err.message); }
  likeBusy = false;
}

function downloadButton(t) {
  if (t.local || !t.id || t.live) return null;
  const node = downloadButtonInner(t);
  node.dataset.dl = t.id;
  node._track = t;
  return node;
}

function refreshDownloadButtons() {
  document.querySelectorAll("[data-dl]").forEach((node) => {
    const fresh = downloadButton(node._track);
    if (node.contains(document.activeElement) && fresh.tagName === "BUTTON") return;
    node.replaceWith(fresh);
  });
}

function downloadButtonInner(t) {
  const d = state.downloads[t.id];
  if (d && (d.status === "queued" || d.status === "downloading")) {
    const pct = d.progress != null ? Math.round(d.progress * 100) + "%" : "…";
    return el("span", { class: "icon-btn dl-state", title: "Descargando", "aria-label": `Descargando ${pct}` }, pct);
  }
  if (d && d.status === "done") {
    return el("span", { class: "icon-btn dl-done", title: "Guardada en el disco", "aria-label": "Guardada en el disco" }, icon("check"));
  }
  return el("button", {
    class: "icon-btn", title: "Descargar", "aria-label": `Descargar ${t.title}`,
    onclick: (e) => { e.stopPropagation(); download(t); },
  }, icon("download"));
}

const isPlayable = (t) => (!t.kind || t.kind === "video") && !t.live;
const LIVE_LABEL = { is_live: "En vivo", is_upcoming: "Programado" };

function trackRow(t, list, i, ctx = {}) {
  const current = state.queue[state.index];
  const playing = current && key(current) === key(t);
  const play = () => (list && isPlayable(t)
    ? playList(list, i)
    : toast(t.live === "is_upcoming" ? "Esta transmisión todavía no empezó." : "Las transmisiones en vivo no se pueden reproducir en RiPlay."));
  const tag = t.live ? el("span", { class: "tag tag-live", text: LIVE_LABEL[t.live] }) : t.short ? el("span", { class: "tag", text: "Short" }) : null;
  const row = el("li", {
    class: "track" + (playing ? " playing" : "") + (isPlayable(t) ? "" : " not-playable"),
    ondblclick: play,
  },
    coverImg(t),
    el("div", { class: "track-main" },
      el("button", { class: "play-hit", title: isPlayable(t) ? "Reproducir" : LIVE_LABEL[t.live] || "", onclick: play },
        el("div", { class: "track-title" }, tag, t.title || "Sin título")),
      el("div", { class: "track-artist", text: t.artist || "Artista desconocido" })),
    el("div", { class: "track-album", text: t.album || "" }),
    el("div", { class: "track-dur", text: t.duration ? fmt(t.duration) : "" }),
    el("div", { class: "track-actions" },
      likeButton(t),
      downloadButton(t),
      el("button", {
        class: "icon-btn", title: "Más opciones", "aria-label": `Más opciones para ${t.title}`, "aria-haspopup": "menu",
        onclick: (e) => { e.stopPropagation(); openTrackMenu(e.currentTarget, t, ctx); },
      }, icon("more")))
  );
  return row;
}

function trackList(list, ctx = {}) {
  return el("ul", { class: "tracks" }, list.map((t, i) => trackRow(t, list, ctx.indexMap ? ctx.indexMap[i] : i, { ...ctx, position: i })));
}

/* ============================================================ vista: buscar */

let suggestTimer;
function renderSearch() {
  const input = el("input", {
    type: "search", value: state.draft != null ? state.draft : state.query, placeholder: "Canción, artista o álbum",
    "aria-label": "Buscar", list: "suggestions", autocomplete: "off", enterkeyhint: "search",
    oninput: (e) => {
      state.draft = e.target.value;
      // Elegir una sugerencia de la lista busca directamente
      if (e.inputType === "insertReplacementText" || e.inputType === undefined) { doSearch(e.target.value); return; }
      clearTimeout(suggestTimer);
      const q = e.target.value.trim();
      if (q.length < 2) return;
      suggestTimer = setTimeout(async () => {
        try {
          const items = await api("suggest?q=" + encodeURIComponent(q));
          $("#suggestions").replaceChildren(...items.map((s) => el("option", { value: s })));
        } catch { /* las sugerencias son opcionales */ }
      }, 250);
    },
  });
  const typeBtn = (value, label) => el("button", {
    type: "button", "aria-pressed": String(state.type === value),
    onclick: () => { state.type = value; store.set("type", value); if (state.query) doSearch(state.query); else render(); },
  }, label);

  const head = el("div", { class: "view-head" }, el("h1", { text: "Buscar" }));
  const bar = el("div", { class: "search-bar" },
    el("form", { class: "search-form", role: "search", onsubmit: (e) => { e.preventDefault(); doSearch(input.value); } },
      el("label", { class: "search-field" }, icon("search"), input, el("datalist", { id: "suggestions" })),
      el("button", { class: "btn primary search-go", type: "submit" }, "Buscar")),
    el("div", { class: "segmented", role: "group", "aria-label": "Dónde buscar" },
      typeBtn("youtube", "YouTube"), typeBtn("songs", "YouTube Music"), typeBtn("artists", "Artistas")));

  const problem = installProblem();
  let body;
  if (state.searching) body = el("p", { class: "loading", text: "Buscando…" });
  else if (state.searchError) body = el("div", { class: "error-box", text: state.searchError });
  else if (state.searched && !state.results.length)
    body = el("div", { class: "empty" }, el("strong", { text: `Sin resultados para “${state.query}”` }), "Probá con otro nombre o agregá el artista.");
  else if (state.results.length) {
    const playable = state.results.filter(isPlayable);
    body = el("div", {},
      el("div", { class: "toolbar", style: "margin-bottom:14px" },
        playable.length ? el("button", { class: "btn primary", onclick: () => playList(playable, 0) }, icon("play"), "Reproducir todo") : null,
        el("span", { class: "result-note", text: {
          youtube: "Resultados de YouTube, sin filtros",
          songs: "Canciones de YouTube Music",
          artists: state.results.some((r) => r.fromYouTube) ? "YouTube Music no respondió: canales de YouTube" : "Artistas de YouTube Music",
        }[state.type] })),
      el("ul", { class: "tracks" }, state.results.map((t) =>
        t.kind === "artist" ? artistRow(t)
          : t.kind === "playlist" || t.kind === "channel" ? collectionRow(t)
          : trackRow(t, isPlayable(t) ? playable : null, playable.indexOf(t)))),
      state.hasMore
        ? el("div", { class: "more-row" },
            el("button", { class: "btn", disabled: state.loadingMore, onclick: loadMoreResults },
              state.loadingMore ? "Cargando…" : "Cargar más resultados"))
        : null);
  } else {
    body = el("div", { class: "empty" }, el("strong", { text: "¿Qué querés escuchar?" }),
      { youtube: "Busca en todo YouTube, igual que su buscador: videos, Shorts, listas y canales.",
        songs: "Busca solo canciones en YouTube Music.",
        artists: "Busca un artista para ver toda su discografía: álbumes, EP y singles." }[state.type]);
  }
  if (!state.results.length && !state.searching) setTimeout(() => { if (input.isConnected) input.focus(); });
  return el("section", {}, head, problem, bar, body);
}

function installProblem() {
  const st = state.status;
  if (!st) return null;
  const lines = [];
  if (!st.pythonOk) lines.push(`Tu Python es ${st.python} y RiPlay necesita 3.10 o más nuevo. Instalá la última versión desde python.org, borrá la carpeta .venv dentro de RiPlayWeb y abrí de nuevo iniciar.bat.`);
  const missing = ["yt-dlp", "ytmusicapi"].filter((k) => !st[k]);
  if (missing.length && st.pythonOk) lines.push(`Falta instalar ${missing.join(" y ")}. Cerrá RiPlay y abrí de nuevo iniciar.bat con internet; si sigue, borrá la carpeta .venv y probá otra vez.`);
  if (!lines.length) return null;
  return el("div", { class: "error-box" }, el("strong", { text: "La búsqueda no puede funcionar todavía" }), ...lines.map((l) => el("p", { text: l })));
}

let searchSeq = 0;
async function doSearch(q) {
  q = q.trim();
  if (!q) return;
  const seq = ++searchSeq;
  state.query = q;
  state.draft = q;
  store.set("query", q);
  state.searching = true;
  state.loadingMore = false;
  state.searchError = null;
  render();
  try {
    const results = await api(`search?q=${encodeURIComponent(q)}&type=${state.type}`, { timeout: 75000 });
    if (seq !== searchSeq) return; // llegó tarde: ya hay una búsqueda más nueva
    state.results = results;
    state.page = 1;
    state.hasMore = state.type === "youtube" && state.results.length >= 10;
  } catch (err) {
    if (seq !== searchSeq) return;
    state.results = [];
    state.hasMore = false;
    state.searchError = err.message + (state.status && state.status.log ? `  (Detalle en ${state.status.log})` : "");
  }
  state.searching = false;
  state.searched = true;
  if (state.view === "search") render();
}

async function loadMoreResults() {
  if (state.loadingMore || !state.hasMore) return;
  state.loadingMore = true;
  render();
  const seq = searchSeq;
  try {
    const next = await api(`search?q=${encodeURIComponent(state.query)}&type=youtube&page=${state.page + 1}`, { timeout: 75000 });
    if (seq === searchSeq) { // si mientras tanto se hizo otra búsqueda, esta página se descarta
      const seen = new Set(state.results.map((t) => (t.kind || "video") + ":" + t.id));
      const fresh = next.filter((t) => !seen.has((t.kind || "video") + ":" + t.id));
      state.results = state.results.concat(fresh);
      state.page += 1;
      state.hasMore = next.length >= 10 && fresh.length > 0 && state.page < 20;
    }
  } catch (err) { if (seq === searchSeq) toast(err.message); }
  state.loadingMore = false;
  if (state.view === "search") render();
}

/* ============================================================ listas y canales de YouTube */

function collectionRow(item) {
  const isChannel = item.kind === "channel";
  const sub = isChannel
    ? ["Canal", item.followers ? `${fmtCount(item.followers)} suscriptores` : null]
    : ["Lista", item.count ? `${item.count} videos` : null, item.artist || null];
  const open = () => openCollection(item);
  const cover = coverImg(item);
  cover.classList.add(isChannel ? "cover-round" : "cover-stack");
  return el("li", { class: "track collection-row", ondblclick: open },
    cover,
    el("div", { class: "track-main" },
      el("button", { class: "play-hit", title: isChannel ? "Ver los videos del canal" : "Ver la lista", onclick: open },
        el("div", { class: "track-title", text: item.title || (isChannel ? "Canal" : "Lista") })),
      el("div", { class: "track-artist", text: sub.filter(Boolean).join(" · ") })),
    el("div", { class: "track-album" }),
    el("div", { class: "track-dur" }),
    el("div", { class: "track-actions" },
      el("button", { class: "btn", onclick: open }, isChannel ? "Ver canal" : "Ver lista")));
}

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",") + " M";
  if (n >= 1e3) return Math.round(n / 1e3) + " mil";
  return String(n);
}

function openCollection(item, back = null) {
  state.collection = { kind: item.kind, id: item.id, title: item.title, artist: item.artist || "", thumb: item.thumb,
                       tracks: [], page: 0, hasMore: true, loading: false, error: null, back };
  setView("col");
  loadCollectionPage();
}

async function loadCollectionPage() {
  const c = state.collection;
  if (!c || c.loading || !c.hasMore) return;
  c.loading = true;
  c.error = null;
  if (state.view === "col") render();
  try {
    const data = c.kind === "album"
      ? await api(`album?id=${encodeURIComponent(c.id)}`, { timeout: 90000 })
      : await api(`collection?kind=${c.kind}&id=${encodeURIComponent(c.id)}&page=${c.page + 1}`, { timeout: 90000 });
    if (c.kind === "album" && data.year) c.year = data.year;
    if (state.collection !== c) return;
    if (data.title) c.title = data.title;
    if (data.artist && !c.artist) c.artist = data.artist;
    const seen = new Set(c.tracks.map((t) => t.id));
    c.tracks = c.tracks.concat(data.tracks.filter((t) => !seen.has(t.id)));
    c.page += 1;
    c.hasMore = data.hasMore;
  } catch (err) {
    c.error = err.message;
  }
  c.loading = false;
  if (state.view === "col" && state.collection === c) render();
}

function renderCollection() {
  const c = state.collection;
  const playable = c.tracks.filter(isPlayable);
  const head = el("div", { class: "view-head" },
    el("div", { class: "col-head" },
      el("button", { class: "text-btn back-btn", onclick: () => setView(c.back ? c.back.view : "search") },
        "← " + (c.back ? c.back.label : "Volver a los resultados")),
      el("h1", { text: c.title || (c.kind === "channel" ? "Canal" : "Lista") })),
    el("div", { class: "toolbar" },
      playable.length ? el("button", { class: "btn primary", onclick: () => playList(playable, 0) }, icon("play"), "Reproducir todo") : null,
      playable.length ? el("button", { class: "btn", onclick: () => saveCollectionAsPlaylist(c) }, icon("plus"), "Guardar como lista") : null));
  const label = c.kind === "channel" ? "Videos del canal"
    : c.kind === "album" ? [RELEASE_LABEL[c.releaseKind] || "Álbum", c.year, c.artist].filter(Boolean).join(" · ")
    : ["Lista de YouTube", c.artist].filter(Boolean).join(" · ");
  const unit = c.kind === "album" ? (c.tracks.length === 1 ? "canción" : "canciones") : "videos";
  const count = c.tracks.length ? ` · ${c.tracks.length}${c.hasMore ? "+" : ""} ${unit}` : "";
  const sub = el("p", { class: "view-sub", text: label + count });
  let body;
  if (c.error) body = el("div", { class: "error-box", text: c.error });
  else if (!c.tracks.length && c.loading) body = el("p", { class: "loading", text: "Cargando videos…" });
  else if (!c.tracks.length) body = el("div", { class: "empty" }, el("strong", { text: "No hay videos para mostrar" }));
  else body = el("ul", { class: "tracks" }, c.tracks.map((t) => trackRow(t, isPlayable(t) ? playable : null, playable.indexOf(t))));
  const more = c.tracks.length && c.hasMore
    ? el("div", { class: "more-row" },
        el("button", { class: "btn", disabled: c.loading, onclick: loadCollectionPage }, c.loading ? "Cargando…" : "Cargar más videos"))
    : null;
  return el("section", {}, head, sub, body, more);
}

async function saveCollectionAsPlaylist(c) {
  const name = prompt("Nombre de la lista en RiPlay:", c.title || "");
  if (!name || !name.trim()) return;
  try {
    const pl = await api("playlists", { method: "POST", body: { name: name.trim(), tracks: c.tracks.filter(isPlayable) } });
    state.playlists.push(pl);
    toast(`Lista “${pl.name}” guardada con ${pl.tracks.length} videos${c.hasMore ? " (los cargados hasta ahora)" : ""}`);
    renderNav();
  } catch (err) { toast(err.message); }
}

/* ============================================================ artistas y discografía */

const RELEASE_LABEL = { album: "Álbum", single: "Single", ep: "EP" };
const SORTS = [
  ["year-desc", "Año: más nuevos primero"],
  ["year-asc", "Año: más viejos primero"],
  ["popularity", "Relevancia"],
  ["likes", "Tus me gusta"],
];

function artistRow(item) {
  const open = () => openArtist(item);
  const cover = coverImg(item);
  cover.classList.add("cover-round");
  return el("li", { class: "track collection-row", ondblclick: open },
    cover,
    el("div", { class: "track-main" },
      el("button", { class: "play-hit", title: "Ver discografía", onclick: open },
        el("div", { class: "track-title", text: item.title || "Artista" })),
      el("div", { class: "track-artist", text: ["Artista", item.subscribers ? `${item.subscribers} suscriptores` : null].filter(Boolean).join(" · ") })),
    el("div", { class: "track-album" }),
    el("div", { class: "track-dur" }),
    el("div", { class: "track-actions" }, el("button", { class: "btn", onclick: open }, "Ver artista")));
}

function openArtist(item) {
  state.artist = {
    id: item.id, name: item.title || "", thumb: item.thumb, data: null, loading: true, error: null,
    filter: "all", sort: store.get("artistSort", "year-desc"), popOrder: null, popLoading: false,
  };
  setView("artist");
  loadArtist(state.artist);
}

async function loadArtist(a) {
  try {
    const data = await api("artist?id=" + encodeURIComponent(a.id), { timeout: 90000 });
    if (state.artist !== a) return;
    a.data = data;
    a.name = data.name || a.name;
    a.thumb = data.thumb || a.thumb;
    if (a.sort === "popularity") loadPopularity(a);
  } catch (err) {
    if (state.artist !== a) return;
    a.error = err.message;
  }
  a.loading = false;
  if (state.view === "artist" && state.artist === a) render();
}

async function loadPopularity(a) {
  if (a.popOrder || a.popLoading) return;
  a.popLoading = true;
  try {
    const ids = await api(`artist/order?id=${encodeURIComponent(a.id)}&order=popularity`, { timeout: 90000 });
    a.popOrder = new Map(ids.map((id, i) => [id, i]));
  } catch (err) { toast("No se pudo ordenar por relevancia: " + err.message); }
  a.popLoading = false;
  if (state.view === "artist" && state.artist === a) render();
}

const normTitle = (s) => (s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/\s*[\(\[].*?[\)\]]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Cuántas canciones de cada lanzamiento están en Favoritos (por nombre del álbum)
function likesByRelease(a) {
  const fav = favoritesPl();
  const counts = new Map();
  if (!fav) return counts;
  const name = normTitle(a.name);
  for (const t of fav.tracks) {
    if (!t.album) continue;
    if (name && t.artist && !normTitle(t.artist).includes(name) && t.artistId !== a.id) continue;
    const key = normTitle(t.album);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function sortedReleases(a) {
  const likes = likesByRelease(a);
  let list = a.data.releases.map((r) => ({ ...r, likes: likes.get(normTitle(r.title)) || 0 }));
  if (a.filter === "album") list = list.filter((r) => r.kind === "album");
  if (a.filter === "single") list = list.filter((r) => r.kind !== "album");
  const byYear = (dir) => (x, y) => (x.year == null) - (y.year == null) || dir * ((x.year || 0) - (y.year || 0)) || x.rank - y.rank;
  if (a.sort === "year-asc") list.sort(byYear(1));
  else if (a.sort === "popularity" && a.popOrder) {
    const pos = (r) => (a.popOrder.has(r.id) ? a.popOrder.get(r.id) : 1e6 + r.rank);
    list.sort((x, y) => pos(x) - pos(y));
  } else if (a.sort === "likes") list.sort((x, y) => y.likes - x.likes || byYear(-1)(x, y));
  else list.sort(byYear(-1));
  return list;
}

function releaseCard(r, a) {
  const open = () => openAlbum(r, a);
  const meta = [RELEASE_LABEL[r.kind], r.year].filter(Boolean).join(" · ");
  return el("li", { class: "release" },
    el("button", { class: "release-hit", onclick: open, title: `Ver ${r.title}` },
      r.thumb ? el("img", { class: "release-cover", src: r.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
        : el("div", { class: "release-cover blank" }, icon("disk")),
      el("span", { class: "release-title", text: r.title }),
      el("span", { class: "release-meta" }, meta,
        r.likes ? el("span", { class: "release-likes", title: `${r.likes} en Favoritos` }, icon("heart-fill"), String(r.likes)) : null)));
}

function openAlbum(r, a) {
  state.collection = {
    kind: "album", id: r.id, title: r.title, artist: a ? a.name : "", thumb: r.thumb, year: r.year, releaseKind: r.kind,
    tracks: [], page: 0, hasMore: true, loading: false, error: null,
    back: a ? { view: "artist", label: `Volver a ${a.name}` } : null,
  };
  setView("col");
  loadCollectionPage();
}

function renderArtist() {
  const a = state.artist;
  const back = el("button", { class: "text-btn back-btn", onclick: () => setView("search") }, "← Volver a la búsqueda");
  const cover = a.thumb ? el("img", { class: "artist-photo", src: a.thumb, alt: "", referrerpolicy: "no-referrer" })
    : el("div", { class: "artist-photo blank" }, icon("artist"));
  const d = a.data;
  const head = el("div", { class: "artist-head" }, cover,
    el("div", { class: "artist-info" }, back,
      el("h1", { text: a.name || "Artista" }),
      el("p", { class: "view-sub", text: d ? [d.subscribers ? `${d.subscribers} suscriptores` : null,
        `${d.releases.length} lanzamientos`].filter(Boolean).join(" · ") : "" })));
  if (a.loading) return el("section", {}, head, el("p", { class: "loading", text: "Cargando discografía…" }));
  if (a.error) return el("section", {}, head, el("div", { class: "error-box" }, a.error),
    el("button", { class: "btn", onclick: () => openCollection({ kind: "channel", id: a.id, title: a.name }, { view: "artist", label: `Volver a ${a.name}` }) }, "Ver los videos del canal"));

  const fav = likesByRelease(a);
  const top = a.sort === "likes" ? [...d.topSongs].sort((x, y) => isLiked(y) - isLiked(x)) : d.topSongs;
  const popular = el("section", { class: "artist-section" },
    el("div", { class: "section-head" },
      el("h2", { class: "section-title", text: "Populares" }),
      el("div", { class: "toolbar" },
        top.length ? el("button", { class: "btn primary", onclick: () => playList(top, 0) }, icon("play"), "Reproducir") : null,
        d.songsPlaylist ? el("button", { class: "btn", onclick: () => openCollection({ kind: "playlist", id: d.songsPlaylist, title: `Canciones de ${a.name}` }, { view: "artist", label: `Volver a ${a.name}` }) }, "Ver todas") : null)),
    top.length ? el("ul", { class: "tracks" }, top.slice(0, 10).map((t, i) => trackRow(t, top, i)))
      : el("p", { class: "hint", text: "YouTube Music no muestra canciones populares para este artista." }));

  const counts = { all: d.releases.length, album: d.releases.filter((r) => r.kind === "album").length };
  counts.single = counts.all - counts.album;
  const chip = (id, label) => el("button", {
    class: "chip", "aria-pressed": String(a.filter === id),
    onclick: () => { a.filter = id; render(); },
  }, `${label} ${counts[id]}`);
  const sortSel = el("select", {
    class: "sort-select", "aria-label": "Ordenar discografía",
    onchange: (e) => {
      a.sort = e.target.value;
      store.set("artistSort", a.sort);
      if (a.sort === "popularity") loadPopularity(a);
      render();
    },
  }, SORTS.map(([v, label]) => el("option", { value: v, selected: a.sort === v }, label)));
  const releases = sortedReleases(a);
  const discog = el("section", { class: "artist-section" },
    el("div", { class: "section-head" },
      el("h2", { class: "section-title", text: "Discografía" }),
      el("div", { class: "discog-controls" },
        el("div", { class: "chips" }, chip("all", "Todo"), chip("album", "Álbumes"), chip("single", "Singles y EP")),
        sortSel)),
    a.sort === "popularity" && a.popLoading ? el("p", { class: "hint", text: "Ordenando por relevancia…" }) : null,
    a.sort === "likes" && !fav.size ? el("p", { class: "hint", text: "Todavía no tenés canciones de este artista en Favoritos: se muestran por año." }) : null,
    releases.length ? el("ul", { class: "release-grid" }, releases.map((r) => releaseCard(r, a)))
      : el("p", { class: "hint", text: "No hay lanzamientos en esta categoría." }));
  return el("section", {}, head, popular, discog);
}

/* ============================================================ vista: en el disco */

function renderLocal() {
  if (state.local == null) {
    loadLocal();
    return el("section", {}, el("div", { class: "view-head" }, el("h1", { text: "En el disco" })), el("p", { class: "loading", text: "Leyendo la carpeta…" }));
  }
  const folder = state.config ? state.config.downloadDir : "";
  const head = el("div", { class: "view-head" },
    el("h1", { text: "En el disco" }),
    el("div", { class: "toolbar" },
      state.local.length ? el("button", { class: "btn primary", onclick: () => playList(state.local, 0) }, icon("play"), "Reproducir todo") : null,
      el("button", { class: "btn", onclick: () => api("open-folder", { method: "POST" }).catch((e) => toast(e.message)) }, icon("disk"), "Abrir carpeta"),
      el("button", { class: "btn", onclick: changeFolder }, "Cambiar carpeta")));
  const line = el("div", { class: "folder-line" }, "Se guardan en", el("code", { text: folder }));

  const active = Object.entries(state.downloads).filter(([, d]) => d.status === "queued" || d.status === "downloading" || d.status === "error");
  const pending = active.length ? el("div", { style: "margin-bottom:26px" },
    el("h2", { class: "section-title", text: "Descargas" }),
    el("ul", { class: "tracks" }, active.map(([id, d]) => {
      const t = d.track || { id, title: id };
      const status = d.status === "error" ? d.error : d.status === "queued" ? "En espera" : d.progress != null ? `${Math.round(d.progress * 100)}%` : "Descargando…";
      const isError = d.status === "error";
      return el("li", { class: "track" }, coverImg(t),
        el("div", { class: "track-main" },
          el("div", { class: "track-title", text: t.title }),
          el("div", { class: "track-artist dl-status" + (isError ? " is-error" : ""), text: isError ? status : [status, t.artist].filter(Boolean).join("  ·  ") })),
        el("div", { class: "track-album", text: isError ? "" : t.album || "" }),
        el("div", { class: "track-dur", text: "" }),
        el("div", { class: "track-actions" }, isError ? [
          el("button", { class: "icon-btn", title: "Reintentar", "aria-label": "Reintentar descarga", onclick: () => download(t) }, icon("download")),
          el("button", { class: "icon-btn", title: "Descartar", "aria-label": "Descartar descarga fallida", onclick: () => dismissDownload(id) }, icon("close")),
        ] : null));
    }))) : null;

  const body = state.local.length ? trackList(state.local, { source: "local" }) :
    el("div", { class: "empty" }, el("strong", { text: "Todavía no hay canciones guardadas" }),
      "Usá el botón de descarga en cualquier canción y va a aparecer acá, lista para escuchar sin internet.");
  return el("section", {}, head, line, pending, body);
}

async function loadLocal() {
  try {
    const [files, config] = await Promise.all([api("local"), api("config")]);
    state.local = files;
    state.config = config;
  } catch (err) {
    state.local = [];
    toast(err.message);
  }
  if (state.view === "local") render();
}

async function changeFolder() {
  const current = state.config ? state.config.downloadDir : "";
  const value = prompt("Carpeta donde guardar las descargas (ruta completa):", current);
  if (!value || value.trim() === current) return;
  try {
    state.config = { ...state.config, ...(await api("config", { method: "POST", body: { downloadDir: value.trim() } })) };
    state.local = null;
    toast("Carpeta cambiada");
    render();
  } catch (err) { toast(err.message); }
}

/* ============================================================ vista: lista */

function renderPlaylist(pl) {
  const head = el("div", { class: "view-head" },
    el("h1", { text: pl.name }),
    el("div", { class: "toolbar" },
      pl.tracks.length ? el("button", { class: "btn primary", onclick: () => playList(pl.tracks, 0) }, icon("play"), "Reproducir") : null,
      pl.tracks.length ? el("button", { class: "btn", onclick: () => downloadAll(pl.tracks) }, icon("download"), "Descargar todas") : null,
      pl.special === "favorites" ? null : el("button", { class: "btn", onclick: () => renamePlaylist(pl) }, "Renombrar"),
      el("button", { class: "btn danger", onclick: () => deletePlaylist(pl) }, "Borrar lista")));
  const total = pl.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const sub = el("p", { class: "view-sub", text: pl.tracks.length ? `${pl.tracks.length} ${pl.tracks.length === 1 ? "canción" : "canciones"}, ${fmt(total)}` : "" });
  const body = pl.tracks.length ? trackList(pl.tracks, { playlist: pl }) :
    pl.special === "favorites"
      ? el("div", { class: "empty" }, el("strong", { text: "Todavía no hay favoritas" }),
          "Tocá el corazón de cualquier canción y va a aparecer acá.")
      : el("div", { class: "empty" }, el("strong", { text: "Esta lista está vacía" }),
          "En Buscar o En el disco, abrí el menú ⋯ de una canción y elegí “", pl.name, "”.");
  return el("section", {}, head, sub, body);
}

async function loadPlaylists() {
  try { state.playlists = await api("playlists"); } catch (err) { toast(err.message); }
  render();
}

function createPlaylist(withTrack) {
  openPlaylistDialog("empty", withTrack || null);
}

/* ============================================================ diálogo nueva lista / importar */

const dlg = $("#pl-dialog");
let dlgPendingTrack = null;
let importJob = null;      // última importación (en curso o terminada)
let importTimer = null;

function setDialogMode(mode) {
  dlg.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== mode; });
  const tabs = dlg.querySelector(".dialog-tabs");
  tabs.hidden = mode === "progress";
  tabs.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  $("#pl-dialog-title").textContent = mode === "empty" ? "Nueva lista" : "Importar de Spotify";
  dlg.dataset.mode = mode;
  setTimeout(() => {
    const focus = mode === "empty" ? $("#pl-name") : mode === "spotify" ? $("#sp-text") : null;
    if (focus) focus.focus();
  });
}

function openPlaylistDialog(mode, track = null) {
  closeMenu();
  dlgPendingTrack = track;
  const pending = $("#pl-pending");
  pending.hidden = !track;
  if (track) pending.textContent = `Se va a agregar “${track.title}” a la lista nueva.`;
  $("#pl-name").value = "";
  const running = importJob && (importJob.stage === "queued" || importJob.stage === "reading" || importJob.stage === "matching");
  setDialogMode(running && mode === "spotify" ? "progress" : mode);
  if (running && mode === "spotify") renderImport();
  if (!dlg.open) dlg.showModal();
}

dlg.querySelectorAll(".dialog-tabs [data-mode]").forEach((b) => b.addEventListener("click", () => setDialogMode(b.dataset.mode)));
$("#pl-dialog-close").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // clic afuera

$("#pl-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (dlg.dataset.mode === "empty") return submitNewPlaylist();
  if (dlg.dataset.mode === "spotify") return submitImport();
});

async function submitNewPlaylist() {
  const input = $("#pl-name");
  const name = input.value.trim();
  if (!name) { input.focus(); toast("Escribí un nombre para la lista"); return; }
  const btn = $("#pl-create");
  btn.disabled = true;
  try {
    const pl = await api("playlists", { method: "POST", body: { name } });
    state.playlists.push(pl);
    dlg.close();
    if (dlgPendingTrack) { await addToPlaylist(pl, dlgPendingTrack); renderNav(); }
    else { toast(`Lista “${pl.name}” creada`); setView("pl:" + pl.id); }
  } catch (err) { toast(err.message); }
  btn.disabled = false;
}

async function submitImport() {
  const text = $("#sp-text").value.trim();
  const file = $("#sp-csv").files[0];
  if (!text && !file) { $("#sp-text").focus(); toast("Pegá el enlace de la lista de Spotify"); return; }
  const btn = $("#sp-start");
  btn.disabled = true;
  try {
    const csv = file ? await file.text() : "";
    importJob = await api("import", { method: "POST", body: { text: file ? "" : text, csv, name: $("#sp-name").value.trim() } });
    setDialogMode("progress");
    renderImport();
    pollImport();
  } catch (err) { toast(err.message); }
  btn.disabled = false;
}

async function pollImport() {
  clearTimeout(importTimer);
  if (!importJob) return;
  try {
    importJob = await api("import/" + importJob.id);
  } catch (err) {
    importJob = { ...importJob, stage: "error", error: err.message };
  }
  renderImport();
  if (importJob.stage === "done") {
    await loadPlaylists();
    if (!dlg.open) toast(`Lista importada: ${importJob.name} (${importJob.found} canciones)`);
  } else if (importJob.stage === "error") {
    if (!dlg.open) toast(`No se pudo importar: ${importJob.error}`);
  } else {
    importTimer = setTimeout(pollImport, 700);
  }
}

function renderImport() {
  const j = importJob;
  if (!j) return;
  const running = j.stage === "queued" || j.stage === "reading" || j.stage === "matching";
  const badge = $("#import-badge");
  badge.hidden = !running;
  badge.textContent = j.total ? `${Math.round(((j.done || 0) / j.total) * 100)}%` : "…";

  const bar = $("#imp-bar");
  const title = $("#imp-title"), detail = $("#imp-detail");
  bar.classList.toggle("indeterminate", j.stage === "queued" || j.stage === "reading");
  if (j.stage === "queued" || j.stage === "reading") {
    title.textContent = "Leyendo la lista de Spotify…";
    detail.textContent = j.readCount ? `${j.readCount}${j.total ? " de " + j.total : ""} canciones leídas` : "";
    bar.style.width = "";
  } else if (j.stage === "matching") {
    title.textContent = `Buscando en YouTube: ${j.done} de ${j.total}`;
    detail.textContent = `“${j.name}”. Encontradas: ${j.found || 0}. Sin encontrar: ${j.missingCount || 0}. Podés cerrar esta ventana, sigue en segundo plano.`;
    bar.style.width = (j.total ? (j.done / j.total) * 100 : 0) + "%";
  } else if (j.stage === "done") {
    title.textContent = `Listo: “${j.name}”`;
    detail.textContent = `Se agregaron ${j.found} ${j.found === 1 ? "canción" : "canciones"}${j.missing && j.missing.length ? ` de ${j.found + j.missing.length}` : ""}.`;
    bar.style.width = "100%";
  } else if (j.stage === "error") {
    title.textContent = "No se pudo importar";
    detail.textContent = "";
    bar.style.width = "0";
  }
  const warning = $("#imp-warning");
  warning.hidden = !j.warning;
  warning.textContent = j.warning || "";
  const missing = (j.stage === "done" && j.missing) || [];
  $("#imp-missing").hidden = !missing.length;
  $("#imp-missing-title").textContent = `No se encontraron en YouTube (${missing.length}):`;
  $("#imp-missing-list").replaceChildren(...missing.map((m) => el("li", { text: m.artist ? `${m.artist} - ${m.title}` : m.title })));
  const error = $("#imp-error");
  error.hidden = j.stage !== "error";
  error.textContent = j.error || "";
  $("#imp-open").hidden = j.stage !== "done";
  $("#imp-again").hidden = running;
  $("#imp-background").hidden = !running;
}

$("#imp-open").addEventListener("click", () => { dlg.close(); if (importJob && importJob.playlistId) setView("pl:" + importJob.playlistId); });
$("#imp-again").addEventListener("click", () => { $("#sp-text").value = ""; $("#sp-csv").value = ""; $("#sp-name").value = ""; setDialogMode("spotify"); });
$("#imp-background").addEventListener("click", () => dlg.close());

async function addToPlaylist(pl, t) {
  try {
    const updated = await api(`playlists/${pl.id}/tracks`, { method: "POST", body: { track: t } });
    Object.assign(pl, updated);
    toast(`Agregada a ${pl.name}`);
    render();
  } catch (err) { toast(err.message); }
}

async function removeFromPlaylist(pl, position) {
  if (pl.special === "favorites" && pl.tracks[position]) return toggleLike(pl.tracks[position]);
  try {
    Object.assign(pl, await api(`playlists/${pl.id}/tracks/${position}`, { method: "DELETE" }));
    render();
  } catch (err) { toast(err.message); }
}

async function movInPlaylist(pl, position, delta) {
  const target = position + delta;
  if (target < 0 || target >= pl.tracks.length) return;
  const order = pl.tracks.map((_, i) => i);
  [order[position], order[target]] = [order[target], order[position]];
  try {
    Object.assign(pl, await api(`playlists/${pl.id}`, { method: "PATCH", body: { order } }));
    render();
  } catch (err) { toast(err.message); }
}

async function renamePlaylist(pl) {
  const name = prompt("Nuevo nombre:", pl.name);
  if (!name || !name.trim() || name.trim() === pl.name) return;
  try { Object.assign(pl, await api(`playlists/${pl.id}`, { method: "PATCH", body: { name: name.trim() } })); render(); }
  catch (err) { toast(err.message); }
}

async function deletePlaylist(pl) {
  if (!confirm(`¿Borrar la lista “${pl.name}”? Las canciones descargadas no se borran.`)) return;
  try {
    await api(`playlists/${pl.id}`, { method: "DELETE" });
    state.playlists = state.playlists.filter((p) => p.id !== pl.id);
    toast("Lista borrada");
    setView("search");
  } catch (err) { toast(err.message); }
}

/* ============================================================ menú contextual */

function closeMenu() {
  const menu = $("#menu");
  if (menu.hidden) return;
  menu.hidden = true;
  if (menu._opener) menu._opener.focus({ preventScroll: true });
}

function openMenu(anchor, items) {
  const menu = $("#menu");
  menu._opener = anchor;
  menu.replaceChildren(...items.map((it) => {
    if (it === "-") return el("hr");
    if (it.label) return el("div", { class: "menu-label", text: it.label });
    return el("button", {
      role: "menuitem", class: it.danger ? "danger" : null,
      onclick: () => { menu.hidden = true; it.action(); },
    }, it.icon ? icon(it.icon) : null, it.text);
  }));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = top + "px";
  const first = menu.querySelector("button");
  if (first) first.focus();
}

function openTrackMenu(anchor, t, ctx) {
  const liked = isLiked(t);
  const items = [
    ...(likeKey(t) && !(ctx.playlist && ctx.playlist.special === "favorites")
      ? [{ icon: liked ? "heart-fill" : "heart", text: liked ? "Quitar de Favoritos" : "Me gusta", action: () => toggleLike(t) }]
      : []),
    ...(isPlayable(t) ? [
      { icon: "play", text: "Reproducir a continuación", action: () => playNext(t) },
      { icon: "queue", text: "Agregar a la cola", action: () => enqueue(t) },
    ] : []),
  ];
  if (t.id) items.push({ icon: "radio", text: "Iniciar radio", action: () => startRadio(t) });
  if (t.artistId) items.push({ icon: "artist", text: "Ir al artista", action: () => openArtist({ id: t.artistId, title: (t.artist || "").split(",")[0] }) });
  if (t.id && !t.local && !t.live) items.push({ icon: "download", text: "Descargar", action: () => download(t) });
  items.push("-", { label: "Agregar a una lista" });
  for (const pl of state.playlists) {
    if (ctx.playlist && pl.id === ctx.playlist.id) continue;
    if (pl.special === "favorites") continue; // se agrega con el corazón
    items.push({ icon: "list", text: pl.name, action: () => addToPlaylist(pl, t) });
  }
  items.push({ icon: "plus", text: "Nueva lista…", action: () => createPlaylist(t) });
  if (ctx.playlist) {
    const pos = ctx.position;
    items.push("-");
    if (pos > 0) items.push({ text: "Subir", action: () => movInPlaylist(ctx.playlist, pos, -1) });
    if (pos < ctx.playlist.tracks.length - 1) items.push({ text: "Bajar", action: () => movInPlaylist(ctx.playlist, pos, 1) });
    items.push({ icon: "close", text: `Quitar de ${ctx.playlist.name}`, danger: true, action: () => removeFromPlaylist(ctx.playlist, pos) });
  }
  openMenu(anchor, items);
}

document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) closeMenu(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== "range";
  if (typing || dlg.open) return;
  if (e.code === "Space" && !e.target.closest("button")) { e.preventDefault(); togglePlay(); }
  if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); next(); }
  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); prev(); }
});
window.addEventListener("resize", closeMenu);
$("#main").addEventListener("scroll", closeMenu);

/* ============================================================ descargas */

let pollTimer;
async function download(t) {
  try {
    const d = await api("downloads", { method: "POST", body: { track: t } });
    state.downloads[t.id] = d;
    toast(d.status === "done" ? "Ya está guardada en el disco" : `Descargando ${t.title}`);
    if (state.view === "local") render(); else { refreshDownloadButtons(); renderNav(); }
    updateDownloadCurrent();
    pollDownloads();
  } catch (err) { toast(err.message); }
}

async function dismissDownload(id) {
  try {
    await api("downloads/" + encodeURIComponent(id), { method: "DELETE" });
    delete state.downloads[id];
    render();
  } catch (err) { toast(err.message); }
}

async function downloadAll(tracks) {
  for (const t of tracks) if (t.id && !t.local) await download(t);
}

async function pollDownloads() {
  clearTimeout(pollTimer);
  let list;
  try { list = await api("downloads"); } catch { return; }
  let finished = false;
  for (const d of list) {
    const before = state.downloads[d.id];
    if (before && before.status !== "done" && d.status === "done") { finished = true; toast(`Guardada: ${d.track ? d.track.title : d.file}`); }
    if (before && before.status !== "error" && d.status === "error") toast(`No se pudo descargar: ${d.error}`);
    state.downloads[d.id] = d;
  }
  if (finished) state.local = null; // recargar "En el disco"
  if (state.view === "local") render(); else { refreshDownloadButtons(); renderNav(); }
  updateDownloadCurrent();
  if (list.some((d) => d.status === "queued" || d.status === "downloading")) pollTimer = setTimeout(pollDownloads, 900);
}

/* ============================================================ reproductor */

function saveQueue() {
  store.set("queue", state.queue.slice(-500));
  store.set("index", state.index);
}

function srcFor(t) {
  return t.local ? "/api/local/" + encodeURIComponent(t.local) : "/api/stream/" + encodeURIComponent(t.id);
}

function playList(list, i) {
  state.queue = list.map((t) => ({ ...t }));
  playIndex(i);
}

function playIndex(i, autoplay = true) {
  if (i < 0 || i >= state.queue.length) return;
  state.index = i;
  saveQueue();
  const t = state.queue[i];
  audio.src = srcFor(t);
  if (autoplay) {
    $("#btn-play").classList.add("busy");
    audio.play().catch((err) => {
      $("#btn-play").classList.remove("busy");
      if (err.name !== "AbortError") toast("No se pudo reproducir. Probá de nuevo o elegí otra canción.");
    });
  }
  updateNow();
  renderQueue();
  render();
}

function playNext(t) {
  if (state.index < 0) return playList([t], 0);
  state.queue.splice(state.index + 1, 0, { ...t });
  saveQueue(); renderQueue();
  toast("Suena a continuación");
}

function enqueue(t) {
  if (state.index < 0) return playList([t], 0);
  state.queue.push({ ...t });
  saveQueue(); renderQueue();
  toast("Agregada a la cola");
}

async function startRadio(t) {
  toast("Buscando canciones parecidas…");
  try {
    const related = await api("radio/" + encodeURIComponent(t.id));
    playList([t, ...related], 0);
  } catch (err) { toast(err.message); }
}

function togglePlay() {
  if (state.index < 0) {
    const list = state.view === "local" ? state.local : state.results;
    if (list && list.length) playList(list, 0);
    return;
  }
  if (!audio.src) return playIndex(state.index);
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

async function next(fromEnded = false) {
  if (fromEnded && state.repeat === "one") { audio.currentTime = 0; return audio.play(); }
  if (state.index + 1 < state.queue.length) return playIndex(state.index + 1);
  if (state.repeat === "all" && state.queue.length) return playIndex(0);
  const last = state.queue[state.index];
  if (fromEnded && state.radioAuto && last && last.id) {
    try {
      const seen = new Set(state.queue.map(key));
      const more = (await api("radio/" + encodeURIComponent(last.id))).filter((t) => !seen.has(key(t)));
      if (more.length) { state.queue.push(...more); return playIndex(state.index + 1); }
    } catch { /* sin radio: se detiene */ }
  }
}

function prev() {
  if (audio.currentTime > 3 || state.index <= 0) { audio.currentTime = 0; return; }
  playIndex(state.index - 1);
}

function shuffleQueue() {
  if (state.queue.length < 3) return;
  const head = state.queue.slice(0, state.index + 1);
  const rest = state.queue.slice(state.index + 1);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  state.queue = [...head, ...rest];
  saveQueue(); renderQueue();
  toast("Cola mezclada");
}

function cycleRepeat() {
  state.repeat = { off: "all", all: "one", one: "off" }[state.repeat];
  store.set("repeat", state.repeat);
  updateRepeat();
}

function updateRepeat() {
  const b = $("#btn-repeat");
  b.classList.toggle("on", state.repeat !== "off");
  $(".repeat-one", b).hidden = state.repeat !== "one";
  const label = { off: "Repetir: no", all: "Repetir: toda la cola", one: "Repetir: esta canción" }[state.repeat];
  b.title = label;
  b.setAttribute("aria-label", label);
}

function updateNow() {
  const t = state.queue[state.index];
  const cover = $("#now-cover");
  if (!t) {
    $("#now-title").textContent = "Nada sonando";
    $("#now-artist").textContent = "Elegí una canción para empezar";
    cover.hidden = true;
    document.title = "RiPlay";
    updateLikeCurrent();
    return;
  }
  $("#now-title").textContent = t.title || "Sin título";
  $("#now-artist").textContent = [t.artist, t.album].filter(Boolean).join(" — ") || (t.local ? "Archivo local" : "");
  if (t.thumb) { cover.src = t.thumb; cover.hidden = false; } else cover.hidden = true;
  document.title = `${t.title} — RiPlay`;
  updateDownloadCurrent();
  updateLikeCurrent();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title || "", artist: t.artist || "", album: t.album || "",
      artwork: t.thumb ? [{ src: t.thumb.replace(/=w\d+-h\d+/, "=w512-h512"), sizes: "512x512" }] : [],
    });
  }
}

function updateDownloadCurrent() {
  const t = state.queue[state.index];
  const b = $("#btn-dl-current");
  const d = t && t.id ? state.downloads[t.id] : null;
  b.disabled = !t || !!t.local || !t.id || (d && d.status !== "error");
  b.title = d && d.status === "done" ? "Ya está guardada" : d && d.status !== "error" ? "Descargando…" : "Descargar esta canción";
}

function renderQueue() {
  const list = $("#queue-list");
  if (!state.queue.length) {
    list.replaceChildren(el("li", { class: "empty", style: "padding:20px 12px;font-size:15px", text: "La cola está vacía. Reproducí algo o usá “Agregar a la cola”." }));
    return;
  }
  list.replaceChildren(...state.queue.map((t, i) =>
    el("li", {
      class: "q-item" + (i === state.index ? " current" : i < state.index ? " past" : ""),
      onclick: () => playIndex(i),
    },
      coverImg(t, 40),
      el("div", { class: "track-main" }, el("div", { class: "track-title", text: t.title }), el("div", { class: "track-artist", text: t.artist || "" })),
      i === state.index ? null : el("button", {
        class: "icon-btn small", title: "Quitar de la cola", "aria-label": `Quitar ${t.title} de la cola`,
        onclick: (e) => {
          e.stopPropagation();
          state.queue.splice(i, 1);
          if (i < state.index) state.index--;
          saveQueue(); renderQueue();
        },
      }, icon("close")))
  ));
  const cur = list.children[state.index];
  if (cur && !$("#queue").hidden) cur.scrollIntoView({ block: "nearest" });
}

/* ---- eventos del <audio> */
const seek = $("#seek");
let seeking = false;

audio.addEventListener("playing", () => $("#btn-play").classList.remove("busy"));
audio.addEventListener("waiting", () => $("#btn-play").classList.add("busy"));
audio.addEventListener("play", syncPlayButton);
audio.addEventListener("pause", syncPlayButton);
audio.addEventListener("ended", () => next(true));
audio.addEventListener("error", () => {
  $("#btn-play").classList.remove("busy");
  if (!audio.src || state.index < 0) return;
  toast("No se pudo cargar esta canción. Paso a la siguiente.");
  setTimeout(() => next(true), 1200);
});
audio.addEventListener("loadedmetadata", updateTime);
audio.addEventListener("timeupdate", () => { if (!seeking) updateTime(); });

function syncPlayButton() {
  const playing = !audio.paused;
  const b = $("#btn-play");
  b.replaceChildren(icon(playing ? "pause" : "play"));
  b.title = playing ? "Pausar" : "Reproducir";
  b.setAttribute("aria-label", b.title);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
}

function updateTime() {
  const d = audio.duration || (state.queue[state.index] || {}).duration || 0;
  const c = audio.currentTime || 0;
  seek.disabled = !d;
  const v = d ? Math.round((c / d) * 1000) : 0;
  seek.value = v;
  seek.style.setProperty("--p", v / 10 + "%");
  seek.setAttribute("aria-valuetext", `${fmt(c)} de ${fmt(d)}`);
  $("#time").textContent = `${fmt(c)} / ${fmt(d)}`;
}

seek.addEventListener("input", () => {
  seeking = true;
  const d = audio.duration || 0;
  seek.style.setProperty("--p", seek.value / 10 + "%");
  $("#time").textContent = `${fmt((seek.value / 1000) * d)} / ${fmt(d)}`;
});
seek.addEventListener("change", () => {
  const d = audio.duration || 0;
  if (d) audio.currentTime = (seek.value / 1000) * d;
  seeking = false;
});

/* ---- botones */
$("#btn-play").addEventListener("click", togglePlay);
$("#btn-next").addEventListener("click", () => next());
$("#btn-prev").addEventListener("click", prev);
$("#btn-shuffle").addEventListener("click", shuffleQueue);
$("#btn-repeat").addEventListener("click", cycleRepeat);
$("#btn-like").addEventListener("click", (e) => { const t = state.queue[state.index]; if (t) toggleLike(t, e.currentTarget); });
$("#btn-dl-current").addEventListener("click", () => { const t = state.queue[state.index]; if (t) download(t); });
$("#btn-queue").addEventListener("click", () => {
  const q = $("#queue");
  q.hidden = !q.hidden;
  $("#btn-queue").classList.toggle("on", !q.hidden);
  if (!q.hidden) renderQueue();
});
$("#queue-close").addEventListener("click", () => { $("#queue").hidden = true; $("#btn-queue").classList.remove("on"); });
$("#queue-clear").addEventListener("click", () => {
  const cur = state.queue[state.index];
  state.queue = cur ? [cur] : [];
  state.index = cur ? 0 : -1;
  saveQueue(); renderQueue();
});
const radioAuto = $("#radio-auto");
radioAuto.checked = state.radioAuto;
radioAuto.addEventListener("change", () => { state.radioAuto = radioAuto.checked; store.set("radioAuto", state.radioAuto); });

const volume = $("#volume");
volume.value = audio.volume;
volume.addEventListener("input", () => { audio.volume = +volume.value; audio.muted = false; });
audio.addEventListener("volumechange", () => {
  store.set("volume", audio.volume);
  $("#btn-mute").replaceChildren(icon(audio.muted || audio.volume === 0 ? "mute" : "volume"));
});
$("#btn-mute").addEventListener("click", () => { audio.muted = !audio.muted; });

document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("#new-playlist").addEventListener("click", () => openPlaylistDialog("empty"));
$("#import-spotify").addEventListener("click", () => openPlaylistDialog("spotify"));

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => audio.play());
  ms.setActionHandler("pause", () => audio.pause());
  ms.setActionHandler("nexttrack", () => next());
  ms.setActionHandler("previoustrack", prev);
  try { ms.setActionHandler("seekto", (d) => { audio.currentTime = d.seekTime; }); } catch { /* no soportado */ }
}

/* ============================================================ inicio */

/* ============================================================ instalar como app (PWA) */

let installPrompt = null;
const installBtn = $("#install-app");
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // el botón propio reemplaza al aviso del navegador
  installPrompt = e;
  installBtn.hidden = isStandalone();
});
installBtn.addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  if (outcome === "accepted") installBtn.hidden = true;
  installPrompt = null;
});
window.addEventListener("appinstalled", () => {
  installBtn.hidden = true;
  installPrompt = null;
  toast("RiPlay quedó instalado. Lo encontrás en el menú Inicio.");
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("Service worker:", err));
  });
}
// Accesos directos del ícono instalado (clic derecho en la barra de tareas)
{
  const vista = new URLSearchParams(location.search).get("vista");
  if (vista === "buscar") state.view = "search";
  if (vista === "disco") state.view = "local";
  if (vista) history.replaceState(null, "", "/");
}

(async function init() {
  updateRepeat();
  syncPlayButton();
  if (state.index >= 0 && state.queue[state.index]) {
    audio.src = srcFor(state.queue[state.index]);
    audio.preload = "none";
    updateNow();
  }
  renderQueue();
  render();
  await loadPlaylists();
  updateLikeCurrent();
  api("config").then((c) => { state.config = c; }).catch(() => {});
  api("status").then((st) => { state.status = st; if (state.view === "search") render(); }).catch(() => {});
  pollDownloads();
})();
