// ============================================================
// SERVICE WORKER - SIC ARGOS PWA
// ============================================================

const CACHE_NAME = 'sic-argos-v1';

// Archivos esenciales para cachear (app shell)
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

// Bibliotecas CDN que se deben cachear
const CDN_CACHE = [
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

// ============================================================
// INSTALACIÓN - Cachear app shell
// ============================================================
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando Service Worker...');
  
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Cacheando app shell...');
      // Cacheamos lo esencial; si falla CDN no bloqueamos la instalación
      return cache.addAll(APP_SHELL).catch(err => {
        console.warn('[SW] Error cacheando algunos recursos:', err);
        // No fallar la instalación por recursos externos
        return Promise.resolve();
      });
    }).then(() => {
      // Forzar activación inmediata sin esperar
      return self.skipWaiting();
    })
  );
});

// ============================================================
// ACTIVACIÓN - Limpiar cachés viejos
// ============================================================
self.addEventListener('activate', (event) => {
  console.log('[SW] Service Worker activado');
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Eliminando caché viejo:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      // Controlar todas las pestañas inmediatamente
      return self.clients.claim();
    })
  );
});

// ============================================================
// FETCH - Estrategia de caché
// ============================================================

// Network First para Firebase y APIs
// Cache First para recursos estáticos
// Stale While Revalidate para CDN

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar peticiones que no son GET
  if (request.method !== 'GET') return;

  // Firebase Realtime Database y Auth → Network Only (datos en tiempo real)
  if (url.hostname.includes('firebaseio.com') ||
      url.hostname.includes('firebase.com') ||
      url.hostname.includes('googleapis.com') ||
      url.pathname.includes('/.well-known/')) {
    return;
  }

  // Recursos locales (HTML, CSS, JS, imágenes) → Stale While Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          const fetchPromise = fetch(request).then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => cachedResponse);

          return cachedResponse || fetchPromise;
        });
      })
    );
    return;
  }

  // CDN (SheetJS, face-api, etc.) → Cache First con fallback
  if (url.hostname.includes('cdn.jsdelivr.net') ||
      url.hostname.includes('unpkg.com') ||
      url.hostname.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          return fetch(request).then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => {
            // Si no hay caché ni red, devolver offline
            return new Response('Recurso no disponible offline', {
              status: 503,
              statusText: 'Service Unavailable'
            });
          });
        });
      })
    );
    return;
  }

  // Todo lo demás → Network con fallback a caché
  event.respondWith(
    fetch(request).catch(() => {
      return caches.match(request);
    })
  );
});
