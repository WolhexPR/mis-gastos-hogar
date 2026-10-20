/* Mis Gastos del Hogar — Service Worker
   Cachea la app y el lector de recibos (Tesseract.js) para que funcione
   offline después de la primera carga. Nunca envía ni guarda datos del
   usuario: los gastos viven solo en localStorage del teléfono
   (llave gastos_hogar_v1) y este archivo no los toca. */

const VERSION = 'v6';
const STATIC_CACHE = 'mis-gastos-static-' + VERSION;
const RUNTIME_CACHE = 'mis-gastos-runtime-' + VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// Lector de recibos: script principal de Tesseract.js en el CDN.
// Sus piezas internas (worker, núcleo y datos de idioma) se cachean
// en tiempo de ejecución la primera vez que se usa el lector.
const OCR_PRECACHE = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
];

const OCR_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'tessdata.projectnaptha.com',
  'cdn.jsdelivr.net'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(APP_SHELL);
    // Si el CDN no responde durante la instalación, la app igual se
    // instala; el lector se cacheará en su primer uso con conexión.
    await Promise.allSettled(OCR_PRECACHE.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isOCRRequest(url) {
  return OCR_HOSTS.includes(url.hostname) && (
    url.pathname.includes('tesseract') ||
    url.pathname.includes('worker') ||
    url.pathname.includes('.wasm') ||
    url.pathname.includes('tessdata') ||
    url.pathname.includes('/lang') ||
    url.hostname === 'tessdata.projectnaptha.com'
  );
}

// Cache-first: sirve del caché y solo va a la red si no está guardado.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: false });
  if (hit) return hit;
  const res = await fetch(request);
  if (res && (res.status === 200 || res.type === 'opaque')) {
    cache.put(request, res.clone());
  }
  return res;
}

// Stale-while-revalidate: responde rápido del caché y refresca detrás.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request).then((res) => {
    if (res && res.status === 200) cache.put(request, res.clone());
    return res;
  }).catch(() => hit);
  return hit || network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Navegación: red primero, y sin conexión cae a la app cacheada.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        const cache = await caches.open(STATIC_CACHE);
        cache.put('./index.html', res.clone());
        return res;
      } catch (e) {
        const cache = await caches.open(STATIC_CACHE);
        return (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               Response.error();
      }
    })());
    return;
  }

  // Lector OCR (CDN): cache-first para trabajar offline tras el 1er uso.
  if (url.origin !== self.location.origin && isOCRRequest(url)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // Cualquier otro recurso del CDN de Tesseract que cargue en runtime.
  if (url.origin !== self.location.origin && OCR_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // Recursos propios de la app: caché con refresco en segundo plano.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
  }
});
