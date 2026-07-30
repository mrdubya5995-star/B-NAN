/* B-NAN service worker — caches the app shell so the library,
   your saves, and everything you've imported still work with no
   connection. Emulator core files are fetched from the EmulatorJS CDN
   the first time you play a given system and are cached by the browser
   from then on; this worker doesn't manage those. Auto-fetched box art
   (from thumbnails.libretro.com) is also left to the browser cache. */

// Bumping this is the ONLY thing that makes a browser that already has
// this service worker installed stop serving its old cached shell --
// the fetch handler below is cache-first and never revalidates against
// the network on its own. Any real edit to a file in SHELL_FILES (which,
// this session, was basically all of them, repeatedly) needs a version
// bump here too, or a browser that visited before keeps getting served
// the stale build indefinitely no matter what's actually deployed --
// exactly what happened: this stayed on v2 through a full UI rework,
// which is why a previously-visited browser tab looked nothing like the
// current app despite the server having the new code the whole time.
const CACHE = "bnan-shell-v3";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./src/styles.css",
  "./src/coreRegistry.js",
  "./src/db.js",
  "./src/ui.js",
  "./src/import.js",
  "./src/player.js",
  "./src/backup.js",
  "./src/settings.js",
  "./src/artwork.js",
  "./src/gameMenu.js",
  "./src/windowChrome.js",
  "./src/main.js",
  "./src/vendor/fflate.min.js",
  "./assets/fonts/Baloo2-Variable.woff2",
  "./assets/icons/banana-192.png",
  "./assets/icons/banana-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // let CDN core/artwork requests pass through normally
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((res) => {
          if (res.ok && event.request.method === "GET") {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, clone));
          }
          return res;
        })
    )
  );
});
