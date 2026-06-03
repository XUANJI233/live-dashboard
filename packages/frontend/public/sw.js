self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  try {
    const { title, body, icon, url } = event.data.json();
    event.waitUntil(
      self.registration.showNotification(title || "Live Dashboard", {
        body: body || "",
        icon: icon || "/icon-192.png",
        badge: "/icon-192.png",
        data: { url: url || "/" },
        requireInteraction: false,
        vibrate: [200, 100, 200],
      })
    );
  } catch {
    // Ignore malformed push data
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", () => {
  // Keep runtime behavior simple: the dashboard already controls its own caching.
});
