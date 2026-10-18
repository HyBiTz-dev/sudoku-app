/**
 * Service worker for offline play.
 *
 * Served from public/ rather than bundled, so it keeps a stable, root-scoped URL
 * across builds. Registered from components/pwa/service-worker-registration.tsx.
 *
 * The cache name carries the app shell revision. Bumping it invalidates every
 * cache in CACHE_PREFIX on the next activation; the hashed chunks under
 * /_next/static are versioned by the build itself, so they are safe to cache
 * forever and are never invalidated by hand.
 */
const VERSION = "v1";
const CACHE_PREFIX = "sudoku-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const ASSET_CACHE = `${CACHE_PREFIX}assets-${VERSION}`;
const FONT_CACHE = `${CACHE_PREFIX}fonts-${VERSION}`;

/**
 * The app shell. "/" is the whole app — it is a single client-rendered page with
 * no per-route data — so caching it is what makes a cold offline start work.
 */
const SHELL = ["/", "/manifest.webmanifest"];

/**
 * Google Sans is loaded from a CDN (see the <link> in app/layout.tsx), so it
 * would be the one piece of the UI missing offline.
 *
 * A worker cannot always reach a third-party host — some environments permit
 * cross-origin requests from the page but not from the worker. When that
 * happens, intercepting and then failing would break a stylesheet the browser
 * would otherwise load perfectly well. So font URLs are only intercepted once
 * they are known to be in FONT_CACHE, and this set records exactly which ones
 * got in. Everything else is left to the browser.
 */
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const cachedFontUrls = new Set();

/**
 * Pull the build output the first render needs out of the rendered HTML.
 *
 * Runtime caching alone is not enough: the chunks are requested during the very
 * first load, before this worker is installed and controlling the page, so none
 * of them reach the cache until a second visit. Warming them here is what makes
 * a first-visit-then-offline start work, rather than only the second one.
 *
 * Turbopack emits the asset URLs twice — absolute in the `<script>`/`<link>`
 * tags, and relative ("static/chunks/…") inside the build manifest — so both
 * forms are matched.
 */
function collectWarmUrls(html) {
  const assets = new Set();

  for (const match of html.matchAll(/\/_next\/static\/[A-Za-z0-9_\-./]+/g)) {
    assets.add(new URL(match[0], self.location.origin).href);
  }

  for (const match of html.matchAll(/"static\/[A-Za-z0-9_\-./]+"/g)) {
    assets.add(new URL(`/_next/${match[0].slice(1, -1)}`, self.location.origin).href);
  }

  // The webfont stylesheet. The .woff2 files it points at are only discovered
  // when the browser parses that CSS back, so they stay in the HTTP cache
  // rather than here; offline they fall back to the system stack in
  // --font-sans, which is a real sans-serif.
  const fonts = new Set(
    [...html.matchAll(/https:\/\/fonts\.[a-z.]+\/[^"'\s<>]+/g)].map(
      (match) => match[0]
    )
  );

  return { assets: [...assets], fonts: [...fonts] };
}

/** Cache the shell document and everything the first render needs. */
async function warmCaches() {
  const shellCache = await caches.open(SHELL_CACHE);
  const assetCache = await caches.open(ASSET_CACHE);
  const fontCache = await caches.open(FONT_CACHE);

  let response;
  try {
    response = await fetch("/", { cache: "no-cache" });
  } catch {
    // Activation can be reached from a cached shell on a later visit, so a
    // failed warm-up is not fatal — keep whatever is already stored.
    return;
  }

  if (!response.ok) return;

  // Clone before the body is read: `text()` consumes the original stream.
  await shellCache.put("/", response.clone());

  const { assets, fonts } = collectWarmUrls(await response.text());

  // Individually, so one unreachable asset cannot fail the whole warm-up.
  await Promise.allSettled(assets.map((url) => assetCache.add(url)));

  const stored = await Promise.allSettled(
    fonts.map(async (url) => {
      await fontCache.add(url);
      return url;
    })
  );

  // Only URLs that actually landed in the cache are recorded — that set is what
  // decides whether the fetch handler takes over.
  cachedFontUrls.clear();
  for (const result of stored) {
    if (result.status === "fulfilled") cachedFontUrls.add(result.value);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individually, so one unreachable entry cannot fail the whole install
      // and leave the worker permanently uninstalled.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(warmCaches)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && !key.endsWith(VERSION))
            .map((key) => caches.delete(key))
        )
      )
      // A new deployment means new hashed chunks. Warming here means the update
      // is usable offline immediately, not only after a visit to repopulate it.
      .then(warmCaches)
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  // Lets the page trigger an immediate update check instead of waiting for the
  // browser's own (lazy, navigation-triggered) one.
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/** Hashed build output — immutable, so a hit is always correct. */
function isStaticAsset(url) {
  return url.pathname.startsWith("/_next/static/");
}

/**
 * Navigations are network-first: a fresh document is preferred while online,
 * but the cached shell covers a cold offline start. `cache.match("/")` rather
 * than the requested URL, so every route resolves to the one page there is.
 */
async function handleNavigate(event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(event.request);
    // Only cache a real, successful document. `fetch` resolves for a 404 or a
    // 500 too, and storing either would make the offline fallback wrong.
    if (response.ok) cache.put("/", response.clone());
    return response;
  } catch {
    const cached = await cache.match("/");
    if (cached) return cached;
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

/** Cache-first for anything already known to be stored. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET is cacheable; a POST replayed from cache would be wrong.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(handleNavigate(event));
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    // The icon set and the manifest: same origin, not versioned by the build.
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Only take over a font once it is in the cache. Without this guard the worker
  // would answer a request it may not be able to perform at all, turning a
  // stylesheet the browser would have loaded into a failed one.
  if (FONT_HOSTS.includes(url.hostname) && cachedFontUrls.has(request.url)) {
    event.respondWith(cacheFirst(request, FONT_CACHE));
  }
});