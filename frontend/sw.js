const CACHE_NAME = "setu-shell-v9";
const SHELL_ASSETS = ["/", "/about.html", "/verify", "/app.js?v=9", "/styles.css?v=9", "/sw.js"];

self.addEventListener("install", (event) => {
  // skipWaiting forces the new SW to activate immediately,
  // replacing the old one without waiting for tabs to close
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              console.log("[SW] Deleting old cache:", key);
              return caches.delete(key);
            }
          })
        )
      )
      .then(() => {
        console.log("[SW] Now active:", CACHE_NAME);
        // claim() makes this SW control all open tabs immediately
        return self.clients.claim();
      })
      .then(() => {
        // Tell every open tab to reload so it picks up the new JS/CSS
        return self.clients.matchAll({ type: "window" });
      })
      .then((clients) => {
        clients.forEach((client) => {
          console.log("[SW] Reloading client:", client.url);
          client.navigate(client.url);
        });
      })
  );
});

self.addEventListener("fetch", (event) => {
  // API calls: always network-only — never serve stale data
  if (event.request.url.includes("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // JS and CSS files: network-first, SHORT cache
  // This means updated app.js is always fetched fresh when online
  const url = new URL(event.request.url);
  const isAsset = url.pathname.endsWith(".js") || url.pathname.endsWith(".css");
  if (isAsset) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // HTML pages: network-first, fall back to cache for offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
