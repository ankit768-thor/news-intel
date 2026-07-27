// News Intel — service worker for local alert notifications.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// Tap a notification → open the story INSIDE the News Intel app.
// If a window is already open, focus it and tell it which alert to show (warm path).
// Otherwise cold-open the app at the #alert=<id> deep link.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || "/";
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if ("focus" in c) {
        await c.focus();
        if (data.alert) c.postMessage({ type: "open-alert", alert: data.alert });
        return;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

// Allow the page to ask the SW to show a notification (works when installed as a PWA).
self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "notify") {
    self.registration.showNotification(d.title, d.options || {});
  }
});

// A push arrived from the server — the app may be fully CLOSED. Pushes carry no
// payload; ask the server what to show, then notify. Tapping opens the in-app reader.
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    let alerts = [];
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const r = await fetch("/api/push/pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        alerts = (await r.json()).alerts || [];
      }
    } catch {}
    // If the app is already open & visible, its in-page poll shows alerts — don't
    // double-notify. (We still drained /api/push/pending above so nothing is lost.)
    try {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (wins.some(w => w.visibilityState === "visible")) return;
    } catch {}
    if (!alerts.length) {
      // must always show something after a push wake-up
      return self.registration.showNotification("🔔 News Intel", {
        body: "New updates in your briefing",
        icon: "/icon-192.png", badge: "/icon-192.png", data: { url: "/" },
      });
    }
    for (const a of alerts.slice(0, 4)) {
      await self.registration.showNotification(a.ntitle || "🔔 News alert", {
        body: a.title || "",
        icon: "/icon-192.png", badge: "/icon-192.png",
        tag: a.id || undefined,
        data: { url: "/#alert=" + encodeURIComponent(a.id || ""), alert: a },
      });
    }
  })());
});

// The browser rotated our push subscription — re-subscribe and tell the server,
// migrating the old record so preferences survive.
function _b64ToU8(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
self.addEventListener("pushsubscriptionchange", e => {
  e.waitUntil((async () => {
    try {
      const oldSub = e.oldSubscription;
      // Browsers usually fire this event WITHOUT oldSubscription, so we can't rely
      // on its key — fetch the server's VAPID key as the fallback.
      let appKey = oldSub && oldSub.options && oldSub.options.applicationServerKey;
      if (!appKey) {
        try { appKey = _b64ToU8((await (await fetch("/api/push/vapid-key")).json()).key); } catch {}
      }
      if (!appKey) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appKey,
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          prev_endpoint: oldSub ? oldSub.endpoint : "",
        }),
      });
    } catch {}
  })());
});
