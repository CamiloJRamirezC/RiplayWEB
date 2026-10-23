/* RiPlay: service worker.
   Solo se ocupa de una cosa: si el servicio local está apagado, en vez del error del
   navegador muestra una página que explica qué hacer y se reconecta sola.
   No guarda canciones ni respuestas de la API. */
const CACHE = "riplay-v2";
const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  // La API y el audio van directo a la red, sin pasar por este script (Chrome/Edge 123+).
  // Así el audio no tiene demoras extra y los guardados que se mandan al cerrar o
  // recargar la página no se cancelan.
  if (event.addRoutes) {
    try {
      const pattern = typeof URLPattern === "function" ? new URLPattern({ pathname: "/api/*" }) : "/api/*";
      event.waitUntil(event.addRoutes([{ condition: { urlPattern: pattern }, source: "network" }]).catch(() => {}));
    } catch { /* navegador sin rutas estáticas: se usa el manejador de abajo */ }
  }
  event.waitUntil(caches.open(CACHE).then((c) => c.add(new Request(OFFLINE, { cache: "reload" }))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // audio, API y archivos van directo
  event.respondWith(
    fetch(event.request).catch(async () => (await caches.match(OFFLINE)) || Response.error())
  );
});
