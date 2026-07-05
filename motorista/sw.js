// Service Worker do app do motorista (Certify Delivery)
// Objetivo: permitir a instalação como PWA, dar um cache básico do "shell" do app,
// e receber notificações push (FCM) mesmo com o app fechado.
// Chamadas ao Firebase (Auth/Firestore/Storage) NÃO são cacheadas — sempre vão para a rede,
// já que envolvem dados dinâmicos e autenticação.

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBysXPCsKozn7nEwJ7TVzHCMarDoQbjA6A",
  authDomain: "entrega-certa-b54ae.firebaseapp.com",
  projectId: "entrega-certa-b54ae",
  storageBucket: "entrega-certa-b54ae.firebasestorage.app",
  messagingSenderId: "528945535586",
  appId: "1:528945535586:web:265b8701f7a8ba81cecf3b"
});

// Com o app em segundo plano/fechado, o próprio FCM já mostra a notificação
// automaticamente usando os dados de "notification" enviados pela function.
// Deixamos o handler aqui só para customizar o ícone exibido.
try{
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const titulo = payload.notification?.title || 'Certify Delivery';
    const opcoes = {
      body: payload.notification?.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png'
    };
    self.registration.showNotification(titulo, opcoes);
  });
}catch(e){ /* messaging pode não estar disponível em navegadores sem suporte a push */ }

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
