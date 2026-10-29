"use strict";
/* Inicio: lo último que escuchaste, mixes del día, tus artistas, novedades y para descubrir.
   Se carga antes que app.js; solo define funciones (usa el, api, state, etc. de app.js). */

const GENRES = ["Rock", "Metal", "Pop", "Reggaetón", "Cumbia", "Electrónica", "Hip-hop", "Jazz", "Baladas", "Clásica"];
const HOME_BACK = { view: "home", label: "Volver al inicio" };

function homeState() {
  if (!state.home) state.home = { local: null, feed: null, feedLoading: false, feedError: null, feedDay: null };
  return state.home;
}

async function loadHome() {
  const h = homeState();
  try {
    h.local = await api("home");
    h.localError = null;
  } catch (err) { h.localError = err.message; }
  if (state.view === "home") render();
  const today = new Date().toDateString();
  if (!h.feedLoading && (!h.feed || h.feedDay !== today)) loadFeed(false);
}

async function loadFeed(refresh) {
  const h = homeState();
  if (h.feedLoading) return;
  h.feedLoading = true;
  h.feedError = null;
  if (state.view === "home") render();
  try {
    h.feed = await api("home/feed" + (refresh ? "?refresh=1" : ""), { timeout: 180000 });
    h.feedDay = new Date().toDateString();
  } catch (err) { h.feedError = err.message; }
  h.feedLoading = false;
  if (state.view === "home") render();
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? "Buenas noches" : hr < 12 ? "Buenos días" : hr < 20 ? "Buenas tardes" : "Buenas noches";
}

function fmtHours(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

/* ------------------------------------------------------------ piezas */

// "AVATAR - Valley of Disease (Official Lyric Video)" subido por "Avatar Metal" → título y artista limpios
const JUNK_PAREN = /\s*[\(\[][^\)\]]*(official|oficial|video|vídeo|lyric|letra|audio|visualizer|hd|4k|remaster|sub )[^\)\]]*[\)\]]/gi;
function prettyTrack(t) {
  let title = (t.title || "").replace(JUNK_PAREN, "").trim();
  let artist = t.artist || "";
  const m = !t.artistId && title.match(/^(.{1,40}?)\s+[-–—|]\s+(.+)$/);
  if (m) { artist = m[1].trim(); title = m[2].trim(); }
  return { title: title || t.title || "Sin título", artist };
}


function homeSection(title, extra, ...body) {
  return el("section", { class: "home-section" },
    el("div", { class: "section-head" }, el("h2", { class: "section-title", text: title }), extra || null),
    ...body);
}

function shelf(items, cls = "") {
  return el("ul", { class: "shelf " + cls }, items);
}

function skeletonShelf(n, cls = "") {
  return el("ul", { class: "shelf " + cls, "aria-hidden": "true" },
    Array.from({ length: n }, () => el("li", { class: "card skeleton" }, el("div", { class: "card-cover" }), el("span"), el("span"))));
}

function playOverlay(onPlay, label) {
  return el("button", {
    class: "card-play", title: label, "aria-label": label,
    onclick: (e) => { e.stopPropagation(); onPlay(); },
  }, icon("play"));
}

function quickTile(t, list, i) {
  const current = state.queue[state.index];
  const playing = current && key(current) === key(t);
  const nice = prettyTrack(t);
  return el("li", { class: "quick" + (playing ? " playing" : "") },
    el("button", { class: "quick-hit", title: `Reproducir ${t.title}`, onclick: () => playList(list, i) },
      coverImg(t, 64),
      el("span", { class: "quick-text" },
        el("span", { class: "quick-title", text: nice.title }),
        el("span", { class: "quick-artist", text: nice.artist })),
      el("span", { class: "quick-play", "aria-hidden": "true" }, icon(playing ? "pause" : "play"))));
}

function openMix(m) {
  state.collection = {
    kind: "mix", id: m.id, title: m.title, artist: m.subtitle || "", thumb: m.thumb,
    tracks: m.tracks, page: 1, hasMore: false, loading: false, error: null, back: HOME_BACK,
  };
  setView("col");
}

