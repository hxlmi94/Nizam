// Zeytinkule Defteri — minimal service worker.
// Uygulamanın "yüklenebilir" (PWA) sayılması için gerekli; offline çalışma YOK,
// tüm istekler doğrudan ağa gidiyor (Tasarım Notları md.12 — offline kasıtlı olarak yapılmadı).

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
