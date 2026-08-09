self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let payload = { title: "Flip Manager", body: "Nowa okazja inwestycyjna.", data: { url: "/alerts" } };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch { if (event.data) payload.body = event.data.text(); }
  event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, icon: payload.icon || "/icon", badge: payload.badge || "/icon", data: payload.data, tag: payload.data?.eventType && payload.data?.listingId ? `${payload.data.eventType}:${payload.data.listingId}` : undefined }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close(); const target = new URL(event.notification.data?.url || "/alerts", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => { for (const client of clients) { if ("navigate" in client) { client.navigate(target); return client.focus(); } } return self.clients.openWindow(target); }));
});