function mixCard(m) {
  const playable = m.tracks.filter(isPlayable);
  return el("li", { class: "card mix-card" },
    el("button", { class: "card-hit", onclick: () => openMix(m), title: `Ver ${m.title}` },
      el("div", { class: "card-cover mix-cover" },
        m.thumb ? el("img", { src: m.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null,
        el("span", { class: "mix-badge", text: "Mix" }),
        el("span", { class: "mix-name" + ((m.artist || m.title).length > 13 ? " long" : ""), text: m.artist || m.title })),
      el("span", { class: "card-title", text: m.title }),
      el("span", { class: "card-meta", text: m.subtitle || `${m.tracks.length} canciones` })),
    playable.length ? playOverlay(() => playList(playable, 0), `Reproducir ${m.title}`) : null);
}

function artistBubble(a) {
  const open = () => openArtist({ id: a.id, title: a.name, thumb: a.thumb }, HOME_BACK);
  return el("li", { class: "card artist-card" },
    el("button", { class: "card-hit", onclick: open, title: `Ver ${a.name}` },
      a.thumb ? el("img", { class: "card-cover round", src: a.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
        : el("div", { class: "card-cover round blank" }, icon("artist")),
      el("span", { class: "card-title", text: a.name }),
      el("span", { class: "card-meta", text: a.plays ? `${a.plays} ${a.plays === 1 ? "escuchada" : "escuchadas"}` : "Artista" })));
}

function newReleaseCard(r) {
  const card = releaseCard(r, { name: r.artist, id: r.artistId }, HOME_BACK);
  card.classList.add("card");
  const meta = card.querySelector(".release-meta");
  if (meta) meta.textContent = [r.artist, RELEASE_LABEL[r.kind], r.year].filter(Boolean).join(" · ");
  return card;
}

function playlistCard(p) {
  const pl = state.playlists.find((x) => x.id === p.id);
  const thumbs = p.thumbs || [];
  const cover = thumbs.length >= 4
    ? el("div", { class: "card-cover collage" }, thumbs.slice(0, 4).map((src) => el("img", { src, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })))
    : thumbs.length ? el("img", { class: "card-cover", src: thumbs[0], alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
    : el("div", { class: "card-cover blank" }, icon(p.special === "favorites" ? "heart-fill" : "list"));
  const playable = pl ? pl.tracks.filter(isPlayable) : [];
  return el("li", { class: "card" },
    el("button", { class: "card-hit", onclick: () => setView("pl:" + p.id), title: `Ver ${p.name}` },
      cover,
      el("span", { class: "card-title", text: p.name }),
      el("span", { class: "card-meta", text: `${p.count} ${p.count === 1 ? "canción" : "canciones"}` })),
    playable.length ? playOverlay(() => playList(playable, 0), `Reproducir ${p.name}`) : null);
}

/* ------------------------------------------------------------ vista */

function homeSearch() {
  const input = el("input", { type: "search", placeholder: "¿Qué querés escuchar?", "aria-label": "Buscar", enterkeyhint: "search" });
  return el("form", {
    class: "search-field home-search", role: "search",
    onsubmit: (e) => { e.preventDefault(); const q = input.value.trim(); if (!q) return; setView("search"); doSearch(q); },
  }, icon("search"), input);
}

function renderHome() {
  const h = homeState();
  const local = h.local;
  const feed = h.feed;
  const week = local && local.week;
  const weekLine = week && week.plays
    ? `Esta semana: ${week.plays} ${week.plays === 1 ? "canción" : "canciones"}${week.artists > 1 ? ` de ${week.artists} artistas` : ""} · ${fmtHours(week.seconds)}`
    : "Tu música, sin publicidad.";
  const hero = el("header", { class: "home-hero" },
    el("div", {}, el("h1", { text: greeting() }), el("p", { class: "home-sub", text: weekLine })),
    homeSearch());
  const out = [hero, installProblem()];

  if (!local) {
    out.push(h.localError ? el("div", { class: "error-box", text: h.localError }) : el("p", { class: "loading", text: "Cargando…" }));
    return el("section", { class: "home" }, ...out);
  }

  const empty = !local.hasHistory && !local.playlists.some((p) => p.count);
  if (empty) {
    out.push(el("div", { class: "home-welcome" },
      el("h2", { text: "Empezá por acá" }),
      el("p", { text: "Buscá lo que te guste o elegí un género. Mientras escuchás, este inicio se llena con tus mixes del día, tus artistas y canciones nuevas para descubrir." }),
      el("div", { class: "chips genre-chips" }, GENRES.map((g) =>
        el("button", { class: "chip", onclick: () => { setView("search"); doSearch(g + " mix"); } }, g))),
      el("div", { class: "toolbar" },
        el("button", { class: "btn", onclick: () => openPlaylistDialog("spotify") }, icon("import"), "Importar de Spotify"))));
    return el("section", { class: "home" }, ...out);
  }

  // Seguir escuchando
  if (local.recent.length) {
    const list = local.recent.filter(isPlayable);
    out.push(homeSection("Seguir escuchando",
      el("button", { class: "text-btn", onclick: () => setView("history") }, "Ver historial"),
      el("ul", { class: "quick-grid" }, list.slice(0, 8).map((t, i) => quickTile(t, list, i)))));
  }

  // Recomendaciones (necesitan internet)
  const refresh = el("button", { class: "text-btn", disabled: h.feedLoading, onclick: () => loadFeed(true) },
    h.feedLoading && feed ? "Actualizando…" : "Actualizar");
  if (h.feedError && !feed) {
    out.push(homeSection("Tus mixes del día", null,
      el("div", { class: "error-box" }, el("strong", { text: "No se pudieron armar las recomendaciones" }), el("p", { text: h.feedError })),
      el("button", { class: "btn", onclick: () => loadFeed(true) }, "Reintentar")));
  } else if (!feed) {
    out.push(homeSection("Tus mixes del día", el("span", { class: "hint", text: "Armando tus mixes…" }), skeletonShelf(6)));
    out.push(homeSection("Tus artistas", null, skeletonShelf(7, "shelf-round")));
  } else if (!feed.empty) {
    if (feed.mixes.length) out.push(homeSection("Tus mixes del día", refresh, shelf(feed.mixes.map(mixCard))));
    if (feed.artists.length) out.push(homeSection("Tus artistas", null, shelf(feed.artists.map(artistBubble), "shelf-round")));
    if (feed.discover.length) {
      const list = feed.discover.filter(isPlayable);
      out.push(homeSection("Para descubrir",
        el("div", { class: "toolbar" },
          el("button", { class: "btn primary", onclick: () => playList(list, 0) }, icon("play"), "Reproducir"),
          el("button", { class: "btn", onclick: () => openMix({ id: "discover", title: "Para descubrir", subtitle: "Canciones parecidas a las tuyas que todavía no escuchaste", tracks: feed.discover }) }, "Ver todas")),
        el("p", { class: "hint home-hint", text: "Parecidas a lo que escuchás, y que todavía no pusiste nunca." }),
        el("ul", { class: "tracks" }, list.slice(0, 6).map((t, i) => trackRow(t, list, i)))));
    }
    if (feed.releases.length) out.push(homeSection("Novedades de tus artistas", null, shelf(feed.releases.map(newReleaseCard))));
    if (!feed.mixes.length && !feed.artists.length && !feed.discover.length)
      out.push(el("p", { class: "hint", text: "Todavía no hay suficiente para recomendarte. Seguí escuchando y volvé más tarde." }));
  }

  // Lo que más escuchás
  if (local.top.length) {
    const list = local.top.map((x) => x.track).filter(isPlayable);
    out.push(homeSection("Lo que más escuchás",
      list.length ? el("button", { class: "btn", onclick: () => playList(list, 0) }, icon("play"), "Reproducir") : null,
      el("ul", { class: "tracks" }, local.top.map((x, i) => trackRow(x.track, list, list.indexOf(x.track), { meta: `${x.plays} veces` })))));
  }

  // Tus listas
  if (local.playlists.length) out.push(homeSection("Tus listas", null, shelf(local.playlists.map(playlistCard))));

  if (feed && feed.generatedAt)
    out.push(el("p", { class: "home-foot", text: `Recomendaciones de hoy, armadas a las ${new Date(feed.generatedAt * 1000).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}. Se renuevan cada día.` }));
  return el("section", { class: "home" }, ...out);
}
