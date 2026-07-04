// Service Worker do app do motorista (Certify Delivery)
// Objetivo: permitir a instalação como PWA e dar um cache básico do "shell" do app.
// Chamadas ao Firebase (Auth/Firestore/Storage) NÃO são cacheadas — sempre vão para a rede,
// já que envolvem dados dinâmicos e autenticação.

const CACHE_NAME = 'certifydelivery-motorista-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Nunca interceptar chamadas de rede para Firebase/Google APIs — sempre direto à rede.
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebaseapp.com') ||
      url.includes('googleapis.com') ||
      url.includes('identitytoolkit') ||
      url.includes('firebasestorage')) {
    return;
  }

  // Para o restante (shell do app, fontes, ícones): cache-first com fallback de rede.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).catch(() => cached);
    })
  );
});
