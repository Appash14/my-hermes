/**
 * Service worker minimal.
 *
 * Il rend l'app installable et disponible hors ligne pour sa coquille
 * (HTML/CSS/JS). Il ne met JAMAIS en cache les appels à /api ni /ws :
 * ce sont des réponses vivantes, et servir une vieille conversation depuis
 * le cache serait pire que d'afficher une erreur réseau.
 */

const CACHE = "hermes-v1";
const SHELL = ["/", "/manifest.webmanifest", "/pcm-worklet.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Jamais de cache sur l'API, le WebSocket, ou les requêtes non-GET.
  if (
    event.request.method !== "GET" ||
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/ws")
  ) {
    return;
  }

  // Réseau d'abord, cache en repli : l'app reste à jour quand la connexion
  // est là, et démarre quand même quand elle ne l'est pas.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/"))),
  );
});
