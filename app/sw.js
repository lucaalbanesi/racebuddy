/* RaceBuddy – service worker: riceve le notifiche push anche ad app chiusa e apre l'app al tocco.
   Nessuna cache dei file: l'app resta sempre aggiornata. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  const mostrata = self.registration.showNotification(d.title || "RaceBuddy", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "badge-96.png",
    tag: d.tag || "racebuddy-mattino",
    renotify: false,
    data: { url: d.url || "./#/oggi" },
  });
  // Conferma di ricezione (novembre 2026): dopo averla mostrata, il telefono dice al server "arrivata" (d.r = indirizzo
  // della funzione e chiave pubblica, li manda il job). Solo l'iscrizione e il tipo di messaggio, niente testo.
  e.waitUntil(mostrata.then(() => (d.r && d.r.u ? self.registration.pushManager.getSubscription().then((s) => s && fetch(d.r.u, {
    method: "POST",
    headers: { apikey: d.r.k, "Content-Type": "application/json" },
    body: JSON.stringify({ p_endpoint: s.endpoint, p_tipo: String(d.tag || "").split("-")[0] }),
  })).catch(() => null) : null)));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || "./#/oggi", self.registration.scope).href;
  e.waitUntil((async () => {
    const tutte = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of tutte) {
      if (c.url.startsWith(self.registration.scope)) { await c.focus(); return c.navigate ? c.navigate(url) : null; }
    }
    return self.clients.openWindow(url);
  })());
});
