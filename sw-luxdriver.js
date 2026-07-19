// Service worker — LuxDriver
// Cache-first básico do "shell" da app + receção de push em segundo plano via Firebase Cloud Messaging.

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Configuração real do projeto Firebase "Lux Transfers" (igual à do luxdriver-motorista.html).
firebase.initializeApp({
  apiKey: 'AIzaSyCZdkmtYcjzGu93l0miV1iKfIcc55IC7Tc',
  authDomain: 'lux-transfers-47cb2.firebaseapp.com',
  projectId: 'lux-transfers-47cb2',
  storageBucket: 'lux-transfers-47cb2.firebasestorage.app',
  messagingSenderId: '11041025655',
  appId: '1:11041025655:web:702b7e016352ae33d16072'
});

try{
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'LuxDriver';
    const options = {
      body: (payload.notification && payload.notification.body) || '',
      icon: 'icons/luxdriver-icon-192.png',
      badge: 'icons/luxdriver-icon-192.png'
    };
    self.registration.showNotification(title, options);
  });
}catch(e){ /* configuração Firebase ainda não preenchida — ignora em modo demo */ }

const CACHE_NAME = 'luxdriver-v1';
const APP_SHELL = [
  './luxdriver-motorista.html',
  './luxdriver-manifest.json',
  './icons/luxdriver-icon-192.png',
  './icons/luxdriver-icon-512.png',
  './icons/luxdriver-icon-maskable-512.png'
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
