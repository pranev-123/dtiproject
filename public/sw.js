// Service worker for REC Faculty Dashboard – PWA & smartwatch notifications
// Notifications mirror to paired smartwatches (Wear OS / Apple Watch) when enabled

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// Handle push (for future server-sent alerts)
self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || 'REC Classroom Attention';
  const body = data.body || 'Attention alert';
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/rec-mascot.png',
      tag: 'rec-attention',
      requireInteraction: false,
      vibrate: [100, 50, 100]
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((c) => {
    if (c.length) c[0].focus();
    else if (clients.openWindow) clients.openWindow('/');
  }));
});
