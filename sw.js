/**
 * Service Worker - Sistema ARGOS - Investigación Criminal
 * v20260915b - Plan B: eliminado Storage, nodos _heavy, compresión imágenes
 * Fix: ignorar peticiones POST/PUT/DELETE (no se pueden cachear)
 */
const CACHE_NAME = 'argos-v20260915b';
const PRECACHE_URLS = [
  './',
  './index.html',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-database-compat.js',
  'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

// Instalación: precachear recursos esenciales
self.addEventListener('install', event => {
  console.log('[SW] Instalando v20260915b');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activación: limpiar cachés viejas
self.addEventListener('activate', event => {
  console.log('[SW] Activando v20260915b');
  event.waitUntil(
    caches.keys().then(names => {
      return Promise.all(
        names
          .filter(name => name.startsWith('argos-') && name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: network-first para HTML, cache-first para assets estáticos
self.addEventListener('fetch', event => {
  // ★ Solo cachear peticiones GET — POST/PUT/DELETE no son soportadas por Cache API
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // Firebase RTDB WebSocket / REST no-GET: no cachear
  if (url.protocol === 'wss:' || url.hostname.includes('firebaseio.com')) {
    return;
  }

  // Firebase Auth / identidad: no cachear
  if (url.hostname.includes('securetoken') ||
      url.hostname.includes('identitytoolkit') ||
      url.hostname.includes('firebaseauth') ||
      url.hostname.includes('googleapis.com') && url.pathname.includes('/identity')) {
    return;
  }

  // HTML: network-first
  if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Assets estáticos (JS CDNs): cache-first
  if (url.hostname === 'www.gstatic.com' ||
      url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      caches.match(event.request)
        .then(cached => cached || fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        }))
    );
    return;
  }

  // Default: network-first (solo GET, ya filtrado arriba)
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Mensaje para skipWaiting
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
