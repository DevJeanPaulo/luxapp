// Service worker — Lux (cliente)
// Cache-first básico do "shell" da app + receção de push em segundo plano via Firebase Cloud Messaging.

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Configuração real do projeto Firebase "Lux Transfers" (igual à do lux-cliente.html).
firebase.initializeApp({
  apiKey: 'AIzaSyC-AgjcPJvgktgK_6ctSF7DyBD6u-EQzMs',
  authDomain: 'lux-transfers-3327d.firebaseapp.com',
  projectId: 'lux-transfers-3327d',
  storageBucket: 'lux-transfers-3327d.firebasestorage.app',
  messagingSenderId: '612200636206',
  appId: '1:612200636206:web:7765946c7da6f7d24c64bf'
});

try{
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'Lux Transfers';
    const options = {
      body: (payload.notification && payload.notification.body) || '',
      icon: 'icons/lux-icon-192.png',
      badge: 'icons/lux-icon-192.png'
    };
    self.registration.showNotification(title, options);
  });
}catch(e){ /* configuração Firebase ainda não preenchida — ignora em modo demo */ }

const CACHE_NAME = 'lux-cliente-v1';
const APP_SHELL = [
  './lux-cliente.html',
  './lux-manifest.json',
  './icons/lux-icon-192.png',
  './icons/lux-icon-512.png',
  './icons/lux-icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => cached);
    })
  );
});
