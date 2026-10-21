/* RaceBuddy – web app (fetta 1: tutto sul telefono, senza account).
   Stato salvato nel browser; contenuti e calendario letti dai file pubblicati. */
(function () {
  "use strict";
  const L = window.RBLogic;
  const KEY = "racebuddy.v1";
  const $app = document.getElementById("app");
  let entrata = null; // "da-destra" / "da-sinistra" dopo uno swipe tra le sezioni della gara

  // ------------------------------------------------------------------ stato
  const vuoto = () => ({ profilo: {}, gare: [], spunte: {}, rinvii: {}, personali: [], scarpe: [], prova: "" });
  let S = vuoto();
  try { S = Object.assign(vuoto(), JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { /* storage non disponibile */ }
  let timerPush;
  const salva = () => {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast("Non riesco a salvare sul telefono"); }
    if (S.push && S.push.attivo) { clearTimeout(timerPush); timerPush = setTimeout(() => sincronizzaPush(), 2000); }
    if (S.gruppo && S.gruppo.dentro) { clearTimeout(timerGareGruppo); timerGareGruppo = setTimeout(() => { sincronizzaGareGruppo(); sincronizzaPBGruppo(); sincronizzaStagione(); }, 2500); }
  };
  let timerGareGruppo;

  const D = { fasi: [], percorso: [], pillole: [], gare: [], aggiornato: null, ok: false, errore: "" };
  const meteoCache = {};

  const oggi = () => S.prova || L.todayISO();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const titoloGara = (n) => String(n || "").replace(/^\s*[IVXLCDM]+\^\s*/, "").replace(/^\d+[ªa°^]\s*/, "");
  const nomeLuogo = (l) => String(l || "").toLowerCase().replace(/(^|[\s'-])\S/g, (m) => m.toUpperCase());

  function toast(msg) {
    document.querySelectorAll(".toast").forEach((x) => x.remove());
    const t = document.createElement("div");
    t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2400);
  }

  // ---------------------------------------------------------------- dati
  async function carica() {
    try {
      const [fasi, percorso, pillole, cal] = await Promise.all(
        ["content/fasi.json", "content/percorso.json", "content/pillole.json", "data/gare.json"].map((u) => fetch(u, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(u); return r.json(); })));
      Object.assign(D, { fasi, percorso, pillole, gare: cal.gare || [], aggiornato: cal.aggiornato, ok: true });
      const opz = (u, def) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : def)).catch(() => def);
      let est;
      [D.schede, D.contenuti, D.novita, D.sfondi, est] = await Promise.all([opz("content/schede.json", {}), opz("data/contenuti.json", { contenuti: [] }).then((x) => (x.contenuti || []).filter((c) => c.tipo !== "podcast")), opz("data/novita_gare.json", { novita: [] }).then((x) => x.novita || []), opz("content/sfondi.json", {}), opz("content/estero.json", { gare: [] })]);
      D.esteroDoc = est || { gare: [] }; D.estero = D.esteroDoc.gare || []; D.circuiti = D.esteroDoc.circuiti || {};
    } catch (e) {
      D.errore = "Non riesco a caricare i contenuti. Controlla la connessione e ricarica.";
    }
  }

  // ---------------------------------------------------------------- meteo (Open-Meteo, gratuito, senza chiave)
  // Luogo dell'utente: coordinate dal GPS se le ha date, altrimenti il nome della città.
  const mioLuogo = () => (S.profilo.coord ? { ...S.profilo.coord, nome: S.profilo.citta } : S.profilo.citta);
  async function coordinate(citta) {
    if (citta && typeof citta === "object" && citta.lat != null) return citta;
    // { cerca, mondo: true } per le gare estere: la città si cerca in tutto il mondo, non solo in Italia
    const mondo = !!(citta && citta.mondo), nome = mondo ? citta.cerca : citta;
    const k = "geo:" + (mondo ? "mondo:" : "") + String(nome).toLowerCase();
    if (meteoCache[k]) return meteoCache[k];
    const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(nome)}&count=1&language=it${mondo ? "" : "&countryCode=IT"}`;
    const r = await fetch(u).then((x) => x.json());
    const p = r.results && r.results[0];
    meteoCache[k] = p ? { lat: p.latitude, lon: p.longitude, nome: p.name } : null;
    return meteoCache[k];
  }
  async function serie(citta) {
    const c = await coordinate(citta);
    if (!c) return null;
    const k = `m:${c.lat.toFixed(2)},${c.lon.toFixed(2)}`;
    if (!meteoCache[k]) {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code,is_day&timezone=auto&forecast_days=16`;
      meteoCache[k] = await fetch(u).then((x) => x.json());
    }
    return { h: meteoCache[k].hourly, c };
  }
  const oraInput = (ora) => { const m = String(ora || "").match(/(\d{1,2})(?:[:.](\d{2}))?/); return m ? `${m[1].padStart(2, "0")}:${m[2] || "00"}` : ""; };
  const oraISO = (ora) => { const m = String(ora || "").match(/(\d{1,2})(?:[:.](\d{2}))?/); return `${String(Math.min(23, Number(m ? m[1] : 7))).padStart(2, "0")}:00`; };
  async function meteoAlle(citta, quandoISO) {
    const sr = await serie(citta);
    if (!sr) return null;
    const { h, c } = sr;
    const i = h.time.indexOf(quandoISO);
    if (i < 0) return null;
    return { temp: h.temperature_2m[i], pioggia: h.precipitation_probability[i] ?? 0, vento: h.wind_speed_10m[i] ?? 0, codice: h.weather_code ? h.weather_code[i] : null, notte: h.is_day ? h.is_day[i] === 0 : false, luogo: c.nome };
  }

  // ---------------------------------------------------------------- elenco condiviso delle gare seguite
  // Manda solo i dati pubblici della gara (nessun dato personale), una volta per gara per telefono.
  function segnalaGara(g, fonte) {
    const C = window.RB_CONFIG || {};
    if (!C.supabaseUrl || !C.supabaseKey || !g) return;
    S.segnalate = S.segnalate || {};
    if (S.segnalate[g.id]) return;
    const corpo = { gara_id: g.id.slice(0, 40), nome: String(g.nome).slice(0, 150), data: g.data, luogo: String(g.luogo || "").slice(0, 80), distanza: String(g.distanza), fonte: fonte === "manuale" ? "manuale" : "FIDAL" };
    if (corpo.nome.length < 3) return;
    fetch(`${C.supabaseUrl}/rest/v1/gare_aggiunte`, {
      method: "POST",
      headers: { apikey: C.supabaseKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(corpo),
    }).then((r) => { if (r.ok) { S.segnalate[g.id] = true; delete S.erroreSegnala; } else { S.erroreSegnala = `HTTP ${r.status}`; r.text().then((t) => { S.erroreSegnala += " " + t.slice(0, 120); salva(); }); } salva(); })
      .catch((e) => { S.erroreSegnala = String(e && e.message || e).slice(0, 120); salva(); });
  }

  // ---------------------------------------------------------------- notifiche push (messaggio del mattino)
  // Online salviamo solo ciò che serve a comporre il messaggio: orario di uscita, zona (circa 1 km) o città,
  // le gare (nome, data, distanza, ruolo) e le voci già spuntate. Niente nome.
  const C = () => window.RB_CONFIG || {};
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  function supportoPush() {
    if (!C().vapidPublic) return "non-pronto";
    if (iOS && !standalone()) return "ios-home";
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "no";
    if (Notification.permission === "denied") return "negato";
    return "ok";
  }
  const b64 = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
  function datiPush() {
    const o = oggi(), attive = S.gare.filter((g) => g.data >= L.addDays(o, -14) && nonArchiviata(g));
    const ids = new Set(attive.map((g) => g.id));
    return {
      v: 1, ora: S.profilo.ora || "07:00", pref: { meteo: true, percorso: true, gara: true, documenti: true, novita: true, fase: true, ...(S.prefPush || {}) },
      documenti: Object.fromEntries(Object.entries(S.documenti || {}).filter(([, d]) => d && d.scadenza).map(([k, d]) => [k, k === "tessera" ? { tipo: d.tipo || "", scadenza: d.scadenza } : { scadenza: d.scadenza }])),
      luogo: S.profilo.coord ? { lat: S.profilo.coord.lat, lon: S.profilo.coord.lon } : S.profilo.citta ? { citta: S.profilo.citta } : null,
      gare: attive.map((g) => ({ id: g.id, nome: g.nome, data: g.data, luogo: g.luogo || "", distanza: g.distanza, ruolo: g.ruolo, aggiunta: g.aggiunta })),
      spunte: [...new Set([...Object.keys(S.spunte), ...attive.flatMap((g) => { const a = adattaGara(g), tenute = new Set(a.percorso.map((v) => v.id)); return [...Object.keys(a.fatte), ...D.percorso.filter((v) => !tenute.has(v.id)).map((v) => `${g.id}:${v.id}`)]; })])].filter((k) => ids.has(k.split(":")[0])),
      rinvii: Object.fromEntries(Object.entries(S.rinvii).filter(([k, d]) => ids.has(k.split(":")[0]) && d >= o)),
    };
  }
  async function rpc(nome, corpo) {
    const r = await fetch(`${C().supabaseUrl}/rest/v1/rpc/${nome}`, { method: "POST", headers: { apikey: C().supabaseKey, "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
    const testo = await r.text();
    if (!r.ok) {
      let msg = testo, code = "";
      try { const j = JSON.parse(testo); msg = j.message || testo; code = j.code || ""; } catch (e) { /* testo grezzo */ }
      if (code === "PGRST202") msg = "Il gruppo non è ancora attivo sul server: va completata la configurazione del database.";
      throw new Error(String(msg).slice(0, 160));
    }
    try { return testo ? JSON.parse(testo) : null; } catch (e) { return testo; }
  }
  // ---------------------------------------------------------------- account (facoltativo: email e codice, Supabase Auth)
  // La sessione sta in una chiave a parte, non nei dati dell'app. Dell'account online c'è solo l'email.
  const AUTH_KEY = "racebuddy.account";
  let AUTH = null;
  try { AUTH = JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch (e) { AUTH = null; }
  const salvaAuth = () => { try { if (AUTH) localStorage.setItem(AUTH_KEY, JSON.stringify(AUTH)); else localStorage.removeItem(AUTH_KEY); } catch (e) { /* niente */ } };
  const ERR_AUTH = { otp_expired: "Codice scaduto o sbagliato: chiedine uno nuovo", over_email_send_rate_limit: "Troppe email in poco tempo: riprova tra qualche minuto",
    email_address_invalid: "Email non valida", validation_failed: "Email non valida", otp_disabled: "Il login non è ancora attivo" };
  async function chiamaAuth(percorso, corpo, bearer) {
    const r = await fetch(`${C().supabaseUrl}/auth/v1/${percorso}`, { method: "POST", headers: { apikey: C().supabaseKey, "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(corpo || {}) });
    const t = await r.text(); let j = {};
    try { j = t ? JSON.parse(t) : {}; } catch (e) { /* testo grezzo */ }
    if (!r.ok) throw new Error(ERR_AUTH[j.error_code || j.code] || (r.status === 429 ? ERR_AUTH.over_email_send_rate_limit : "Non riuscito, riprova"));
    return j;
  }
  function salvaSessione(j) { AUTH = { access: j.access_token, refresh: j.refresh_token, scade: Date.now() + (Number(j.expires_in) || 3600) * 1000, email: (j.user && j.user.email) || (AUTH && AUTH.email) || "" }; salvaAuth(); }
  async function tokenAccount() {
    if (!AUTH) return null;
    if (AUTH.scade > Date.now() + 60000) return AUTH.access;
    try { salvaSessione(await chiamaAuth("token?grant_type=refresh_token", { refresh_token: AUTH.refresh })); return AUTH.access; }
    catch (e) { AUTH = null; salvaAuth(); return null; }
  }
  async function conAccount(url, corpo) {
    const tk = await tokenAccount();
    if (!tk) throw new Error("Entra di nuovo con la tua email");
    return fetch(url, { method: "POST", headers: { apikey: C().supabaseKey, Authorization: `Bearer ${tk}`, "Content-Type": "application/json" }, body: JSON.stringify(corpo || {}) });
  }
  async function rpcAccount(nome, corpo) {
    const r = await conAccount(`${C().supabaseUrl}/rest/v1/rpc/${nome}`, corpo), t = await r.text();
    if (!r.ok) { let m = t; try { m = JSON.parse(t).message || t; } catch (e) { /* testo */ } throw new Error(String(m).slice(0, 160)); }
    try { return t ? JSON.parse(t) : null; } catch (e) { return t; }
  }
  // Strava non richiede l'account: la funzione riconosce il telefono dal suo codice segreto (lo stesso del gruppo).
  async function funzioneStrava(corpo) {
    const r = await fetch(`${C().supabaseUrl}/functions/v1/strava`, { method: "POST", headers: { apikey: C().supabaseKey, "x-racebuddy-token": token(), "Content-Type": "application/json" }, body: JSON.stringify(corpo || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.errore === "non collegato" ? "Strava non è collegato" : j.errore === "non configurato" ? "Strava non è ancora configurato" : "Strava non risponde, riprova più tardi");
    return j;
  }
  async function endpointPush() {
    try { const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, ko) => setTimeout(ko, 2000))]); const sub = await reg.pushManager.getSubscription(); return sub ? sub.endpoint : null; }
    catch (e) { return null; }
  }

  async function inviaIscrizione(sub) {
    const j = sub.toJSON();
    await rpc("salva_iscrizione", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_dati: datiPush() });
  }
  async function sincronizzaPush() {
    try {
      const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
      if (sub) { await inviaIscrizione(sub); delete S.erroreSegnala; }
      else { S.push = null; localStorage.setItem(KEY, JSON.stringify(S)); }
    } catch (e) { /* riprova al prossimo salvataggio */ }
  }
  async function attivaPush(btn) {
    btn.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast("Notifiche non permesse"); btn.disabled = false; rerender(); return; }
      await navigator.serviceWorker.register("sw.js");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(C().vapidPublic) }));
      await inviaIscrizione(sub);
      S.push = { attivo: true, dal: oggi() }; salva();
      toast("Notifiche attive"); rerender();
    } catch (e) {
      btn.disabled = false; toast("Non sono riuscito ad attivarle"); S.errorePush = String(e.message || e).slice(0, 140); salva(); rerender();
    }
  }
  async function disattivaPush(silenziosa) {
    try {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, ko) => setTimeout(ko, 2000))]), sub = await reg.pushManager.getSubscription();
      if (sub) { await rpc("cancella_iscrizione", { p_endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    } catch (e) { /* va bene lo stesso */ }
    S.push = null; salva();
    if (!silenziosa) { toast("Notifiche disattivate"); rerender(); }
  }
  async function provaNotifica() {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification("RaceBuddy · prova", { body: "Le notifiche funzionano. Ti scrivo solo quando c'è qualcosa di nuovo per te.", icon: "icon-192.png", badge: "badge-96.png", data: { url: "./#/oggi" } });
  }
  function cardPush(compatta, nudo) {
    const st = supportoPush(), on = S.push && S.push.attivo;
    if (st === "non-pronto") return compatta ? "" : `<section class="card"><h2>Messaggio del mattino</h2><span class="small">In arrivo a breve.</span></section>`;
    if (compatta && (on || S.pushNonOra || st === "no" || st === "negato")) return "";
    const ora = esc(S.profilo.ora || "7:00");
    let corpo;
    const pr = { meteo: true, percorso: true, gara: true, documenti: true, novita: true, fase: true, ...(S.prefPush || {}) };
    const sw = (k, t, d) => `<label class="check" style="cursor:pointer"><input type="checkbox" data-act="push-pref" data-k="${k}" ${pr[k] ? "checked" : ""}><span><span class="t">${t}</span><br><span class="d">${d}</span></span></label>`;
    if (on) corpo = `<span class="small">Ti scrivo solo quando c'è qualcosa di nuovo, al massimo una volta al giorno, mezz'ora prima della tua uscita delle <b>${ora}</b>. Mai di notte.</span>
      <div>${sw("meteo", "Meteo che cambia", "Solo se cambia davvero rispetto a ieri: gelo, caldo, vento forte, pioggia, ±5°. Mai lo stesso avviso due volte.")}${sw("percorso", "Tappe del percorso", "Le cose importanti da fare e quelle che hai rimandato a oggi.")}${sw("gara", "La tua gara", "Scheda pronta o cambiata, prime previsioni, la vigilia alle 19 e la mattina della gara.")}${sw("novita", "Novità ufficiali della gara", "Medaglia, maglia, percorso, orari e pettorale appena escono, al massimo una al giorno per gara. Le altre notizie nel messaggio del mattino.")}${sw("documenti", "Scadenze", "Tessera e certificato medico: 30, 15 e 2 giorni prima.")}${sw("fase", "Da leggere per la tua fase", "Un contenuto a settimana, la domenica, solo se quel mattino non c'è altro.")}</div>
      <div class="grid2"><button class="btn ghost" data-act="push-prova">Prova</button><button class="btn ghost" data-act="push-off">Disattiva</button></div>`;
    else if (st === "ios-home") corpo = `<span class="small">Su iPhone le notifiche arrivano solo se RaceBuddy è sulla schermata Home: in Safari tocca <b>Condividi</b> → <b>Aggiungi alla schermata Home</b>, poi apri l'app da lì e torna qui.</span>`;
    else if (st === "negato") corpo = `<span class="small">Le notifiche sono bloccate per questa app: riattivale dalle impostazioni del telefono o del browser.</span>`;
    else if (st === "no") corpo = `<span class="small">Questo browser non supporta le notifiche.</span>`;
    else corpo = `<span class="small">Solo quando serve: il meteo che cambia, le tappe importanti del percorso, la vigilia e la mattina della gara. Niente countdown, niente doppioni.</span><div class="${compatta ? "grid2" : ""}" style="display:${compatta ? "grid" : "flex"}"><button class="btn" data-act="push-on" style="${compatta ? "" : "width:100%"}">Attiva le notifiche</button>${compatta ? `<button class="btn ghost" data-act="push-nonora">Non ora</button>` : ""}</div>`;
    if (nudo) return `${corpo}<span class="small muted">Per mandarle salviamo online orario, zona (circa 1 km) e le tue gare, senza il tuo nome.</span>${S.errorePush && !on ? `<span class="small muted">Ultimo errore: ${esc(S.errorePush)}</span>` : ""}`;
    return `<section class="card ${compatta ? "soft" : ""}" aria-label="Messaggio del mattino"><div class="between"><h2>Notifiche</h2>${on ? `<span class="pill ok">attivo</span>` : ""}</div>${corpo}${!compatta ? `<span class="small muted">Per mandarlo salviamo online orario, zona (circa 1 km) e le tue gare, senza il tuo nome.</span>` : ""}${S.errorePush && !on && !compatta ? `<span class="small muted">Ultimo errore: ${esc(S.errorePush)}</span>` : ""}</section>`;
  }

  // ---------------------------------------------------------------- documenti: tessera e certificato medico
  // Numero, scadenze e foto restano solo su questo telefono (le foto in IndexedDB). Online, solo per le notifiche,
  // vanno le date di scadenza.
  const DOCS = { tessera: "Tessera", certificato: "Certificato medico" };
  const doc = (k) => ((S.documenti = S.documenti || {})[k] = S.documenti[k] || {});
  function statoDoc(d, rif) {
    if (!d || !d.scadenza) return { livello: "manca", etichetta: "scadenza da inserire" };
    const n = L.diffDays(d.scadenza, rif || oggi());
    if (n < 0) return { n, livello: "scaduto", etichetta: `scaduto il ${L.fmtBreve(d.scadenza)}` };
    if (n <= 15) return { n, livello: "urgente", etichetta: n === 0 ? "scade oggi" : n === 1 ? "scade domani" : `scade tra ${n} giorni` };
    if (n <= 30) return { n, livello: "presto", etichetta: `scade tra ${n} giorni` };
    return { n, livello: "ok", etichetta: `valido fino al ${L.fmtBreve(d.scadenza)} ${d.scadenza.slice(0, 4)}` };
  }
  const pillDoc = (st) => `<span class="pill doc-${st.livello}">${esc(st.etichetta)}</span>`;
  let dbDoc;
  const idb = () => (dbDoc = dbDoc || new Promise((ok, ko) => { const r = indexedDB.open("racebuddy-documenti", 1); r.onupgradeneeded = () => r.result.createObjectStore("foto"); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); }));
  const idbFai = async (modo, fn) => { const db = await idb(); return new Promise((ok, ko) => { const tx = db.transaction("foto", modo); const req = fn(tx.objectStore("foto")); tx.oncomplete = () => ok(req && req.result); tx.onerror = () => ko(tx.error); }); };
  const fotoLeggi = (k) => idbFai("readonly", (st) => st.get(k));
  const fotoSalva = (k, blob) => idbFai("readwrite", (st) => st.put(blob, k));
  const fotoTogli = (k) => idbFai("readwrite", (st) => { st.delete(k + ":file"); return st.delete(k); });
  // File originale (PDF o foto) da scaricare o condividere per i portali di iscrizione.
  const fileSalva = (k, blob, ext) => idbFai("readwrite", (st) => st.put({ blob, nome: `${k === "tessera" ? "tessera" : "certificato-medico"}.${ext}` }, k + ":file"));
  const fileLeggi = (k) => idbFai("readonly", (st) => st.get(k + ":file"));
  async function scaricaDoc(k) {
    const f = await fileLeggi(k).catch(() => null);
    if (!f || !f.blob) { toast("Nessun file salvato: usa Scansiona"); return; }
    const file = new File([f.blob], f.nome, { type: f.blob.type || "application/octet-stream" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: DOCS[k] }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = f.nome;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function comprimi(file) {
    const img = await createImageBitmap(file);
    const lato = 1600, sc = Math.min(1, lato / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.82));
  }
  async function mostraFotoDoc() {
    for (const el of document.querySelectorAll("[data-doc-thumb]")) {
      try { const b = await fotoLeggi(el.dataset.docThumb); if (b) { el.src = URL.createObjectURL(b); el.hidden = false; } } catch (e) { /* niente foto */ }
    }
  }
  function apriFoto(src) {
    const ov = document.createElement("div");
    ov.className = "foto-ov"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "Foto del documento");
    ov.innerHTML = `<img src="${src}" alt="Foto del documento"><button class="btn" type="button">Chiudi</button>`;
    ov.addEventListener("click", () => ov.remove()); document.body.appendChild(ov);
  }
  // Scansione dei documenti: OCR sul telefono (Tesseract.js, caricato solo alla prima scansione). La foto non lascia
  // il telefono: si salva in IndexedDB come quella di Io, il testo letto propone numero, tipo e date da controllare.
  let motoreOcr;
  const caricaOcr = () => (motoreOcr = motoreOcr || new Promise((ok, ko) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    sc.onload = () => (window.Tesseract ? ok(window.Tesseract) : ko(new Error("OCR non caricato")));
    sc.onerror = () => { motoreOcr = null; ko(new Error("OCR non raggiungibile")); };
    document.head.appendChild(sc);
  }));
  // PDF (il tesserino FIDAL si scarica in PDF): pdf.js estrae il testo esatto e disegna la prima pagina per la foto.
  let motorePdf;
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  const caricaPdf = () => (motorePdf = motorePdf || new Promise((ok, ko) => {
    const sc = document.createElement("script");
    sc.src = PDFJS + "pdf.min.js";
    sc.onload = () => { const lib = window.pdfjsLib; if (!lib) return ko(new Error("PDF non caricato")); lib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; ok(lib); };
    sc.onerror = () => { motorePdf = null; ko(new Error("PDF non raggiungibile")); };
    document.head.appendChild(sc);
  }));
  async function leggiPdf(file) {
    const lib = await caricaPdf();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pag = await pdf.getPage(1);
    const tc = await pag.getTextContent();
    const righe = new Map(); // testo per riga: stessa altezza sulla pagina, da sinistra a destra
    for (const it of tc.items) { if (!it.str || !it.str.trim()) continue; const y = Math.round(it.transform[5] / 3) * 3; (righe.get(y) || righe.set(y, []).get(y)).push(it); }
    const testo = [...righe.entries()].sort((a, b) => b[0] - a[0]).map(([, its]) => its.sort((a, b) => a.transform[4] - b.transform[4]).map((x) => x.str.trim()).join("  ")).join("\n");
    const vp = pag.getViewport({ scale: 2 }), c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await pag.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    return { testo, blob };
  }
  // Prima dell'OCR: scala di grigi, contrasto, larghezza 2200 px e soglia adattiva (bianco e nero rispetto alla media
  // dei dintorni). Sulle foto del tesserino, col fondo sfumato, è la differenza tra leggere le date e perderle.
  async function preparaPerOcr(blob) {
    const img = await createImageBitmap(blob);
    const W = 2200, H = Math.round(img.height * (W / img.width));
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H), p = d.data, n = W * H, g = new Float32Array(n), ist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = 0.299 * p[i * 4] + 0.587 * p[i * 4 + 1] + 0.114 * p[i * 4 + 2]; g[i] = v; ist[v | 0]++; }
    let lo = 0, hi = 255, acc = 0; for (; lo < 255 && (acc += ist[lo]) < n * 0.02; lo++); acc = 0; for (; hi > 0 && (acc += ist[hi]) < n * 0.02; hi--);
    const sc = 255 / Math.max(1, hi - lo);
    const I = new Float64Array((W + 1) * (H + 1)); // immagine integrale per la media locale
    for (let y = 0; y < H; y++) { let riga = 0; for (let xx = 0; xx < W; xx++) { const v = Math.min(255, Math.max(0, (g[y * W + xx] - lo) * sc)); g[y * W + xx] = v; riga += v; I[(y + 1) * (W + 1) + xx + 1] = I[y * (W + 1) + xx + 1] + riga; } }
    const r = 25;
    for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
      const x0 = Math.max(0, xx - r), x1 = Math.min(W, xx + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      const m = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      const o = g[y * W + xx] < m - 12 ? 0 : 255, j = (y * W + xx) * 4; p[j] = p[j + 1] = p[j + 2] = o; p[j + 3] = 255;
    }
    x.putImageData(d, 0, 0);
    return new Promise((ok) => c.toBlob(ok, "image/png"));
  }
  async function scansiona(k, file, stato) {
    let daPdf = false;
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name || "")) {
      stato("Leggo il PDF…");
      const { testo, blob } = await leggiPdf(file);
      await fotoSalva(k, blob); await fileSalva(k, file, "pdf"); doc(k).foto = true; doc(k).file = "pdf"; salva(); daPdf = true;
      if (testo.replace(/\s/g, "").length >= 20) return L.leggiDocumento(testo, k, oggi());
      file = blob; // PDF senza testo (scansione): si passa all'OCR, il PDF resta come file da scaricare
    }
    const blob = await comprimi(file);
    await fotoSalva(k, blob); doc(k).foto = true;
    if (!daPdf) { await fileSalva(k, blob, "jpg"); doc(k).file = "jpg"; }
    salva();
    stato("Leggo il documento…");
    const T = await caricaOcr();
    const pronta = await preparaPerOcr(blob);
    let giro = 0;
    const w = await T.createWorker("ita", 1, { logger: (m) => { if (m.status === "recognizing text") stato(`Leggo il documento… ${Math.round(((m.progress || 0) + giro) * 50)}%`); } });
    try {
      // due letture: pagina intera e "testo sparso" (trova le scritte piccole sul fondo colorato del tesserino)
      await w.setParameters({ tessedit_pageseg_mode: "11" });
      const a = (await w.recognize(pronta)).data.text;
      giro = 1; await w.setParameters({ tessedit_pageseg_mode: "3" });
      const b = (await w.recognize(pronta)).data.text;
      return L.leggiDocumento(`${a}\n${b}`, k, oggi());
    } finally { w.terminate(); }
  }
  const bottoneScan = (k) => `<div class="scan"><label class="btn ghost block" style="cursor:pointer">📷 ${k === "tessera" ? "Scansiona la tessera o carica il PDF" : "Scansiona il certificato o carica il PDF"}<input type="file" accept="image/*,application/pdf" data-scan="${k}" hidden></label>
    <span class="small muted" data-scan-stato="${k}" aria-live="polite">${k === "tessera" ? "Foto o PDF del tesserino (quello che scarichi dalla FIDAL): " : "Foto o PDF: "}leggo i dati qui sul telefono, il file non viene inviato.</span></div>`;
  // Certificato: solo caricamento del file (foto o PDF), niente lettura: la scadenza si scrive a mano o arriva dal tesserino FIDAL.
  const bottoneCarica = (k) => `<div class="scan"><label class="btn ghost block" style="cursor:pointer">📎 ${doc(k).file ? "Sostituisci" : "Carica"} il certificato (foto o PDF)<input type="file" accept="image/*,application/pdf" data-carica="${k}" hidden></label>
    <span class="small muted">Resta sul telefono: lo scarichi da Io quando un portale di iscrizione lo chiede.</span></div>`;
  async function caricaFile(k, file) {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name || "")) {
      await fotoTogli(k).catch(() => {}); await fileSalva(k, file, "pdf"); doc(k).foto = false; doc(k).file = "pdf";
    } else {
      const blob = await comprimi(file); await fotoSalva(k, blob); await fileSalva(k, blob, "jpg"); doc(k).foto = true; doc(k).file = "jpg";
    }
    salva();
  }
  const descriviLetti = (r, k) => [r.tipo && `tipo ${r.tipo}`, r.numero && `numero ${r.numero}`, (r.codiceSocieta || r.societa) && `società ${[r.codiceSocieta, r.societa].filter(Boolean).join(" ")}`, r.scadenza && `scadenza ${k === "tessera" ? "tessera " : ""}${L.fmtBreve(r.scadenza)} ${r.scadenza.slice(0, 4)}`, r.certificato && r.certificato.scadenza && `scadenza certificato ${L.fmtBreve(r.certificato.scadenza)} ${r.certificato.scadenza.slice(0, 4)}`].filter(Boolean).join(", ");

  function sezioneDocumenti() {
    const t = doc("tessera"), c = doc("certificato");
    const campo = (k, f, l, v, extra = "") => `<div class="field"><label for="doc-${k}-${f}">${l}</label><input class="input" id="doc-${k}-${f}" data-docf="${k}:${f}" value="${esc(v || "")}" ${extra}></div>`;
    const file = (k) => doc(k).foto || doc(k).file ? `<div class="doc-foto">${doc(k).foto ? `<img data-doc-thumb="${k}" alt="${DOCS[k]}" hidden data-act="doc-apri">` : `<span class="pill">📄 PDF salvato</span>`}
      <div class="doc-azioni">${doc(k).file ? `<button class="btn ghost small" type="button" data-act="doc-scarica" data-k="${k}">⬇︎ Scarica ${doc(k).file === "pdf" ? "il PDF" : "la foto"}</button>` : ""}<button class="btn ghost small" type="button" data-act="doc-togli-foto" data-k="${k}">Togli il file</button></div></div>` : "";
    return `<section class="card doc"><div class="between"><span class="title">Tessera</span>${pillDoc(statoDoc(t))}</div>
        ${bottoneScan("tessera")}
        <div class="field"><label for="doc-tessera-tipo">Tipo di tessera</label><select class="input" id="doc-tessera-tipo" data-docf="tessera:tipo">${["", "FIDAL", "Runcard", "Runcard EPS"].map((x) => `<option value="${x}" ${t.tipo === x ? "selected" : ""}>${x || "Scegli…"}</option>`).join("")}</select></div>
        <div class="field"><label for="doc-tessera-numero">Numero di tessera</label><div class="row"><input class="input" id="doc-tessera-numero" data-docf="tessera:numero" value="${esc(t.numero || "")}" inputmode="text" autocomplete="off" autocapitalize="characters"><button class="btn ghost" type="button" data-act="doc-copia" ${t.numero ? "" : "disabled"}>Copia</button></div></div>
        ${campo("tessera", "scadenza", "Scadenza della tessera", t.scadenza, 'type="date"')}
        ${campo("tessera", "codiceSocieta", "Codice società", t.codiceSocieta, 'autocapitalize="characters" placeholder="es. RM123"')}
        ${campo("tessera", "societa", "Nome società", t.societa)}
        ${file("tessera")}</section>
      <section class="card doc"><div class="between"><span class="title">Certificato medico</span>${pillDoc(statoDoc(c))}</div>
        ${bottoneCarica("certificato")}
        <div class="field"><label for="doc-certificato-tipo">Tipo</label><select class="input" id="doc-certificato-tipo" data-docf="certificato:tipo">${["agonistico (atletica leggera)", "non agonistico"].map((x) => `<option ${c.tipo === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
        ${campo("certificato", "scadenza", "Scadenza del certificato", c.scadenza, 'type="date"')}
        ${file("certificato")}
        <span class="small muted">${c.file ? "" : "Per iscriverti a una gara di solito serve caricare il certificato: caricalo qui una volta e lo scarichi quando serve. "}Per le gare FIDAL e con Runcard serve il certificato agonistico per l'atletica leggera, valido il giorno della gara.</span></section>
      <span class="small muted">Numeri, date e file restano solo su questo telefono. Se attivi le notifiche, online va solo la data di scadenza per avvisarti 30, 15 e 2 giorni prima.</span>`;
  }
  function avvisoDocumenti(perGara) {
    const out = [];
    for (const k of Object.keys(DOCS)) {
      const d = (S.documenti || {})[k];
      if (perGara) {
        if (!d || !d.scadenza) continue;
        if (d.scadenza < perGara.data) out.push(`${DOCS[k]} ${k === "tessera" ? "scade" : "scade"} il ${L.fmtGiorno(d.scadenza)}, prima della gara.`);
      } else {
        const st = statoDoc(d);
        if (["scaduto", "urgente", "presto"].includes(st.livello)) out.push(`${DOCS[k]}: ${st.etichetta}.`);
      }
    }
    return out.length ? `<a class="card doc-avviso" href="#/io/documenti"><span class="eyebrow">Documenti</span><span class="small"><b>${out.map(esc).join("<br>")}</b></span><span class="small">Aggiorna le date ›</span></a>` : "";
  }

  // ---------------------------------------------------------------- Prepara RaceBuddy: scheda in Oggi + funnel #/prepara/:passo
  // Quattro passi obbligatori (ora, zona, tessera, certificato: bastano per le notifiche anche senza gare), la gara facoltativa.
  // Il funnel finisce con l'attivazione delle notifiche. Regole dei passi in L.passiPrepara (testate).
  const ORDINE_FUNNEL = ["ora", "zona", "documenti", "notifiche", "gara"];
  const statoPrepara = () => L.passiPrepara({ profilo: S.profilo, documenti: S.documenti || {}, gare: S.gare, nonTesserato: !!S.nonTesserato }, oggi());
  const pushChiusa = () => !!(S.push && S.push.attivo) || ["no", "negato", "non-pronto"].includes(supportoPush());
  let RIVEDI = null; // "prepara" | "entra": si rivede il funnel passo per passo, anche i passi già fatti
  const bannerRivedi = () => RIVEDI ? `<div class="rivedi-banner"><span>Anteprima del percorso</span><a href="#/io">Esci</a></div>` : "";
  function prossimoPasso(dopo) {
    if (RIVEDI === "prepara") { const i = dopo ? ORDINE_FUNNEL.indexOf(dopo) + 1 : 0; return ORDINE_FUNNEL[i] || null; }
    const st = statoPrepara(), fatto = Object.fromEntries(st.passi.map((x) => [x.k, x.fatto]));
    fatto.notifiche = pushChiusa();
    if (S.nonTesserato) fatto.documenti = true;
    const i = dopo ? ORDINE_FUNNEL.indexOf(dopo) + 1 : 0;
    const obbligatori = new Set(st.passi.filter((x) => x.obbligatorio).map((x) => x.k));
    // prima i passi che vengono dopo, poi gli obbligatori rimasti indietro
    const giro = [...ORDINE_FUNNEL.slice(i), ...ORDINE_FUNNEL.slice(0, Math.max(0, i - 1)).filter((k) => obbligatori.has(k))];
    return giro.find((k) => !fatto[k]) || null;
  }
  const vaiPasso = (dopo) => { location.hash = `#/prepara/${prossimoPasso(dopo) || "fine"}`; };
  const oraMessaggio = () => { const m = String(S.profilo.ora || "07:00").match(/(\d{1,2})[:.](\d{2})/); if (!m) return "6:30"; const h = Number(m[1]), mi = Number(m[2]); if (h >= 12) return "7:00"; const t = Math.max(5 * 60, (h * 60 + mi - 30) - ((h * 60 + mi - 30) % 30)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
  function cardPrepara() {
    if (S.nonTesserato) return ""; // chi non è tesserato ha chiuso la scheda per sempre
    const st = statoPrepara();
    if (st.completo && pushChiusa()) return "";
    if (S.preparaDopo && L.diffDays(oggi(), S.preparaDopo) < 3) return "";
    if (st.completo) return `<section class="card prepara" aria-label="Prepara RaceBuddy"><div class="between"><span class="eyebrow">Prepara RaceBuddy · ultimo passo</span><span class="pill ok">4 di 4</span></div>
      <span class="title">Attiva le notifiche</span><span class="small">Ti avviso prima che scadano tessera e certificato e quando cambia il meteo della tua uscita. Al massimo una al giorno, mai di notte.</span>
      <div class="grid2"><a class="btn" href="#/prepara/notifiche">Attiva</a><button class="btn ghost" type="button" data-act="prepara-dopo">Più tardi</button></div></section>`;
    const righe = st.passi.map((x) => `<li class="${x.fatto ? "ok" : ""}"><span class="pallino" aria-hidden="true">${x.fatto ? "✓" : ""}</span><span>${esc(x.titolo)}${x.obbligatorio ? "" : ' <span class="muted">· facoltativa</span>'}</span><span class="sr">${x.fatto ? "fatto" : "da fare"}</span></li>`).join("");
    return `<section class="card prepara" aria-label="Prepara RaceBuddy">
      <div class="between"><span class="eyebrow">Prepara RaceBuddy</span><span class="small"><b>${st.fatti} di ${st.totale}</b></span></div>
      <span class="title">Ti avviso io, solo quando serve</span>
      <ul class="vantaggi"><li>Tessera e certificato: 30, 15 e 2 giorni prima che scadano</li><li>Il meteo della tua uscita, solo quando cambia davvero</li><li>Con una gara: vigilia, mattina di gara e novità ufficiali</li></ul>
      <div class="meter acc" aria-hidden="true"><div style="width:${Math.round((st.fatti / st.totale) * 100)}%"></div></div>
      <ul class="passi">${righe}</ul>
      <div class="grid2"><a class="btn" href="#/prepara">${st.fatti ? "Continua" : "Inizia"} · 2 minuti</a><button class="btn ghost" type="button" data-act="prepara-dopo">Più tardi</button></div>
      <button class="link-btn small" type="button" data-act="non-tesserato">Non sono tesserato: chiudi</button></section>`;
  }
  const campiDocumenti = () => { const tessera = doc("tessera"), cert = doc("certificato"); return [`<span class="title">Tessera</span>
        <div class="field"><label for="pf-tipo">Tipo di tessera</label><select class="input" id="pf-tipo" required>${["", "FIDAL", "Runcard", "Runcard EPS"].map((x) => `<option value="${x}" ${tessera.tipo === x ? "selected" : ""}>${x || "Scegli…"}</option>`).join("")}</select></div>
        <div class="field"><label for="pf-numero">Numero di tessera</label><input class="input" id="pf-numero" required minlength="3" autocomplete="off" autocapitalize="characters" value="${esc(tessera.numero || "")}"></div>
        <div class="field"><label for="pf-tess-scadenza">Scadenza della tessera</label><input class="input" id="pf-tess-scadenza" type="date" required value="${esc(tessera.scadenza || "")}"><span class="small muted">FIDAL: 31 dicembre dell'anno stampato in basso a sinistra sul tesserino. Runcard: 12 mesi dall'emissione.</span></div>
        <div class="field"><label for="pf-codice">Codice società</label><input class="input" id="pf-codice" autocomplete="off" autocapitalize="characters" placeholder="es. RM123" value="${esc(tessera.codiceSocieta || "")}"></div>
        <div class="field"><label for="pf-societa">Nome società</label><input class="input" id="pf-societa" autocomplete="off" value="${esc(tessera.societa || "")}"></div>
        <span class="title">Certificato medico agonistico</span>
        <div class="field"><label for="pf-cert-scadenza">Scadenza del certificato</label><input class="input" id="pf-cert-scadenza" type="date" required value="${esc(cert.scadenza || "")}"><span class="small muted">Sulla tessera FIDAL la trovi stampata: la scansione la legge da sola. Serve il certificato agonistico per l'atletica leggera, valido il giorno della gara.</span></div>`,
        `<details class="scan-cert"><summary class="small">Carica anche il file del certificato (foto o PDF), per le iscrizioni</summary>${bottoneCarica("certificato")}</details>`]; };
  // Passo tessera e certificato nei due funnel: prima la scansione, i campi a mano solo se servono, e un'uscita facile
  function passoDocumenti(funnel) {
    const [campi, nota] = campiDocumenti(), t = doc("tessera"), c = doc("certificato"), pieni = !!(t.numero || t.scadenza || c.scadenza);
    return `<h1>Tessera e certificato medico</h1>
      <p class="sub">Con la foto o il PDF del tesserino FIDAL bastano 30 secondi: leggo io numero, società e scadenze. Poi ti avviso prima che scadano.</p>
      ${bottoneScan("tessera").replace('class="btn ghost block"', 'class="btn block"')}
      <form id="prepara-form" data-passo="documenti" ${funnel === "entra" ? 'data-funnel="entra"' : ""}>
        <details class="card doc-mano" ${pieni ? "open" : ""}><summary>${pieni ? "Controlla i dati e vai avanti" : "Oppure scrivili a mano"}</summary>
          <div class="funnel-form" style="margin-top:12px">${campi}<button class="btn block" type="submit">Avanti</button>${nota}</div></details></form>
      <div class="piede"><button class="btn ghost block" type="button" data-act="doc-dopo" data-funnel="${funnel}">Lo faccio più tardi</button>
        <p class="small muted centro">Nessun problema: te lo ricordo in Oggi e lo trovi sempre in Io → Tessera e certificato.</p>
        <button class="link-btn small centro" type="button" data-act="non-tesserato" data-dal-funnel="${funnel === "entra" ? "entra" : "1"}">Non sono tesserato</button></div>`;
  }
  function vistaPrepara(passo) {
    const k = passo === "fine" || ORDINE_FUNNEL.includes(passo) ? passo : prossimoPasso() || "fine";
    const i = ORDINE_FUNNEL.indexOf(k);
    const barra = `<div class="funnel-barra" aria-hidden="true">${ORDINE_FUNNEL.map((x, j) => `<span class="${k === "fine" || j < i ? "ok" : j === i ? "ora" : ""}"></span>`).join("")}</div>`;
    const testa = (eyebrow) => `<header class="head-back">${back("#/oggi")}<div style="min-width:0;flex:1"><span class="eyebrow">${eyebrow}</span>${barra}</div></header>`;
    const passoN = `Prepara RaceBuddy · ${i + 1} di ${ORDINE_FUNNEL.length}`;
    const form = (campi, nota = "") => `<form id="prepara-form" data-passo="${k}" class="funnel-form">${campi}<button class="btn block" type="submit">Avanti</button>${nota}</form>`;
    const tessera = doc("tessera"), cert = doc("certificato");
    let corpo;
    if (k === "ora") corpo = `<h1>A che ora esci di solito a correre?</h1><p class="sub">Il messaggio del mattino arriva mezz'ora prima della tua uscita. Al massimo uno al giorno, mai di notte.</p>
      ${form(`<div class="field"><label for="pf-ora">Ora dell'uscita</label><input class="input" id="pf-ora" type="time" step="900" required value="${esc(oraInput(S.profilo.ora) || "07:00")}"></div>`)}`;
    else if (k === "zona") corpo = `<h1>Dove corri di solito?</h1><p class="sub">Serve per il meteo della tua uscita: ti avviso solo se cambia davvero. La posizione resta sul telefono, arrotondata a circa 1 km.</p>
      ${form(`<div class="field">${bottoneGps("pf-citta")}</div><div class="field"><label for="pf-citta">Città o quartiere</label><input class="input" id="pf-citta" required placeholder="es. Roma" value="${esc(S.profilo.citta || "")}" autocomplete="address-level2"></div>`)}`;
    else if (k === "documenti") corpo = passoDocumenti("prepara");
    else if (k === "notifiche") {
      const sp = supportoPush(), on = S.push && S.push.attivo;
      const cosa = `<ul class="vantaggi"><li>Scadenze di tessera e certificato</li><li>Il meteo della tua uscita, solo quando cambia davvero</li>${S.gare.length ? "<li>Le tue gare: scheda pronta, vigilia alle 19, mattina di gara, novità ufficiali</li>" : ""}</ul>`;
      let azione;
      if (on) azione = `<p class="sub"><span class="pill ok">attive</span> Ti scrivo al massimo una volta al giorno, verso le ${oraMessaggio()}.</p><a class="btn block" href="#/prepara/${prossimoPasso("notifiche") || "fine"}">Avanti</a>`;
      else if (sp === "ios-home") azione = `<section class="card soft"><span class="title">Su iPhone serve un passo in più</span><span class="small">Le notifiche arrivano solo se RaceBuddy è sulla schermata Home. In Safari tocca <b>Condividi</b> → <b>Aggiungi alla schermata Home</b>, poi apri l'app dall'icona: ritrovi questo passo.</span></section><a class="btn ghost block" href="#/prepara/${prossimoPasso("notifiche") || "fine"}">Lo faccio dopo</a>`;
      else if (sp === "ok") azione = `<button class="btn block" type="button" data-act="prepara-push">Attiva le notifiche</button><a class="btn ghost block" href="#/prepara/${prossimoPasso("notifiche") || "fine"}">Non ora</a>`;
      else azione = `<p class="sub">${sp === "negato" ? "Le notifiche sono bloccate per questa app: puoi riattivarle dalle impostazioni del telefono o del browser." : "Su questo telefono le notifiche non sono disponibili."}</p><a class="btn block" href="#/prepara/${prossimoPasso("notifiche") || "fine"}">Avanti</a>`;
      corpo = `<h1>Attiva le notifiche</h1><p class="sub">Ti scrivo solo quando c'è qualcosa di nuovo, al massimo una volta al giorno verso le ${oraMessaggio()}. Mai di notte, niente countdown.</p>${cosa}${azione}
        <span class="small muted">Per mandarle salviamo online orario, zona (circa 1 km), scadenze e le tue gare, senza il tuo nome.</span>`;
    } else if (k === "gara") corpo = `<h1>Segui la tua prossima gara</h1><p class="sub">Facoltativo. Con una gara arrivano la preparazione settimana per settimana, la scheda con orari e logistica dal sito ufficiale, la vigilia e la mattina di gara.</p>
      <a class="btn block" href="#/gare?focus=1">Scegli la gara</a><a class="btn ghost block" href="#/prepara/fine">Lo faccio dopo</a>`;
    else {
      const st = statoPrepara(), on = S.push && S.push.attivo;
      corpo = `<h1>${st.completo ? "Tutto pronto" : "Quasi pronto"}</h1><p class="sub">${st.completo ? (on ? `Da domani ti scrivo solo quando serve, verso le ${oraMessaggio()}.` : "Puoi attivare le notifiche quando vuoi da Io.") : `Mancano ${st.totale - st.fatti} ${st.totale - st.fatti === 1 ? "passo" : "passi"}: li ritrovi in Oggi.`}</p>
        <ul class="passi">${st.passi.map((x) => `<li class="${x.fatto ? "ok" : ""}"><span class="pallino" aria-hidden="true">${x.fatto ? "✓" : ""}</span><span>${esc(x.titolo)}${x.obbligatorio ? "" : ' <span class="muted">· facoltativa</span>'}</span></li>`).join("")}<li class="${on ? "ok" : ""}"><span class="pallino" aria-hidden="true">${on ? "✓" : ""}</span><span>Notifiche</span></li></ul>
        <a class="btn block" href="#/oggi">Vai a Oggi</a>`;
    }
    if (k === "fine") RIVEDI = null;
    return `${bannerRivedi()}${testa(k === "fine" ? "Prepara RaceBuddy" : passoN)}<div class="funnel">${corpo}</div>`;
  }

  // ---------------------------------------------------------------- posizione dal GPS
  // Le coordinate restano sul telefono, arrotondate a circa 1 km. Il nome della città arriva da BigDataCloud (gratuito, senza chiave).
  const ICO_PIN = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>`;
  const bottoneGps = (target) => `<button class="btn ghost small gps" type="button" data-act="gps" data-target="${target}">${ICO_PIN}Usa la mia posizione</button>`;
  function usaGps(btn) {
    if (!navigator.geolocation) { toast("Il telefono non dà la posizione: scrivi la città"); return; }
    btn.disabled = true; btn.lastChild.textContent = "Cerco la posizione…";
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const lat = Math.round(pos.coords.latitude * 100) / 100, lon = Math.round(pos.coords.longitude * 100) / 100;
      let nome = "";
      try {
        const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=it`).then((x) => x.json());
        nome = r.city || r.locality || r.principalSubdivision || "";
      } catch (e) { /* senza nome va bene lo stesso */ }
      S.profilo = { ...S.profilo, coord: { lat, lon }, citta: nome || "La mia zona" };
      salva(); toast(`Posizione impostata: ${S.profilo.citta}`);
      const campo = document.getElementById(btn.dataset.target);
      if (btn.dataset.target === "a-citta" && campo) { campo.value = S.profilo.citta; btn.disabled = false; btn.lastChild.textContent = "Usa la mia posizione"; } else rerender();
    }, (err) => {
      btn.disabled = false; btn.lastChild.textContent = "Usa la mia posizione";
      toast(err.code === 1 ? "Permesso negato: scrivi la città a mano" : "Posizione non disponibile: scrivi la città");
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  }

  // ---------------------------------------------------------------- icone meteo (SVG in linea, nessuna dipendenza)
  const SOLE = `<circle cx="12" cy="12" r="4.2" fill="var(--sun)" stroke="none"/><g stroke="var(--sun)"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g>`;
  const NUVOLA = (y = 0) => `<path transform="translate(0 ${y})" d="M7 18.5h10a3.8 3.8 0 0 0 .4-7.6A5.5 5.5 0 0 0 6.8 12 3.3 3.3 0 0 0 7 18.5z" fill="var(--cloud)" stroke="var(--cloud-line)"/>`;
  const LUNA = `<path d="M15.5 4.5a7.5 7.5 0 1 0 4 12.8A6.2 6.2 0 0 1 15.5 4.5z" fill="var(--moon)" stroke="none"/>`;
  const ICONE = {
    sereno: SOLE,
    variabile: `<g transform="translate(-3 -3) scale(.8)">${SOLE}</g>${NUVOLA(1)}`,
    nuvoloso: NUVOLA(-1),
    nebbia: `${NUVOLA(-4)}<g stroke="var(--cloud-line)"><path d="M5 18h14M7 21h10"/></g>`,
    pioggia: `${NUVOLA(-4)}<g stroke="var(--rain)"><path d="M9 17l-1 3M13 17l-1 3M17 17l-1 3"/></g>`,
    neve: `${NUVOLA(-4)}<g fill="var(--rain)" stroke="none"><circle cx="8.5" cy="18.5" r="1.1"/><circle cx="12.5" cy="20.5" r="1.1"/><circle cx="16.5" cy="18.5" r="1.1"/></g>`,
    temporale: `${NUVOLA(-4)}<path d="M13 15l-3 4h3l-2 4" stroke="var(--sun)" fill="none"/>`,
  };
  const icona = (m, size = 40) => {
    const t = L.tipoCielo(m);
    const g = m.notte && t === "sereno" ? LUNA : m.notte && t === "variabile" ? `<g transform="translate(-3 -3) scale(.8)">${LUNA}</g>${NUVOLA(1)}` : ICONE[t];
    return `<svg class="ico-meteo" aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${g}</svg>`;
  };
  const ICO_VENTO = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h10a2.5 2.5 0 1 0-2.5-2.5M3 12h15a3 3 0 1 1-3 3M3 16h7"/></svg>`;
  const ICO_GOCCIA = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>`;
  const ICO_AVVISO = { gelo: "❄", freddo: "🧤", caldo: "☀", vento: "💨", pioggia: "☔", temporale: "⚡", neve: "❄", nebbia: "🌫" };
  const NOME_CIELO = { sereno: "Sereno", variabile: "Variabile", nuvoloso: "Nuvoloso", nebbia: "Nebbia", pioggia: "Pioggia", neve: "Neve", temporale: "Temporale" };
  const datiMeteo = (m) => `<div class="meteo-dati"><span>${ICO_VENTO}${Math.round(m.vento)} km/h</span><span>${ICO_GOCCIA}${Math.round(m.pioggia)}%</span></div>`;
  const avvisi = (m, gara) => L.avvisiMeteo(m, gara).map((a) => `<div class="avviso ${a.livello}" role="note"><span class="avviso-ico" aria-hidden="true">${ICO_AVVISO[a.tipo] || "!"}</span><span><b>${esc(a.titolo)}.</b> ${esc(a.testo)}</span></div>`).join("");
  const bloccoMeteo = (m, gara, titolo) => `<div class="meteo-top">${icona(m, 52)}<div style="flex:1;min-width:0"><div class="meteo-temp">${Math.round(m.temp)}°</div><span class="small muted">${esc(NOME_CIELO[L.tipoCielo(m)])}</span></div>${datiMeteo(m)}</div>${titolo || ""}<span class="small">${esc(L.vestizione(m, gara))}</span>${avvisi(m, gara)}`;

  // ---------------------------------------------------------------- pezzi di interfaccia
  const back = (href) => `<a class="back" href="${href}" aria-label="Indietro"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></a>`;
  const bannerProva = () => (S.prova ? `<div class="banner-prova">Modalità prova: oggi è ${esc(L.fmtGiorno(S.prova))} · <a href="#/io" style="color:#fff">cambia</a></div>` : "");

  function barraFasi(gara, scuro) {
    const fasi = [...D.fasi].sort((a, b) => a.ordine - b.ordine).filter((f) => f.id !== "dopo");
    const f = L.fase(D.fasi, gara.distanza, gara.data, oggi());
    const segs = fasi.map((x) => {
      const g = x.giorni[gara.distanza], len = g.fine - g.inizio + 1;
      let inner = "";
      if (f.offset > g.fine) inner = `<div class="done" style="width:100%"></div>`;
      else if (f.offset >= g.inizio) inner = `<div class="fill" style="width:${Math.max(6, Math.round(((f.offset - g.inizio + 1) / len) * 100))}%"></div>`;
      return `<div style="flex:${len}">${inner}</div>`;
    }).join("");
    const labels = fasi.map((x) => { const g = x.giorni[gara.distanza]; return `<span style="flex:${g.fine - g.inizio + 1}" class="${x.id === f.id ? "cur" : ""}">${x.id === "gara" ? "" : esc(x.nome)}</span>`; }).join("");
    return `<div class="bar" aria-hidden="true">${segs}</div>${scuro ? "" : `<div class="bar-labels" aria-hidden="true">${labels}</div>`}`;
  }

  // Preparazione su misura (L.adatta): voci nascoste se non servono, fatte da sole se già soddisfatte, con messaggio e azione.
  const ctxPrep = () => ({ oggi: oggi(), documenti: S.documenti || {}, nonTesserato: !!S.nonTesserato, scarpe: S.scarpe || [], citta: S.profilo.citta || "", kmSettimana: Number(S.profilo.kmSettimana) || 0, gare: S.gare, risultati: S.risultati || {}, pb: S.pb || {} });
  const AUTO = {}; // chiave → { fatta, msg, azione }, riempito da adattaGara per le voci mostrate
  function adattaGara(g) {
    const a = L.adatta(D.percorso, g, ctxPrep());
    for (const [k, i] of Object.entries(a.info)) AUTO[k] = { ...i, fatta: !!a.fatte[k], gara: g.id };
    return a;
  }
  const statoGara = (g, o = oggi()) => { const a = adattaGara(g); return L.stato(a.percorso, g, o, { ...S.spunte, ...a.fatte }, S.rinvii); };
  const fattaVoce = (k) => !!S.spunte[k] || !!(AUTO[k] && AUTO[k].fatta);
  function azioneVoce(k) {
    const a = AUTO[k];
    if (!a || !a.azione) return "";
    const g = S.gare.find((x) => x.id === a.gara) || {};
    if (a.azione === "documenti") return `<a class="btn small" href="#/io/documenti">${(S.documenti || {}).tessera || (S.documenti || {}).certificato ? "Aggiorna" : "Carica"} tessera e certificato</a>`;
    if (a.azione === "tempo") return `<a class="btn small" href="${urlGara(g.id)}?modifica=1">Imposta il tempo obiettivo</a>`;
    if (a.azione === "aggiungi-scarpe") return `<a class="btn small" href="#/io/scarpe">Aggiungi le tue scarpe</a>`;
    if (a.azione === "km-settimana") return `<div class="field"><label for="km-${esc(k)}" class="small">Quanti km corri a settimana?</label><input class="input" id="km-${esc(k)}" type="number" inputmode="numeric" min="1" max="250" step="1" data-auto="kmSettimana" placeholder="es. 40" style="max-width:140px"></div>${a.ok === false ? selectScarpa(k, g) : ""}`;
    if (a.azione === "scegli-scarpa") return selectScarpa(k, g);
    return "";
  }
  function selectScarpa(k, g) {
    return `<div class="field"><label class="sr" for="sg-${esc(k)}">Scarpe della gara</label><select class="input" id="sg-${esc(k)}" data-act-change="scarpa-gara" data-gara="${esc(g.id)}"><option value="">Scegli le scarpe…</option>${(S.scarpe || []).filter((x) => !x.ritirata).map((x) => `<option value="${esc(x.id)}" ${g.scarpa === x.id ? "selected" : ""}>${esc(x.nome)} · ${Math.round(Number(x.km) || 0)} km</option>`).join("")}</select></div>`;
  }
  function voceCheck(v, opts = {}) {
    const a = AUTO[v.chiave], auto = !!(a && a.fatta), fatto = fattaVoce(v.chiave), testo = a && a.msg ? a.msg : v.messaggio;
    return `<div class="voce"><label class="check ${fatto ? "done" : ""}"><input type="checkbox" data-act="spunta" data-k="${esc(v.chiave)}" ${fatto ? "checked" : ""} ${auto ? 'disabled aria-describedby="auto-nota"' : ""}>
      <span><span class="t">${esc(v.titolo)}</span>${opts.nodesc && !(a && a.msg) ? "" : `<br><span class="d">${esc(testo)}</span>`}${auto ? `<br><span class="d auto">✓ fatto da solo</span>` : ""}${opts.quando ? `<br><span class="d muted">${esc(opts.quando)}</span>` : ""}</span></label>${!fatto || (a && ["scegli-scarpa", "km-settimana"].includes(a.azione)) ? azioneVoce(v.chiave) : ""}</div>`;
  }

  function cardGara(g, attiva) {
    if (g.paese) g = { ...g, luogo: `${g.luogo}, ${g.paese}` };
    const d = new Date(g.data + "T12:00:00");
    const mesi = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
    const giorni = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
    return `<div class="race"><div class="date" aria-hidden="true"><span class="m">${mesi[d.getMonth()]} ’${String(d.getFullYear()).slice(2)}</span><b>${d.getDate()}</b><span>${giorni[d.getDay()]}</span></div>
      <div class="info"><span class="title">${esc(titoloGara(g.nome))}</span><span class="small muted">${esc(nomeLuogo(g.luogo))} · ${esc(L.DIST_LABEL[g.distanza])}</span>${attiva || ""}</div></div>`;
  }

  // ---------------------------------------------------------------- viste
  // ---------------------------------------------------------------- benvenuto (tutorial al primo avvio)
  function vistaBenvenuto() {
    const m = { temp: -1, vento: 27, pioggia: 15, codice: 2 };
    const fasiDemo = [["Si parte", 21, "done"], ["Costruzione", 28, "fill"], ["Picco", 21, ""], ["Scarico", 14, ""]];
    const barra = `<div class="bar" style="height:10px">${fasiDemo.map(([, n, c]) => `<div style="flex:${n}">${c === "done" ? '<div class="done" style="width:100%"></div>' : c === "fill" ? '<div class="fill" data-ob-w="55%" style="width:55%"></div>' : ""}</div>`).join("")}</div><div class="bar-labels">${fasiDemo.map(([t, n, c]) => `<span style="flex:${n}" class="${c === "fill" ? "cur" : ""}">${t}</span>`).join("")}</div>`;
    const riga = (l, t) => `<div class="line"><span class="when" style="width:84px">${l}</span><span class="small">${t}</span></div>`;
    const mappaDemo = `<svg class="ob-mappa" viewBox="0 0 300 96" aria-hidden="true"><rect width="300" height="96" rx="10" fill="var(--line2)"/><path d="M0 70 C60 60 90 80 150 64 S240 40 300 52" stroke="var(--cloud)" stroke-width="10" fill="none"/><path d="M30 30 C70 10 110 70 150 50 S220 20 270 62" stroke="var(--accent)" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-dasharray="1 0"/><circle cx="30" cy="30" r="6" fill="var(--ok)"/><circle cx="270" cy="62" r="6" fill="var(--navy)"/><text x="40" y="26" font-size="11" font-weight="700" fill="var(--fg2)">Partenza</text><text x="226" y="84" font-size="11" font-weight="700" fill="var(--fg2)">Arrivo</text></svg>`;
    const notifica = (ora, titolo, testo) => `<div class="ob-notif"><img src="icon-192.png" alt="" width="34" height="34"><div class="ob-notif-t"><div class="between"><span>RaceBuddy</span><span>${ora}</span></div><b>${titolo}</b><span>${testo}</span></div></div>`;
    const pos = (n, nome, tempo, tu) => `<div class="post ${tu ? "mio" : ""}"><span class="ob-pos p${n}">${n}</span>${avatar(nome, 30)}<span style="flex:1;min-width:0"><b>${tu ? "Tu" : nome}</b>${tu ? `<br><span class="small" style="color:var(--accent-strong);font-weight:600">a 2:10 da Marco</span>` : ""}</span><b class="pb-tempo">${tempo}</b></div>`;
    const chi = (nome, ruolo, tempo) => `<div class="between small"><span><b>${nome}</b> · ${ruolo}</span><span class="muted">${tempo}</span></div>`;
    const garaDemo = (nome, quando, pill) => `<div class="ob-gara"><div style="min-width:0"><b>${nome}</b><br><span class="small muted">${quando}</span></div>${pill}</div>`;
    const slides = [
      { cls: "ob-alto", k: "Ciao! · Le gare", t: "Scegli la tua gara", d: "Tutto il calendario italiano. E se sogni in grande, i circuiti del mondo: Major, SuperHalfs, Classics.",
        nota: "Corri solo in Italia? Va benissimo: i circuiti sono un di più.",
        ill: `<div class="ob-marchio"><img src="icon-192.png" alt="" width="56" height="56"><span><b>RaceBuddy</b><br>Il tuo compagno di gara, dalla scelta al traguardo</span></div>
          <div class="card ob-mini" style="gap:8px"><div class="seg ob-seg"><a>Le mie</a><a aria-current="page">Italia</a><a>Circuiti</a></div>
            ${garaDemo("Firenze Marathon", "dom 29 nov · Firenze · 42 km", '<span class="pill ok">la segui</span>')}
            ${garaDemo("Corri per il Verde", "dom 8 nov · Roma · 10 km", '<span class="pill grigio">FIDAL</span>')}
</div>
          <div class="card ob-mini ob-mini2" style="gap:8px"><span class="eyebrow">Circuiti</span>
            ${garaDemo("TCS London Marathon", "dom 25 apr 2027 · Londra", '<span class="row" style="gap:4px;flex:none"><span class="pill navy-pill">Major</span><span class="pill">⭐</span></span>')}
            <span class="small muted">Nel mirino: la segui senza impegno, la attivi quando hai il pettorale.</span></div>` },
      { k: "La preparazione", t: "Ogni giorno sai cosa fare", d: "Cosa provare e cosa preparare, sulle date vere della tua gara. E i conti li faccio io: documenti in regola, scarpa che arriva al via.",
        ill: `<div class="ob-countdown"><span class="big ob-num" id="ob-num">46</span><span>giorni alla tua gara</span></div>
          <div class="card dark ob-barra">${barra}</div>
          <div class="card ob-mini"><span class="eyebrow" style="color:var(--accent)">Oggi</span>
            <div class="ob-cont" style="border-top:0;padding-top:0"><span class="thumb noimg t-video"><span class="play" aria-hidden="true">▶</span></span><span class="c-testo"><span class="c-meta">Per la tua fase · video · 6 min</span><span class="c-titolo">Il lungo a ritmo gara, spiegato bene</span></span></div>
            <div class="ob-auto"><span class="ob-auto-ico" aria-hidden="true">👟</span><span style="flex:1;min-width:0"><span class="t">La scarpa arriva alla gara</span><br><span class="d">Adizero: 250 km oggi, circa 290 al via · limite 600</span><span class="ob-km" aria-hidden="true"><span style="width:48%"></span></span></span><span class="pill ok">✓ ok</span></div>
            <span class="ob-auto-nota">Calcolato da solo dai tuoi km</span></div>` },
      { k: "La gara e gli avvisi", t: "Sempre aggiornato, mai invadente", d: "Orari e percorso dal sito ufficiale, la borsa da spuntare, il meteo della tua uscita. Una notifica solo se cambia qualcosa, mai di notte.",
        nota: "Le notifiche le attivi da Io. Su iPhone prima aggiungi RaceBuddy alla schermata Home.",
        ill: `<div class="card ob-mini"><div class="between"><b>Domenica · ore 8:30</b><span class="pill ok">dal sito ufficiale</span></div>${mappaDemo}<div class="list" style="display:flex;flex-direction:column">${riga("Pettorale", "Expo, ven 10-19 · sab 9-19")}</div></div>
          ${notifica("6:00", "Il meteo cambia", "Alle 7: -1°, vento forte. Guanti e uno strato antivento.")}` },
      { cls: "ob-alto", k: "Dopo la gara", t: "Il traguardo è tuo", d: "Segna il tempo, anche cercandolo nelle classifiche ufficiali. Festeggia il personale e condividi l'immagine con la foto della città.",
        ill: `<div class="card ob-mini ob-esito"><span class="eyebrow" style="color:var(--accent)">Com'è andata?</span><div class="between"><span class="small">Trovato nelle classifiche ufficiali</span><b class="pb-tempo">3:28:41</b></div><span class="pill ok" style="align-self:flex-start">Nuovo personale · −2:15 🎉</span></div>
          <div class="ob-storia" role="img" aria-label="Esempio di immagine del risultato"><img src="content/sfondi/roma.jpg" alt=""><div class="ob-storia-testo"><span class="ob-storia-logo">RaceBuddy</span><span class="ob-storia-gara">Maratona di Roma</span><span class="ob-storia-sub">Maratona · 22 marzo</span><span class="ob-storia-tempo">3:28:41</span><span class="ob-storia-badge">Nuovo personale · −2:15</span></div></div>` },
      { k: "Il gruppo", t: "Corri con la tua società", d: "La classifica dei personali della squadra e chi corre le tue gare. Condividi solo quello che scegli.",
        ill: `<div class="card ob-mini" style="gap:4px"><div class="between"><span style="font:700 22px/1 var(--display)">Classifica dei personali</span><span class="chip" aria-pressed="true" style="height:26px;font-size:12px;display:inline-flex;align-items:center">Mezza</span></div>
            ${pos(1, "Giulia", "1:38:00")}${pos(2, "Marco", "1:41:20")}${pos(3, "Tu", "1:43:30", true)}</div>
          <div class="card ob-mini ob-mini2"><div class="between" style="align-items:flex-end"><div><span class="eyebrow">Il gruppo alla gara</span><div style="font:700 22px/1 var(--display)">Firenze Marathon</div></div><span class="small" style="font-weight:700;color:var(--accent)">dom 29 nov</span></div>
            <div class="row">${avatari(["Giulia B", "Marco R", "Sara P", "Anna", "Paolo", "Luca"], 3)}<span class="small"><b>6 del gruppo</b> la corrono con te</span></div>
            <div style="display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--line2);padding-top:8px">${chi("Giulia", "Obiettivo", "3:25:00")}${chi("Marco", "Obiettivo", "3:40:00")}${chi("Sara", "Per divertimento", "")}</div></div>` },
    ];
    const tot = slides.length + 1;
    return `<section class="ob" aria-roledescription="tutorial" aria-label="Benvenuto in RaceBuddy">
      <div class="ob-top"><span class="ob-logo">RaceBuddy</span><button class="ob-salta" data-act="ob-fine">Salta</button></div>
      <div class="ob-track" id="ob-track">${slides.map((x, i) => `<article class="ob-slide ${x.cls || ""}" aria-label="${i + 1} di ${tot}"><div class="ob-ill">${x.ill}</div><span class="eyebrow">${x.k}</span><h1>${x.t}</h1><p>${x.d}</p>${x.nota ? `<p class="ob-nota">${x.nota}</p>` : ""}${i === 0 ? `<button class="ob-invito" type="button" data-act="ob-invito">Hai un invito del gruppo? Incollalo</button>` : ""}</article>`).join("")}
        <article class="ob-slide" aria-label="${tot} di ${tot}"><div class="ob-ill"><div class="ob-countdown"><span class="big">Via!</span></div></div><span class="eyebrow">Partiamo</span><h1>Qual è la tua prossima gara?</h1><p>Ci vuole un minuto. I tuoi dati restano su questo telefono.</p>
          <button class="btn block" data-act="ob-fine" data-vai="#/gare">Scegli la tua gara</button>
          <div class="grid2"><button class="btn ob-sec" data-act="ob-fine" data-vai="#/pb">Inserisci i tuoi personali</button><button class="btn ob-sec" data-act="ob-fine" data-vai="#/gruppo">Ho un invito del gruppo</button></div>
          <p class="ob-nota">Indicazioni generali per runner amatoriali in salute: non sostituiscono medico, nutrizionista o allenatore.</p></article></div>
      <div class="ob-bottom"><div class="ob-dots" aria-hidden="true">${Array.from({ length: tot }, (_, i) => `<span class="${i ? "" : "on"}"></span>`).join("")}</div><button class="btn" id="ob-avanti" data-act="ob-avanti">Avanti</button></div></section>`;
  }
  function avviaBenvenuto() {
    const tr = document.getElementById("ob-track");
    if (!tr) return;
    const dots = [...document.querySelectorAll(".ob-dots span")], av = document.getElementById("ob-avanti");
    tr.addEventListener("scroll", () => {
      const i = Math.round(tr.scrollLeft / tr.clientWidth);
      dots.forEach((d, j) => d.classList.toggle("on", j === i));
      tr.querySelectorAll(".ob-slide").forEach((sl, j) => sl.classList.toggle("vista", j === i));
      av.style.visibility = i === dots.length - 1 ? "hidden" : "visible";
      if (num && num.closest(".ob-slide.vista")) contaAlla();
    }, { passive: true });
    // Schermata della preparazione: il conto alla rovescia scende a 46 e la fase si riempie, la prima volta che si vede
    // (niente se il telefono riduce le animazioni).
    const num = document.getElementById("ob-num"), fill = tr.querySelector(".ob-barra .fill");
    if (!num || !fill || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    num.textContent = "60"; fill.style.width = "0%";
    let fatto = false;
    function contaAlla() {
    if (fatto || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    fatto = true;
    const da = 60, a = 46, durata = 900, t0 = performance.now();
    fill.style.width = "0%";
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.transition = `width ${durata}ms ease-out`; fill.style.width = fill.dataset.obW; }));
    const passo = (t) => { const k = Math.min(1, (t - t0) / durata), e = 1 - Math.pow(1 - k, 3); num.textContent = String(Math.round(da - (da - a) * e)); if (k < 1) requestAnimationFrame(passo); };
    requestAnimationFrame(passo);
    }
    if (num.closest(".ob-slide.vista")) contaAlla();
  }

  const cardMeteo = () => (S.profilo.citta ? `<a class="card" id="meteo" href="#/meteo" style="text-decoration:none;color:inherit;font-weight:inherit" aria-label="Meteo di oggi, apri il dettaglio"><span class="eyebrow">${esc(S.profilo.citta)} · adesso</span><span class="small muted">Meteo in arrivo…</span></a>`
    : `<a class="card" href="#/io" style="text-decoration:none;color:inherit"><span class="title">Meteo e vestizione</span><span class="small">Dimmi dove e a che ora corri di solito: ti dico come vestirti.</span></a>`);
  const contenutiLetti = () => Object.fromEntries(Object.keys(S.letti || {}).filter((k) => k.startsWith("c:")).map((k) => [k.slice(2), true]));
  // Ricorda (solo sul telefono) quali contenuti sono stati mostrati in cima: dal giorno dopo scendono e lasciano posto ad altri.
  function segnaContenutiVisti(lista, o) {
    const nuovo = L.segnaVisti(S.visti, lista.map((c) => c.id), o);
    if (JSON.stringify(nuovo) !== JSON.stringify(S.visti || {})) { S.visti = nuovo; salva(); }
  }
  /** I migliori n contenuti non ancora letti, una sola fonte per volta, registrati come visti oggi. */
  function topPerTe(n) {
    const cx = contesto(), letti = contenutiLetti();
    const lista = L.perTe(D.contenuti || [], { fase: cx.fase, distanza: cx.distanza, oggi: cx.o, letti, visti: S.visti || {} }).filter((c) => !letti[c.id]);
    const top = L.varieta(lista, n, 1);
    segnaContenutiVisti(top, cx.o);
    return top;
  }
  function cardPerTe(titolo) {
    const top = topPerTe(3);
    return top.length ? `<section aria-label="${titolo}"><div class="between" style="margin-bottom:8px"><h2>${titolo}</h2><a class="small" href="#/perte">Altro ›</a></div><div class="lista-c">${top.map((c, i) => cardContenuto(c, i === 0)).join("")}</div></section>` : "";
  }
  function vistaVuota(concluse) {
    const o = oggi(), pil = L.pillola(D.pillole, "nessuna", "21", o, Number(o.slice(5, 7)));
    return `${bannerProva()}<header class="head"><div><span class="eyebrow">${esc(L.fmtGiorno(o))}</span><h1>${S.profilo.nome ? "Ciao, " + esc(S.profilo.nome.trim().split(/\s+/)[0]) : "Buongiorno"}</h1></div>${pulsanteBuddy()}</header>
      ${cardEntra() || cardPrepara()}
      <a class="card dark" href="#/gare" style="text-decoration:none;font-weight:inherit"><span class="eyebrow">${concluse ? "Tutte le tue gare sono concluse" : "Nessuna gara in vista"}</span><span style="font:700 24px/1.1 var(--display)">${concluse ? "Qual è la prossima?" : "Scegli la tua prossima gara"}</span><span class="sub">Ti preparo la strada fino al via: cosa fare e quando, info gara, borsa ›</span></a>
      ${cardMeteo()}
      ${cardInvitoPB()}
      ${pil ? `<section class="card soft" aria-label="Pillola del giorno"><span class="eyebrow" style="color:var(--accent-strong)">Pillola di stagione</span><span class="title">${esc(pil.titolo)}</span><span class="small">${esc(pil.testo)}</span></section>` : ""}
      ${cardPerTe("Da leggere e guardare")}
      <p class="sub">Indicazioni generali per runner amatoriali in salute: non sostituiscono medico, nutrizionista o allenatore.</p>`;
  }

  function vistaOggi() {
    if (!S.gare.length) return vistaVuota();
    const o = oggi();
    const { obiettivo, focus, tutte } = L.gareAttive(S.gare, D.fasi, o, S.risultati || {});
    if (!obiettivo) return vistaVuota(true);
    const f = L.fase(D.fasi, obiettivo.distanza, obiettivo.data, o);
    const mancano = (g) => g.mancano === 0 ? "oggi" : g.mancano === 1 ? "domani" : g.mancano > 0 ? `tra ${g.mancano} giorni` : "conclusa";
    const hero = `<section class="card dark" aria-label="Le tue gare">
      <a class="between" href="#/gara/${encodeURIComponent(obiettivo.id)}" style="align-items:flex-end;color:inherit;text-decoration:none;font-weight:inherit" aria-label="Scheda gara: ${esc(titoloGara(obiettivo.nome))}"><div style="display:flex;flex-direction:column;gap:2px;min-width:0">
        <span class="eyebrow">${esc(L.RUOLO_LABEL[obiettivo.ruolo])}</span>
        <span style="font:700 24px/1.1 var(--display)">${esc(titoloGara(obiettivo.nome))}</span>
        <span class="sub">${esc(L.fmtGiorno(obiettivo.data))} · ${esc(L.DIST_LABEL[obiettivo.distanza])} · ${esc(f.nome)}</span></div>
        <div style="text-align:right">${obiettivo.mancano > 0 ? `<div class="big">${obiettivo.mancano}</div><span class="sub">${obiettivo.mancano === 1 ? "giorno" : "giorni"}</span>` : `<span class="pill navy">${esc(mancano(obiettivo))}</span>`}</div></a>
      ${barraFasi(obiettivo, true)}
      <div class="links-dark"><a href="${urlGara(obiettivo.id)}">La gara</a><a href="${urlGara(obiettivo.id, "preparazione")}">Preparazione</a><a href="${urlGara(obiettivo.id, "borsa")}">Borsa</a></div>
      ${tutte.filter((g) => g.id !== obiettivo.id).slice(0, 2).map((altra) => `<a class="between small" href="#/gara/${encodeURIComponent(altra.id)}" style="border-top:1px solid #FFFFFF26;padding-top:10px;color:inherit;text-decoration:none;font-weight:inherit"><span><b>${esc(titoloGara(altra.nome))}</b> · ${esc(L.RUOLO_LABEL[altra.ruolo].toLowerCase())}</span><span class="pill navy">${esc(mancano(altra))} ›</span></a>`).join("")}
      <a class="between small" href="#/gare" style="border-top:1px solid #FFFFFF26;padding-top:10px;color:inherit;text-decoration:none;font-weight:700"><span>Vedi tutte le tue gare${tutte.length > 1 ? ` · ${tutte.length}` : ""}</span><span aria-hidden="true">›</span></a>
    </section>`;

    const st = statoGara(focus, o);
    const stO = focus.id === obiettivo.id ? st : statoGara(obiettivo, o);
    const daFare = [...st.oggi, ...(focus.id === obiettivo.id ? [] : stO.oggi)].filter((v) => v.tipo !== "momento" || true);
    const azioni = daFare.filter((v) => v.tipo === "cosa da fare");
    const momenti = daFare.filter((v) => v.tipo === "momento" && !(S.letti || {})[v.chiave]);
    const recuperi = stO.daRecuperare.length;
    let blocco = "";
    if (momenti.length) blocco += momenti.map((m) => `<section class="card soft"><div class="between"><span class="eyebrow" style="color:var(--accent-strong)">Momento della preparazione</span><button class="btn ghost small" data-act="letto" data-k="${esc(m.chiave)}" aria-label="Chiudi: ${esc(m.titolo)}">Ok, chiudi</button></div><span class="title">${esc(m.titolo)}</span><span class="small">${esc(m.messaggio)}</span></section>`).join("");
    if (azioni.length) {
      blocco += `<section class="card" aria-label="Da fare oggi"><h2>Da fare oggi</h2>${azioni.map((v) => {
        const fatto = fattaVoce(v.chiave);
        return `<div style="display:flex;flex-direction:column;gap:10px">${voceCheck(v)}${fatto ? "" : `<div class="grid2"><button class="btn" data-act="spunta" data-k="${esc(v.chiave)}">Fatto</button><button class="btn ghost" data-act="rinvia" data-k="${esc(v.chiave)}">Domani</button></div>`}</div>`;
      }).join("")}</section>`;
    } else {
      const prossima = st.settimana.find((v) => !S.spunte[v.chiave]);
      blocco += `<section class="card"><h2>Da fare oggi</h2><span class="small">Niente di speciale oggi.${prossima ? ` Prossima cosa: <b>${esc(prossima.titolo)}</b> (${esc(L.fmtGiorno(prossima.data))}).` : ""}</span></section>`;
    }
    blocco = cardDallaGara() + blocco;
    const daRaccontare = garaDaRaccontare();
    if (daRaccontare) blocco = `<a class="card dark" href="#/risultato/${encodeURIComponent(daRaccontare.id)}" style="text-decoration:none;font-weight:inherit"><span class="eyebrow">Dopo la gara</span><span style="font:700 24px/1.1 var(--display)">Com'è andata la ${esc(titoloGara(daRaccontare.nome))}?</span><span class="sub">Segna il tuo tempo${S.gruppo && S.gruppo.dentro ? " e condividilo con il gruppo" : ""} ›</span></a>` + blocco;
    if (recuperi) blocco += `<a class="card soft" href="${urlGara(obiettivo.id, "preparazione")}" style="text-decoration:none;color:inherit"><span class="between"><span class="title">Hai ${recuperi} ${recuperi === 1 ? "cosa" : "cose"} da recuperare</span><span aria-hidden="true">›</span></span><span class="small">Ti sei iscritto a preparazione iniziata.</span></a>`;
    if (focus.mancano >= 0 && focus.mancano <= 2) blocco += `<a class="btn block" href="${urlGara(focus.id, "borsa")}">Apri la checklist della borsa</a>`;
    blocco += cardInvitoPB();

    const fp = L.fase(D.fasi, focus.distanza, focus.data, o);
    const pil = L.pillola(D.pillole, fp.id, focus.distanza, o, Number(o.slice(5, 7)));
    const pill = pil ? `<section class="card soft" aria-label="Pillola del giorno"><span class="eyebrow" style="color:var(--accent-strong)">Pillola · ${esc(fp.nome)}</span><span class="title">${esc(pil.titolo)}</span><span class="small">${esc(pil.testo)}</span>${(() => { const n = L.pillolePool(D.pillole, fp.id, focus.distanza, Number(o.slice(5, 7))).length - 1; return n > 0 ? `<a class="small" href="#/pillole/${encodeURIComponent(focus.id)}">Vedi le altre ${n} di questa fase ›</a>` : ""; })()}</section>` : "";

    const meteo = cardMeteo();

    return `${bannerProva()}<header class="head"><div><span class="eyebrow">${esc(L.fmtGiorno(o))}</span><h1>Buongiorno${S.profilo.nome ? ", " + esc(S.profilo.nome.trim().split(/\s+/)[0]) : ""}</h1></div>${pulsanteBuddy()}</header>${cardEntra() || cardPrepara()}${hero}${avvisoDocumenti()}${meteo}${blocco}${statoPrepara().completo ? cardPush(true) : ""}${pill}${(() => {
      const top = topPerTe(2);
      return top.length ? `<section aria-label="Per te oggi"><div class="between" style="margin-bottom:8px"><h2>Per te oggi</h2><a class="small" href="#/perte">Altro ›</a></div><div class="lista-c">${top.map((c, i) => cardContenuto(c, i === 0)).join("")}</div></section>` : "";
    })()}`;
  }

  // Il meteo di oggi: adesso (ora piena) più minima e massima della giornata. null se mancano i dati.
  const meteoDaSerie = (h, t) => { const i = h.time.indexOf(t); return i < 0 ? null : { temp: h.temperature_2m[i], pioggia: h.precipitation_probability[i] ?? 0, vento: h.wind_speed_10m[i] ?? 0, codice: h.weather_code ? h.weather_code[i] : null, notte: h.is_day ? h.is_day[i] === 0 : false }; };
  function bloccoOggi(h, giorno) {
    const m = meteoDaSerie(h, `${giorno}T${String(new Date().getHours()).padStart(2, "0")}:00`);
    if (!m) return "";
    const temps = h.time.map((t, i) => (t.startsWith(giorno) ? h.temperature_2m[i] : null)).filter((x) => x != null);
    return `<div class="meteo-top">${icona(m, 52)}<div style="flex:1;min-width:0"><div class="meteo-temp">${Math.round(m.temp)}°</div><span class="small muted">${esc(NOME_CIELO[L.tipoCielo(m)])}</span></div>${datiMeteo(m)}</div>
        ${temps.length ? `<span class="small muted">Oggi min ${Math.round(Math.min(...temps))}° · max ${Math.round(Math.max(...temps))}°</span>` : ""}${avvisi(m, false)}`;
  }
  // Home: il meteo di oggi. In piccolo la prossima uscita, solo se non è oggi (già passata).
  async function riempiMeteo() {
    const box = document.getElementById("meteo");
    if (!box || !S.profilo.citta) return;
    try {
      const sr = await serie(mioLuogo());
      if (!sr) { box.innerHTML = `<span class="eyebrow">${esc(S.profilo.citta)}</span><span class="small">Non trovo la città: correggila in Io.</span>`; return; }
      const { h, c } = sr, adesso = new Date(), giorno = S.prova || L.todayISO(), at = (t) => meteoDaSerie(h, t);
      const oggiHtml = bloccoOggi(h, giorno);
      if (!oggiHtml) { box.innerHTML = `<span class="eyebrow">${esc(c.nome)}</span><span class="small">Previsioni non disponibili per oggi.</span>`; return; }
      let uscita = "";
      const quando = S.prova ? `${S.prova}T${oraISO(S.profilo.ora)}` : L.prossimaUscita(S.profilo.ora, adesso);
      if (quando.slice(0, 10) !== giorno) {
        const u = at(quando);
        if (u) uscita = `<div class="row" style="gap:8px;border-top:1px solid var(--line2);padding-top:8px">${icona(u, 24)}<span class="small" style="flex:1;min-width:0"><b>Uscita di ${quando.slice(0, 10) === L.addDays(giorno, 1) ? "domani" : esc(L.fmtGiorno(quando.slice(0, 10)))} alle ${esc(S.profilo.ora || "7:00")}</b> · ${Math.round(u.temp)}°, ${esc(NOME_CIELO[L.tipoCielo(u)].toLowerCase())}<br>${esc(L.vestizione(u, false).split(". ")[0].replace(/\.$/, ""))}.</span></div>`;
      }
      box.innerHTML = `<span class="eyebrow">${esc(c.nome)} · adesso</span>
        ${oggiHtml}${uscita}<span class="small" style="color:var(--accent);font-weight:700">Prossimi giorni e meteo gara ›</span>`;
    } catch (e) { box.innerHTML = `<span class="small muted">Meteo non disponibile al momento.</span>`; }
  }

  // Quando una gara appena corsa passa in archivio: dal giorno dopo l'esito, al più tardi dopo L.POST_GARA giorni.
  function quandoArchivio(g, o) {
    const r = (S.risultati || {})[g.id], segnato = r ? r.salvato || g.data : g.esito ? g.esitoData || g.data : null;
    const giorni = segnato ? 1 : L.POST_GARA + 1 + L.diffDays(g.data, o);
    return giorni <= 1 ? "domani" : `tra ${giorni} giorni`;
  }
  function vistaGare(param) {
    const o = oggi();
    const { attive, postgara, archivio } = L.dividiGare(S.gare, o, S.risultati || {}, oraAdesso());
    const mie = [...postgara, ...attive];
    // Barra in alto: le mie gare, il calendario italiano, l'estero (quando c'è). La ricerca vive nel calendario.
    const estero = (D.estero || []).length > 0;
    const vista = ["mie", "italia", "estero"].includes(param.v) && (param.v !== "estero" || estero) ? param.v : param.q || param.d || !(mie.length || archivio.length || L.nelMirino(S.mirino, o).length) ? "italia" : "mie";
    const seg = (k, l) => `<a href="#/gare?v=${k}" ${vista === k ? 'aria-current="page"' : ""}>${l}</a>`;
    const testa = `${bannerProva()}<header class="head"><h1>Gare</h1></header>
      <nav class="seg" aria-label="Gare">${seg("mie", `Le mie${mie.length ? " · " + mie.length : ""}`)}${seg("italia", "Italia")}${estero ? seg("estero", "Circuiti") : ""}</nav>`;
    if (vista === "mie") return testa + vistaLeMieGare(o, mie, archivio);
    if (vista === "estero") return testa + vistaEstero(param, o);
    const q = param.q || "", dist = param.d || "", conSoc = clAttive() && gareSoc().some((s) => s.data >= o), soc = conSoc && param.s === "1";
    const chip = (v, l) => `<button class="chip" data-act="filtro" data-d="${v}" aria-pressed="${dist === v}">${l}</button>`;
    return `${testa}
      <div class="field"><label for="cerca">Cerca una gara o una città</label><input class="input" id="cerca" type="search" value="${esc(q)}" placeholder="es. Firenze" autocomplete="off"></div>
      <div class="chips" role="group" aria-label="Filtri">${chip("", "Tutte")}${chip("10", "10 km")}${chip("21", "Mezza")}${chip("42", "Maratona")}${conSoc ? `<button class="chip" data-act="filtro-soc" aria-pressed="${soc}">★ Società</button>` : ""}</div>
      <div id="risultati">${risultatiItalia(q, dist, soc, o)}</div>
      <details class="card"><summary>Non la trovi? Aggiungila a mano</summary>
        <form id="manuale" style="display:flex;flex-direction:column;gap:10px">
          <div class="field"><label for="m-nome">Nome della gara</label><input class="input" id="m-nome" required></div>
          <div class="grid2"><div class="field"><label for="m-data">Data</label><input class="input" id="m-data" type="date" required min="${o}"></div>
          <div class="field"><label for="m-dist">Distanza</label><select class="input" id="m-dist"><option value="10">10 km</option><option value="21">Mezza</option><option value="42">Maratona</option></select></div></div>
          <div class="field"><label for="m-luogo">Città</label><input class="input" id="m-luogo"></div>
          <button class="btn" type="submit">Continua</button></form></details>
      <p class="sub">Calendario FIDAL su strada e, per il Lazio, Gare Podistiche Lazio (anche le non competitive)${D.aggiornato ? `; aggiornato il ${esc(L.fmtGiorno(D.aggiornato.slice(0, 10)))}` : ""}. Maratone e mezze del 2027 dal calendario FIDAL già pubblicato; le altre gare del 2027 compaiono man mano.</p>`;
  }
  function vistaLeMieGare(o, mie, archivio) {
    const mirino = L.nelMirino(S.mirino, o);
    const blMirino = mirino.length ? `<section aria-label="Nel mirino" style="display:flex;flex-direction:column;gap:8px"><h2>⭐ Nel mirino</h2>${mirino.map((g) => { const e = garaEsteraDati(g.id) || g;
      return `<a class="card mia-gara mirino" href="#/estera/${encodeURIComponent(g.id)}">${cardGara(e, `<span class="row" style="gap:6px;flex-wrap:wrap"><span class="pill">tra ${L.diffDays(g.data, o)} giorni</span>${pillIscrizione(e)}</span><span class="small muted">Da attivare quando sei iscritto</span>`)}<span class="chev" aria-hidden="true">›</span></a>`; }).join("")}</section>` : "";
    if (!mie.length && !archivio.length && !mirino.length) return `<section class="card"><span class="title">Nessuna gara</span><span class="small">Scegline una dal calendario: ti preparo la strada fino al via.</span><a class="btn" href="#/gare?v=italia&focus=1">Cerca una gara</a></section>`;
    return `${mie.length ? `<section aria-label="Le mie gare" style="display:flex;flex-direction:column;gap:8px">${mie.map((g) => {
        const n = L.diffDays(g.data, o), f = L.fase(D.fasi, g.distanza, g.data, o), r = (S.risultati || {})[g.id];
        const pill = !corsa(g, o) ? `<span class="pill">${n > 1 ? `tra ${n} giorni` : n === 1 ? "domani" : "oggi!"}</span>` : `<span class="pill ok">${r ? esc(r.tempo) + (r.pb ? " · personale" : "") : g.esito ? esc(ESITO[g.esito]) : "com'è andata?"}</span>`;
        return `<a class="card mia-gara ${corsa(g, o) ? "corsa" : ""}" href="${urlGara(g.id)}">${cardGara(g, `<span class="row" style="gap:6px;flex-wrap:wrap">${pill}${pillSoc(g)}<span class="small muted">${corsa(g, o) ? "Appena corsa · in archivio " + quandoArchivio(g, o) : esc(L.RUOLO_LABEL[g.ruolo]) + (!["prima", "conclusa"].includes(f.id) ? " · " + esc(f.nome) : "")}</span></span>`)}<span class="chev" aria-hidden="true">›</span></a>`;
      }).join("")}</section>` : `<p class="sub">Nessuna gara in programma.</p>`}
      ${blMirino}
      <a class="btn ghost block" href="#/gare?v=italia&focus=1">Aggiungi una gara</a>
      ${archivio.length ? `<details class="card acc" aria-label="Archivio delle gare"><summary><span>Archivio</span><span class="small muted" style="font-weight:600">${archivio.length} ${archivio.length === 1 ? "gara corsa" : "gare corse"}</span></summary>${archivio.map((g) => {
        const r = (S.risultati || {})[g.id];
        const esito = r ? `<span class="pill ok">${esc(r.tempo)}</span>${r.pb ? `<span class="pill navy-pill">personale</span>` : ""}` : g.esito ? `<span class="pill grigio">${esc(ESITO[g.esito])}</span>` : `<span class="pill grigio">tempo non segnato</span>`;
        return `<a class="arch-riga" href="${urlGara(g.id)}">${cardGara(g, `<span class="row" style="gap:6px;flex-wrap:wrap">${esito}<span class="small muted">${esc(g.data.slice(0, 4))}</span></span>`)}<span class="chev" aria-hidden="true">›</span></a>`;
      }).join("")}</details>` : ""}`;
  }
  // Dettagli dal calendario (orario, quota, iscrizioni): oggi li ha Gare Podistiche Lazio.
  function dettagliCalendario(g) {
    const isc = g.iscrizioni === "chiuse" ? "iscrizioni chiuse" : /^chiuse/.test(g.iscrizioni || "") ? "iscrizioni chiuse, sul posto" : /^\d{4}-/.test(g.iscrizioni || "") ? (g.iscrizioni < oggi() ? "iscrizioni chiuse" : `iscrizioni entro il ${L.fmtBreve(g.iscrizioni)}`) : "";
    const parti = [g.ora && `ore ${g.ora}`, g.quota, isc].filter(Boolean);
    return parti.length ? `<span class="small muted">${esc(parti.join(" · "))}</span>` : "";
  }
  // Gare → Italia: con il filtro Società, solo le gare della società; quelle aggiunte a mano dal direttivo (fuori dal
  // calendario) si ricordano in fondo con il rimando all'elenco del gruppo.
  function risultatiItalia(q, dist, soc, o) {
    if (!soc) return risultati(L.cercaGare(D.gare, q, dist, o));
    const ris = L.cercaGare(filtraSoc(D.gare), q, dist, o);
    const fuori = gareSoc().filter((s) => s.data >= o && (!dist || s.distanza === dist) && !D.gare.some((g) => L.garaSocDi([s], g)));
    return (ris.length || !fuori.length ? risultati(ris) : "") + (fuori.length ? `<a class="card soft link-card" href="#/gruppo/societa" style="margin-top:8px"><span class="small">${fuori.length === 1 ? "Un'altra gara della società non è" : `Altre ${fuori.length} gare della società non sono`} nel calendario (aggiunte a mano dal direttivo).</span><span class="small" style="color:var(--accent);font-weight:700">Gare della società ›</span></a>` : "");
  }
  function risultati(ris) {
    if (!ris.length) return `<p class="sub">Nessuna gara trovata. Prova con la città o aggiungila a mano.</p>`;
    const giaMie = new Set(S.gare.map((g) => g.id));
    return `<h2 style="margin-bottom:8px">Risultati · ${ris.length}${ris.length === 40 ? "+" : ""}</h2><div style="display:flex;flex-direction:column;gap:8px">${ris.map((g) =>
      `<article class="card">${cardGara(g, `${L.circuitiDi(g, D.esteroDoc).length || garaSoc(g) ? `<span class="row" style="gap:6px;flex-wrap:wrap">${pillSoc(g)}${pillCircuiti(L.circuitiDi(g, D.esteroDoc))}</span>` : ""}${dettagliCalendario(g)}${giaMie.has(g.id) ? `<span class="pill ok">già tra le tue gare</span>` : `<a class="btn small" style="align-self:flex-start" href="#/aggiungi/${encodeURIComponent(g.id)}">Scegli ${esc(L.DIST_LABEL[g.distanza])}</a>`}`)}</article>`).join("")}</div>`;
  }
  // Gare estere (content/estero.json, curato e verificato ogni mese): Major, SuperHalfs, European Marathon Classics,
  // grandi gare europee. Filtri per circuito e distanza; il ballottaggio è in evidenza.
  const pillCircuiti = (cs) => (cs || []).map((c) => `<span class="pill ${c === "major" || c === "superhalfs" ? "navy-pill" : "grigio"}">${esc((D.circuiti[c] || {}).breve || c)}</span>`).join("");
  const pillIscrizione = (g) => g.iscrizione === "ballottaggio" ? `<span class="pill ballottaggio">🎟️ Ballottaggio</span>` : g.iscrizione === "qualificazione" ? `<span class="pill ballottaggio">⏱️ Tempo di qualificazione</span>` : "";
  function vistaEstero(param, o) {
    // La distanza si filtra solo dove ha senso: Major e Classics sono maratone, le SuperHalfs mezze.
    const c = param.c || "", conDistanza = !c || c === "grandi", dist = conDistanza ? param.d || "" : "";
    const ris = L.cercaEstero(D.estero, c, dist, o), giaMie = new Set(S.gare.map((g) => g.id));
    const chip = (k, v, l, att) => { const cc = k === "c" ? v : c, dd = k === "d" ? v : !cc || cc === "grandi" ? dist : ""; return `<a class="chip" href="#/gare?v=estero&c=${cc}&d=${dd}" aria-pressed="${att === v}">${l}</a>`; };
    // Con un circuito scelto si vedono tutte le sue città: quelle senza un'edizione in elenco restano, con il motivo.
    const info = D.circuiti[c] || {}, mancanti = (info.citta || []).filter((x) => !ris.some((g) => g.luogo.toLowerCase() === x.toLowerCase()));
    const italiana = (citta) => { const nomi = ((D.esteroDoc.italiane || {})[c]) || []; return (D.gare || []).filter((g) => g.data >= o && L.circuitiDi(g, D.esteroDoc).includes(c) && nomeLuogo(g.luogo).toLowerCase() === citta.toLowerCase() && nomi.length).sort((a, b) => a.data.localeCompare(b.data))[0]; };
    const extra = mancanti.map((citta) => {
      const it = italiana(citta);
      if (it) return [it.data, `<article class="card">${cardGara(it, `<span class="row" style="gap:6px;flex-wrap:wrap">${pillCircuiti([c])}<span class="pill grigio">nel calendario italiano</span></span>${giaMie.has(it.id) ? `<a class="pill ok" style="align-self:flex-start" href="${urlGara(it.id)}">già tra le tue gare ›</a>` : `<a class="btn small" style="align-self:flex-start" href="#/aggiungi/${encodeURIComponent(it.id)}">Scegli ${esc(L.DIST_LABEL[it.distanza])}</a>`}`)}</article>`];
      return ["9999", `<article class="card citta-attesa"><div class="between"><span class="title">${esc(citta)}</span>${pillCircuiti([c])}</div><span class="small muted">La data della prossima edizione non è ancora ufficiale: appena esce la trovi qui.</span></article>`];
    });
    return `<div class="chips chips-scorri" role="group" aria-label="Circuito">${chip("c", "", "Tutte", c)}${Object.entries(D.circuiti).map(([k, x]) => chip("c", k, esc(x.breve || x.nome), c)).join("")}</div>
      ${conDistanza ? `<div class="chips" role="group" aria-label="Distanza">${chip("d", "", "Mezza e maratona", dist)}${chip("d", "21", "Mezza", dist)}${chip("d", "42", "Maratona", dist)}</div>` : ""}
      ${c && info.nome ? `<p class="sub">${esc(info.nome)}${info.citta ? ` · ${info.citta.length} ${c === "superhalfs" ? "mezze" : "maratone"}` : ""}${info.sito ? ` · <a href="${esc(info.sito)}" rel="noopener">sito del circuito ↗</a>` : ""}</p>` : ""}
      ${ris.length || extra.length ? `<div style="display:flex;flex-direction:column;gap:8px">${[...ris.map((g) => [g.data, `<article class="card">${cardGara(g, `<span class="row" style="gap:6px;flex-wrap:wrap">${pillCircuiti(g.circuiti)}${pillIscrizione(g)}</span>${giaMie.has(g.id) ? `<a class="pill ok" style="align-self:flex-start" href="${urlGara(g.id)}">già tra le tue gare ›</a>` : `<span class="row" style="gap:8px">${inMirino(g.id) ? `<span class="pill navy-pill">⭐ nel mirino</span>` : ""}<a class="btn small" href="#/estera/${encodeURIComponent(g.id)}">Scopri</a></span>`}`)}</article>`]), ...extra].sort((a, b) => a[0].localeCompare(b[0])).map((x) => x[1]).join("")}</div>` : `<p class="sub">Nessuna gara con questi filtri.</p>`}
      <p class="sub">Le Abbott World Marathon Majors, le SuperHalfs, gli European Marathon Classics e le grandi gare europee. Date e iscrizioni dai siti ufficiali${D.esteroDoc.aggiornato ? `, ricontrollate il ${esc(L.fmtGiorno(D.esteroDoc.aggiornato))}` : ""}: fai sempre fede al sito della gara.</p>`;
  }

  // ---------------------------------------------------------------- gare estere: presentazione, pagina, "nel mirino"
  // Una gara estera non si aggiunge come una gara di paese: si scopre (presentazione a schermate la prima volta), si mette
  // "nel mirino" (S.mirino: solo la gara, niente preparazione né notifiche) e si attiva da iscritti (diventa una gara
  // normale in S.gare). La presentazione si vede una volta per gara (S.introEstere), e si può rivedere.
  const garaEsteraDati = (id) => (D.estero || []).find((x) => x.id === id) || (S.mirino || []).find((x) => x.id === id) || null;
  const inMirino = (id) => (S.mirino || []).some((x) => x.id === id);
  const MESI_LUNGHI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  const dataLunga = (iso) => { const d = new Date(iso + "T12:00:00"); return `${["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"][d.getDay()]} ${d.getDate()} ${MESI_LUNGHI[d.getMonth()]} ${d.getFullYear()}`; };
  // L'animazione del circuito, in SVG: le città si accendono una dopo l'altra, quella della gara pulsa d'oro.
  function animCircuito(it) {
    const n = it.citta.length;
    if (it.circuito === "grandi" || !n) {
      const pallini = Array.from({ length: 96 }, (_, i) => { const x = 18 + (i % 12) * 24, y = 40 + Math.floor(i / 12) * 24; return `<circle class="an-folla" cx="${x}" cy="${y}" r="6" style="--d:${((i % 12) + Math.floor(i / 12)) * 60}ms"/>`; }).join("");
      return `<svg class="an" viewBox="0 0 300 260" role="img" aria-label="Una folla di runner">${pallini}<text x="150" y="250" text-anchor="middle" class="an-num">15.000+</text></svg>`;
    }
    const cx = 150, cy = 140, r = 104, forma = it.circuito === "major" ? "stella" : "medaglia";
    const pezzi = it.citta.map((c, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a), mia = i === it.indice;
      const sim = forma === "stella" ? `<path d="M0,-13 L3.8,-4.2 13,-4 5.8,2.2 8.2,11.6 0,6.3 -8.2,11.6 -5.8,2.2 -13,-4 -3.8,-4.2Z"/>` : `<circle r="11"/><circle r="6" class="an-centro"/>`;
      const co = Math.cos(a), si = Math.sin(a), lato = co > 0.3 ? "start" : co < -0.3 ? "end" : "middle";
      const lx = x + (lato === "middle" ? 0 : co > 0 ? 20 : -20), ly = lato === "middle" ? y + (si < 0 ? -22 : 32) : y + 5;
      return `<g class="an-pezzo ${mia ? "mia" : ""}" style="--d:${300 + i * 260}ms"><g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${mia ? 1.45 : 1})">${sim}</g><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${lato}">${esc(c)}</text></g>`;
    }).join("");
    const centro = it.circuito === "classics" ? `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="an-num">5</text><text x="${cx}" y="${cy + 20}" text-anchor="middle" class="an-sotto">per la medaglia</text>`
      : `<text x="${cx}" y="${cy + 10}" text-anchor="middle" class="an-num">${n}</text><text x="${cx}" y="${cy + 30}" text-anchor="middle" class="an-sotto">${it.circuito === "major" ? "Major" : "mezze"}</text>`;
    return `<svg class="an" viewBox="-40 0 380 290" role="img" aria-label="${esc(it.info.nome || "")}: ${esc(it.citta.join(", "))}"><circle cx="${cx}" cy="${cy}" r="${r}" class="an-anello"/>${pezzi}${centro}</svg>`;
  }
  function vistaIntroEstera(g) {
    const it = L.introEstera(g, D.esteroDoc), e = garaEsteraDati(g.id) || g, b = L.benvenutoTop([it.circuito], g.distanza);
    const nomeC = it.info.nome || "Gara internazionale", altri = it.altri.map((c) => (D.circuiti[c] || {}).nome).filter(Boolean);
    const km = g.distanza === "42" ? "42,195 km" : "21,097 km";
    const isc = e.iscrizione === "ballottaggio" ? ["🎟️", "Si entra con il ballottaggio", "I pettorali si sorteggiano tra chi si candida. Incrociamo le dita 🤞"]
      : e.iscrizione === "qualificazione" ? ["⏱️", "Serve un tempo di qualificazione", "Si entra con un tempo minimo ottenuto in una maratona valida."]
      : e.iscrizione === "libera" ? ["✅", "Iscrizioni libere", "Fino a esaurimento dei pettorali: nelle grandi gare finiscono in fretta."] : ["🏁", "Come si entra", "Le iscrizioni sono sul sito ufficiale."];
    // Foto della città (content/sfondi.json): l'iconica nella prima schermata, quella dell'immagine da condividere
    // come sfondo a tutto schermo della seconda (compare in dissolvenza quando la schermata è visibile).
    const foto = (D.sfondi || {})[chiaveCitta(g)] || null, ico = foto && foto.iconica;
    const posFoto = (f) => `object-position:${Math.round((f.fuoco || [0.5, 0.4])[0] * 100)}% ${Math.round((f.fuoco || [0.5, 0.4])[1] * 100)}%`;
    const credito = (f) => `Foto: ${f.autore} · Wikimedia Commons (${f.licenza})`;
    const cartolina = ico ? `<figure class="an-cartolina"><img src="${esc(ico.file)}" alt="${esc(ico.titolo || g.luogo)}" style="${posFoto(ico)}" onerror="this.closest('figure').remove()"><figcaption><b>${esc(g.luogo)}</b>${ico.titolo ? ` · ${esc(ico.titolo)}` : ""}</figcaption></figure>` : "";
    const slides = [
      { k: nomeC, t: b ? b.titolo : "Una delle grandi d'Europa", d: `${it.info.racconto || ""} ${it.info.traguardo || ""}${altri.length ? ` Fa parte anche di ${altri.join(" e ")}.` : ""}`.trim(),
        ill: cartolina ? `${cartolina}<div class="an-piccola">${animCircuito(it)}</div>` : animCircuito(it), credito: ico ? credito(ico) : "" },
      { k: dataLunga(g.data), t: g.luogo, d: e.racconto || `${g.nome}: ${km} a ${g.luogo}${e.paese ? `, ${e.paese}` : ""}.`, sfondo: !!foto, credito: foto ? credito(foto) : "",
        ill: `<div class="an-citta"><svg class="an" viewBox="0 0 300 150" aria-hidden="true"><path class="an-percorso" d="M20 120 C60 40 110 140 150 80 S230 20 280 60"/><circle class="an-arrivo" cx="280" cy="60" r="7"/></svg><span class="an-km">${km}</span></div>` },
      { k: "Il pettorale", t: isc[1], d: `${e.notaIscrizione ? e.notaIscrizione + " " : ""}${isc[2]}`, ill: `<div class="ob-countdown"><span class="big an-ticket">${isc[0]}</span></div>` },
    ];
    const tot = slides.length + 1;
    return `<section class="ob ob-estera" aria-roledescription="presentazione" aria-label="${esc(g.nome)}">
      ${foto ? `<div class="ob-sfondo" aria-hidden="true"><img src="${esc(foto.file)}" alt="" style="${posFoto(foto)}" onerror="this.parentNode.remove()"></div>` : ""}
      <div class="ob-top"><span class="ob-logo">${esc(g.nome)}</span><button class="ob-salta" data-act="intro-fine" data-id="${esc(g.id)}">Salta</button></div>
      <div class="ob-track" id="ob-track">${slides.map((x, i) => `<article class="ob-slide ${i ? "" : "vista"} ${x.sfondo ? "con-sfondo" : ""}" aria-label="${i + 1} di ${tot}"><div class="ob-ill">${x.ill}</div><span class="eyebrow">${esc(x.k)}</span><h1>${esc(x.t)}</h1><p>${esc(x.d)}</p>${x.credito ? `<span class="ob-credito">${esc(x.credito)}</span>` : ""}</article>`).join("")}
        <article class="ob-slide" aria-label="${tot} di ${tot}"><div class="ob-ill"><div class="ob-countdown"><span class="big an-stella">⭐</span><span>${L.diffDays(g.data, oggi())} giorni al via</span></div></div><span class="eyebrow">E adesso?</span><h1>La metti nel mirino?</h1>
          <p>La segui senza impegno: date, ballottaggio e novità. Quando hai il pettorale, la attivi e parte la preparazione.</p>
          <button class="btn block" data-act="mirino-si" data-id="${esc(g.id)}">Mettila nel mirino ⭐</button>
          <button class="btn ob-sec block" data-act="intro-fine" data-id="${esc(g.id)}">Prima voglio guardarla</button></article></div>
      <div class="ob-bottom"><div class="ob-dots" aria-hidden="true">${Array.from({ length: tot }, (_, i) => `<span class="${i ? "" : "on"}"></span>`).join("")}</div><button class="btn" id="ob-avanti" data-act="ob-avanti">Avanti</button></div></section>`;
  }
  function vistaEstera(id) {
    const g = garaEsteraDati(id);
    if (!g) return `<p class="sub">Gara non trovata: forse questa edizione è già passata.</p><a class="btn" href="#/gare?v=estero">I circuiti</a>`;
    const it = L.introEstera(g, D.esteroDoc), n = L.diffDays(g.data, oggi()), mir = inMirino(id), cs = L.circuitiDi(g, D.esteroDoc);
    return `${bannerProva()}<header class="head-back">${back(mir ? "#/gare?v=mie" : "#/gare?v=estero")}<div style="min-width:0"><span class="eyebrow">${esc(cs.map((c) => (D.circuiti[c] || {}).breve || c).join(" · "))}</span><h1 style="font-size:28px">${esc(g.nome)}</h1></div></header>
      <section class="card dark benvenuto-top"><div class="between" style="align-items:flex-end"><div style="display:flex;flex-direction:column;gap:2px;min-width:0">
        <span style="font:700 20px/1.1 var(--display)">${esc(g.luogo)}${g.paese ? `, ${esc(g.paese)}` : ""}</span><span class="sub">${esc(dataLunga(g.data))} · ${esc(L.DIST_LABEL[g.distanza])}</span></div>
        <div style="text-align:right"><div class="big" style="font-size:44px">${n}</div><span class="sub">giorni</span></div></div>
        ${mir ? `<span class="pill navy">⭐ Nel mirino</span>` : ""}</section>
      ${g.racconto ? `<section class="card"><span class="small">${esc(g.racconto)}</span></section>` : ""}
      ${riquadriTop(g, false)}
      ${it.info.nome ? `<section class="card"><h2>${esc(it.info.nome)}</h2><span class="small">${esc(it.info.racconto || "")} ${esc(it.info.traguardo || "")}</span>${it.info.sito ? `<a class="small" href="${esc(it.info.sito)}" rel="noopener">Il sito del circuito ↗</a>` : ""}</section>` : ""}
      ${mir ? `<a class="btn block" href="#/aggiungi/${encodeURIComponent(id)}">Sono iscritto: attiva la preparazione</a>
        <button class="btn ghost block" data-act="mirino-no" data-id="${esc(id)}">Non la seguo più</button>`
      : `<button class="btn block" data-act="mirino-si" data-id="${esc(id)}">Mettila nel mirino ⭐</button>
        <a class="btn ghost block" href="#/aggiungi/${encodeURIComponent(id)}">Sono già iscritto: attiva la preparazione</a>`}
      <button class="linkbtn small" data-act="intro-rivedi" data-id="${esc(id)}" style="align-self:center">Rivedi la presentazione</button>
      ${g.sito ? `<p class="sub">Date e iscrizioni dal <a href="${esc(g.sito)}" rel="noopener">sito ufficiale ↗</a>${g.verificato ? `, ricontrollate il ${esc(L.fmtGiorno(g.verificato))}` : ""}.</p>` : ""}`;
  }

  // Gare del top (Major, SuperHalfs): un benvenuto speciale. Iscrizione con ballottaggio o qualificazione: in evidenza.
  function riquadriTop(g, scelta) {
    const e = (D.estero || []).find((x) => x.id === g.id) || {}, cs = L.circuitiDi(g, D.esteroDoc), b = L.benvenutoTop(cs, g.distanza);
    const top = b ? `<section class="card dark benvenuto-top" aria-label="${esc(b.titolo)}"><span class="eyebrow">★ ${esc(cs.map((c) => (D.circuiti[c] || {}).nome || c).join(" · "))}</span><span style="font:700 22px/1.15 var(--display)">${esc(b.titolo)}</span><span class="sub">${esc(b.testo)}</span></section>` : "";
    const sito = e.sito ? `<a class="small" href="${esc(e.sito)}" rel="noopener" style="font-weight:700">Iscrizioni sul sito ufficiale ↗</a>` : "";
    const iscr = e.iscrizione === "ballottaggio" ? `<section class="card ballottaggio-box" aria-label="Iscrizione con ballottaggio"><span class="title">🎟️ Iscrizione con ballottaggio</span><span class="small">${esc(e.notaIscrizione || "I pettorali si assegnano con un sorteggio: iscriversi al ballottaggio non garantisce il posto.")}</span>${scelta ? `<span class="small muted">Puoi aggiungerla già ora: la preparazione resta valida anche se il pettorale arriva più tardi, con charity o tour operator.</span>` : ""}${sito}</section>`
      : e.iscrizione === "qualificazione" ? `<section class="card ballottaggio-box" aria-label="Iscrizione con tempo di qualificazione"><span class="title">⏱️ Serve un tempo di qualificazione</span><span class="small">${esc(e.notaIscrizione || "Per iscriverti serve un tempo minimo ottenuto in una maratona valida, diverso per età e sesso.")}</span>${sito}</section>` : "";
    return top + iscr;
  }
  function vistaAggiungi(id) {
    const g = D.gare.find((x) => x.id === id) || (D.estero || []).find((x) => x.id === id) || (S._bozza && S._bozza.id === id ? S._bozza : null);
    if (!g) return `<p class="sub">Gara non trovata.</p><a class="btn" href="#/gare">Torna alle gare</a>`;
    const ha = S.gare.some((x) => x.ruolo === "obiettivo" && x.data >= oggi());
    const r = (v, t, d, chk) => `<label class="radio"><input type="radio" name="ruolo" value="${v}" ${chk ? "checked" : ""}><span><span class="title" style="font-size:16px">${t}</span><br><span class="small">${d}</span></span></label>`;
    const P = S.profilo;
    return `<header class="head-back">${back(garaEstera(g) ? `#/estera/${encodeURIComponent(g.id)}` : "#/gare")}<div><h1 style="font-size:26px">${esc(titoloGara(g.nome))}</h1><span class="sub">${esc(L.fmtGiorno(g.data))} · ${esc(L.DIST_LABEL[g.distanza])} · tra ${L.diffDays(g.data, oggi())} giorni</span></div></header>
      ${riquadriTop(g, true)}
      <form id="aggiungi" data-id="${esc(id)}" style="display:flex;flex-direction:column;gap:16px">
      <fieldset style="border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px"><legend class="title" style="margin-bottom:8px;padding:0">Che gara è per te?</legend>
        ${r("obiettivo", "Obiettivo", "Costruisco la preparazione su questa gara", !ha)}
        ${r("tappa", "Tappa", "Una gara di passaggio verso l'obiettivo", ha)}
        ${r("divertimento", "Per divertimento", "Solo checklist e promemoria", false)}</fieldset>
      <div class="field"><span class="lbl" id="a-tempo-l">Tempo obiettivo <span class="muted">(facoltativo)</span></span>${campoTempo("a-tempo", g.distanza, "", "a-tempo-l")}</div>
      ${P.citta ? "" : `<span class="title">Due cose su di te <span class="muted small" style="font-weight:500">· puoi saltarle</span></span>
      <div class="field">${bottoneGps("a-citta")}</div>
      <div class="grid2"><div class="field"><label for="a-citta">Dove corri di solito</label><input class="input" id="a-citta" placeholder="es. Roma"></div>
      <div class="field"><label for="a-ora">A che ora</label><input class="input" id="a-ora" type="time" step="900" value="07:00"></div></div>`}
      <button class="btn block" type="submit">Crea la mia preparazione</button></form>`;
  }

  // ---------------------------------------------------------------- la gara: panoramica, preparazione, info gara, borsa
  // Architettura: la Panoramica riassume (quanto manca, cosa fare adesso, info chiave, borsa, gruppo) e rimanda alle tre
  // sezioni di dettaglio. Preparazione = cosa fare e quando. Info gara = logistica e percorso di gara (dal sito ufficiale).
  // Borsa = cosa portare e la mattina della gara.
  const CAMPI = [
    ["partenza", "Orario di partenza", "es. 8:30"],
    ["luogoPartenza", "Partenza e arrivo", "es. Piazza Duomo / Stadio"],
    ["pettorale", "Ritiro pettorale", "dove e quando, es. Expo, ven-sab 10-19"],
    ["griglia", "Griglia o onda", "es. griglia C, chiusura 8:15"],
    ["deposito", "Deposito borse", "dove e fino a che ora"],
    ["ristori", "Ristori e spugnaggi", "es. ogni 5 km, gel al 25°"],
    ["arrivare", "Come arrivare e parcheggi", "es. metro A fermata …"],
    ["sito", "Sito ufficiale", "https://…"],
    ["note", "Altre note", ""],
  ];
  const garaCalendario = (g) => (D.gare || []).find((x) => x.id === g.id) || {};
  const infoGara = (g) => { const c = garaCalendario(g); return Object.assign({}, c.ora ? { partenza: c.ora } : {}, c.sito ? { sito: c.sito } : {}, (D.schede || {})[g.id] || {}, g.info || {}); };
  const oraPartenza = (g) => { const m = String(infoGara(g).partenza || "").match(/\d{1,2}[:.]\d{2}/); return m ? m[0].replace(".", ":") : null; };
  const urlGara = (id, sez = "") => `#/gara/${encodeURIComponent(id)}${sez ? "/" + sez : ""}`;
  // Link a Google Maps per la partenza: usa il campo "mappa" della scheda (indirizzo o "lat,lon"), altrimenti il testo + città.
  function mappa(info, g) {
    const q = info.mappa || `${String(info.luogoPartenza || "").split(/,|\barrivo\b/i)[0].replace(/^partenza (da|in)\s*/i, "")} ${nomeLuogo(g.luogo)}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q.trim())}`;
  }
  function testataGara(g, sez) {
    const tab = (k, l) => `<a href="${urlGara(g.id, k)}" ${sez === k ? 'aria-current="page"' : ""}>${l}</a>`;
    return `${bannerProva()}<header class="head-back">${back(sez ? urlGara(g.id) : "#/gare")}<div style="min-width:0"><span class="eyebrow">${esc(L.fmtGiorno(g.data))} · ${esc(L.DIST_LABEL[g.distanza])} · ${esc(L.RUOLO_LABEL[g.ruolo].toLowerCase())}</span><h1 style="font-size:28px">${esc(titoloGara(g.nome))}</h1></div>${pulsanteBuddy()}</header>
      <nav class="seg" aria-label="Sezioni della gara">${tab("", "Panoramica")}${tab("preparazione", "Preparazione")}${tab("info", "Info gara")}${tab("borsa", "Borsa")}</nav>`;
  }
  // Ciclo di vita: attiva → post-gara (3 giorni) → archivio. Esiti diversi dal tempo, segnati da "Com'è andata?".
  const oraAdesso = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const cicloGara = (g, o = oggi()) => L.ciclo(g, o, (S.risultati || {})[g.id], oraAdesso());
  const corsa = (g, o = oggi()) => cicloGara(g, o) !== "attiva"; // gara già corsa (anche oggi, dopo le 12)
  const nonArchiviata = (g) => cicloGara(g) !== "archiviata";
  const ESITO = { dnf: "Ritirato", dns: "Non partito", annullata: "Annullata" };
  // Dove cercare il meteo di una gara: le estere in tutto il mondo (ore locali del posto), le italiane in Italia.
  const garaEstera = (g) => String(g.id || "").startsWith("E-");
  const luogoMeteo = (g) => (garaEstera(g) ? { cerca: g.luogo, mondo: true } : nomeLuogo(g.luogo) || S.profilo.citta || "");
  const garaMancante = () => `<p class="sub">Gara non trovata tra le tue.</p><a class="btn" href="#/gare">Le mie gare</a>`;
  function boxMeteoGara(g, modo) {
    const n = L.diffDays(g.data, oggi());
    if (n < 0) return "";
    if (n > 15) return modo === "info" ? `<section class="card"><h2>Meteo della gara</h2><span class="small muted">Le previsioni arrivano 15 giorni prima, dal ${esc(L.fmtGiorno(L.addDays(g.data, -15)))}.</span></section>` : "";
    return `<section class="card ${modo === "borsa" ? "soft" : ""}" id="meteo-gara-box" data-id="${esc(g.id)}" data-modo="${modo}" aria-label="Meteo della gara"><h2>Meteo della gara</h2><span class="small muted">Previsioni in arrivo…</span></section>`;
  }
  async function riempiMeteoGaraBox() {
    const box = document.getElementById("meteo-gara-box");
    if (!box) return;
    const g = S.gare.find((x) => x.id === box.dataset.id), modo = box.dataset.modo;
    if (!g) return;
    const ora = oraPartenza(g);
    try {
      const m = await meteoAlle(luogoMeteo(g), `${g.data}T${oraISO(ora || "9:00")}`);
      if (!m) { box.innerHTML = `<h2>Meteo della gara</h2><span class="small">Previsioni non disponibili per questo luogo.</span>`; return; }
      const titolo = `${modo === "borsa" ? "Come vestirti" : "Meteo della gara"} · ${esc(m.luogo)} alle ${esc(ora || "9:00")}${ora ? "" : " (indicativo)"}`;
      box.innerHTML = modo === "home"
        ? `<h2>${titolo}</h2><div class="meteo-top">${icona(m, 40)}<div style="flex:1"><b style="font:700 28px var(--display)">${Math.round(m.temp)}°</b> <span class="small muted">${esc(L.descriviMeteo(m).split(", ").slice(1).join(", "))}</span></div></div><span class="small">${esc(L.vestizione(m, true).split(". ")[0])}.</span>`
        : `<h2>${titolo}</h2>${bloccoMeteo(m, true)}`;
    } catch (e) { box.innerHTML = `<h2>Meteo della gara</h2><span class="small muted">Meteo non disponibile al momento.</span>`; }
  }

  function vistaGaraHome(id, param) {
    const g = S.gare.find((x) => x.id === id);
    if (!g) return garaMancante();
    const o = oggi(), n = L.diffDays(g.data, o), f = L.fase(D.fasi, g.distanza, g.data, o), info = infoGara(g), ora = oraPartenza(g);
    const st = statoGara(g, o);
    const prossime = [...st.oggi.filter((v) => v.tipo === "cosa da fare"), ...st.settimana].filter((v, i, a) => !fattaVoce(v.chiave) && a.findIndex((x) => x.chiave === v.chiave) === i).slice(0, 3);
    const momento = st.momenti[0];
    const ck = L.checklist(D.percorso, g, S.personali), tot = ck.borsa.length; // la mattina della gara è una lista da leggere, non si spunta
    const fatte = ck.borsa.filter((v) => S.spunte[v.chiave]).length;
    const righeInfo = [["Partenza", [ora, info.luogoPartenza && String(info.luogoPartenza).split(/[,.]/)[0].replace(/^partenza (da|in)\s*/i, "")].filter(Boolean).join(" · ")], ["Pettorale", info.pettorale && String(info.pettorale).split(/[.:]/)[0]], ["Griglia", info.griglia && String(info.griglia).split(".")[0]]].filter((x) => x[1]);
    const imgOk = /^https:\/\//i.test(info.percorsoImmagine || "");
    const gr = S.gruppo && S.gruppo.dentro && GD() ? GD().gare.filter((x) => x.gara_id === g.id && x.membro_id !== GD().io.id).map((x) => x.membro) : [];
    const ris = (S.risultati || {})[g.id];
    return `${testataGara(g, "")}
      <section class="card dark"><div class="between" style="align-items:flex-end"><div style="display:flex;flex-direction:column;gap:2px;min-width:0">
        <span style="font:700 20px/1.1 var(--display)">${esc(L.fmtGiorno(g.data))} ${esc(g.data.slice(0, 4))}${ora ? " · ore " + esc(ora) : ""}</span>
        <span class="sub">${esc(nomeLuogo(g.luogo) || "Luogo da indicare")}${g.tempo ? " · obiettivo " + esc(g.tempo) : ""}</span></div>
        <div style="text-align:right">${n > 0 ? `<div class="big" style="font-size:44px">${n}</div><span class="sub">${n === 1 ? "giorno" : "giorni"}</span>` : `<span class="pill navy">${n === 0 ? "oggi!" : "conclusa"}</span>`}</div></div>
        ${n >= 0 ? `${barraFasi(g, true)}<span class="sub">${f.id === "prima" ? "Preparazione non ancora iniziata" : `Fase: <b style="color:#fff">${esc(f.nome)}</b>`}</span>` : ""}</section>
      ${corsa(g, o) ? `<a class="card soft" href="#/risultato/${encodeURIComponent(g.id)}" style="text-decoration:none;color:inherit;font-weight:inherit"><span class="title">${ris ? `Il tuo tempo: ${esc(ris.tempo)}${ris.pb ? " · personale!" : ""}` : g.esito ? ESITO[g.esito] : "Com'è andata?"}</span><span class="small">${ris ? "Modifica o condividi ›" : g.esito ? "Cambia ›" : "Segna il tuo tempo ›"}</span></a>` : ""}
      ${n >= 0 ? riquadriTop(g, false) : ""}
      ${cardStagioneGara(g, fatte, tot)}
      ${riquadroNovita(g)}
      ${n >= 0 ? avvisoDocumenti(g) : ""}
      ${n >= 0 ? `<a class="card link-card" href="${urlGara(g.id, "preparazione")}"><div class="between"><h2>Preparazione</h2><span class="small" style="color:var(--accent);font-weight:700">Tutta ›</span></div>
        ${prossime.length ? prossime.map((v) => `<div class="riga-next"><span class="when ${v.data <= o ? "hot" : ""}">${v.data <= o ? "oggi" : esc(L.fmtBreve(v.data))}</span><span>${esc(v.titolo)}</span></div>`).join("") : `<span class="small">Niente da fare nei prossimi giorni.</span>`}
        ${st.daRecuperare.length ? `<span class="small" style="color:var(--accent-strong);font-weight:700">${st.daRecuperare.length} da recuperare</span>` : ""}
        ${momento ? `<span class="small muted">Prossimo momento: ${esc(momento.titolo)} · ${esc(L.fmtBreve(momento.data))}</span>` : ""}</a>` : ""}
      ${boxMeteoGara(g, "home")}
      <a class="card link-card" href="${urlGara(g.id, "info")}"><div class="between"><h2>Info gara</h2><span class="small" style="color:var(--accent);font-weight:700">Tutte ›</span></div>
        ${righeInfo.length ? righeInfo.map(([l, t]) => `<div class="riga-next"><span class="when" style="width:84px">${l}</span><span>${esc(t)}</span></div>`).join("") : `<span class="small">Orari, pettorale, griglie e percorso di gara: arrivano dal sito ufficiale, oppure li annoti tu.</span>`}
        ${imgOk || info.percorsoDescrizione ? `<div class="mini-percorso">${imgOk ? `<img src="${esc(info.percorsoImmagine)}" alt="" loading="lazy" onerror="this.remove()">` : ""}<span class="small">${esc(info.percorsoDescrizione ? info.percorsoDescrizione.split(".")[0] + "." : "Il percorso di gara")}</span></div>` : ""}</a>
      ${n >= 0 ? `<a class="card link-card ${n <= 2 ? "soft" : ""}" href="${urlGara(g.id, "borsa")}"><div class="between"><h2>Borsa</h2><span class="small" style="color:var(--accent);font-weight:700">Apri ›</span></div>
        <div class="between small"><span><b>${fatte} di ${tot}</b> pronte</span><span class="muted">${n <= 2 ? "è il momento di prepararla" : "da preparare la sera prima"}</span></div><div class="meter acc" aria-hidden="true"><div style="width:${tot ? Math.round((fatte / tot) * 100) : 0}%"></div></div></a>` : ""}
      ${gr.length ? `<a class="card link-card" href="#/gruppo/gara/${encodeURIComponent(g.id)}"><div class="between"><h2>Il gruppo</h2><span class="small" style="color:var(--accent);font-weight:700">›</span></div><div class="row">${avatari(gr)}<span class="small">${gr.length} del gruppo ${gr.length === 1 ? "corre" : "corrono"} anche loro</span></div></a>` : ""}
      <details class="card" ${param.modifica ? "open" : ""}><summary>Ruolo e tempo obiettivo</summary>
        <form id="gara-imp" data-id="${esc(g.id)}" style="display:flex;flex-direction:column;gap:10px">
        <div class="field"><label for="gi-ruolo">Ruolo</label><select class="input" id="gi-ruolo">${["obiettivo", "tappa", "divertimento"].map((r) => `<option value="${r}" ${g.ruolo === r ? "selected" : ""}>${L.RUOLO_LABEL[r]}</option>`).join("")}</select></div>
        <div class="field"><span class="lbl" id="gi-tempo-l">Tempo obiettivo <span class="muted">(facoltativo)</span></span>${campoTempo("gi-tempo", g.distanza, g.tempo || "", "gi-tempo-l")}</div>
        <button class="btn" type="submit">Salva</button></form></details>
      ${corsa(g, o) ? (() => {
        const c = cicloGara(g, o), torna = g.archiviata && L.ciclo({ ...g, archiviata: null }, o, ris) !== "archiviata";
        return `<section class="card soft" aria-label="Archivio"><span class="small">${c === "archiviata" ? "Questa gara è in archivio: la ritrovi in Gare, sotto Archivio, con il tuo tempo." : `Va in archivio ${quandoArchivio(g, o)}: la ritroverai in Gare, sotto Archivio.`}</span>
          ${c === "postgara" ? `<button class="btn ghost" data-act="archivia" data-id="${esc(g.id)}">Archivia ora</button>` : torna ? `<button class="btn ghost" data-act="riporta" data-id="${esc(g.id)}">Riporta tra le mie gare</button>` : ""}</section>`;
      })() : ""}
      <div><button class="btn danger block" data-act="rimuovi" data-id="${esc(g.id)}">Rimuovi gara</button></div>`;
  }

  function vistaPreparazione(id) {
    const o = oggi();
    if (!S.gare.length) return vistaVuota();
    const g = S.gare.find((x) => x.id === id);
    if (!g) return garaMancante();
    const f = L.fase(D.fasi, g.distanza, g.data, o);
    const st = statoGara(g, o);
    const rec = st.daRecuperare.length ? `<section class="card soft" aria-label="Da recuperare"><div class="between"><span class="title" style="color:var(--accent-strong)">Ti sei iscritto a preparazione iniziata</span><span class="small"><b>${st.daRecuperare.length}</b></span></div>${st.daRecuperare.map((v) => voceCheck(v)).join("")}</section>` : "";
    const sett = st.settimana.length ? `<section class="card" aria-label="Prossimi giorni"><h2>Nei prossimi 7 giorni</h2>${st.settimana.map((v) => voceCheck(v, { quando: L.fmtGiorno(v.data) })).join("")}</section>` : "";
    const mom = st.momenti.length ? `<section class="card list" aria-label="Prossimi momenti" style="padding-top:12px;padding-bottom:6px"><h2>Prossimi momenti</h2>${st.momenti.map((v) => `<div class="line"><span class="when">${esc(L.fmtBreve(v.data))}</span><span>${esc(v.titolo)}</span></div>`).join("")}</section>` : "";
    const altre = S.gare.filter((x) => x.id !== g.id && x.data <= g.data && x.data >= o);
    const tappe = altre.length ? `<section class="card list" style="padding-top:12px;padding-bottom:6px"><h2>Altre gare prima di questa</h2>${altre.map((x) => `<div class="line"><span class="when hot">${esc(L.fmtBreve(x.data))}</span><a href="${urlGara(x.id)}">${esc(titoloGara(x.nome))} · ${esc(L.RUOLO_LABEL[x.ruolo].toLowerCase())}</a></div>`).join("")}</section>` : "";
    const perFase = {};
    st.voci.forEach((v) => { (perFase[v.fase] = perFase[v.fase] || []).push(v); });
    const tutto = [...D.fasi].sort((a, b) => a.ordine - b.ordine).filter((x) => perFase[x.id]).map((x) =>
      `<h2 style="margin-top:8px">${esc(x.nome)}${x.id === f.id ? ' <span class="pill">ora</span>' : ""}</h2>${perFase[x.id].map((v) => v.tipo === "cosa da fare" ? voceCheck(v, { nodesc: true, quando: L.fmtGiorno(v.data) }) : `<div class="line" style="opacity:${v.data < o ? 0.55 : 1}"><span class="when">${esc(L.fmtBreve(v.data))}</span><span>${esc(v.titolo)}</span></div>`).join("")}`).join("");
    return `${testataGara(g, "preparazione")}
      <section aria-label="Fase attuale: ${esc(f.nome)}">${barraFasi(g)}</section>
      ${f.id === "prima" ? `<section class="card"><span class="small">La preparazione per questa gara parte il <b>${esc(L.fmtGiorno(L.addDays(g.data, D.fasi.find((x) => x.ordine === 1).giorni[g.distanza].inizio)))}</b>. Ti avviso io.</span></section>` : ""}
      ${rec}${sett}${tappe}${mom}
      <details class="card"><summary>Tutta la preparazione, fase per fase</summary>${tutto}</details>`;
  }

  function vistaInfoGara(id, param) {
    const g = S.gare.find((x) => x.id === id);
    if (!g) return garaMancante();
    const info = infoGara(g), n = L.diffDays(g.data, oggi());
    const compilati = CAMPI.filter(([k]) => info[k]);
    const cerca = `https://www.google.com/search?q=${encodeURIComponent(titoloGara(g.nome) + " " + g.data.slice(0, 4) + " sito ufficiale")}`;
    const sitoOk = /^https?:\/\//i.test(info.sito || "");
    const testa = testataGara(g, "info");
    if (param.modifica) {
      return `${testa}<form id="scheda" data-id="${esc(g.id)}" class="card"><h2>Informazioni pratiche</h2><span class="small muted">Valgono solo per te e prevalgono su quelle dal sito ufficiale.</span>
        ${CAMPI.map(([k, l, ph]) => `<div class="field"><label for="i-${k}">${l}</label>${k === "note" ? `<textarea class="input" id="i-${k}">${esc(info[k])}</textarea>` : k === "partenza" ? `<input class="input" id="i-partenza" type="time" step="300" value="${esc(oraInput((String(info.partenza || "").match(/\d{1,2}[:.]\d{2}/) || [""])[0]))}">` : `<input class="input" id="i-${k}" value="${esc(info[k])}" placeholder="${esc(ph)}" ${k === "sito" ? 'type="url" inputmode="url"' : ""}>`}</div>`).join("")}
        <div class="grid2"><button class="btn" type="submit">Salva</button><a class="btn ghost" href="${urlGara(g.id, "info")}">Annulla</a></div></form>`;
    }
    const azioni = [info.luogoPartenza || info.mappa ? `<a class="btn ghost small" href="${mappa(info, g)}" target="_blank" rel="noopener">Partenza in Maps ↗</a>` : "", sitoOk ? `<a class="btn ghost small" href="${esc(info.sito)}" target="_blank" rel="noopener">Sito ufficiale ↗</a>` : ""].filter(Boolean).join("");
    const logistica = compilati.length
      ? `<section class="card list" style="padding-top:12px;padding-bottom:6px" aria-label="Informazioni pratiche"><div class="between"><h2>Logistica</h2><a class="small" href="${urlGara(g.id, "info")}?modifica=1">Modifica</a></div>
        ${compilati.filter(([k]) => k !== "sito").map(([k, l]) => `<div class="line" style="flex-direction:column;gap:2px"><span class="small muted" style="font-weight:600">${l}</span><span style="white-space:pre-line">${esc(info[k])}</span>${k === "luogoPartenza" ? `<a class="small" href="${mappa(info, g)}" target="_blank" rel="noopener">Apri la partenza in Maps ↗</a>` : ""}</div>`).join("")}</section>`
      : `<section class="card"><h2>Logistica</h2><span class="small">Orario di partenza, ritiro pettorale, griglie, deposito borse, ristori: annotali qui una volta sola e li ritrovi quando servono, anche nella borsa.</span>
        <div class="grid2"><a class="btn" href="${urlGara(g.id, "info")}?modifica=1">Compila</a><a class="btn ghost" href="${cerca}" target="_blank" rel="noopener">Cerca il sito ↗</a></div>
        <span class="small muted">${n >= 0 ? "Le cerchiamo noi sul sito ufficiale: di solito compaiono qui entro un paio di giorni, quando l'organizzatore le ha pubblicate." : ""}</span></section>`;
    const uff = (D.schede || {})[g.id];
    const prov = uff ? `<p class="sub">Informazioni dal sito ufficiale${uff.verificato ? `, verificate il ${esc(L.fmtGiorno(uff.verificato))}` : ""}${(uff.fonti || []).filter((u) => /^https?:\/\//.test(u)).slice(0, 2).map((u, i) => ` · <a href="${esc(u)}" target="_blank" rel="noopener">fonte${uff.fonti.length > 1 ? " " + (i + 1) : ""} ↗</a>`).join("")}.${g.info && Object.keys(g.info).length ? " I campi che hai modificato tu valgono solo per te." : ""}</p>` : "";
    const imgOk = /^https:\/\//i.test(info.percorsoImmagine || ""), linkOk = /^https?:\/\//i.test(info.percorsoLink || "");
    const tracciato = imgOk || linkOk || info.percorsoDescrizione ? `<section class="card" aria-label="Il percorso di gara"><h2>Il percorso di gara</h2>
      ${imgOk ? `<a href="${esc(info.percorsoImmagine)}" target="_blank" rel="noopener" class="mappa-percorso"><img src="${esc(info.percorsoImmagine)}" alt="Mappa del percorso di ${esc(titoloGara(g.nome))}" loading="lazy" onerror="this.closest('a').remove()"></a><span class="small muted">Tocca la mappa per ingrandirla · immagine dal sito ufficiale</span>` : ""}
      ${info.percorsoDescrizione ? `<span class="small">${esc(info.percorsoDescrizione)}</span>` : ""}
      ${linkOk ? `<a class="small" href="${esc(info.percorsoLink)}" target="_blank" rel="noopener">Il percorso sul sito ufficiale ↗</a>` : ""}</section>` : "";
    return `${testa}${azioni ? `<div class="row" style="flex-wrap:wrap">${azioni}</div>` : ""}${logistica}${tracciato}${boxMeteoGara(g, "info")}${prov}
      ${(() => { const c = garaCalendario(g), d = dettagliCalendario(c); return d && L.diffDays(g.data, oggi()) >= 0 ? `<section class="card soft" aria-label="Iscrizione">${d}${c.scheda_lazio || c.fonte === "Gare Podistiche Lazio" ? `<a class="small" href="${esc(c.scheda_lazio || c.url)}" rel="noopener">La gara su Gare Podistiche Lazio ↗</a>` : ""}</section>` : ""; })()}
      <p class="sub">Dati del calendario: ${g.id.startsWith("M") ? "inseriti da te" : esc([garaCalendario(g).fonte && !/Lazio/.test(garaCalendario(g).fonte) ? "FIDAL" : "", garaCalendario(g).fonte === "Gare Podistiche Lazio" || garaCalendario(g).scheda_lazio ? "Gare Podistiche Lazio" : ""].filter(Boolean).join(" e ") || "FIDAL")}. Fai sempre fede al regolamento ufficiale della gara.</p>`;
  }

  function vistaBorsa(id) {
    const g = S.gare.find((x) => x.id === id);
    if (!g) return garaMancante();
    const ck = L.checklist(D.percorso, g, S.personali);
    const tutte = ck.borsa; // la mattina della gara si legge e basta: niente caselle, non conta nelle pronte
    const fatte = tutte.filter((v) => S.spunte[v.chiave]).length;
    const pct = tutte.length ? Math.round((fatte / tutte.length) * 100) : 0;
    const n = L.diffDays(g.data, oggi());
    return `${testataGara(g, "borsa")}
      <div style="display:flex;flex-direction:column;gap:6px"><div class="between small"><b>${fatte} di ${tutte.length} pronte</b><span class="muted">${n === 1 ? "la gara è domani" : n === 0 ? "la gara è oggi" : n > 1 ? "da preparare la sera prima" : ""}</span></div>
      <div class="meter acc" aria-hidden="true"><div style="width:${pct}%"></div></div></div>
      ${boxMeteoGara(g, "borsa")}
      ${(() => {
        const ud = n >= 0 ? L.ultimoDebrief(S.gare, S.risultati || {}, g.data) : null;
        return ud ? `<section class="card soft" aria-label="Dalla tua ultima gara"><span class="eyebrow" style="color:var(--accent-strong)">Dalla ${esc(titoloGara(ud.gara.nome))}</span>${ud.voci.map((x) => `<span class="small">• ${esc(x)}</span>`).join("")}${ud.nota ? `<span class="title" style="font-size:16px">«${esc(ud.nota)}»</span>` : ""}<a class="small" href="#/risultato/${encodeURIComponent(ud.gara.id)}">Rivedi il bilancio ›</a></section>` : "";
      })()}
      <section class="card" style="gap:0;padding-top:4px;padding-bottom:4px" aria-label="Borsa">${ck.borsa.map((v) => voceCheck(v, { nodesc: !v.messaggio })).join("")}</section>
      <form id="personale" class="row"><label class="sr" for="p-voce">Aggiungi una voce tua</label><input class="input" id="p-voce" placeholder="Aggiungi una voce tua" required><button class="btn" type="submit">Aggiungi</button></form>
      ${S.personali.length ? `<p class="sub">Le tue voci restano salvate per le prossime gare. <button class="btn ghost small" data-act="svuota-personali">Svuota le mie voci</button></p>` : ""}
      <section class="card" aria-label="Mattina della gara"><h2>La mattina della gara</h2>
        <a class="small" href="${urlGara(g.id, "info")}" style="font-weight:700">Orario, griglia, deposito e partenza: in Info gara ›</a>
        ${ck.mattina.length ? `<ol class="lista-mattina">${ck.mattina.map((v) => `<li><span class="t">${esc(v.titolo)}</span><span class="d">${esc(v.messaggio)}</span></li>`).join("")}</ol>` : ""}</section>`;
  }

  // ---------------------------------------------------------------- meteo dettaglio
  function vistaMeteo() {
    if (!S.profilo.citta) return `<header class="head-back">${back("#/oggi")}<h1 style="font-size:28px">Meteo</h1></header><a class="card" href="#/io" style="text-decoration:none;color:inherit"><span class="title">Dimmi dove corri</span><span class="small">Indica città e orario di uscita nel profilo.</span></a>`;
    return `${bannerProva()}<header class="head-back">${back("#/oggi")}<div><h1 style="font-size:28px">Meteo e vestizione</h1><span class="sub">${esc(S.profilo.citta)} · uscite alle ${esc(S.profilo.ora || "7:00")} · <a href="#/io">cambia</a></span></div></header>
      <div id="meteo-dettaglio" style="display:flex;flex-direction:column;gap:14px"><p class="sub">Previsioni in arrivo…</p></div>
      <p class="sub">Previsioni Open-Meteo. La vestizione è un'indicazione generale: ognuno sente il freddo a modo suo.</p>`;
  }
  async function riempiMeteoDettaglio() {
    const box = document.getElementById("meteo-dettaglio");
    if (!box) return;
    try {
      const sr = await serie(mioLuogo());
      if (!sr) { box.innerHTML = `<p class="sub">Non trovo la città "${esc(S.profilo.citta)}". Correggila nel profilo.</p>`; return; }
      const { h, c } = sr, ora = oraISO(S.profilo.ora), o = oggi();
      const at = (t) => { const i = h.time.indexOf(t); return i < 0 ? null : { temp: h.temperature_2m[i], pioggia: h.precipitation_probability[i] ?? 0, vento: h.wind_speed_10m[i] ?? 0, codice: h.weather_code ? h.weather_code[i] : null, notte: h.is_day ? h.is_day[i] === 0 : false }; };
      const giorni = [];
      const passata = !S.prova && L.prossimaUscita(S.profilo.ora, new Date()).slice(0, 10) !== L.todayISO();
      for (let d = passata ? 1 : 0; d < (passata ? 8 : 7); d++) { const dd = L.addDays(o, d), m = at(`${dd}T${ora}`); if (m) giorni.push([dd, m]); }
      const ore = [];
      const base = S.prova ? `${S.prova}T${ora}` : null;
      let i0 = base ? h.time.indexOf(base) : h.time.indexOf(`${L.todayISO()}T${String(new Date().getHours()).padStart(2, "0")}:00`);
      if (i0 >= 0) for (let i = i0; i < Math.min(h.time.length, i0 + 12); i += 2) ore.push([h.time[i].slice(11), { temp: h.temperature_2m[i], pioggia: h.precipitation_probability[i] ?? 0, codice: h.weather_code ? h.weather_code[i] : null, notte: h.is_day ? h.is_day[i] === 0 : false }]);
      const gareMeteo = S.gare.filter((g) => { const n = L.diffDays(g.data, o); return n >= 0 && n <= 15; });
      // Le gare entro 15 giorni con previsioni: in evidenza in cima, prima del meteo di oggi.
      const gareConMeteo = (await Promise.all(gareMeteo.sort((x, y) => x.data.localeCompare(y.data)).map(async (g) => {
        const ora = oraPartenza(g);
        try { const m = await meteoAlle(luogoMeteo(g), `${g.data}T${oraISO(ora || "9:00")}`); return m ? { g, m, ora } : null; } catch (e) { return null; }
      }))).filter(Boolean);
      const quandoGara = (d) => (d === L.todayISO() ? "oggi" : d === L.addDays(L.todayISO(), 1) ? "domani" : esc(L.fmtGiorno(d)));
      const carteGara = gareConMeteo.map(({ g, m, ora }) => `<section class="card gara-meteo" style="gap:12px" aria-label="Meteo di ${esc(titoloGara(g.nome))}"><span class="eyebrow" style="color:var(--accent-strong)">Meteo gara · ${quandoGara(g.data)} alle ${esc(ora || "9:00")}${ora ? "" : " (indicativo)"}</span><span class="title">${esc(titoloGara(g.nome))} · ${esc(m.luogo)}</span>${bloccoMeteo(m, true)}<a class="small" href="${urlGara(g.id)}" style="font-weight:700">Apri la scheda gara ›</a></section>`).join("");
      const oggiHtml = bloccoOggi(h, S.prova || L.todayISO());
      box.innerHTML = carteGara + (oggiHtml ? `<section class="card" style="gap:12px"><span class="eyebrow">Oggi · adesso · ${esc(c.nome)}</span>${oggiHtml}</section>` : `<p class="sub">Previsioni non disponibili per oggi.</p>`)
        + (ore.length ? `<section class="card"><h2>Nelle prossime ore</h2><div style="display:flex;justify-content:space-between;gap:4px;text-align:center">${ore.map(([t, m]) => `<div style="display:flex;flex-direction:column;align-items:center;gap:2px"><span class="small muted">${esc(t)}</span>${icona(m, 28)}<b style="font:700 20px var(--display)">${Math.round(m.temp)}°</b><span class="small muted">${m.pioggia}%</span></div>`).join("")}</div><span class="small muted">Temperatura e probabilità di pioggia, alle ore indicate.</span></section>` : "")
        + (giorni.length ? `<section class="card list" style="padding-top:12px;padding-bottom:6px"><h2>Le prossime uscite · alle ${esc(S.profilo.ora || "7:00")}</h2>${giorni.map(([dd, m]) => `<div class="line" style="flex-direction:column;gap:4px"><div class="between"><span style="display:flex;align-items:center;gap:8px">${icona(m, 30)}<b>${dd === L.todayISO() ? "Oggi" : dd === L.addDays(L.todayISO(), 1) ? "Domani" : esc(L.fmtGiorno(dd))}</b></span><span style="display:flex;align-items:center;gap:10px"><b style="font:700 20px var(--display)">${Math.round(m.temp)}°</b>${datiMeteo(m)}</span></div><span class="small">${esc(L.vestizione(m))}</span>${L.avvisiMeteo(m).filter((a) => a.livello === "attenzione").map((a) => `<span class="small" style="color:var(--warn);font-weight:600">${ICO_AVVISO[a.tipo] || "!"} ${esc(a.titolo)}</span>`).join("")}</div>`).join("")}</section>` : "")
        + gareMeteo.filter((g) => !gareConMeteo.some((x) => x.g.id === g.id)).map((g) => `<a class="card soft" href="${urlGara(g.id)}" style="text-decoration:none;color:inherit;font-weight:inherit"><span class="between"><span class="title">Meteo per ${esc(titoloGara(g.nome))}</span><span aria-hidden="true">›</span></span><span class="small">Il ${esc(L.fmtGiorno(g.data))}: previsioni non ancora disponibili.</span></a>`).join("");
    } catch (e) { box.innerHTML = `<p class="sub">Meteo non disponibile al momento.</p>`; }
  }

  function vistaPillole(id) {
    const o = oggi(), mese = Number(o.slice(5, 7));
    const g = S.gare.find((x) => x.id === id) || L.gareAttive(S.gare, D.fasi, o, S.risultati || {}).focus;
    if (!g) return `<p class="sub">Nessuna gara attiva.</p><a class="btn" href="#/gare">Scegli una gara</a>`;
    const f = L.fase(D.fasi, g.distanza, g.data, o);
    const pool = L.pillolePool(D.pillole, f.id, g.distanza, mese);
    const delGiorno = L.pillola(D.pillole, f.id, g.distanza, o, mese);
    const ord = [...pool].sort((a, b) => (a === delGiorno ? -1 : b === delGiorno ? 1 : 0));
    const fuori = f.id === "prima" || f.id === "conclusa" || !D.pillole.some((p) => p.fase === f.id);
    return `${bannerProva()}<header class="head-back">${back("#/oggi")}<div><h1 style="font-size:28px">Pillole</h1><span class="sub">${fuori ? "Consigli di stagione" : `${esc(f.nome)} · ${esc(L.DIST_LABEL[g.distanza])}`} · ${pool.length} pillole</span></div></header>
      ${ord.map((p) => `<section class="card ${p === delGiorno ? "soft" : ""}">${p === delGiorno ? `<span class="eyebrow" style="color:var(--accent-strong)">Pillola di oggi</span>` : `<span class="eyebrow">${esc(p.categoria || "")}</span>`}<span class="title">${esc(p.titolo)}</span><span class="small">${esc(p.testo)}</span></section>`).join("")}
      <p class="sub">Cambiano con le fasi della preparazione: quando entri nella fase successiva qui trovi le nuove.</p>`;
  }

  // ---------------------------------------------------------------- per te: articoli e video
  const TIPO_LABEL = { articolo: "Articolo", video: "Video", podcast: "Podcast" };
  const fa = (d) => { const n = L.diffDays(oggi(), d); return n <= 0 ? "oggi" : n === 1 ? "ieri" : n < 7 ? `${n} giorni fa` : L.fmtBreve(d); };

  // ---------------------------------------------------------------- novità ufficiali delle gare (data/novita_gare.json)
  const TEMA_LABEL = { annullata: "Annullata o rinviata", medaglia: "Medaglia", maglia: "Maglia ufficiale", percorso: "Percorso", partenza: "Partenza e orari", pettorale: "Pettorale ed Expo",
    risultati: "Risultati e foto", pacer: "Pacer", allenamento: "Allenamenti ufficiali", video: "Video", iscrizioni: "Iscrizioni", promo: "Promozioni", notizia: "Notizia", altro: "Altro evento" };
  const PRI_URG = { subito: 0, mattino: 1, app: 2 };
  const novitaDi = (gid) => (D.novita || []).filter((n) => n.gara === gid).sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : PRI_URG[a.urgenza] - PRI_URG[b.urgenza]));
  const novitaVista = (n) => !!(S.letti || {})["n:" + n.id];
  const novitaNuova = (n) => !novitaVista(n) && L.diffDays(oggi(), n.data) <= 14;
  const segnaNovitaViste = (lista) => { S.letti = S.letti || {}; let c = 0; for (const n of lista) if (!S.letti["n:" + n.id]) { S.letti["n:" + n.id] = oggi(); c++; } if (c) salva(); };
  const urlNovita = (n) => `${urlGara(n.gara, "novita")}?n=${encodeURIComponent(n.id)}`;
  const garaDiNovita = (n) => S.gare.find((g) => g.id === n.gara);
  const pillTema = (n) => `<span class="pill ${PRI_URG[n.urgenza] ? "grigio" : ""}">${esc(n.ufficiale ? TEMA_LABEL[n.tema] || "Notizia" : "Dalle riviste")}</span>`;
  const fonteNovita = (n) => `${esc(n.fonte)} · ${esc(fa(n.data))}`;
  const thumbNovita = (n, cls = "") => `<div class="thumb ${n.immagine ? "" : "noimg"} t-${esc(n.tipo)} ${cls}">${n.immagine ? `<img src="${esc(n.immagine)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('noimg');this.remove()">` : ""}${n.tipo === "video" ? '<span class="play" aria-hidden="true">▶</span>' : ""}</div>`;
  // La novità più importante non ancora vista delle tue gare (per Oggi)
  function novitaInEvidenza() {
    const gare = S.gare.filter((g) => g.data >= L.addDays(oggi(), -14)).map((g) => g.id);
    return L.novitaInEvidenza(D.novita, { gare, letti: S.letti || {}, esposte: S.vistiNovita || {}, oggi: oggi() });
  }
  function cardDallaGara() {
    const n = novitaInEvidenza(), g = n && garaDiNovita(n);
    if (!n || !g) return "";
    // mostrata in cima oggi: dopo 2 giorni diversi senza aprirla lascia il posto alla successiva
    const prima = JSON.stringify(S.vistiNovita || {});
    S.vistiNovita = L.segnaVisti(S.vistiNovita || {}, [n.id], oggi());
    if (JSON.stringify(S.vistiNovita) !== prima) setTimeout(salva, 0);
    return `<section class="card novita-top" aria-label="Dalla tua gara"><a href="${urlNovita(n)}" style="text-decoration:none;color:inherit;font-weight:inherit;display:flex;flex-direction:column">${thumbNovita(n)}<span class="nuovo-badge">Nuovo</span>
      <div class="novita-testo"><span class="eyebrow" style="color:var(--accent)">Dalla tua gara · ${esc(TEMA_LABEL[n.tema] || "Notizia")}</span><span class="novita-titolo">${esc(n.titolo)}</span>
      <span class="small muted">${esc(titoloGara(g.nome))} · ${fonteNovita(n)}</span></div></a>
      <button class="novita-x" data-act="novita-letta" data-id="${esc(n.id)}" aria-label="Togli dalla home: segna come letta">✕</button>
      <div class="novita-azioni"><button class="btn ghost small" data-act="novita-letta" data-id="${esc(n.id)}">✓ Segna come letta</button><a class="small" href="${urlGara(g.id, "novita")}" style="font-weight:700">Tutte le novità ›</a></div></section>`;
  }
  function riquadroNovita(g) {
    const lista = novitaDi(g.id).filter((n) => n.tema !== "altro").slice(0, 3);
    if (!lista.length) return "";
    return `<section class="card" style="gap:0"><div class="between" style="margin-bottom:4px"><h2>Novità ufficiali</h2><a class="small" href="${urlGara(g.id, "novita")}">Tutte ›</a></div>
      ${lista.map((n) => `<a class="riga-novita" href="${urlNovita(n)}"><span class="pallino ${novitaNuova(n) ? "on" : ""}" ${novitaNuova(n) ? 'aria-label="nuova"' : 'aria-hidden="true"'}></span><span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><span class="row" style="gap:6px">${pillTema(n)}<span class="small muted">${fonteNovita(n)}</span></span><span class="novita-riga-t">${esc(n.titolo)}</span></span></a>`).join("")}</section>`;
  }
  function vistaNovitaGara(id, param) {
    const g = S.gare.find((x) => x.id === id);
    if (!g) return garaMancante();
    const lista = novitaDi(id), s = (D.schede || {})[id] || {}, can = s.canali || {};
    const top = lista.find((n) => n.id === param.n) || lista.find((n) => novitaNuova(n) && n.urgenza === "subito") || lista[0];
    setTimeout(() => segnaNovitaViste(lista), 0);
    const altri = lista.filter((n) => n !== top);
    const dettagli = (n) => (["percorso", "partenza", "pettorale"].includes(n.tema) ? `<a class="small" href="${urlGara(id, "info")}">I dettagli pratici sono in Info gara ›</a>` : "");
    const link = [["Instagram", can.instagram], ["Facebook", can.facebook], ["Sito", s.sito]].filter(([, u]) => /^https:\/\//.test(u || ""));
    return `${bannerProva()}<header class="head-back">${back(urlGara(id))}<div style="min-width:0"><span class="eyebrow">${esc(titoloGara(g.nome))}</span><h1 style="font-size:28px">Novità ufficiali</h1></div></header>
      ${top ? `<a class="card novita-top ${novitaNuova(top) ? "" : "vista"}" href="${esc(top.link)}" target="_blank" rel="noopener" data-act="apri-novita" data-id="${esc(top.id)}">${thumbNovita(top)}${novitaNuova(top) ? '<span class="nuovo-badge">Nuovo</span>' : ""}
        <div class="novita-testo"><span class="row" style="gap:6px">${pillTema(top)}<span class="small muted">${fonteNovita(top)}</span></span><span class="novita-titolo">${esc(top.titolo)}</span></div></a>${dettagli(top)}`
        : `<p class="sub">Ancora nessuna novità ufficiale per questa gara. Le cerchiamo ogni ora sul sito ufficiale, sul canale YouTube della gara e nelle riviste italiane.</p>`}
      ${altri.length ? `<div class="lista-c">${altri.map((n) => `<a class="card riga-novita box" href="${esc(n.link)}" target="_blank" rel="noopener" data-act="apri-novita" data-id="${esc(n.id)}"><span class="pallino ${novitaNuova(n) ? "on" : ""}" ${novitaNuova(n) ? 'aria-label="nuova"' : 'aria-hidden="true"'}></span><span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px"><span class="row" style="gap:6px">${pillTema(n)}<span class="small muted">${fonteNovita(n)}</span></span><span class="novita-riga-t">${esc(n.titolo)}</span></span></a>`).join("")}</div>` : ""}
      ${link.length ? `<section style="display:flex;flex-direction:column;gap:8px"><h2>Segui la gara anche su</h2><div class="row" style="flex-wrap:wrap">${link.map(([l, u]) => `<a class="btn ghost small" href="${esc(u)}" target="_blank" rel="noopener">${l} ↗</a>`).join("")}</div></section>` : ""}
      <p class="sub">Raccolte dal sito ufficiale e dal canale YouTube della gara, e dalle riviste italiane che ne parlano: tocca per aprirle alla fonte.</p>`;
  }
  function cardNovitaPerTe(n) {
    const g = garaDiNovita(n);
    return `<a class="contenuto" href="${esc(n.link)}" target="_blank" rel="noopener" data-act="apri-novita" data-id="${esc(n.id)}">${thumbNovita(n)}
      <div class="c-testo"><span class="row" style="gap:6px;flex-wrap:wrap"><span class="pill navy-pill">${esc(titoloGara(g ? g.nome : ""))}</span>${novitaNuova(n) ? '<span class="pill">Nuovo</span>' : ""}</span>
      <span class="c-titolo">${esc(n.titolo)}</span><span class="c-meta">${n.ufficiale ? "Ufficiale" : esc(n.fonte)} · ${esc(TIPO_LABEL[n.tipo] || "")} · ${esc(fa(n.data))}</span></div></a>`;
  }
  const novitaMieGare = () => { const mie = new Set(S.gare.filter((g) => g.data >= L.addDays(oggi(), -14)).map((g) => g.id)); return L.ordinaNovita((D.novita || []).filter((n) => mie.has(n.gara) && n.tema !== "altro")); }; // dalla più recente: il blocco "Dalle tue gare" ne mostra 3, il filtro tutte
  function contesto() {
    const o = oggi(), { focus } = L.gareAttive(S.gare, D.fasi, o, S.risultati || {});
    if (!focus) return { o, fase: null, nomeFase: "Senza gara in vista", distanza: null };
    const f = L.fase(D.fasi, focus.distanza, focus.data, o);
    const fase = ["prima", "conclusa"].includes(f.id) ? null : f.id;
    return { o, fase, nomeFase: fase ? `${f.nome} · ${L.DIST_LABEL[focus.distanza]}` : "Senza gara in vista", distanza: focus.distanza };
  }
  function cardContenuto(c, grande) {
    const letto = (S.letti || {})["c:" + c.id];
    const img = c.immagine ? `<img src="${esc(c.immagine)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('noimg');this.remove()">` : "";
    return `<a class="contenuto ${grande ? "grande" : ""} ${letto ? "letto" : ""}" href="${esc(c.link)}" target="_blank" rel="noopener" data-act="apri-contenuto" data-id="${esc(c.id)}">
      <div class="thumb ${img ? "" : "noimg"} t-${esc(c.tipo)}">${img}${c.tipo === "video" ? '<span class="play" aria-hidden="true">▶</span>' : c.tipo === "podcast" ? '<span class="play" aria-hidden="true">🎧</span>' : ""}</div>
      <div class="c-testo"><span class="c-meta">${esc(c.fonte)} · ${esc(TIPO_LABEL[c.tipo] || "")} · ${esc(fa(c.data))}${letto ? " · già visto" : ""}</span>
      <span class="c-titolo">${esc(c.titolo)}</span>${grande && c.estratto ? `<span class="c-estratto">${esc(c.estratto)}</span>` : ""}</div></a>`;
  }
  function vistaPerTe(param) {
    const { o, fase, nomeFase, distanza } = contesto();
    const mieGare = novitaMieGare();
    const tipo = param.t || "", letti = contenutiLetti();
    const chip = (v, l) => `<button class="chip" data-act="perte-tipo" data-t="${v}" aria-pressed="${tipo === v}">${l}</button>`;
    const testa = `${bannerProva()}<header class="head"><div><span class="eyebrow">${esc(nomeFase)}</span><h1>Per te</h1></div></header>
      <div class="chips" role="group" aria-label="Tipo di contenuto">${chip("", "Tutto")}${mieGare.length ? chip("gare", `Le mie gare · ${mieGare.length}`) : ""}${chip("articolo", "Articoli")}${chip("video", "Video")}</div>`;
    if (tipo === "gare") return `${testa}<div class="lista-c">${mieGare.map(cardNovitaPerTe).join("")}</div><p class="sub">Novità ufficiali e articoli delle riviste sulle gare che segui. Tocca per aprirli alla fonte.</p>`;
    const lista = L.perTe(D.contenuti || [], { fase, distanza, oggi: o, letti, visti: S.visti || {}, tipo });
    if (!lista.length) return `${testa}<p class="sub">Nessun contenuto per ora: le fonti si aggiornano due volte al giorno.</p>`;
    const perFase = fase ? L.varieta(lista.filter((c) => c.perLaFase && !letti[c.id]), 6, 2) : [];
    segnaContenutiVisti(perFase, o);
    const usati = new Set(perFase.map((c) => c.id));
    const novita = lista.filter((c) => !usati.has(c.id)).sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
    const n = Number(param.n || 20);
    return `${testa}
      ${!tipo && mieGare.length ? `<section aria-label="Dalle tue gare"><div class="between" style="margin-bottom:8px"><h2>Dalle tue gare</h2><button class="linkbtn small" data-act="perte-tipo" data-t="gare">Tutte ›</button></div><div class="lista-c">${mieGare.slice(0, 3).map(cardNovitaPerTe).join("")}</div></section>` : ""}
      ${perFase.length ? `<section aria-label="Per la tua fase"><h2 style="margin-bottom:8px">Per la tua fase</h2><div class="lista-c">${perFase.map((c, i) => cardContenuto(c, i === 0)).join("")}</div></section>` : ""}
      <section aria-label="Novità"><h2 style="margin-bottom:8px">Novità dalle fonti</h2><div class="lista-c">${novita.slice(0, n).map((c) => cardContenuto(c)).join("")}</div></section>
      ${novita.length > n ? `<a class="btn ghost" href="#/perte?t=${tipo}&n=${n + 20}">Mostra altri</a>` : ""}
      <p class="sub">Titoli ed estratti dalle fonti originali in italiano: tocca per leggere o guardare sul sito dell'autore. La scelta in base alla tua fase avviene sul telefono.</p>`;
  }

  // ---------------------------------------------------------------- il gruppo (società)
  // Identità senza account: un codice segreto casuale resta su questo telefono; online se ne salva solo l'impronta.
  const G = () => (S.gruppo = S.gruppo || {});
  function token() {
    if (!G().token) { const b = new Uint8Array(32); crypto.getRandomValues(b); G().token = [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); salva(); }
    return G().token;
  }
  const GD = () => (S.gruppo && S.gruppo.dati) || null;
  const COLORI = ["#1E2B4A", "#C2410C", "#4B5A73", "#1F7A4D", "#9A3412", "#2F7BD6", "#6B4FA0", "#0F766E"];
  const iniziali = (n) => String(n || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join("").toUpperCase();
  const avatar = (n, size = 32) => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `<span class="av" style="width:${size}px;height:${size}px;background:${COLORI[h % COLORI.length]}" title="${esc(n)}">${esc(iniziali(n))}</span>`; };
  const avatari = (nomi, max = 4) => `<span class="avs" aria-hidden="true">${nomi.slice(0, max).map((n) => avatar(n)).join("")}${nomi.length > max ? `<span class="av piu">+${nomi.length - max}</span>` : ""}</span>`;
  const linkInvito = (codice) => `${location.origin}${location.pathname}#/invito/${codice}`;
  const RUOLI_G = { admin: "Amministratore", organizzatore: "Organizzatore", membro: "Membro" };
  const DISTANZE = ["10", "21", "42"];

  let caricando = false;
  async function aggiornaGruppo(silenzioso) {
    if (!S.gruppo || !S.gruppo.dentro || caricando) return;
    caricando = true;
    try {
      const d = await rpc("stato_gruppo", { p_token: token() });
      const prima = JSON.stringify(GD());
      S.gruppo.dati = d; S.gruppo.aggiornato = new Date().toISOString(); localStorage.setItem(KEY, JSON.stringify(S));
      aggiornaClassifiche();
      if (prima !== JSON.stringify(d) && /^#\/(gruppo|risultato)/.test(location.hash)) rerender();
    } catch (e) {
      if (/non sei in un gruppo/.test(e.message)) { S.gruppo = { token: S.gruppo.token }; salva(); toast("Non fai più parte del gruppo"); rerender(); }
      else if (!silenzioso) toast("Gruppo non raggiungibile: riprova tra poco");
    } finally { caricando = false; }
  }
  async function sincronizzaGareGruppo() {
    if (!S.gruppo || !S.gruppo.dentro) return;
    const o = oggi();
    const gare = S.gare.filter((g) => g.data >= L.addDays(o, -2) && nonArchiviata(g)).map((g) => ({ id: g.id, nome: g.nome, data: g.data, luogo: g.luogo, distanza: g.distanza, ruolo: g.ruolo, tempo: g.tempo || "" }));
    try { await rpc("sincronizza_gare", { p_token: token(), p_gare: gare }); } catch (e) { /* riprova al prossimo salvataggio */ }
  }
  // Personali al gruppo: solo tempo, gara e data, e solo se il membro li vuole in classifica. Si inviano solo se cambiati.
  async function sincronizzaPBGruppo(forza) {
    if (!S.gruppo || !S.gruppo.dentro) return;
    if (!forza && GD() && GD().io && GD().io.mostra_pb === false) return;
    const pb = DISTANZE.filter((d) => (S.pb || {})[d]).map((d) => ({ distanza: d, tempo: L.leggiTempo(d, S.pb[d].tempo).tempo, gara: S.pb[d].gara || "", data: S.pb[d].data || "" })).filter((x) => x.tempo);
    const firma = JSON.stringify(pb);
    if (!forza && G().pbInviati === firma) return;
    try { await rpc("sincronizza_pb", { p_token: token(), p_pb: pb }); G().pbInviati = firma; localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* riprova al prossimo salvataggio */ }
  }

  // ---------------------------------------------------------------- classifiche del gruppo (fase 1)
  // Spente se in config.js manca classifiche: true. Poi le accende l'amministratore per il gruppo (Gestione) e ognuno
  // sceglie se partecipare (consenso). I risultati certificati li scrive solo la funzione "tempi"; qui si leggono e si
  // fanno le classifiche con le funzioni pure di logic.js.
  const CL = () => (S.gruppo && S.gruppo.cl) || null;
  const clOn = () => !!(C().classifiche && S.gruppo && S.gruppo.dentro);
  const clAttive = () => !!(clOn() && CL() && CL().attive);
  const partecipo = () => !!(clAttive() && CL().io && CL().io.partecipa);
  const fmtSec = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  // In coda, non saltato: se un caricamento è già partito (per esempio prima di un'aggiunta), ne parte un altro dopo,
  // così i dati appena scritti arrivano sempre. Al massimo uno in corso e uno in attesa.
  let clCoda = Promise.resolve(), clAttese = 0;
  function aggiornaClassifiche() {
    if (!clOn()) return Promise.resolve();
    if (clAttese > 1) return clCoda;
    clAttese++;
    clCoda = clCoda.then(caricaClassifiche).finally(() => { clAttese--; });
    return clCoda;
  }
  async function caricaClassifiche() {
    try {
      const [d, st] = await Promise.all([rpc("stato_classifiche", { p_token: token() }), rpc("stato_stagione", { p_token: token() }).catch(() => null)]);
      const prima = JSON.stringify([CL(), S.gruppo.st || null]);
      S.gruppo.cl = d; if (st) S.gruppo.st = st; localStorage.setItem(KEY, JSON.stringify(S));
      sincronizzaStagione();
      proponiEntra();
      if (prima !== JSON.stringify([d, S.gruppo.st || null]) && (!location.hash || /^#\/(gruppo|risultato|io|entra|oggi)/.test(location.hash))) rerender();
    } catch (e) { /* database non ancora aggiornato o rete assente: restano i dati di prima */ }
  }
  // Certificazione: la funzione "tempi" rifà la ricerca e registra solo i risultati che esistono davvero.
  async function certificaRisultati({ nome, cognome, anno, persone, risultati }) {
    const tess = (S.documenti || {}).tessera || {};
    const r = await fetch(`${C().supabaseUrl}/functions/v1/tempi`, { method: "POST", headers: { apikey: C().supabaseKey, "Content-Type": "application/json", "x-racebuddy-token": token() },
      body: JSON.stringify({ azione: "certifica", nome, cognome, ...(anno ? { anno } : {}), ...(tess.codiceSocieta ? { codice: tess.codiceSocieta } : {}), persone, risultati }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.errore || "Non riuscito: riprova tra poco");
    return j;
  }
  const esitoCertifica = (j) => j.certificati ? `${j.certificati === 1 ? "Tempo certificato" : `${j.certificati} gare certificate`}: contano per le classifiche`
    : j.in_approvazione ? "Il nome in classifica è diverso da quello nel gruppo: lo approva il referente" : "Già certificato";
  const rigaCl = (x, destra, sotto = "", href = "") => { const tag = href ? "a" : "div"; return `<${tag} class="post ${x.mio ? "mio" : ""}${href ? " link-card" : ""}"${href ? ` href="${href}"` : ""}><span class="pos">${x.pos}</span>${avatar(x.membro, 30)}<span style="flex:1;min-width:0"><b>${esc(x.mio ? "Tu" : x.membro)}</b>${sotto ? `<br><span class="small muted">${sotto}</span>` : ""}</span><b style="font:700 18px var(--display)">${destra}</b>${href ? `<span class="muted" aria-hidden="true">›</span>` : ""}</${tag}>`; };
  // Classifiche: le tre principali (Impegno, Obiettivo centrato, Albo d'oro) e le altre (Gare corse, PB della stagione)
  const TAB_CL = { impegno: "Impegno", obiettivo: "Obiettivo centrato", albo: "Albo d'oro", gare: "Gare corse", pb: "PB della stagione" };
  const PRINCIPALI = ["impegno", "obiettivo", "albo"];
  let tabCl = "impegno", distAlbo = "21";
  const pct = (n) => `${Number(n).toFixed(1).replace(".", ",")}%`;
  // ---------------------------------------------------------------- stagione (fase 2): dati da stato_stagione
  // (docs/supabase_stagione.sql), calcoli in logic.js. Le percentuali per età arrivano già fatte: l'età non esce mai.
  const ST = () => (S.gruppo && S.gruppo.st) || {};
  const gareSoc = () => ST().gare_societa || [];
  // Fuori misura (es. 9,9 km come 10 km): vale per Gare corse e arrivo Impegno, non per PB e Albo d'oro
  const kmReali = (r) => `${String(r.km_reali).replace(".", ",")} km`;
  const notaFuori = (r) => (L.fuoriMisura(r) ? ` · ${kmReali(r)}, fuori misura` : "");
  const PERCHE_FUORI = (r) => `${kmReali(r)}, fuori misura: vale per Gare corse e arrivo Impegno, non per PB e Albo d'oro`;
  // Bollino in Gare: solo le gare della propria società (le altre società non si vedono mai)
  const garaSoc = (g) => (clAttive() ? L.garaSocDi(gareSoc(), g) : null);
  const pillSoc = (g) => (garaSoc(g) ? `<span class="pill navy-pill">★ Gara della società</span>` : "");
  // Filtro "Società" in Gare → Italia: le gare del calendario che sono della società
  const filtraSoc = (gare) => gare.filter((g) => garaSoc(g));
  const ioId = () => (CL() && CL().io && CL().io.id) || (GD() && GD().io && GD().io.id) || null;
  const nomiCl = () => { const n = {}; for (const r of (CL() || {}).risultati || []) n[r.membro_id] = r.membro; for (const p of ST().partecipanti || []) n[p.id] = p.nome; return n; };
  let memoSt = null;
  function datiSt() {
    const cl = CL() || {}, st = ST();
    if (memoSt && memoSt.cl === cl && memoSt.st === st) return memoSt.v;
    const eta = new Map((st.eta || []).map((e) => [e.id, e]));
    const risultati = (cl.risultati || []).map((r) => { const e = eta.get(r.id); return e ? { ...r, ag: Number(e.ag), circa: !!e.circa, sesso_ag: e.sesso } : r; });
    const eventi = L.eventiPunti({ risultati, gareSoc: st.gare_societa || [], obiettivi: st.obiettivi || [], borse: st.borse || [], inviti: st.inviti || [] });
    memoSt = { cl, st, v: { risultati, eventi } };
    return memoSt.v;
  }
  // I miei badge; con fino/prima si guardano solo le gare fino a quella data (o prima), per la scheda post-gara
  function badgeMiei({ fino, prima } = {}) {
    const { risultati, eventi } = datiSt(), id = ioId(), st = ST();
    const miei = risultati.filter((r) => r.mio && (!fino || r.data <= fino) && (!prima || r.data < prima));
    const primo = (l) => l.length && l[0].mio && l[0].pos === 1;
    const record = DISTANZE.some((d) => primo(L.alboDoro(risultati, d)) || primo(L.alboEta(risultati, d)));
    return L.badgeAtleta({ miei, gareSoc: gareSoc(), obiettivi: (st.obiettivi || []).filter((o) => o.membro_id === id), borse: (st.borse || []).filter((b) => b.membro_id === id),
      soci: eventi.filter((e) => e.membro_id === id && e.tipo === "socio" && (!fino || e.data <= fino) && (!prima || e.data < prima)).length, record, oggi: fino || oggi() });
  }
  // dove porta una gara della società: alla mia gara se l'ho in Gare, altrimenti all'elenco
  const hrefSoc = (s) => { const g = S.gare.find((x) => x.data === s.data && x.distanza === s.distanza); return g ? urlGara(g.id) : "#/gruppo/societa"; };
  const ciSonoSoc = (s) => new Set(((GD() && GD().gare) || []).filter((x) => x.data === s.data && x.distanza === s.distanza).map((x) => x.membro_id)).size;
  // le righe di una classifica, già calcolate
  function righeCl(tab, { periodo = "stagione", dist = distAlbo, sesso = "", vista = "assoluto" } = {}) {
    const { risultati: ris, eventi } = datiSt(), o = oggi(), nomi = nomiCl(), io = ioId();
    const per = periodo === "mese" ? { mese: o.slice(0, 7) } : { anno: o.slice(0, 4) };
    if (tab === "impegno") return L.classificaImpegno(eventi, { ...per, nomi, io }).map((x) => ({ ...x,
      html: (y) => rigaCl(y, `${y.punti} <span class="small muted" style="font-weight:500">pt</span>`, `${y.gare} ${y.gare === 1 ? "gara" : "gare"} della società`, y.mio ? "#/gruppo/carriera" : "") }));
    if (tab === "obiettivo") return L.classificaObiettivo({ risultati: ris, obiettivi: ST().obiettivi }, { anno: o.slice(0, 4), nomi, io }).lista.map((x) => ({ ...x,
      html: (y) => rigaCl(y, pct(y.media), `${y.n} gare · ${y.centrate} ${y.centrate === 1 ? "centrata" : "centrate"}`) }));
    if (tab === "pb") return L.classificaPBStagione(ris, o.slice(0, 4)).map((x) => ({ ...x, html: (y) => rigaCl(y, `${y.n} PB`, `+${String(y.perc).replace(".", ",")}% di miglioramento`) }));
    if (tab === "albo" && vista === "eta") return L.alboEta(ris, dist, sesso).map((x) => ({ ...x,
      html: (y) => rigaCl(y, `${y.circa ? "≈ " : ""}${pct(y.ag)}`, [fmtSec(y.secondi), dist === "tutte" ? L.DIST_LABEL[y.distanza] : "", titoloGara(y.gara_nome || ""), y.data.slice(0, 4)].filter(Boolean).map(esc).join(" · ")) }));
    if (tab === "albo") return L.alboDoro(ris, dist === "tutte" ? "21" : dist, sesso).map((x) => ({ ...x, html: (y) => rigaCl(y, fmtSec(y.secondi), [titoloGara(y.gara_nome || ""), L.fmtBreve(y.data) + " " + y.data.slice(0, 4), y.categoria].filter(Boolean).map(esc).join(" · ")) }));
    return L.classificaGareCorse(ris, per).map((x) => ({ ...x, html: (y) => rigaCl(y, `${y.n} <span class="small muted" style="font-weight:500">${y.n === 1 ? "gara" : "gare"}</span>`, y.mio ? "le tue gare" : "", y.mio ? "#/gruppo/mie?da=classifiche" : "") }));
  }
  // Gare della società in Gruppo, per tutti (anche chi non partecipa): la prossima e il link all'elenco completo.
  // La prossima può essere anche dell'anno dopo (a fine stagione il direttivo prepara già il calendario nuovo).
  function cardGareSoc(io, org) {
    const o = oggi(), anno = o.slice(0, 4), tutte = gareSoc(), soc = tutte.filter((s) => s.data.slice(0, 4) === anno), prox = tutte.find((s) => s.data >= o);
    const daCorrere = soc.filter((s) => s.data >= o).length; // solo la stagione in corso
    if (!prox) return org ? `<a class="card soft link-card" href="#/gruppo/societa"><span class="title">${soc.length ? "Aggiungi le prossime gare della società" : "Scegli le gare della società"}</span><span class="small">Le sceglie il direttivo: solo queste fanno punti nella classifica Impegno.</span><span class="small" style="color:var(--accent);font-weight:700">Gare della società ›</span></a>`
      : soc.length ? `<a class="card soft link-card" href="#/gruppo/societa"><span class="title">Gare della società</span><span class="small">Quelle del ${esc(anno)} sono già corse: le prossime le sceglie il direttivo.</span><span class="small" style="color:var(--accent);font-weight:700">Vedi l'elenco ›</span></a>` : "";
    const socProx = tutte.filter((s) => s.data.slice(0, 4) === prox.data.slice(0, 4)), altroAnno = prox.data.slice(0, 4) !== anno, n = ciSonoSoc(prox);
    return `<section class="card" style="gap:8px" aria-label="Gare della società"><div class="between"><span class="eyebrow">Gare della società</span><span class="small muted">la ${socProx.indexOf(prox) + 1}ª di ${socProx.length}${altroAnno ? ` del ${esc(prox.data.slice(0, 4))}` : ""}</span></div>
      <a class="link-card" href="${hrefSoc(prox)}" style="display:flex;flex-direction:column;gap:2px;color:inherit;text-decoration:none"><span class="small muted">La prossima</span>
        <span class="title">${esc(titoloGara(prox.nome))} · ${esc(L.DIST_LABEL[prox.distanza])}</span><span class="small muted">${esc(L.fmtGiorno(prox.data))}${altroAnno ? ` ${esc(prox.data.slice(0, 4))}` : ""}${n ? ` · ${n === 1 ? "c'è 1 del gruppo" : `ci sono ${n} del gruppo`}` : ""}</span>
        ${io.partecipa ? `<span class="small" style="color:var(--accent-strong);font-weight:700">In palio fino a ${L.PUNTI.arrivo + L.PUNTI.pb + L.PUNTI.obiettivo + L.PUNTI.borsa} punti Impegno</span>` : ""}</a>
      <a class="btn ghost block" href="#/gruppo/societa">${daCorrere > 1 ? `Le ${daCorrere} gare da correre nel ${esc(anno)}` : "L'elenco delle gare della società"} ›</a></section>`;
  }
  // In cima a Gruppo: invito a partecipare, oppure la tua stagione, la prossima gara della società e le classifiche
  function cardStagione(d) {
    if (!clAttive()) return cardClassifica(d);
    const cl = CL(), io = cl.io || {}, org = io.ruolo === "admin" || io.ruolo === "organizzatore", o = oggi(), anno = o.slice(0, 4);
    if (!io.partecipa) return `<section class="card dark"><span class="eyebrow">Novità nel gruppo</span><span style="font:700 26px/1.05 var(--display)">Le classifiche della stagione</span>
      <span class="small" style="color:var(--navy-muted)">Impegno nelle gare della società, Obiettivo centrato e Albo d'oro, con i tempi presi dalle classifiche ufficiali. ${cl.partecipanti} ${cl.partecipanti === 1 ? "runner partecipa" : "runner partecipano"} su ${cl.membri}.</span>
      <div class="row" style="gap:14px;align-items:center"><a class="btn" style="flex:1" href="#/entra/classifiche">Partecipo</a><a href="#/gruppo/regole" style="color:var(--accent-on-dark)">Come funzionano</a></div></section>${cardGareSoc(io, org)}${cardClassifica(d)}`;
    const { risultati: ris, eventi } = datiSt(), nomi = nomiCl(), id = ioId();
    const imp = L.classificaImpegno(eventi, { anno, nomi, io: id }).find((x) => x.mio);
    const obc = L.classificaObiettivo({ risultati: ris, obiettivi: ST().obiettivi }, { anno, nomi, io: id }).lista.find((x) => x.mio);
    const liv = L.livello(L.puntiCarriera(eventi, id)), nBadge = badgeMiei().filter((b) => b.preso).length;
    const posizioni = [imp && `${imp.pos}° Impegno`, obc && `${obc.pos}° Obiettivo centrato`, `${nBadge} badge`].filter(Boolean).join(" · ");
    const stagione = `<a class="card dark link-card" href="#/gruppo/carriera" style="gap:6px"><div class="between"><span class="eyebrow">La tua stagione ${esc(anno)}</span><span class="pill navy">${esc(liv.nome)}</span></div>
      <div class="row" style="align-items:baseline;gap:8px"><span class="big" style="font-size:48px;color:var(--accent-on-dark)">${imp ? imp.punti : 0}</span><span style="font-weight:600">punti Impegno</span></div>
      <span class="small" style="color:var(--navy-muted)">${esc(posizioni)}</span>
      <div class="between" style="border-top:1px solid #FFFFFF26;padding-top:10px"><b>La tua carriera <span class="small" style="font-weight:500;color:var(--navy-muted)">· livello e badge</span></b><span class="small" style="color:var(--accent-on-dark);font-weight:700">Apri ›</span></div></a>`;
    // la prossima può essere anche dell'anno dopo (a fine stagione il direttivo prepara già il calendario nuovo)
    const soc = gareSoc().filter((s) => s.data.slice(0, 4) === anno);
    const prossima = cardGareSoc(io, org);
    const tab = PRINCIPALI.includes(tabCl) ? tabCl : "impegno";
    const l = righeCl(tab), { primi, tu } = L.primiETu(l);
    const chip = (k) => `<button class="chip" data-act="cl-tab" data-t="${k}" aria-pressed="${k === tab}">${k === "obiettivo" ? "Obiettivo" : TAB_CL[k]}</button>`;
    const chipD = (x) => `<button class="chip" data-act="cl-dist" data-d="${x}" aria-pressed="${x === distAlbo}">${esc(L.DIST_LABEL[x])}</button>`;
    const sotto = { impegno: "Punti nelle gare della società", obiettivo: "Scarto medio dall'obiettivo · almeno 3 gare", albo: "Il miglior tempo di sempre" }[tab];
    const vuoto = { impegno: soc.length ? "Ancora nessun punto: arrivano con le gare della società." : "Ancora nessuna gara della società: le sceglie il direttivo.", obiettivo: "Nessuno ha ancora 3 gare con un obiettivo fissato.", albo: `Nessun tempo certificato sulla ${esc(L.DIST_LABEL[distAlbo].toLowerCase())}.` }[tab];
    const recupero = L.recuperoAperto(io) ? `<a class="card soft link-card" href="#/gruppo/recupero"><span class="title">Recupera le gare già corse</span><span class="small">Le prendiamo dalle classifiche ufficiali. Puoi farlo fino al ${esc(L.fmtBreve(String(io.recupero_fino).slice(0, 10)))}.</span><span class="small" style="color:var(--accent);font-weight:700">Cerca le mie gare ›</span></a>` : "";
    const coda = org && cl.da_approvare ? `<a class="card link-card" href="#/gruppo/admin"><div class="between"><span class="title">Da approvare</span><span class="pill">${cl.da_approvare}</span></div><span class="small">Tempi non trovati nelle classifiche: li approvate tu e gli altri referenti.</span><span class="small" style="color:var(--accent);font-weight:700">Apri la coda ›</span></a>` : "";
    const capo = (k) => { const x = righeCl(k)[0]; return x ? `${x.mio ? "Tu" : x.membro.split(/\s+/)[0]} · ${k === "pb" ? x.n : x.n}` : "nessuno, per ora"; };
    const nConta = L.riepilogoMie(L.cercaMieGare(mieGare(), "", { oggi: o })).conta;
    const altra = (href, t, d, ultima) => `<a class="between link-card" href="${href}" style="min-height:44px;${ultima ? "" : "border-bottom:1px solid var(--line2);"}"><span style="font-weight:600">${t}</span><span class="small muted">${esc(d)}</span></a>`;
    return `${recupero}${coda}${stagione}${prossima}<section class="card" aria-label="Le classifiche della stagione"><div class="between"><h2>Le classifiche · ${esc(anno)}</h2><span class="small muted">${cl.partecipanti} runner</span></div>
      <div class="chips">${PRINCIPALI.map(chip).join("")}</div>
      ${tab === "albo" ? `<div class="chips">${DISTANZE.map(chipD).join("")}</div>` : ""}
      <span class="small muted">${sotto}</span>
      <div>${l.length ? primi.map((x) => x.html(x)).join("") + (tu ? `<div class="post small muted" style="justify-content:center;padding:2px 0">···</div>${tu.html(tu)}` : "") : `<span class="small">${vuoto}</span>`}</div>
      <a class="btn ghost block" href="#/gruppo/classifiche?c=${tab}${tab === "albo" ? `&d=${distAlbo}` : ""}">Classifica completa ›</a></section>
      <section class="card" style="gap:0;padding-top:8px;padding-bottom:8px" aria-label="Altre classifiche"><span class="eyebrow" style="padding:4px 0 6px">Altre classifiche</span>
        ${altra("#/gruppo/classifiche?c=gare", "Gare corse", capo("gare"))}${altra("#/gruppo/classifiche?c=pb", "PB della stagione", capo("pb"))}${altra("#/gruppo/societa", "Gare della società", `${soc.length} nel ${anno}`)}${altra("#/gruppo/mie", "Le mie gare in classifica", `${nConta} ${nConta === 1 ? "conta" : "contano"}`, true)}</section>
      <a class="link-regole" href="#/gruppo/regole">Come funzionano le classifiche ›</a>`;
  }
  function vistaPartecipa() {
    if (!clAttive()) return vistaGruppo();
    const voce = (t, ok = true) => `<div class="row" style="align-items:flex-start;gap:10px"><span aria-hidden="true" style="color:${ok ? "var(--ok)" : "var(--muted)"};font-weight:700">${ok ? "✓" : "•"}</span><span class="small">${t}</span></div>`;
    return `<header class="head-back">${back("#/gruppo")}<div><span class="eyebrow">Partecipo alle classifiche</span><h1 style="font-size:30px">Cosa vedono i compagni</h1></div></header>
      <p class="sub">Solo i runner di ${esc(GD() ? GD().gruppo.nome : "questo gruppo")} che partecipano, e solo finché partecipi. ${CL().partecipanti} su ${CL().membri} partecipano già.</p>
      <section class="card"><h2>Va online</h2>${voce("I risultati delle tue gare su 10 km, mezza e maratona, presi dalle classifiche ufficiali: gara, data, tempo, categoria e società")}${voce("Gli esiti senza tempo (ritirato, non partito, annullata)")}${voce("I tempi che mandi al referente, con il link o la nota")}${voce("Il tempo obiettivo e se la Borsa è pronta: i compagni li vedono solo dopo il via")}${voce("Anno di nascita e sesso, se li indichi per la percentuale per età: i compagni vedono solo la percentuale")}</section>
      <section class="card"><h2>Resta sul telefono</h2>${voce("Tessera, certificato, scarpe, preparazione, bilancio delle gare e posizione", false)}</section>
      <p class="sub">Puoi smettere quando vuoi da Io → Gruppo: i tuoi risultati online si cancellano, sul telefono restano.</p>
      <button class="btn block" data-act="cl-partecipa">Partecipo</button><a class="btn ghost block" href="#/gruppo">Non ora</a>`;
  }
  const REC_NO = new Set();
  function vistaRecupero(param = {}) {
    if (!partecipo()) return vistaPartecipa();
    const { nome, cognome } = nomeTempi(), cl = CL();
    if (nome && cognome && (!TEMPI || TEMPI.chiave !== `${nome}|${cognome}|`)) setTimeout(() => cercaTempi(nome, cognome, null), 0);
    let corpo = "";
    if (TEMPI && TEMPI.carico) corpo = `<section class="card" aria-busy="true"><div class="row" style="gap:10px"><span class="spinner" aria-hidden="true"></span><span class="title">Cerco nelle classifiche</span></div><span class="small muted">Gare Podistiche Lazio dal 2019 e FIDAL: qualche secondo.</span></section>`;
    else if (TEMPI && TEMPI.errore) corpo = `<section class="card"><span class="small">${esc(TEMPI.errore)}</span></section>`;
    else if (TEMPI && TEMPI.persone) {
      const P = TEMPI.persone, scelti = TEMPI.scelti || [];
      if (!P.length) corpo = `<section class="card"><span class="title">Nessun risultato</span><span class="small">Non trovo gare a nome di <b>${esc(nome)} ${esc(cognome)}</b>. Controlla come sei scritto nelle classifiche.</span></section>`;
      else {
        const chi = `<section class="card" style="gap:0"><h2 style="margin-bottom:4px">${P.length > 1 ? "Quale sei tu?" : "Ti ho trovato qui"}</h2>${P.map((p) => `<label class="check"><input type="checkbox" data-act-change="tempi-persona" data-id="${esc(p.id)}" ${scelti.includes(p.id) ? "checked" : ""}><span><span class="t">${esc(p.societa || "Senza società")}${p.categoria ? " · " + esc(p.categoria) : ""}</span><br><span class="d">${esc(FONTE_TEMPI[p.fonte])} · ${p.risultati.length} ${p.risultati.length === 1 ? "gara" : "gare"} su 10 km, mezza o maratona</span></span></label>`).join("")}</section>`;
        const lista = scelti.length ? L.daRecuperare(L.tempiUniti(P, scelti), cl.io, cl.miei) : [];
        const n = lista.filter((r) => !REC_NO.has(r.id)).length;
        corpo = chi + (scelti.length ? `<section class="card" style="gap:0"><div class="between" style="margin-bottom:4px"><h2>Le tue gare</h2><span class="small muted">${n} di ${lista.length}</span></div>
          ${lista.length ? lista.map((r) => `<label class="check"><input type="checkbox" data-act-change="rec-tog" data-id="${esc(r.id)}" ${REC_NO.has(r.id) ? "" : "checked"}><span style="flex:1"><span class="t">${esc(L.nomeRisultato(r))}</span><br><span class="d">${esc(L.DIST_LABEL[r.distanza])}${esc(notaFuori(r))} · ${esc(L.fmtBreve(r.data))} ${esc(r.data.slice(0, 4))} · ${esc(FONTE_TEMPI[r.fonte])}</span></span><b class="pb-tempo">${esc(fmtSec(r.secondi))}</b></label>`).join("") : `<span class="small">Niente da recuperare: le gare trovate sono già certificate.</span>`}</section>
          ${n ? `<button class="btn block" data-act="cl-recupera">Recupera ${n} ${n === 1 ? "gara" : "gare"}</button>` : ""}
          <p class="sub">Togli la spunta alle gare che non sono tue (con gli omonimi può capitare). Se il nome in classifica è quello con cui sei nel gruppo sono certificate subito, altrimenti le approva il referente.</p>` : "");
      }
    }
    return `<header class="head-back">${back(param.da === "mie" ? "#/gruppo/mie" : "#/gruppo")}<div><span class="eyebrow">Classifiche · recupero</span><h1 style="font-size:28px">Recupera le tue gare</h1></div></header>
      <form id="tempi-cerca" data-anno="" class="card" style="gap:10px">
        <div class="grid2"><div class="field"><label for="tc-nome">Nome</label><input class="input" id="tc-nome" required maxlength="40" autocomplete="given-name" value="${esc(nome)}"></div>
        <div class="field"><label for="tc-cognome">Cognome</label><input class="input" id="tc-cognome" required maxlength="40" autocomplete="family-name" value="${esc(cognome)}"></div></div>
        <button class="btn ghost" type="submit">${TEMPI && TEMPI.persone ? "Cerca di nuovo" : "Cerca"}</button>
        <span class="small muted">Scrivili come nelle classifiche. ${L.recuperoAperto(cl.io) ? `Fino al ${esc(L.fmtBreve(String(cl.io.recupero_fino).slice(0, 10)))} recuperi anche le gare degli anni scorsi; dopo, solo quelle nuove.` : "Il recupero degli anni scorsi è chiuso: si aggiungono solo le gare nuove."}</span></form>
      ${corpo}`;
  }
  function vistaClassifiche(param = {}) {
    if (!partecipo()) return vistaGruppo();
    const c = TAB_CL[param.c] ? param.c : "impegno", periodo = param.p === "mese" ? "mese" : "stagione", vista = param.v === "eta" ? "eta" : "assoluto";
    const dist = DISTANZE.includes(param.d) || (vista === "eta" && param.d === "tutte") ? param.d : distAlbo, sesso = ["M", "F"].includes(param.s) ? param.s : "";
    const url = (o) => { const q = { c, p: periodo, d: dist, s: sesso, v: vista, ...o }; if (q.v !== "eta" && q.d === "tutte") q.d = "21";
      return `#/gruppo/classifiche?c=${q.c}${["gare", "impegno"].includes(q.c) ? `&p=${q.p}` : ""}${q.c === "albo" ? `&v=${q.v}&d=${q.d}${q.s ? `&s=${q.s}` : ""}` : ""}`; };
    const chip = (href, on, l) => `<a class="chip" href="${href}" aria-pressed="${on}" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit">${l}</a>`;
    const l = righeCl(c, { periodo, dist, sesso, vista }), o = oggi(), anno = o.slice(0, 4);
    const filtri = ["gare", "impegno"].includes(c) ? `<div class="chips">${chip(url({ p: "stagione" }), periodo === "stagione", "Stagione")}${chip(url({ p: "mese" }), periodo === "mese", "Questo mese")}</div>`
      : c === "albo" ? `<div class="chips">${chip(url({ v: "assoluto" }), vista === "assoluto", "Assoluto")}${chip(url({ v: "eta" }), vista === "eta", "Per età")}</div>
        <div class="chips">${[...DISTANZE, ...(vista === "eta" ? ["tutte"] : [])].map((x) => chip(url({ d: x }), x === dist, x === "tutte" ? "Tutte" : esc(L.DIST_LABEL[x]))).join("")}</div>
        <div class="chips">${chip(url({ s: "" }), !sesso, "Tutti")}${chip(url({ s: "M" }), sesso === "M", "Uomini")}${chip(url({ s: "F" }), sesso === "F", "Donne")}</div>` : "";
    const rec = c === "albo" && vista === "assoluto" ? L.recordCategorie(CL().risultati || [], dist) : [];
    const spiega = { gare: "Le gare concluse con un tempo certificato: dalla classifica ufficiale o approvato dal referente. A parità di gare, stessa posizione.",
      pb: "Quante volte migliori il tuo miglior tempo certificato su 10 km, mezza o maratona. La prima gara su una distanza fissa il riferimento e non conta. A parità vince chi è migliorato di più.",
      albo: vista === "eta" ? "" : "Il miglior tempo certificato di sempre di ognuno. Uomini e donne dalla categoria della classifica ufficiale.",
      impegno: "", obiettivo: "" }[c];
    let extra = "";
    if (c === "impegno") extra = `<section class="card" style="gap:0"><h2 style="margin-bottom:4px">Come si fanno i punti</h2>
      ${[["Arrivo in una gara della società", L.PUNTI.arrivo], ["Nuovo personale in una gara della società", L.PUNTI.pb], ["Obiettivo centrato (entro l'1%) in una gara della società", L.PUNTI.obiettivo],
        ["Borsa pronta entro la vigilia di una gara della società, se poi arrivi", L.PUNTI.borsa], ["Nuovo socio portato da te, al suo primo tempo certificato", L.PUNTI.socio]]
        .map(([t, p]) => `<div class="post"><span style="flex:1;min-width:0">${t}</span><b>+${p}</b></div>`).join("")}
      <span class="small muted" style="padding-top:8px">Le altre gare valgono per Gare corse, PB, Obiettivo centrato e Albo d'oro, ma non fanno punti. Niente punti per i km: nessuno corre più del suo piano per salire.</span>
      <a class="small" href="#/gruppo/societa" style="font-weight:700;padding-top:8px">Le gare della società ›</a></section>`;
    if (c === "obiettivo") {
      const id = ioId(), { risultati } = datiSt(), ob = ST().obiettivi || [];
      const { quasi } = L.classificaObiettivo({ risultati, obiettivi: ob }, { anno, nomi: nomiCl(), io: id });
      const mie = L.esatte(risultati).filter((r) => r.mio && r.data.startsWith(anno)).map((r) => ({ r, o: ob.find((x) => x.membro_id === id && x.data === r.data && x.distanza === r.distanza) }))
        .filter((x) => x.o).sort((a, b) => (a.r.data < b.r.data ? 1 : -1)).slice(0, 5);
      extra = `${quasi.length ? `<section class="card" style="gap:6px"><h2>Non ancora in classifica</h2>${quasi.map((x) => `<div class="between small"><span>${esc(x.mio ? "Tu" : x.membro)}</span><span class="muted">${x.mancano === 1 ? "manca 1 gara" : `mancano ${x.mancano} gare`} con obiettivo</span></div>`).join("")}</section>` : ""}
        ${mie.length ? `<section class="card" style="gap:0"><h2 style="margin-bottom:4px">Le tue ultime gare</h2>${mie.map(({ r, o: x }) => { const s = L.scartoObiettivo(r.secondi, x.secondi);
          return `<div class="post"><span style="flex:1;min-width:0"><b>${esc(titoloGara(r.gara_nome || "") || L.DIST_LABEL[r.distanza])}</b><br><span class="small muted">Obiettivo ${esc(fmtSec(x.secondi))} · arrivo ${esc(fmtSec(r.secondi))}</span></span><span class="pill ${s <= L.CENTRATO ? "ok" : "grigio"}">${pct(s)}${s <= L.CENTRATO ? " · centrato" : ""}</span></div>`; }).join("")}</section>` : ""}
        <details class="card"><summary>Come si calcola</summary><span class="small">Fissi il tempo obiettivo nella gara (Ruolo e tempo obiettivo), entro le 23:59 della vigilia: poi si blocca. Dopo l'arrivo, lo scarto è la differenza tra tempo ufficiale e obiettivo, in più o in meno, divisa per l'obiettivo. Andare molto più forte conta come andare più piano.</span>
          <span class="small">Valgono tutte le gare certificate con un obiettivo fissato; servono almeno 3 gare. Entro l'1% è centrato: in una gara della società vale anche +${L.PUNTI.obiettivo} punti Impegno.</span></details>`;
    }
    if (c === "albo" && vista === "eta") extra = `<details class="card" open><summary>Cos'è la percentuale per età</summary><span class="small">Ogni tempo diventa una percentuale del miglior tempo possibile per la tua età e il tuo sesso su quella distanza: un 70% vale un 70% a 30 come a 65 anni. Per orientarti: 60% livello locale, 70% regionale, 80% nazionale.</span>
      <span class="small muted">Tabelle stradali 2025 di Alan Jones, approvate da USATF. Età dall'anno di nascita (La mia carriera); se non c'è, dall'inizio della categoria FIDAL, e il valore è segnato con ≈.</span></details>`;
    const vuoto = { impegno: "Ancora nessun punto in questo periodo.", obiettivo: "Nessuno ha ancora 3 gare con un obiettivo fissato quest'anno." }[c] || "Nessun tempo in questa classifica, per ora.";
    return `<header class="head-back">${back("#/gruppo")}<div><span class="eyebrow">${esc(GD() ? GD().gruppo.nome : "Il gruppo")} · ${c === "albo" ? "di sempre" : esc(anno)}</span><h1 style="font-size:28px">${TAB_CL[c]}</h1></div></header>
      <div class="chips chips-scorri">${Object.keys(TAB_CL).map((k) => chip(`#/gruppo/classifiche?c=${k}`, k === c, TAB_CL[k])).join("")}</div>
      ${filtri}
      ${l.length ? `<section class="card" style="gap:0">${l.map((x) => x.html(x)).join("")}</section>` : `<p class="sub">${vuoto}</p>`}
      ${rec.length ? `<section class="card" style="gap:0"><h2 style="margin-bottom:4px">Record per categoria</h2>${rec.map((x) => `<div class="post ${x.mio ? "mio" : ""}"><span style="width:52px;font-weight:700">${esc(x.categoria)}</span><span style="flex:1;min-width:0"><b>${esc(x.mio ? "Tu" : x.membro)}</b><br><span class="small muted">${esc(titoloGara(x.gara_nome || ""))} · ${esc(x.data.slice(0, 4))}</span></span><b style="font:700 18px var(--display)">${esc(fmtSec(x.secondi))}</b></div>`).join("")}</section>` : ""}
      ${extra}${spiega ? `<p class="sub">${spiega}</p>` : ""}<a class="btn ghost block" href="#/gruppo/mie?da=classifiche">Le mie gare in classifica ›</a><a class="link-regole" href="#/gruppo/regole?da=classifiche">Tutte le regole delle classifiche ›</a>`;
  }

  // Gare della società (#/gruppo/societa?q=…): le vedono tutti; il direttivo (amministratore e organizzatori) le aggiunge
  // dal calendario, dalle proprie gare o a mano, e le toglie. Solo queste fanno punti Impegno.
  function candidatiSoc(q) {
    const anno = oggi().slice(0, 4), gia = new Set(gareSoc().map((s) => `${s.data}|${s.distanza}`)), visti = new Set();
    const parole = String(q || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter(Boolean);
    const testo = (g) => `${g.nome} ${g.luogo || ""} ${L.fmtBreve(g.data)} ${L.DIST_LABEL[g.distanza]}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return [...S.gare, ...(D.gare || [])].filter((g) => g && DISTANZE.includes(g.distanza) && g.data && g.data.slice(0, 4) >= anno && !g.annullata && !gia.has(`${g.data}|${g.distanza}`))
      .filter((g) => parole.every((p) => testo(g).includes(p)))
      .filter((g) => { const k = `${g.data}|${g.distanza}|${g.nome}`; if (visti.has(k)) return false; visti.add(k); return true; })
      .sort((a, b) => (a.data < b.data ? -1 : 1)).slice(0, 8);
  }
  function listaCandidatiSoc(q) {
    if (!String(q || "").trim()) return `<span class="small muted">Scrivi il nome della gara, la città o il mese.</span>`;
    const l = candidatiSoc(q);
    return l.length ? l.map((g) => `<div class="post"><span style="flex:1;min-width:0"><b>${esc(titoloGara(g.nome))}</b><br><span class="small muted">${esc(L.DIST_LABEL[g.distanza])} · ${esc(L.fmtGiorno(g.data))} ${esc(g.data.slice(0, 4))}${g.luogo ? " · " + esc(nomeLuogo(g.luogo)) : ""}</span></span>
      <button class="btn small" data-act="gs-add" data-data="${esc(g.data)}" data-dist="${esc(g.distanza)}" data-nome="${esc(g.nome)}" data-luogo="${esc(g.luogo || "")}" data-gid="${esc(g.id || "")}">Aggiungi</button></div>`).join("")
      : `<span class="small">Nessuna gara trovata per «${esc(q)}». Puoi aggiungerla a mano qui sotto.</span>`;
  }
  function vistaSocieta(param = {}) {
    if (!clAttive()) return vistaGruppo();
    const io = CL().io || {}, dir = io.ruolo === "admin" || io.ruolo === "organizzatore", o = oggi(), anno = o.slice(0, 4);
    // la stagione è l'anno in corso; "Da correre" mostra anche le gare già scelte per gli anni dopo (con l'anno)
    const tutte = gareSoc().filter((s) => s.data.slice(0, 4) === anno), future = gareSoc().filter((s) => s.data >= o), corse = tutte.filter((s) => s.data < o).reverse();
    const futureAnno = future.filter((s) => s.data.slice(0, 4) === anno), anniDopo = [...new Set(future.map((s) => s.data.slice(0, 4)))].filter((a) => a > anno).sort();
    const { risultati } = datiSt();
    const arrivati = (s) => new Set(risultati.filter((r) => r.data === s.data && r.distanza === s.distanza).map((r) => r.membro_id)).size;
    const riga = (s, passata) => { const n = passata ? arrivati(s) : ciSonoSoc(s), mia = S.gare.some((x) => x.data === s.data && x.distanza === s.distanza);
      return `<div class="post"><span style="flex:1;min-width:0"><a href="${hrefSoc(s)}" style="font-weight:700;color:inherit">${esc(titoloGara(s.nome))}</a><br><span class="small muted">${esc(L.DIST_LABEL[s.distanza])} · ${esc(L.fmtGiorno(s.data))}${s.luogo ? " · " + esc(nomeLuogo(s.luogo)) : ""}${n ? ` · ${n} ${passata ? "al traguardo" : n === 1 ? "c'è" : "ci sono"}` : ""}${!passata && mia ? " · ci sei" : ""}</span></span>
        ${dir ? `<button class="btn ghost small" data-act="gs-togli" data-id="${esc(s.id)}" data-nome="${esc(titoloGara(s.nome))}" aria-label="Togli ${esc(titoloGara(s.nome))}">Togli</button>` : ""}</div>`; };
    const perDist = DISTANZE.map((d) => [d, tutte.filter((s) => s.distanza === d).length]).filter((x) => x[1]).map(([d, n]) => `${n} ${d === "10" ? "da 10 km" : d === "21" ? (n === 1 ? "mezza" : "mezze") : n === 1 ? "maratona" : "maratone"}`).join(" · ");
    return `<header class="head-back">${back(dir && param.da === "admin" ? "#/gruppo/admin" : "#/gruppo")}<div><span class="eyebrow">${esc(GD() ? GD().gruppo.nome : "Il gruppo")} · stagione ${esc(anno)}</span><h1 style="font-size:28px">Gare della società</h1></div></header>
      <p class="sub">Le sceglie il direttivo (amministratore e organizzatori). Solo queste fanno punti nella classifica Impegno.</p>
      <section class="card" style="gap:6px"><div class="between" style="align-items:baseline"><span class="big" style="font-size:30px;color:var(--fg)">${tutte.length} ${tutte.length === 1 ? "gara" : "gare"}</span><span class="small muted">${corse.length} ${corse.length === 1 ? "corsa" : "corse"} · ${futureAnno.length} da correre</span></div>
        <div class="meter" aria-hidden="true"><div style="width:${tutte.length ? Math.round((corse.length / tutte.length) * 100) : 0}%"></div></div>${perDist ? `<span class="small muted">${perDist}</span>` : ""}</section>
      ${dir ? `<section class="card" style="gap:8px"><div class="field"><label for="gs-cerca">Aggiungi dal calendario o dalle tue gare</label><input class="input" id="gs-cerca" type="search" value="${esc(param.q || "")}" placeholder="es. Villa Ada, Ostia, dicembre" autocomplete="off"></div>
        <div id="gs-risultati" style="display:flex;flex-direction:column">${listaCandidatiSoc(param.q || "")}</div>
        <details><summary class="small">Non la trovi? Aggiungila a mano</summary><form id="gs-mano" style="display:flex;flex-direction:column;gap:10px;padding-top:10px">
          <div class="field"><label for="gm-nome">Nome della gara</label><input class="input" id="gm-nome" required maxlength="120"></div>
          <div class="grid2"><div class="field"><label for="gm-data">Data</label><input class="input" id="gm-data" type="date" required min="${anno}-01-01"></div>
          <div class="field"><label for="gm-dist">Distanza</label><select class="input" id="gm-dist">${DISTANZE.map((x) => `<option value="${x}" ${x === "21" ? "selected" : ""}>${esc(L.DIST_LABEL[x])}</option>`).join("")}</select></div></div>
          <button class="btn" type="submit">Aggiungi</button></form></details>
        <span class="small muted">Anche una gara già corsa della stagione: i punti si ricalcolano per tutti.</span></section>` : ""}
      <section class="card" style="gap:0"><h2 style="margin-bottom:4px">Da correre · ${esc(anno)}</h2>${futureAnno.length ? futureAnno.map((s) => riga(s, false)).join("") : `<span class="small">${dir ? "Nessuna gara in programma: aggiungi le prossime." : "Nessuna gara in programma, per ora."}</span>`}</section>
      ${anniDopo.map((a) => { const l = future.filter((s) => s.data.slice(0, 4) === a); return `<section class="card" style="gap:0"><div class="between" style="align-items:baseline"><h2 style="margin-bottom:4px">Stagione ${esc(a)}</h2><span class="small muted">${l.length} ${l.length === 1 ? "gara" : "gare"}</span></div>${l.map((s) => riga(s, false)).join("")}</section>`; }).join("")}
      ${corse.length ? `<details class="card" style="gap:0"><summary>Già corse · ${corse.length}</summary>${corse.map((s) => riga(s, true)).join("")}</details>` : ""}
      ${dir ? `<p class="sub">Consiglio: 8-12 gare l'anno, distribuite nei mesi e tra le distanze, così chi non può a una data ha altre occasioni.</p>` : ""}
      <a class="link-regole" href="#/gruppo/classifiche?c=impegno">La classifica Impegno ›</a>`;
  }

  // La mia carriera (#/gruppo/carriera): livello dai punti di carriera, punti della stagione, badge, dati per l'età,
  // link personale per portare un amico.
  function vistaCarriera() {
    if (!partecipo()) return vistaGruppo();
    const { eventi } = datiSt(), id = ioId(), anno = oggi().slice(0, 4), car = L.puntiCarriera(eventi, id), liv = L.livello(car);
    const stag = eventi.filter((e) => e.membro_id === id && e.data.startsWith(anno)), tot = stag.reduce((s, e) => s + e.punti, 0);
    const bd = badgeMiei(), presi = bd.filter((b) => b.preso).length, io = ST().io || {};
    const voci = [["arrivo", "Arrivi in gare della società"], ["obiettivo", "Obiettivi centrati"], ["borsa", "Borsa pronta"], ["socio", "Nuovi soci"], ["pb", "Nuovi personali"]]
      .map(([k, t]) => { const l = stag.filter((e) => e.tipo === k); return { t, n: l.length, p: l.reduce((s, e) => s + e.punti, 0) }; });
    const max = Math.max(1, ...voci.map((v) => v.p));
    const ICO_B = { prima10: "bandiera", prima21: "bandiera", prima42: "bandiera", tris: "bandiera", cecchino: "bersaglio", borsa5: "borsa", borsa10: "borsa", borsa20: "borsa",
      mesi6: "calendario", fedele: "stella", chioccia: "persona", record: "coppa", oltre70: "freccia" };
    const SVG = { bandiera: '<path d="M6 21V4h11l-2 4 2 4H6"/>', bersaglio: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>', borsa: '<path d="M5 8h14l-1 12H6L5 8zM9 8V6a3 3 0 0 1 6 0v2"/>',
      calendario: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>', stella: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4l-5.2 2.7 1-5.8L3.5 9.2l5.9-.9L12 3z"/>',
      persona: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M19 8v6M16 11h6"/>', coppa: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4zM8 6H5a3 3 0 0 0 3 3M16 6h3a3 3 0 0 1-3 3M12 13v4M9 20h6"/>',
      freccia: '<path d="M4 18l6-6 4 4 6-8M15 8h5v5"/>' };
    const badge = (b) => `<div class="badge ${b.preso ? "" : "off"}" title="${esc(b.cosa)}"><span class="badge-ico" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SVG[ICO_B[b.k]]}</svg></span>
      <span class="badge-nome">${esc(b.nome)}</span><span class="badge-prog">${esc(b.preso ? b.cosa : b.progresso)}</span></div>`;
    const annoMax = Number(anno) - 8;
    return `<header class="head-back">${back("#/gruppo")}<div><span class="eyebrow">La mia carriera</span><h1 style="font-size:28px">${esc(GD() ? GD().io.nome : "")}</h1></div></header>
      <section class="card dark" style="gap:8px"><div class="between" style="align-items:flex-end"><span class="big" style="font-size:40px">${esc(liv.nome)}</span>${liv.prossimo ? `<span class="small" style="color:var(--navy-muted)">prossimo: ${esc(liv.prossimo)}</span>` : ""}</div>
        <div class="meter acc" aria-hidden="true" style="background:#FFFFFF33"><div style="width:${Math.round(liv.quota * 100)}%"></div></div>
        <span class="small" style="color:var(--navy-muted)">${car.toLocaleString("it-IT")} punti di carriera${liv.prossimo ? ` · ${esc(liv.prossimo)} a ${liv.prossimaSoglia.toLocaleString("it-IT")}` : " · il livello più alto"}</span>
        <div class="grid2" style="padding-top:4px"><div class="tile-dark"><b>${tot}</b><span>punti stagione ${esc(anno)}</span></div><div class="tile-dark"><b>${presi} di ${bd.length}</b><span>badge</span></div></div></section>
      <section class="card" style="gap:8px"><h2>I livelli</h2><div class="livelli">${L.LIVELLI.map(([n, s]) => `<span class="${n === liv.nome ? "on" : ""}"><b>${esc(n)}</b>${s.toLocaleString("it-IT")}</span>`).join("")}</div>
        <span class="small muted">I punti di carriera sono la somma dei punti Impegno di tutte le stagioni: il livello non scende mai.</span></section>
      <section class="card" style="gap:8px"><h2>Come hai fatto i punti · ${esc(anno)}</h2>${tot ? voci.filter((v) => v.n).map((v) => `<div class="punti-voce"><div>${esc(v.t)} · ${v.n}<div class="meter acc" aria-hidden="true"><div style="width:${Math.round((v.p / max) * 100)}%"></div></div></div><b>${v.p}</b></div>`).join("")
        : `<span class="small">Ancora nessun punto quest'anno: arrivano con le <a href="#/gruppo/societa">gare della società</a>.</span>`}</section>
      <section class="card"><div class="between"><h2>Badge</h2><span class="small muted">${presi} di ${bd.length}</span></div><div class="badge-griglia">${bd.map(badge).join("")}</div></section>
      <section class="card" style="gap:8px"><h2>Porta un amico</h2><span class="small">Con il tuo link personale, chi entra nel gruppo risulta portato da te: al suo primo tempo certificato prendi +${L.PUNTI.socio} punti.</span>
        <button class="btn ghost" data-act="mio-invito">Condividi il tuo link</button></section>
      <form id="eta-form" class="card" style="gap:10px"><h2>Per la percentuale per età</h2>
        <div class="grid2"><div class="field"><label for="eta-anno">Anno di nascita</label><input class="input" id="eta-anno" type="number" inputmode="numeric" min="1920" max="${annoMax}" value="${esc(io.anno_nascita || "")}" placeholder="es. 1980"></div>
        <div class="field"><label for="eta-sesso">Sesso nelle tabelle</label><select class="input" id="eta-sesso"><option value="">Non indicato</option><option value="M" ${io.sesso === "M" ? "selected" : ""}>Uomo</option><option value="F" ${io.sesso === "F" ? "selected" : ""}>Donna</option></select></div></div>
        <span class="small muted">Facoltativi: i compagni vedono solo la percentuale. Senza, si usa l'inizio della tua categoria FIDAL.</span>
        <button class="btn" type="submit">Salva</button></form>
      <p class="sub">Per smettere di partecipare: Io → Gruppo. I tuoi risultati online si cancellano; sul telefono restano.</p>`;
  }

  // In La gara (Panoramica), per chi partecipa: obiettivo che si blocca alla vigilia e, nelle gare della società, i punti in palio
  function cardStagioneGara(g, fatte, tot) {
    if (!partecipo() || !DISTANZE.includes(g.distanza) || g.data < oggi()) return "";
    const soc = L.garaDellaSocieta(gareSoc(), g.data, g.distanza), aperto = L.obiettivoAperto(g.data), id = ioId();
    const online = (ST().obiettivi || []).find((o) => o.membro_id === id && o.data === g.data && o.distanza === g.distanza);
    const sec = !aperto && online ? online.secondi : g.tempo ? L.leggiTempo(g.distanza, g.tempo).secondi : null;
    const margine = sec ? Math.floor(sec * L.CENTRATO / 100) : 0;
    const miei = L.esatte(datiSt().risultati).filter((r) => r.mio && r.distanza === g.distanza && r.data < g.data);
    const pb = miei.length ? Math.min(...miei.map((r) => r.secondi)) : null;
    const ob = sec ? `<div class="row" style="align-items:baseline;gap:10px"><span class="big" style="font-size:34px;color:var(--fg)">${esc(fmtSec(sec))}</span><span class="small muted">${aperto ? "si blocca alle 23:59 della vigilia" : "bloccato"}</span></div>
        <span class="small">Vale per Obiettivo centrato: tra ${esc(fmtSec(sec - margine))} e ${esc(fmtSec(sec + margine))} è centrato.</span>`
      : aperto ? `<span class="small">Fissa il tempo obiettivo entro le 23:59 della vigilia: vale per la classifica Obiettivo centrato.</span><a class="btn ghost" href="${urlGara(g.id)}?modifica=1">Imposta l'obiettivo</a>`
      : `<span class="small muted">Nessun obiettivo fissato per questa gara.</span>`;
    const riga = (t, p, sotto = "") => `<div class="post" style="flex-wrap:wrap"><span style="flex:1;min-width:0">${t}${sotto ? `<br><span class="small muted">${sotto}</span>` : ""}</span><b>+${p}</b></div>`;
    const punti = soc ? `<div style="display:flex;flex-direction:column;margin-top:4px"><div class="between"><span class="eyebrow">Punti in palio</span><span class="small muted">fino a ${L.PUNTI.arrivo + L.PUNTI.pb + L.PUNTI.obiettivo + L.PUNTI.borsa}</span></div>
        ${riga("Arrivo", L.PUNTI.arrivo)}${riga("Borsa pronta entro la vigilia", L.PUNTI.borsa, `${fatte} di ${tot} pronte · <a href="${urlGara(g.id, "borsa")}">Apri la Borsa</a>`)}
        ${riga("Obiettivo centrato", L.PUNTI.obiettivo, sec ? `tra ${esc(fmtSec(sec - margine))} e ${esc(fmtSec(sec + margine))}` : "serve un obiettivo")}${riga("Nuovo personale", L.PUNTI.pb, pb ? `sotto il tuo ${esc(fmtSec(pb))}` : "dalla seconda gara certificata sulla distanza")}
        <span class="small muted" style="padding-top:6px">Il tempo conta quando è certificato dalla classifica ufficiale.</span></div>` : "";
    return `<section class="card" style="gap:8px">${soc ? `<span class="pill navy-pill" style="align-self:flex-start">Gara della società</span>` : ""}<span class="eyebrow">Il tuo obiettivo</span>${ob}${punti}</section>`;
  }

  // Scheda post-gara: in "Com'è andata?", quando il tempo è certificato
  function schedaPostGara(g, m) {
    const { risultati, eventi } = datiSt(), id = ioId();
    const r = risultati.find((x) => x.mio && x.data === g.data && x.distanza === g.distanza) || { ...m, mio: true };
    const o = (ST().obiettivi || []).find((x) => x.membro_id === id && x.data === g.data && x.distanza === g.distanza);
    const sc = o && !L.fuoriMisura(r) ? L.scartoObiettivo(r.secondi, o.secondi) : null, mig = L.miglioramento12(risultati.filter((x) => x.mio), r);
    const soc = L.garaDellaSocieta(gareSoc(), g.data, g.distanza);
    const ev = eventi.filter((e) => e.membro_id === id && e.data === g.data && e.distanza === g.distanza);
    const prima = new Set(badgeMiei({ prima: g.data }).filter((b) => b.preso).map((b) => b.k)), nuovi = badgeMiei({ fino: g.data }).filter((b) => b.preso && !prima.has(b.k));
    const tile = (v, t) => `<div class="tile-dark"><b>${v}</b><span>${t}</span></div>`;
    const tiles = [sc != null && tile(pct(sc), `dall'obiettivo ${esc(fmtSec(o.secondi))}${sc <= L.CENTRATO ? " · centrato" : ""}`), r.ag && tile(`${r.circa ? "≈ " : ""}${pct(r.ag)}`, "per età"),
      mig != null && tile(`${mig > 0 ? "+" : ""}${pct(mig)}`, "sul tuo meglio dei 12 mesi")].filter(Boolean);
    const NOMI_EV = { arrivo: "Arrivo", pb: "Nuovo personale", obiettivo: "Obiettivo centrato", borsa: "Borsa pronta entro la vigilia" };
    return `<section class="card dark" style="gap:10px"><div class="between"><span class="eyebrow">Classifiche del gruppo</span>${soc ? `<span class="pill navy">Gara della società</span>` : ""}</div>
        <span class="big" style="font-size:48px;color:var(--accent-on-dark)">${esc(fmtSec(r.secondi))}</span>
        <span class="small" style="color:var(--navy-muted)">✓ Certificato ${r.fonte === "manuale" ? "dal referente" : `dalla classifica di ${esc(FONTE_TEMPI[r.fonte] || r.fonte)}`}${r.categoria ? ` · categoria ${esc(r.categoria)}` : ""}</span>
        ${tiles.length ? `<div class="tiles-${tiles.length}">${tiles.join("")}</div>` : ""}</section>
      ${soc ? `<section class="card" style="gap:0"><h2 style="margin-bottom:4px">Punti Impegno</h2>${ev.length ? ev.map((e) => `<div class="post"><span style="flex:1">${NOMI_EV[e.tipo]}</span><b>+${e.punti}</b></div>`).join("") : ""}
        <div class="between" style="padding-top:8px"><b>Totale</b><b style="color:var(--accent);font-size:20px">+${ev.reduce((s, e) => s + e.punti, 0)}</b></div></section>` : ""}
      ${nuovi.map((b) => `<section class="card" style="flex-direction:row;align-items:center;gap:14px"><span class="badge-ico grande" aria-hidden="true">★</span><span style="display:flex;flex-direction:column"><span class="eyebrow">Nuovo badge</span><b style="font-size:17px">${esc(b.nome)}</b><span class="small muted">${esc(b.cosa)}</span></span></section>`).join("")}
      <a class="btn ghost block" href="#/gruppo">Le classifiche ›</a>`;
  }

  // Obiettivo e Borsa pronta online, per chi partecipa: solo quando cambiano e solo prima del via
  let timerSt;
  function sincronizzaStagione() {
    if (!partecipo()) return;
    clearTimeout(timerSt);
    timerSt = setTimeout(async () => {
      const inv = (S.gruppo.stInviati = S.gruppo.stInviati || {});
      for (const g of S.gare) {
        if (!DISTANZE.includes(g.distanza) || !L.obiettivoAperto(g.data)) continue;
        const ck = L.checklist(D.percorso, g, S.personali), pronta = ck.borsa.length > 0 && ck.borsa.every((v) => S.spunte[v.chiave]);
        const tempo = g.tempo ? L.leggiTempo(g.distanza, g.tempo).tempo || "" : "", k = `${g.data}|${g.distanza}`;
        const prima = String(inv[k] || "|").split("|");
        try { if (prima[0] !== tempo) { await rpc("fissa_obiettivo", { p_token: token(), p: { data: g.data, distanza: g.distanza, tempo } }); prima[0] = tempo; } } catch (e) { /* riprova al prossimo salvataggio */ }
        try { if (prima[1] !== String(pronta)) { await rpc("segna_borsa", { p_token: token(), p: { data: g.data, distanza: g.distanza, pronta } }); prima[1] = String(pronta); } } catch (e) { /* idem */ }
        inv[k] = prima.join("|");
      }
      for (const k of Object.keys(inv)) if (!L.obiettivoAperto(k.slice(0, 10))) delete inv[k];
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* niente */ }
    }, 3000);
  }

  // Le mie gare in classifica (#/gruppo/mie?p=stagione|tutte&q=…&da=…): quali contano, quali aspettano il referente,
  // quali mancano e perché; ricerca nell'elenco, ricerca nelle classifiche ufficiali (recupero) e aggiunta a mano.
  const PILL_MIE = { conta: ["ok", "Conta"], storico: ["grigio", "Albo e PB"], attesa: ["", "In approvazione"], rifiutato: ["doc-urgente", "Non approvata"],
    esito: ["grigio", ""], locale: ["doc-presto", "Non certificata"], vecchia: ["doc-manca", "Fuori tempo"] };
  const hms = (s) => { s = Math.round(s); return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  const urlAggiungiMia = (x) => `#/gruppo/mie?add=1&n=${encodeURIComponent(x.nome || "")}&dt=${x.data}&ds=${x.distanza}${x.secondi ? `&t=${encodeURIComponent(hms(x.secondi))}` : ""}`;
  const mieGare = () => L.mieGareClassifica(CL().miei, S.gare, S.risultati || {}, { oggi: oggi(), io: CL().io });
  function rigaMia(x) {
    const [cls, etichetta] = PILL_MIE[x.stato], anno = x.data.slice(0, 4);
    const titolo = titoloGara(x.nome) || `Gara del ${L.fmtBreve(x.data)}`;
    const perche = { conta: x.fonte === "manuale" ? "Approvata dal referente" : `Dalla classifica di ${FONTE_TEMPI[x.fonte] || x.fonte}`,
      storico: `Stagione ${anno}: vale per Albo d'oro e PB`, attesa: "La vede il referente del gruppo",
      rifiutato: x.nota || "Il referente non l'ha approvata", esito: "Senza tempo: non dà posizioni",
      locale: x.secondi ? "Nell'app, ma non ancora nelle classifiche" : "Manca il tempo", vecchia: "Corsa prima della tua adesione: non entra più" }[x.stato];
    const percheF = L.fuoriMisura(x) && (x.stato === "conta" || x.stato === "storico") ? PERCHE_FUORI(x) : perche;
    const azioni = [];
    if (x.stato === "locale" && x.secondi) {
      if (C().tempi && x.gid) azioni.push(`<a class="btn small" href="#/tempi?gara=${encodeURIComponent(x.gid)}">Cerca il tempo ufficiale</a>`);
      azioni.push(`<a class="btn ghost small" href="${urlAggiungiMia(x)}">Manda al referente</a>`);
    } else if (x.stato === "locale" && x.gid) azioni.push(`<a class="btn small" href="#/risultato/${encodeURIComponent(x.gid)}">Com'è andata?</a>`);
    if (x.stato === "rifiutato") azioni.push(`<a class="btn ghost small" href="${urlAggiungiMia(x)}">Rimanda</a>`);
    if ((x.stato === "attesa" || x.stato === "rifiutato") && x.id) azioni.push(`<button class="btn ghost small" data-act="cl-togli" data-id="${esc(x.id)}">Togli</button>`);
    return `<div class="post cl-mia cl-${x.stato}"><span style="flex:1;min-width:0"><b>${esc(titolo)}</b><br><span class="small muted">${esc(L.DIST_LABEL[x.distanza])} · ${esc(L.fmtBreve(x.data))} ${esc(anno)}</span></span>
      <span class="cl-mia-dx">${x.secondi ? `<b class="pb-tempo">${esc(fmtSec(x.secondi))}</b>` : ""}<span class="pill ${cls}">${esc(etichetta || L.ESITO_LABEL[x.esito] || "Senza tempo")}</span></span>
      <span class="small cl-mia-perche">${esc(percheF)}</span>${azioni.length ? `<span class="cl-mia-azioni">${azioni.join("")}</span>` : ""}</div>`;
  }
  function listaMie(q, periodo) {
    const l = L.cercaMieGare(mieGare(), q, { periodo, oggi: oggi() });
    if (l.length) return l.map(rigaMia).join("");
    return `<span class="small">${q ? `Nessuna gara trovata per «${esc(q)}».` : periodo === "tutte" ? "Nessuna gara, per ora." : `Nessuna gara nella stagione ${esc(oggi().slice(0, 4))}, per ora.`} Cercale nelle classifiche ufficiali o aggiungile a mano qui sotto.</span>`;
  }
  function vistaMieGare(param = {}) {
    if (!partecipo()) return vistaGruppo();
    const cl = CL(), anno = oggi().slice(0, 4), periodo = param.p === "tutte" ? "tutte" : "stagione", q = param.q || "", da = param.da || "";
    const torna = { classifiche: "#/gruppo/classifiche", regole: "#/gruppo/regole", io: "#/io" }[da] || "#/gruppo";
    const n = L.riepilogoMie(L.cercaMieGare(mieGare(), "", { oggi: oggi() }));
    const pos = (L.classificaGareCorse(cl.risultati || [], { anno }).find((x) => x.mio) || {}).pos;
    const daFare = n.locale + n.rifiutato;
    const extra = [n.attesa && `${n.attesa} in approvazione`, daFare && `${daFare} da sistemare`].filter(Boolean).join(" · ");
    const chip = (p, l) => `<a class="chip" href="#/gruppo/mie?p=${p}${da ? `&da=${da}` : ""}" aria-pressed="${p === periodo}" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit">${l}</a>`;
    const aperto = !!param.add, dist = DISTANZE.includes(param.ds) ? param.ds : "21";
    const dalApp = (S.gare || []).filter((g) => DISTANZE.includes(g.distanza) && g.data <= oggi()).map((g) => g.nome).filter(Boolean);
    if (aperto) setTimeout(() => { const el = document.getElementById("mie-aggiungi"); if (el) { el.scrollIntoView({ block: "start", behavior: "smooth" }); const f = document.getElementById(param.n ? "ma-tempo-h" : "ma-nome"); if (f) f.focus({ preventScroll: true }); } }, 60);
    return `<header class="head-back">${back(torna)}<div><span class="eyebrow">${esc(GD() ? GD().gruppo.nome : "Il gruppo")} · stagione ${esc(anno)}</span><h1 style="font-size:28px">Le mie gare in classifica</h1></div></header>
      <section class="card dark" style="gap:4px"><span style="font:700 34px/1 var(--display)">${n.conta} ${n.conta === 1 ? "gara conta" : "gare contano"}</span>
        <span class="small" style="color:var(--navy-muted)">${pos ? `Sei ${pos}° in Gare corse` : "Non sei ancora in Gare corse"}${extra ? ` · ${esc(extra)}` : ""}</span></section>
      <div class="field"><label for="mie-cerca">Cerca tra le tue gare</label><input class="input" id="mie-cerca" type="search" value="${esc(q)}" placeholder="es. Roma, mezza, ottobre" autocomplete="off"></div>
      <div class="chips">${chip("stagione", `Stagione ${esc(anno)}`)}${chip("tutte", "Tutti gli anni")}</div>
      <section class="card" style="gap:0" id="mie-lista" data-p="${periodo}">${listaMie(q, periodo)}</section>
      <section class="card" style="gap:10px"><span class="title">Manca una gara?</span>
        <span class="small">Cercala nelle classifiche ufficiali (Gare Podistiche Lazio e FIDAL): se il nome è quello con cui sei nel gruppo conta subito. Se non c'è, aggiungila a mano: la approva il referente.</span>
        <a class="btn block" href="#/gruppo/recupero?da=mie">Cerca nelle classifiche</a></section>
      <details class="card" id="mie-aggiungi-box" ${aperto ? "open" : ""}><summary><span class="title" style="font-size:16px">Aggiungi a mano</span></summary>
        <form id="mie-aggiungi" style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
          <div class="field"><label for="ma-nome">Nome della gara</label><input class="input" id="ma-nome" required maxlength="120" list="ma-gare" autocomplete="off" value="${esc(param.n || "")}" placeholder="es. Corsa di Miguel"><datalist id="ma-gare">${[...new Set(dalApp)].map((x) => `<option value="${esc(x)}">`).join("")}</datalist></div>
          <div class="grid2"><div class="field"><label for="ma-data">Data</label><input class="input" id="ma-data" type="date" required max="${esc(oggi())}" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(param.dt || "") ? param.dt : "")}"></div>
          <div class="field"><label for="ma-dist">Distanza</label><select class="input" id="ma-dist">${DISTANZE.map((x) => `<option value="${x}" ${x === dist ? "selected" : ""}>${esc(L.DIST_LABEL[x])}</option>`).join("")}</select></div></div>
          <div class="field"><span class="lbl" id="ma-tempo-l">Tempo ufficiale</span>${campoTempo("ma-tempo", dist, param.t || "", "ma-tempo-l")}</div>
          <div class="field"><label for="ma-link">Link alla classifica <span class="muted">(facoltativo)</span></label><input class="input" id="ma-link" type="url" inputmode="url" maxlength="300" placeholder="https://…"></div>
          <div class="field"><label for="ma-nota">Nota per il referente <span class="muted">(facoltativa)</span></label><input class="input" id="ma-nota" maxlength="280" placeholder="es. la classifica è solo in PDF"></div>
          <button class="btn" type="submit">Manda al referente</button>
          <span class="small muted">Solo 10 km, mezza e maratona su strada. ${L.recuperoAperto(cl.io) ? `Fino al ${esc(L.fmtBreve(String(cl.io.recupero_fino).slice(0, 10)))} anche le gare degli anni scorsi; dopo, solo quelle nuove.` : "Solo gare dalla settimana prima della tua adesione in avanti."} Al massimo 5 in attesa.</span>
        </form></details>
      <a class="link-regole" href="#/gruppo/regole?da=mie">Quali gare contano: le regole ›</a>`;
  }
  // Le regole delle classifiche, in parole semplici (#/gruppo/regole?da=…: la freccia torna da dove si è arrivati)
  function vistaRegole(param = {}) {
    const torna = { entra: "#/entra/classifiche", classifiche: "#/gruppo/classifiche", io: "#/io", admin: "#/gruppo/admin", mie: "#/gruppo/mie" }[param.da] || "#/gruppo";
    const cl = CL() || {}, io = cl.io || {}, anno = oggi().slice(0, 4);
    const sez = (titolo, corpo) => `<section class="card regole"><h2>${titolo}</h2>${corpo}</section>`;
    const cl3 = (nome, cosa, parita) => `<div class="regola-cl"><b>${nome}</b><span>${cosa}</span><span class="small muted">${parita}</span></div>`;
    return `${bannerProva()}<header class="head-back">${back(torna)}<div><span class="eyebrow">${esc(GD() ? GD().gruppo.nome : "Il gruppo")} · stagione ${esc(anno)}</span><h1 style="font-size:28px">Come funzionano le classifiche</h1></div></header>
      ${sez("Chi partecipa", `${voceOk("Solo chi sceglie <b>Partecipo</b>. Chi non partecipa usa l'app come sempre e non compare.")}${voceOk("Puoi uscire quando vuoi da Io → Gruppo: i tuoi risultati online si cancellano, sul telefono restano.")}`)}
      ${sez("Quali gare contano", `${voceOk("<b>10 km, mezza e maratona</b> su strada, con il tempo della classifica ufficiale.")}${voceOk("<b>Fuori misura</b>: se la classifica ufficiale dice poco meno o poco più (10 km tra 9,8 e 10,2; mezza e maratona entro 400 metri), la gara vale per Gare corse e per l'arrivo e la Borsa nell'Impegno, ma non per personali, PB, Albo d'oro, obiettivo e percentuale per età.")}${voceOk("La stagione va dal <b>1 gennaio al 31 dicembre</b>. L'Albo d'oro invece vale per sempre.")}${voceOk("Contano solo i tempi <b>certificati</b>. Ritirato, non partito e annullata si vedono nella tua storia, ma non danno posizioni.")}${io.partecipa && param.da !== "mie" ? `<a class="btn ghost" href="#/gruppo/mie?da=regole">Vedi le tue gare: quali contano</a>` : ""}`)}
      ${sez("Come entra un tempo", `${voceOk("<b>Dalle classifiche ufficiali</b> (Gare Podistiche Lazio e FIDAL): in «Com'è andata?» tocchi <b>Cerca nelle classifiche</b> e poi <b>Usa</b>. Se il nome in classifica è quello con cui sei nel gruppo, è certificato subito.")}
        ${voceOk("<b>Nome diverso, gara non trovata o classifica solo in PDF</b>: tocchi <b>Manda al referente</b> con il link o una nota. Lo approva l'amministratore o un organizzatore (il tuo tempo, se sei referente, lo approva un altro). Al massimo 5 in attesa.")}
        ${voceOk("Un tempo sbagliato, per esempio di un omonimo, lo può annullare l'amministratore.")}
        ${voceOk("Tempi impossibili non entrano: il passo deve stare tra 2:30 e 15:00 al km.")}`)}
      ${sez("Le gare già corse", `${voceOk("Nei <b>primi 30 giorni</b> da quando partecipi recuperi tutte le gare trovate nelle classifiche, anche degli anni scorsi: servono per l'Albo d'oro e per i PB.")}${voceOk("Dopo, si aggiungono solo le gare dalla settimana prima della tua adesione in avanti.")}
        ${L.recuperoAperto(io) ? `<a class="btn ghost" href="#/gruppo/recupero">Recupera le tue gare · fino al ${esc(L.fmtBreve(String(io.recupero_fino).slice(0, 10)))}</a>` : ""}`)}
      ${sez("Le gare della società", `${voceOk("Le sceglie il <b>direttivo</b> (amministratore e organizzatori) in Gestione, anche durante la stagione: i punti si ricalcolano.")}${voceOk("Solo queste fanno punti nella classifica <b>Impegno</b>. Le altre gare valgono per tutte le altre classifiche.")}<a class="btn ghost" href="#/gruppo/societa">Le gare della società</a>`)}
      ${sez("Le classifiche", `${cl3("Impegno", `Punti nelle gare della società: arrivo +${L.PUNTI.arrivo}, nuovo personale +${L.PUNTI.pb}, obiettivo centrato +${L.PUNTI.obiettivo}, Borsa pronta entro la vigilia +${L.PUNTI.borsa} (se poi arrivi). In più +${L.PUNTI.socio} per ogni nuovo socio portato col tuo link, al suo primo tempo certificato. C'è anche la vista del mese.`, "Niente punti per i km. A pari punti, pari posizione.")}
        ${cl3("Obiettivo centrato", "Lo scarto medio tra tempo ufficiale e tempo obiettivo, in più o in meno, su tutte le gare certificate con un obiettivo. L'obiettivo si fissa nella gara e si blocca alle 23:59 della vigilia. Servono almeno 3 gare; entro l'1% è centrato.", "Vince lo scarto più basso; a parità, chi ha più gare.")}
        ${cl3("Albo d'oro", "Il miglior tempo di sempre di ognuno, per distanza, con i record per categoria. Nella vista <b>Per età</b> ogni tempo diventa una percentuale del migliore possibile per età e sesso (tabelle stradali 2025 di Alan Jones, USATF): così un 70% vale lo stesso a 30 e a 65 anni.", "Uomini e donne dalla categoria ufficiale o da quanto indichi in La mia carriera.")}
        ${cl3("Gare corse", `Quante gare concludi nella stagione con un tempo certificato. C'è anche la vista del mese.`, "A pari gare, pari posizione.")}
        ${cl3("PB della stagione", "Quante volte quest'anno migliori il tuo miglior tempo di sempre su 10 km, mezza o maratona. La prima gara su una distanza fissa il riferimento e non conta.", "A pari PB vince chi è migliorato di più, in percentuale.")}
`)}
      ${sez("Livelli e badge", `${voceOk(`I punti Impegno di tutte le stagioni fanno i <b>punti di carriera</b>: ${L.LIVELLI.map(([n, p]) => `${n} ${p.toLocaleString("it-IT")}`).join(", ")}. Il livello non scende mai.`)}${voceOk("13 <b>badge</b> per le prime volte, la costanza, la Borsa, gli obiettivi centrati, i nuovi soci e i record: li trovi in La mia carriera.")}`)}
      ${sez("Cosa vedono i compagni", `${voceOk("Gara, data, distanza, tempo, categoria e società della classifica ufficiale.")}${voceOk("Il tuo tempo obiettivo e la Borsa pronta, ma solo dopo il via. Dell'età solo la percentuale, mai l'anno di nascita.")}${voceOk("L'<b>amministratore</b> vede tutte le tue gare online, anche quelle in approvazione o non approvate, per controllarle e sistemarle.")}<div class="voce-ok"><span class="spunta muto" aria-hidden="true">${ICO.lucchetto}</span><span>Tessera, certificato, scarpe, preparazione e posizione restano sul tuo telefono.</span></div>`)}`;
  }

  // In Gestione: interruttore del gruppo, coda del referente, ultimi tempi certificati (l'amministratore li può annullare)
  let CODA = null;
  async function caricaCoda() {
    try { CODA = await rpc("da_approvare", { p_token: token() }); } catch (e) { CODA = []; }
    if (/^#\/gruppo\/admin/.test(location.hash)) rerender();
  }
  function cardClassificheAdmin(d) {
    if (!clOn() || !CL() || d.io.ruolo === "membro") return "";
    const io = d.io, admin = io.ruolo === "admin", cl = CL();
    const sw = `<input type="checkbox" class="switch" id="cl-gruppo" ${cl.attive ? "checked" : ""} aria-label="Classifiche della stagione">`;
    const interr = !admin ? "" : cl.attive
      ? `<section class="card"><div class="between" style="gap:12px"><span><span class="title">Classifiche della stagione</span><br><span class="small muted">Stagione ${esc(oggi().slice(0, 4))} · ${cl.partecipanti} di ${cl.membri} runner partecipano</span></span>${sw}</div><a class="link-regole" href="#/gruppo/regole?da=admin">Le regole spiegate ai membri ›</a></section>`
      : `<section class="card evid"><div class="between" style="gap:12px;align-items:flex-start"><span><span class="pill">Nuovo</span><br><span class="title">Classifiche della stagione</span></span>${sw}</div>
        <span class="small">Il gruppo gioca insieme alla stagione: Gare corse, PB della stagione e Albo d'oro.</span>
        ${voceOk("Ogni runner sceglie se partecipare: chi non vuole usa l'app come oggi.")}${voceOk("I tempi arrivano dalle classifiche ufficiali: niente da controllare a mano.")}${voceOk("Tu e gli organizzatori approvate solo i tempi che non si trovano in classifica.")}
        <span class="small muted">La stagione va dal 1 gennaio al 31 dicembre. Chi partecipa recupera le gare già corse: in Oggi gli compare un percorso guidato.</span></section>`;
    if (!cl.attive) return interr;
    if (CODA === null) setTimeout(caricaCoda, 0);
    const nSoc = gareSoc().filter((s) => s.data.slice(0, 4) === oggi().slice(0, 4)).length;
    const soc = `<a class="card link-card ${nSoc ? "" : "evid"}" href="#/gruppo/societa?da=admin"><div class="between"><span class="title">Gare della società</span><span class="pill">${nSoc}</span></div><span class="small">${nSoc ? "Le gare scelte dal direttivo: solo queste fanno punti nella classifica Impegno." : "Scegli le gare della stagione: solo queste fanno punti nella classifica Impegno."}</span><span class="small" style="color:var(--accent);font-weight:700">${nSoc ? "Gestisci" : "Scegli le gare"} ›</span></a>`;
    const altri = d.membri.filter((m) => m.id !== io.id && (m.ruolo === "admin" || m.ruolo === "organizzatore")).map((m) => m.nome.split(/\s+/)[0]);
    const coda = (CODA || []).map((x) => `<div class="coda-voce"><div class="between"><b>${esc(x.membro)}</b><span class="small muted">${x.fonte === "manuale" ? "mandato a mano" : "nome diverso in classifica"}</span></div>
      <span class="small">${esc(x.gara_nome ? titoloGara(x.gara_nome) : L.DIST_LABEL[x.distanza])} · ${esc(L.DIST_LABEL[x.distanza])} · ${esc(L.fmtBreve(x.data))} ${esc(String(x.data).slice(0, 4))}</span>
      <div class="row" style="gap:10px;align-items:baseline"><b style="font:700 28px var(--display)">${esc(fmtSec(x.secondi))}</b>${x.link && /^https?:\/\//.test(x.link) ? `<a class="small" href="${esc(x.link)}" rel="noopener" target="_blank">Apri la classifica</a>` : ""}</div>
      ${x.nota ? `<span class="small muted">Nota: «${esc(x.nota)}»</span>` : ""}
      <div class="grid2"><button class="btn" data-act="cl-decidi" data-id="${esc(x.id)}" data-ok="1">Approva</button><button class="btn ghost" data-act="cl-decidi" data-id="${esc(x.id)}" data-ok="0">Rifiuta</button></div></div>`).join("");
    return `${interr}${soc}<section class="card ${CODA && CODA.length ? "evid" : ""}"><div class="between"><span class="title">Da approvare</span>${CODA && CODA.length ? `<span class="pill">${CODA.length}</span>` : ""}</div>
      ${CODA === null ? `<span class="small muted">Carico…</span>` : CODA.length ? `<span class="small muted">Tempi non trovati nelle classifiche ufficiali. Li vedete tu${altri.length ? ` e ${esc(altri.join(", "))}` : ""}.</span>${coda}` : `<span class="small">Niente in attesa. Qui arrivano i tempi non trovati nelle classifiche ufficiali.</span>`}</section>
      ${admin ? `<a class="card link-card" href="#/gruppo/gare"><span class="title">Le gare di tutti</span><span class="small">Ogni gara dei membri: quali contano, quali aspettano, quali non sono approvate. Da qui annulli un tempo sbagliato.</span><span class="small" style="color:var(--accent);font-weight:700">Apri ›</span></a>` : ""}`;
  }
  // Le gare di tutti (#/gruppo/gare?m=<id membro>&p=stagione|tutte&q=…), solo per l'amministratore: ogni risultato online
  // di ogni membro, in ogni stato (gare_membri), con le azioni del referente (approva, rifiuta, annulla).
  let GM = null, caricandoGM = false;
  async function caricaGareMembri() {
    if (caricandoGM) return;
    caricandoGM = true;
    try { GM = await rpc("gare_membri", { p_token: token() }); } catch (e) { GM = { errore: e.message || "Non riuscito", membri: [], risultati: [] }; }
    finally { caricandoGM = false; }
    if (/^#\/gruppo\/gare/.test(location.hash)) rerender();
  }
  const righeGM = () => L.gareMembri((GM && GM.risultati) || [], { oggi: oggi() });
  function rigaGM(x, conNome) {
    const [cls, etichetta] = PILL_MIE[x.stato], anno = x.data.slice(0, 4);
    const titolo = titoloGara(x.nome) || `Gara del ${L.fmtBreve(x.data)}`;
    const perche = { conta: x.fonte === "manuale" ? `Approvata${x.deciso_da ? ` da ${x.deciso_da}` : " dal referente"}` : `Dalla classifica di ${FONTE_TEMPI[x.fonte] || x.fonte}`,
      storico: `Stagione ${anno}: vale per Albo d'oro e PB`, attesa: x.fonte === "manuale" ? "Mandata a mano: aspetta il referente" : "Nome diverso in classifica: aspetta il referente",
      rifiutato: `${x.nota || "Non approvata"}${x.deciso_da && !x.nota.includes("referente") ? ` · ${x.deciso_da}` : ""}`, esito: "Senza tempo: non dà posizioni" }[x.stato];
    const percheF = L.fuoriMisura(x) && (x.stato === "conta" || x.stato === "storico") ? PERCHE_FUORI(x) : perche;
    const azioni = [];
    if (x.stato === "attesa") azioni.push(`<button class="btn small" data-act="cl-decidi" data-id="${esc(x.id)}" data-ok="1">Approva</button><button class="btn ghost small" data-act="cl-decidi" data-id="${esc(x.id)}" data-ok="0">Rifiuta</button>`);
    if (x.stato === "conta" || x.stato === "storico") azioni.push(`<button class="btn ghost small" data-act="cl-annulla" data-id="${esc(x.id)}" data-nome="${esc(x.mio ? "te" : x.membro)}">Annulla</button>`);
    if (x.link && /^https?:\/\//.test(x.link)) azioni.push(`<a class="btn ghost small" href="${esc(x.link)}" rel="noopener" target="_blank">Apri la classifica</a>`);
    return `<div class="post cl-mia cl-${x.stato}"><span style="flex:1;min-width:0">${conNome ? `<span class="small" style="font-weight:700">${esc(x.mio ? "Tu" : x.membro)}</span><br>` : ""}<b>${esc(titolo)}</b><br><span class="small muted">${esc(L.DIST_LABEL[x.distanza])} · ${esc(L.fmtBreve(x.data))} ${esc(anno)}${x.categoria ? ` · ${esc(x.categoria)}` : ""}</span></span>
      <span class="cl-mia-dx">${x.secondi ? `<b class="pb-tempo">${esc(fmtSec(x.secondi))}</b>` : ""}<span class="pill ${cls}">${esc(etichetta || L.ESITO_LABEL[x.esito] || "Senza tempo")}</span></span>
      <span class="small cl-mia-perche">${esc(percheF)}</span>${azioni.length ? `<span class="cl-mia-azioni">${azioni.join("")}</span>` : ""}</div>`;
  }
  function listaGM(q, periodo, m) {
    const base = righeGM().filter((x) => !m || x.membro_id === m);
    // in stagione restano anche i tempi in attesa degli anni prima: vanno comunque decisi
    const l = L.cercaMieGare(base, q, { periodo: "tutte", oggi: oggi() }).filter((x) => periodo === "tutte" || x.data.slice(0, 4) === oggi().slice(0, 4) || x.stato === "attesa");
    if (l.length) return l.map((x) => rigaGM(x, !m)).join("");
    return `<span class="small">${q ? `Nessuna gara trovata per «${esc(q)}».` : periodo === "tutte" ? "Nessuna gara online, per ora." : `Nessuna gara nella stagione ${esc(oggi().slice(0, 4))}, per ora.`}</span>`;
  }
  function vistaGareMembri(param = {}) {
    const d = GD(); if (!d || d.io.ruolo !== "admin" || !clAttive()) return vistaAdmin();
    if (GM === null) setTimeout(caricaGareMembri, 0);
    const anno = oggi().slice(0, 4), periodo = param.p === "tutte" ? "tutte" : "stagione", q = param.q || "";
    const membri = (GM && GM.membri) || [], m = membri.find((x) => x.id === param.m) || null;
    const riep = L.riepilogoMembri(membri, righeGM(), { oggi: oggi() });
    const chip = (p, l) => `<a class="chip" href="#/gruppo/gare?p=${p}${m ? `&m=${encodeURIComponent(m.id)}` : ""}" aria-pressed="${p === periodo}" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit">${l}</a>`;
    const testa = `${bannerProva()}<header class="head-back">${back(m ? "#/gruppo/gare" : "#/gruppo/admin")}<div><span class="eyebrow">${esc(d.gruppo.nome)} · stagione ${esc(anno)}</span><h1 style="font-size:28px">${m ? esc(m.mio ? "Le tue gare" : m.nome) : "Le gare di tutti"}</h1></div></header>`;
    if (GM === null) return `${testa}<p class="sub">Carico le gare del gruppo…</p>`;
    if (GM.errore) return `${testa}<section class="card"><span class="small">Non riesco a caricare le gare: ${esc(GM.errore)}</span><button class="btn ghost" data-act="gm-ricarica">Riprova</button></section>`;
    const somma = (k, l) => l.reduce((t, x) => t + x.n[k], 0);
    const sel = m ? riep.filter((x) => x.id === m.id) : riep;
    const conta = somma("conta", sel), attesa = somma("attesa", sel), rifiutate = somma("rifiutato", sel);
    const extra = [attesa && `${attesa} in approvazione`, rifiutate && `${rifiutate} non ${rifiutate === 1 ? "approvata" : "approvate"}`].filter(Boolean).join(" · ");
    const sotto = m ? `${m.partecipa ? `Partecipa${m.dal ? ` dal ${L.fmtBreve(String(m.dal).slice(0, 10))} ${String(m.dal).slice(0, 4)}` : ""}` : "Non partecipa alle classifiche"}${extra ? ` · ${extra}` : ""}`
      : `${riep.filter((x) => x.partecipa).length} di ${riep.length} partecipano${extra ? ` · ${extra}` : ""}`;
    const cerca = `<div class="field"><label for="gm-cerca">${m ? `Cerca tra le gare di ${esc(m.mio ? "te" : m.nome.split(/\s+/)[0])}` : "Cerca tra le gare di tutti"}</label><input class="input" id="gm-cerca" type="search" value="${esc(q)}" placeholder="${m ? "es. mezza, ottobre, in approvazione" : "es. Giulia, Roma, in approvazione"}" autocomplete="off"></div>
      <div class="chips">${chip("stagione", `Stagione ${esc(anno)}`)}${chip("tutte", "Tutti gli anni")}</div>`;
    const lista = `<section class="card" style="gap:0" id="gm-lista" data-p="${periodo}" data-m="${esc(m ? m.id : "")}">${listaGM(q, periodo, m ? m.id : "")}</section>`;
    const persona = (x) => {
      const n = x.n, bit = [n.conta && `${n.conta} ${n.conta === 1 ? "conta" : "contano"}`, n.attesa && `${n.attesa} in approvazione`, n.rifiutato && `${n.rifiutato} non ${n.rifiutato === 1 ? "approvata" : "approvate"}`, n.esito && `${n.esito} senza tempo`].filter(Boolean);
      return `<a class="post link-card" href="#/gruppo/gare?m=${encodeURIComponent(x.id)}${periodo === "tutte" ? "&p=tutte" : ""}" style="text-decoration:none;color:inherit">${avatar(x.nome, 32)}<span style="flex:1;min-width:0"><b>${esc(x.nome)}</b>${x.mio ? ' <span class="muted">(tu)</span>' : ""}<br><span class="small muted">${esc(!x.partecipa && !x.tutte ? "Non partecipa" : bit.length ? bit.join(" · ") : `Nessuna gara nella stagione${x.tutte ? ` · ${x.tutte} in tutto` : ""}`)}</span></span>${n.attesa ? `<span class="pill">${n.attesa}</span>` : ""}<span aria-hidden="true">›</span></a>`;
    };
    return `${testa}
      <section class="card dark" style="gap:4px"><span style="font:700 34px/1 var(--display)">${conta} ${conta === 1 ? "gara conta" : "gare contano"}</span><span class="small" style="color:var(--navy-muted)">${esc(sotto)}</span></section>
      ${cerca}
      ${m || q ? lista : `<section class="card" style="gap:0"><span class="eyebrow" style="margin-bottom:4px">Membri · ${riep.length}</span>${riep.map(persona).join("")}</section>`}
      <p class="sub">Le vedi solo tu come amministratore. Approva e rifiuta valgono come nella coda «Da approvare»; Annulla toglie dalle classifiche un tempo certificato sbagliato (per esempio di un omonimo).</p>`;
  }
  // In "Com'è andata?": stato del tempo per le classifiche e invio al referente
  function cardRisultatoCl(g, r) {
    if (!partecipo() || !DISTANZE.includes(g.distanza)) return "";
    const m = (CL().miei || []).find((x) => x.data === g.data && x.distanza === g.distanza);
    if (m && m.stato === "certificato" && m.esito === "arrivato") return schedaPostGara(g, m);
    if (m && m.stato === "certificato") return `<section class="card" style="gap:4px"><span class="title">Classifiche del gruppo</span><span class="small"><b style="color:var(--ok)">✓ Certificato</b> · ${esc(fmtSec(m.secondi))} ${m.fonte === "manuale" ? "approvato dal referente" : `dalla classifica di ${esc(FONTE_TEMPI[m.fonte] || m.fonte)}`}</span></section>`;
    if (m && m.stato === "in_approvazione") return `<section class="card" style="gap:4px"><span class="title">Classifiche del gruppo</span><span class="small"><span class="pill">In approvazione</span> ${esc(fmtSec(m.secondi))}: lo vede il referente del gruppo.</span></section>`;
    const rifiutato = m && m.stato === "rifiutato" ? `<span class="small" style="color:var(--warn)">Il referente non ha approvato il tempo che hai mandato.</span>` : "";
    if (!r.tempo) return rifiutato ? `<section class="card">${rifiutato}</section>` : "";
    return `<form id="cl-invia" data-id="${esc(g.id)}" class="card" style="gap:10px"><span class="title">Classifiche del gruppo</span>${rifiutato}
      <span class="small">Il tempo ${esc(r.tempo)} non è certificato. Cercalo nelle classifiche (conta subito) oppure mandalo al referente.</span>
      ${C().tempi ? `<a class="btn ghost" href="#/tempi?gara=${encodeURIComponent(g.id)}">Cerca nelle classifiche</a>` : ""}
      <div class="field"><label for="cl-link">Link alla classifica <span class="muted">(facoltativo)</span></label><input class="input" id="cl-link" type="url" inputmode="url" maxlength="300" placeholder="https://…"></div>
      <div class="field"><label for="cl-nota">Nota per il referente <span class="muted">(facoltativa)</span></label><input class="input" id="cl-nota" maxlength="280" placeholder="es. la classifica è solo in PDF"></div>
      <button class="btn" type="submit">Manda al referente</button></form>`;
  }

  function vistaSenzaGruppo() {
    return `${bannerProva()}<header class="head"><div><span class="eyebrow">Il gruppo</span><h1>Corri con la tua società</h1></div></header>
      <section class="card"><span class="small">Nel gruppo vedi chi corre le tue gare e i risultati che ognuno sceglie di condividere.</span></section>
      <section class="card"><h2>Hai un invito?</h2><span class="small">Apri il link che ti hanno mandato, oppure incolla qui il codice.</span>
        ${navigator.clipboard && navigator.clipboard.readText ? `<button class="btn block" type="button" data-act="inv-incolla">Incolla l'invito</button>` : ""}
        <form id="g-codice" class="row"><label class="sr" for="g-cod">Codice invito</label><input class="input" id="g-cod" placeholder="es. K7MPQ2XA" autocapitalize="characters" required><button class="btn" type="submit">Vai</button></form></section>
      <details class="card"><summary>Sei il presidente? Crea il gruppo</summary>
        <form id="g-crea" style="display:flex;flex-direction:column;gap:10px">
        <div class="field"><label for="g-nome">Nome della società o del gruppo</label><input class="input" id="g-nome" required maxlength="60" placeholder="es. Podistica …"></div>
        <div class="field"><label for="g-io">Come ti vedono gli altri</label><input class="input" id="g-io" required maxlength="40" value="${esc(S.profilo.nome || "")}" placeholder="es. Mario Rossi" autocomplete="name"><span class="small muted">Usa nome e cognome: comparirà anche nel tuo gruppo.</span></div>
        <button class="btn" type="submit">Crea il gruppo</button>
        <span class="small muted">Diventi amministratore: potrai invitare gli altri, nominare chi ti aiuta a invitare e gestire i membri.</span></form></details>`;
  }

  // ---------------------------------------------------------------- Entra nel gruppo: invito e funnel #/entra/:passo
  // Dal link d'invito: (su iPhone prima la Home) → nome → classifiche, tessera, tempi, quando e dove corri, gara, notifiche
  // → "Sei dentro". Chi è già nel gruppo lo ritrova in Oggi quando si accendono le classifiche: vede solo i passi che gli
  // mancano. Regole dei passi in L.passiEntra / L.prossimoEntra (testate); lo stato resta sul telefono (S.gruppo.entra).
  const ENTRA = () => (G().entra = G().entra || { dal: oggi(), saltati: {} });
  const entraAttivo = () => !!(S.gruppo && S.gruppo.dentro && S.gruppo.entra && !S.gruppo.entra.fine);
  function statoEntra() {
    const e = (S.gruppo && S.gruppo.entra) || {}, f = Object.fromEntries(statoPrepara().passi.map((x) => [x.k, x.fatto]));
    return L.passiEntra({ classifiche: clAttive(), partecipa: partecipo(), documenti: f.documenti, nonTesserato: !!S.nonTesserato, tempi: !!C().tempi,
      tempiFatti: !!e.tempi, ora: f.ora, zona: f.zona, garaFutura: f.gara, notifiche: pushChiusa(), saltati: e.saltati || {} });
  }
  function prossimoEntra(st, dopo) {
    if (RIVEDI !== "entra") return L.prossimoEntra(st, dopo);
    const ks = st.passi.map((x) => x.k), i = dopo ? ks.indexOf(dopo) + 1 : 0;
    return ks[i] || null;
  }
  const vaiEntra = (dopo) => { location.hash = `#/entra/${prossimoEntra(statoEntra(), dopo) || "fine"}`; };
  const saltaEntra = (k) => { if (!RIVEDI) { ENTRA().saltati = { ...(ENTRA().saltati || {}), [k]: true }; salva(); } vaiEntra(k); };
  // chi è già nel gruppo: quando l'amministratore accende le classifiche il funnel riparte (una volta sola)
  function proponiEntra() {
    const cl = CL(), e = S.gruppo && S.gruppo.entra;
    if (!cl || !cl.attive || !cl.io || cl.io.partecipa) return;
    if (e && (!e.fine || (e.saltati || {}).classifiche || e.clProposte)) return;
    S.gruppo.entra = { dal: oggi(), saltati: {}, esistente: true, clProposte: true }; localStorage.setItem(KEY, JSON.stringify(S));
  }
  const ICO = {
    gruppo: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5M15 14.5c3 0 6 1.5 6 4.5"/></svg>`,
    coppa: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M12 14v4M8 20h8"/></svg>`,
    bandiera: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>`,
    tessera: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h6M7 14h10"/></svg>`,
    sole: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg>`,
    lucchetto: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
  };
  const voceOk = (t, d = "") => `<div class="voce-ok"><span class="spunta" aria-hidden="true">✓</span><span>${t}${d ? `<br><span class="small muted">${d}</span>` : ""}</span></div>`;
  const vantaggio = (ico, t, d) => `<div class="vantaggio"><span class="ico" aria-hidden="true">${ico}</span><span><b>${t}</b><br><span class="small muted">${d}</span></span></div>`;

  // Scheda in Oggi: il funnel interrotto riparte da dove era rimasto
  function cardEntra() {
    if (!entraAttivo()) return "";
    const e = S.gruppo.entra, st = statoEntra();
    if (st.completo || (e.dopo && L.diffDays(oggi(), e.dopo) < 3)) return "";
    const nome = GD() ? GD().gruppo.nome : "il gruppo", manca = st.passi.filter((x) => !x.fatto), min = Math.max(1, Math.ceil(manca.length / 2));
    return `<section class="card soft" aria-label="Entra nel gruppo"><div class="between"><span class="title">${e.esistente ? `Novità in ${esc(nome)}: le classifiche` : "Finisci di entrare nel gruppo"}</span><b class="small" style="color:var(--accent-strong);white-space:nowrap">${st.fatti} di ${st.totale}</b></div>
      <div class="funnel-barra" aria-hidden="true">${st.passi.map((x) => `<span class="${x.fatto ? "ok" : ""}"></span>`).join("")}</div>
      <ul class="lista-punti">${manca.slice(0, 3).map((x) => `<li>${esc(x.titolo)}</li>`).join("")}</ul>
      <div class="row" style="gap:10px"><a class="btn" style="flex:1" href="#/entra">Continua · ${min} ${min === 1 ? "minuto" : "minuti"}</a><button class="btn ghost" type="button" data-act="entra-dopo">Più tardi</button></div></section>`;
  }

  // L'invito: su iPhone fuori dalla Home prima la Home (l'app nella Home ha una memoria separata da Safari)
  let invitoInSafari = false;
  function vistaInvito(codice, param = {}) {
    if (!codice) return vistaSenzaGruppo();
    const prova = codice === "anteprima" && S.gruppo && S.gruppo.dentro && GD();
    if (prova) {
      const d = GD(), adm = d.membri.find((m) => m.ruolo === "admin") || {};
      return paginaInvito(d.gruppo.codice || "K7MPQ2XA", { nome: d.gruppo.nome, membri: d.membri.length, admin: String(adm.nome || "").split(/\s+/)[0], iniziali: d.membri.map((m) => m.nome), classifiche: clAttive(), partecipanti: (CL() || {}).partecipanti || 0 }, !!param.home);
    }
    if (S.gruppo && S.gruppo.dentro) return `<section class="card"><span class="title">Sei già in un gruppo</span><span class="small">Per entrare in un altro, prima esci da quello attuale (Gruppo → Gestisci o Io).</span><a class="btn" href="#/gruppo">Vai al gruppo</a></section>`;
    return paginaInvito(codice, null, false);
  }
  function paginaInvito(codice, infoProva, home) {
    const link = linkInvito(codice);
    setTimeout(async () => {
      try {
        const info = infoProva || await rpc("info_invito", { p_codice: codice });
        const tit = document.getElementById("inv-tit"), box = document.getElementById("invito-info");
        if (!info) { if (tit) tit.textContent = "Invito non valido"; if (box) box.innerHTML = `<p class="sub">Questo invito non è valido o è stato sostituito. Chiedi un link nuovo a chi ti ha invitato.</p>`; const f = document.getElementById("g-entra"); if (f) f.hidden = true; return; }
        if (tit) tit.textContent = `${info.admin || "Il gruppo"} ti ha invitato in «${info.nome}»`;
        if (box) box.innerHTML = `${avatari(info.iniziali || [], 5)}<h1 id="inv-tit">${esc(info.admin || "Il gruppo")} ti ha invitato in «${esc(info.nome)}»</h1>
          <p class="sub" style="font-size:16px">${info.membri} runner. In 3 minuti sei operativo.</p>
          <div class="vantaggi-lista">${vantaggio(ICO.gruppo, "Le gare del gruppo", "Chi corre le tue gare, e quali gare scelgono gli altri")}
          ${info.classifiche ? vantaggio(ICO.coppa, "Le classifiche della stagione", `Gare corse, PB della stagione e Albo d'oro, con i tempi ufficiali${info.partecipanti ? ` · ${info.partecipanti} partecipano` : ""}`) : ""}
          ${vantaggio(ICO.bandiera, "Il tuo buddy fino al via", "Preparazione, borsa, meteo e scadenze della tessera")}</div>`;
      } catch (e) { const box = document.getElementById("invito-info"); if (box) box.innerHTML = `<p class="sub">Non riesco a leggere l'invito: controlla la connessione.</p>`; }
    }, 0);
    if (((iOS && !standalone()) || home) && !invitoInSafari) {
      const webview = !/Safari\//.test(navigator.userAgent);
      const passo = (n, t) => `<div class="passo-num"><span class="num">${n}</span><span>${t}</span></div>`;
      return `${bannerRivedi()}<section class="entra-invito"><span class="ob-logo">RaceBuddy</span>
        <h1 id="inv-tit">Ti hanno invitato nel gruppo</h1>
        <p class="sub" style="font-size:16px">Su iPhone RaceBuddy funziona come un'app: prima la metti nella Home, poi entri nel gruppo da lì.</p>
        <section class="card" style="gap:12px">${passo(1, `Tocca <b>Condividi</b> ${ICO_CONDIVIDI} nella barra di Safari`)}${passo(2, "Scegli <b>Aggiungi alla schermata Home</b>")}${passo(3, "Apri RaceBuddy dall'icona e tocca <b>Incolla l'invito</b>")}</section>
        <button class="card dark codice-box" type="button" data-act="inv-copia" data-link="${esc(link)}"><span class="eyebrow">Il tuo invito</span><span class="codice-grande">${esc(codice)}</span><span class="pill ok" id="inv-copiato">Tocca per copiarlo</span></button>
        ${webview ? `<p class="sub">Lo hai aperto da WhatsApp o Instagram? Prima apri questa pagina in Safari: menu ··· → <b>Apri in Safari</b>.</p>` : ""}
        <div class="piede"><button class="btn ghost block" type="button" data-act="inv-copia" data-link="${esc(link)}">Copia il codice</button>
          <p class="small muted centro">Le notifiche su iPhone arrivano solo alle app nella Home.</p>
          <button class="link-btn small centro" type="button" data-act="inv-safari">Continua qui in Safari</button></div></section>`;
    }
    return `${bannerRivedi()}<section class="entra-invito"><span class="ob-logo">RaceBuddy</span>
      <div id="invito-info" style="display:flex;flex-direction:column;gap:12px"><h1 id="inv-tit">Leggo l'invito…</h1></div>
      <form id="g-entra" data-codice="${esc(codice)}" ${infoProva ? 'data-anteprima="1"' : ""} class="piede">
        <div class="card"><div class="field"><label for="g-io">Nome e cognome</label><input class="input" id="g-io" required maxlength="40" value="${esc(S.profilo.nome || "")}" placeholder="es. Mario Rossi" autocomplete="name"><span class="small muted">Così ti riconoscono i compagni e troviamo i tuoi tempi nelle classifiche.</span></div></div>
        <button class="btn block" type="submit">Entra nel gruppo</button>
        <p class="small muted centro">Tieni a portata la tessera FIDAL. Niente email né password: le tue gare e i personali si vedono nel gruppo, puoi cambiarlo da Io.</p></form></section>`;
  }

  function vistaEntra(passo) {
    if (!S.gruppo || !S.gruppo.dentro) return vistaGruppo();
    const st = statoEntra(), ks = st.passi.map((x) => x.k);
    const k = passo === "fine" || ks.includes(passo) ? passo : prossimoEntra(st) || "fine";
    if (k === "fine") return vistaEntraFine(st);
    const i = ks.indexOf(k), prev = i > 0 ? `#/entra/${ks[i - 1]}` : "#/gruppo";
    const testa = `<header class="head-back">${back(prev)}<div style="min-width:0;flex:1"><span class="eyebrow">Entra nel gruppo · ${i + 1} di ${st.totale}</span><div class="funnel-barra" aria-hidden="true">${st.passi.map((x, j) => `<span class="${j === i ? "ora" : x.fatto ? "ok" : ""}"></span>`).join("")}</div></div></header>`;
    let corpo;
    if (k === "classifiche") {
      const cl = CL();
      corpo = `<h1>Partecipi alle classifiche?</h1><p class="sub">${cl.partecipanti} dei ${cl.membri} runner del gruppo partecipano. Chi non partecipa usa l'app come sempre. <a href="#/gruppo/regole?da=entra">Come funzionano</a></p>
        <section class="card"><h2>Vedono i compagni</h2>${voceOk("I risultati delle tue gare su 10 km, mezza e maratona, presi dalle classifiche ufficiali")}${voceOk("Categoria e società della classifica, per l'Albo d'oro")}${voceOk("Gli esiti senza tempo: ritirato, non partito, annullata")}</section>
        <section class="card"><h2>Resta sul telefono</h2><div class="voce-ok"><span class="spunta muto" aria-hidden="true">${ICO.lucchetto}</span><span>Tessera, certificato, scarpe, preparazione, posizione</span></div></section>
        <div class="piede"><button class="btn block" data-act="entra-partecipo">Partecipo</button><button class="btn ghost block" data-act="entra-salta" data-k="classifiche">Non ora</button>
          <p class="small muted centro">Puoi cambiare idea quando vuoi da Io → Gruppo: uscendo, i tuoi risultati online si cancellano.</p></div>`;
    } else if (k === "documenti") {
      corpo = passoDocumenti("entra");
    } else if (k === "tempi") corpo = passoTempi();
    else if (k === "uscita") {
      corpo = `<h1>Quando e dove corri</h1><p class="sub">Ti scrivo mezz'ora prima di uscire, con il meteo del posto giusto.</p>
        <form id="prepara-form" data-passo="uscita" data-funnel="entra" class="funnel-form">
          <div class="card"><div class="field"><label for="pf-ora">A che ora esci di solito</label><input class="input" id="pf-ora" type="time" step="900" required value="${esc(oraInput(S.profilo.ora) || "07:00")}" style="max-width:180px"></div></div>
          <div class="card"><div class="field"><span class="title" style="font-size:16px">Dove corri di solito</span>${bottoneGps("pf-citta")}<label for="pf-citta" class="small muted">oppure scrivi la città</label><input class="input" id="pf-citta" placeholder="es. Roma" value="${esc(S.profilo.citta || "")}" autocomplete="address-level2"><span class="small muted">Online va solo la zona, circa 1 km.</span></div></div>
          <div class="piede"><button class="btn block" type="submit">Avanti</button></div></form>`;
    } else if (k === "gara") corpo = passoGara();
    else {
      const sp = supportoPush();
      const azione = sp === "ok" ? `<button class="btn block" type="button" data-act="entra-push">Attiva le notifiche</button><button class="btn ghost block" type="button" data-act="entra-salta" data-k="notifiche">Non ora</button>`
        : sp === "ios-home" ? `<section class="card soft"><span class="small">Su iPhone le notifiche arrivano solo se RaceBuddy è nella Home: in Safari tocca <b>Condividi</b> → <b>Aggiungi alla schermata Home</b>, poi le attivi da Io.</span></section><button class="btn ghost block" type="button" data-act="entra-salta" data-k="notifiche">Lo faccio dopo</button>`
        : `<p class="sub">${sp === "negato" ? "Le notifiche sono bloccate per questa app: puoi riattivarle dalle impostazioni del telefono." : "Su questo telefono le notifiche non sono disponibili."}</p><button class="btn block" type="button" data-act="entra-salta" data-k="notifiche">Avanti</button>`;
      corpo = `<h1>Attiva le notifiche</h1><p class="sub">Ti scrivo solo quando c'è qualcosa di nuovo, al massimo una volta al mattino. Mai di notte.</p>
        <section class="card vantaggi-lista">${vantaggio(ICO.tessera, "Tessera e certificato", "30, 15 e 2 giorni prima della scadenza")}${vantaggio(ICO.sole, "Il meteo della tua uscita", "solo quando cambia davvero")}${vantaggio(ICO.bandiera, "La tua gara", "novità ufficiali, vigilia, mattina del via, com'è andata")}</section>
        <div class="piede">${azione}<p class="small muted centro">Per mandarle salviamo online orario, zona e le tue gare, senza il tuo nome.</p></div>`;
    }
    return `${bannerRivedi()}${testa}<div class="funnel funnel-pieno">${corpo}</div>`;
  }

  // Passo "Sei tu?": la ricerca parte da sola con il nome del gruppo; con un tocco personali e gare nelle classifiche
  function passoTempi() {
    const { nome, cognome } = nomeTempi();
    if (nome && cognome && (!TEMPI || TEMPI.chiave !== `${nome}|${cognome}|`)) setTimeout(() => cercaTempi(nome, cognome, null), 0);
    const altroNome = `<details class="card"><summary class="small">Nelle classifiche sei scritto in un altro modo?</summary>
      <form id="tempi-cerca" data-anno="" style="display:flex;flex-direction:column;gap:10px;margin-top:10px"><div class="grid2"><div class="field"><label for="tc-nome">Nome</label><input class="input" id="tc-nome" required maxlength="40" autocomplete="given-name" value="${esc(nome)}"></div>
        <div class="field"><label for="tc-cognome">Cognome</label><input class="input" id="tc-cognome" required maxlength="40" autocomplete="family-name" value="${esc(cognome)}"></div></div><button class="btn ghost" type="submit">Cerca</button></form></details>`;
    const salta = `<button class="btn ghost block" type="button" data-act="entra-salta" data-k="tempi">Non mi trovo, salta</button>`;
    let corpo = "", pronto = false;
    if (!nome || !cognome) corpo = altroNome.replace("<details ", "<details open ");
    else if (!TEMPI || TEMPI.carico) corpo = `<section class="card" aria-busy="true"><div class="row" style="gap:10px"><span class="spinner" aria-hidden="true"></span><span class="title">Cerco nelle classifiche</span></div><span class="small muted">Gare Podistiche Lazio dal 2019 e FIDAL: qualche secondo.</span><div class="meter attesa" aria-hidden="true"><div></div></div></section>`;
    else if (TEMPI.errore) corpo = `<section class="card"><span class="small">${esc(TEMPI.errore)}</span><button class="btn ghost" data-act="tempi-riprova">Riprova</button></section>`;
    else if (!TEMPI.persone.length) corpo = `<section class="card"><span class="title">Non ti trovo</span><span class="small">Nessuna gara a nome di <b>${esc(nome)} ${esc(cognome)}</b> su Gare Podistiche Lazio e FIDAL. Se ci sei con un altro nome, cercalo qui sotto.</span></section>${altroNome}`;
    else {
      const P = TEMPI.persone, scelti = TEMPI.scelti || [], tess = (S.documenti || {}).tessera || {};
      const proposte = new Set(L.personeProposte(P, tess));
      const ultima = (p) => p.risultati.reduce((m, r) => (r.data > m ? r.data : m), "");
      corpo = `<h2>${P.length > 1 ? `Trovati ${P.length} runner con questo nome` : "Ti ho trovato qui"}</h2>
        <div class="scelte">${P.map((p) => `<label class="scelta"><input type="checkbox" data-act-change="tempi-persona" data-id="${esc(p.id)}" ${scelti.includes(p.id) ? "checked" : ""}><span><b>${esc(p.societa || "Senza società")}${p.categoria ? " · " + esc(p.categoria) : ""}</b><br><span class="small muted">${p.risultati.length} ${p.risultati.length === 1 ? "gara" : "gare"}${ultima(p) ? `, l'ultima nel ${ultima(p).slice(0, 4)}` : ""} · ${esc(FONTE_TEMPI[p.fonte])}${proposte.has(p.id) && P.length > 1 ? " · la tua società" : ""}</span></span></label>`).join("")}</div>`;
      if (scelti.length) {
        const uniti = L.tempiUniti(P, scelti), per = L.tempiPerDistanza(uniti);
        const cat = (P.find((p) => scelti.includes(p.id) && p.categoria) || {}).categoria;
        const rec = partecipo() ? L.daRecuperare(uniti, CL().io, CL().miei) : [], n = rec.filter((r) => !REC_NO.has(r.id)).length;
        corpo += `<section class="card"><h2>Con un tocco porti dentro</h2>
          <div class="tre-tempi">${DISTANZE.map((d) => { const c = per[d][0]; return `<div><b>${c ? esc(fmtSec(c.secondi)) : "—"}</b><span>${esc(L.DIST_LABEL[d])}</span></div>`; }).join("")}</div>
          ${voceOk("I tuoi personali su 10 km, mezza e maratona", "restano sul telefono e, se scegli di comparire, nei personali del gruppo")}
          ${partecipo() ? (rec.length ? `${voceOk(`<b>${n} ${n === 1 ? "gara" : "gare"}</b> nelle classifiche del gruppo`, "certificate subito se il nome è quello del gruppo, altrimenti le approva il referente")}
            <details><summary class="small">Controlla le gare (con gli omonimi può capitare un errore)</summary>${rec.map((r) => `<label class="check"><input type="checkbox" data-act-change="rec-tog" data-id="${esc(r.id)}" ${REC_NO.has(r.id) ? "" : "checked"}><span style="flex:1"><span class="t">${esc(L.nomeRisultato(r))}</span><br><span class="d">${esc(L.DIST_LABEL[r.distanza])}${esc(notaFuori(r))} · ${esc(L.fmtBreve(r.data))} ${esc(r.data.slice(0, 4))}</span></span><b class="pb-tempo">${esc(fmtSec(r.secondi))}</b></label>`).join("")}</details>` : voceOk("Le tue gare sono già nelle classifiche del gruppo")) : ""}
          ${cat ? voceOk(`Categoria ${esc(cat)}`, "dalla classifica ufficiale, per uomini e donne nell'Albo d'oro") : ""}</section>${P.length ? altroNome : ""}`;
        pronto = true;
      }
    }
    return `<h1>Sei tu?</h1><p class="sub">${nome && cognome ? `Ho cercato <b>${esc(nome)} ${esc(cognome)}</b> nelle classifiche di Gare Podistiche Lazio e FIDAL.` : "Scrivi nome e cognome come nelle classifiche."}</p>${corpo}
      <div class="piede">${pronto ? `<button class="btn block" type="button" data-act="entra-tempi">Sono io: usa questi dati</button>` : ""}${salta}
        <p class="small muted centro">I personali restano sul tuo telefono anche se esci dal gruppo.</p></div>`;
  }

  // Passo "La tua prossima gara": si parte da quelle del gruppo
  function passoGara() {
    const o = oggi(), mie = new Set(S.gare.map((g) => g.id));
    const fut = GD() ? gareInComune().filter((g) => g.data >= o && !mie.has(g.gara_id)).slice(0, 5) : [];
    const chi = (l) => (l.length <= 2 ? l.join(" e ") : `${l.slice(0, 2).join(", ")} e altri ${l.length - 2}`);
    return `<h1>La tua prossima gara</h1><p class="sub">${fut.length ? "Partiamo da quelle del gruppo." : "Nessuno del gruppo ha ancora condiviso una gara."} <span class="pill grigio">facoltativo</span></p>
      <form id="entra-gare" class="funnel-form">
        ${fut.map((g, i) => `<div class="card entra-gara"><label class="between" style="gap:10px;cursor:pointer"><input type="checkbox" name="eg" value="${esc(g.gara_id)}" data-i="${i}" class="sr"><span style="min-width:0"><span class="title">${esc(titoloGara(g.nome))}${g.distanza ? ` · ${esc(L.DIST_LABEL[g.distanza] || g.distanza + " km")}` : ""}</span><br><span class="small muted">${esc(L.fmtGiorno(g.data))} · ${esc(chi(g.chi))}</span></span><span class="ci-sono">Ci sono</span></label>
          ${DISTANZE.includes(g.distanza) ? `<div class="entra-obiettivo"><span class="small" id="eg-l-${i}"><b>Tempo obiettivo</b> <span class="muted">(facoltativo)</span></span>${campoTempo(`eg-${i}`, g.distanza, "", `eg-l-${i}`)}</div>` : ""}</div>`).join("")}
        <a href="#/gare?v=italia">Cerca un'altra gara nel calendario</a>
        <div class="piede">${fut.length ? `<button class="btn block" type="submit">Avanti</button>` : ""}<button class="btn ghost block" type="button" data-act="entra-salta" data-k="gara">Non ho gare in programma</button></div></form>`;
  }

  // Arrivo: cosa è pronto (e cosa manca)
  function vistaEntraFine(st) {
    const e = RIVEDI ? (S.gruppo.entra || {}) : ENTRA(); if (!RIVEDI && !e.fine) { e.fine = oggi(); salva(); }
    RIVEDI = null;
    const d = GD(), cl = CL(), o = oggi(), nome = String(S.profilo.nome || "").trim().split(/\s+/)[0];
    const riga = (ok, t, sotto = "") => `<li class="${ok ? "ok" : ""}"><span class="pallino" aria-hidden="true">${ok ? "✓" : ""}</span><span><b>${t}</b>${sotto ? `<br><span>${sotto}</span>` : ""}</span></li>`;
    const righe = [];
    righe.push(riga(true, `Nel gruppo con altri ${d ? d.membri.length - 1 : ""} runner`, partecipo() ? "partecipi alle classifiche" : clAttive() ? "alle classifiche puoi unirti quando vuoi" : ""));
    if (partecipo() && e.recuperate) {
      const pos = L.classificaGareCorse(cl.risultati || [], { anno: o.slice(0, 4) }).find((x) => x.mio);
      righe.push(riga(true, `${e.recuperate} ${e.recuperate === 1 ? "gara recuperata" : "gare recuperate"}`, pos ? `sei ${pos.pos}° in Gare corse` : "alcune le approva il referente"));
    }
    const pb = DISTANZE.filter((x) => (S.pb || {})[x]);
    if (pb.length) righe.push(riga(true, `Personali su ${pb.map((x) => L.DIST_LABEL[x].toLowerCase()).join(", ").replace(/, ([^,]*)$/, " e $1")}`));
    const f = Object.fromEntries(statoPrepara().passi.map((x) => [x.k, x.fatto]));
    if (!S.nonTesserato) righe.push(riga(f.documenti, f.documenti ? "Tessera e certificato in regola" : "Tessera e certificato da inserire", f.documenti ? "ti avviso prima delle scadenze" : "quando vuoi: te lo ricordo in Oggi"));
    const g = S.gare.filter((x) => x.data >= o).sort((a, b) => (a.data < b.data ? -1 : 1))[0];
    if (g) { const n = L.diffDays(g.data, o), con = d ? d.gare.filter((x) => x.gara_id === g.id && x.membro_id !== (d.io || {}).id).map((x) => x.membro) : [];
      righe.push(riga(true, `${titoloGara(g.nome)} ${n === 0 ? "oggi" : n === 1 ? "domani" : `tra ${n} giorni`}`, [con.length ? `con ${con.slice(0, 2).join(", ")}${con.length > 2 ? ` e altri ${con.length - 2}` : ""}` : "", g.tempo ? `obiettivo ${g.tempo}` : ""].filter(Boolean).join(" · "))); }
    const on = S.push && S.push.attivo;
    righe.push(riga(on, on ? "Notifiche attive" : "Notifiche spente", on ? `domani alle ${oraMessaggio()} il meteo della tua uscita` : "le attivi quando vuoi da Io"));
    return `<section class="invito entra-fine"><span class="eyebrow">${esc(d ? d.gruppo.nome : "Il gruppo")}</span><h1>Sei dentro${nome ? `,<br><span style="color:var(--accent-on-dark)">${esc(nome)}</span>` : ""}</h1>
      <ul class="arrivo">${righe.join("")}</ul>
      <div class="piede"><a class="btn block" href="#/gruppo">Vai al gruppo</a><a class="btn ghost-dark block" href="#/oggi">Vai a Oggi</a></div></section>`;
  }

  // ---------------------------------------------------------------- superamministratore (test di Luca)
  // Solo per i telefoni nominati dal workflow "Amministratore del gruppo (assistenza)": vede tutti i gruppi e ci entra
  // come amministratore, uscendo da quello di prima (un telefono sta in un solo gruppo). docs/supabase_superadmin.sql
  let SUPER = null;
  async function caricaSuper() {
    SUPER = { carico: true };
    try { SUPER = { gruppi: await rpc("super_gruppi", { p_token: token() }) }; }
    catch (e) { SUPER = { errore: /superamministratore/.test(e.message || "") ? "Questo telefono non è superamministratore. Si attiva dal workflow «Amministratore del gruppo (assistenza)»." : "Non riesco a leggere i gruppi adesso: riprova tra poco." }; }
    if (/^#\/super/.test(location.hash)) rerender();
  }
  function vistaSuper() {
    if (!SUPER) setTimeout(caricaSuper, 0);
    const testa = `<header class="head-back">${back("#/io")}<div><span class="eyebrow">Strumenti di prova</span><h1 style="font-size:28px">Superamministratore</h1></div></header>`;
    if (!SUPER || SUPER.carico) return `${testa}<p class="sub">Carico i gruppi…</p>`;
    if (SUPER.errore) return `${testa}<section class="card"><span class="small">${esc(SUPER.errore)}</span></section>`;
    const l = SUPER.gruppi || [];
    return `${testa}<p class="sub">Entri in qualunque gruppo come amministratore, senza invito. Un telefono sta in un solo gruppo: spostandoti esci da quello di prima (i tuoi risultati lì si cancellano; un gruppo rimasto vuoto sparisce). Nel nuovo gruppo riparte il percorso "Entra nel gruppo".</p>
      <section class="card" style="gap:0">${l.length ? l.map((g) => `<div class="post"><span style="flex:1;min-width:0"><b>${esc(g.nome)}</b><br><span class="small muted">${g.membri} ${g.membri === 1 ? "membro" : "membri"} · classifiche ${g.classifiche ? `accese, ${g.partecipanti} partecipano` : "spente"}</span></span>
        ${g.qui && g.ruolo === "admin" ? `<span class="pill ok">Sei qui · admin</span>` : g.qui ? `<button class="btn small" data-act="super-vai" data-qui="1" data-id="${esc(g.id)}" data-nome="${esc(g.nome)}">Torna admin</button>` : `<button class="btn ghost small" data-act="super-vai" data-id="${esc(g.id)}" data-nome="${esc(g.nome)}">Entra</button>`}</div>`).join("") : `<span class="small">Nessun gruppo.</span>`}</section>`;
  }

  function gareInComune() {
    const d = GD(), mie = new Set(S.gare.map((g) => g.id)), per = {};
    for (const g of d.gare) (per[g.gara_id] = per[g.gara_id] || { ...g, chi: [] }).chi.push(g.membro);
    return Object.values(per).sort((a, b) => (a.data < b.data ? -1 : 1)).map((g) => ({ ...g, mia: mie.has(g.gara_id) }));
  }

  function vistaGruppo() {
    if (!S.gruppo || !S.gruppo.dentro) return vistaSenzaGruppo();
    setTimeout(() => aggiornaGruppo(true), 0);
    const d = GD();
    if (!d) return `${bannerProva()}<header class="head"><h1>Gruppo</h1></header><p class="sub">Carico il gruppo…</p>`;
    const io = d.io, org = io.ruolo === "admin" || io.ruolo === "organizzatore";
    const comuni = gareInComune();
    return `${bannerProva()}<header class="head"><div style="min-width:0"><span class="eyebrow">Il gruppo · ${d.membri.length} runner</span><h1>${esc(d.gruppo.nome)}</h1></div><a class="btn ghost small" href="#/gruppo/admin">${io.ruolo === "admin" ? "Gestisci" : io.ruolo === "organizzatore" ? "Invita" : "Membri"}</a></header>
      ${cardStagione(d)}
      <section aria-label="Gare in comune"><h2 style="margin-bottom:8px">Le gare del gruppo</h2>${comuni.length ? `<div class="lista-c">${comuni.slice(0, 6).map((g) => `<a class="card" href="#/gruppo/gara/${encodeURIComponent(g.gara_id)}" style="text-decoration:none;color:inherit;font-weight:inherit"><div class="between"><span class="title">${esc(titoloGara(g.nome))}</span><span class="small" style="font-weight:700;color:${g.mia ? "var(--accent)" : "var(--muted)"}">${esc(L.fmtGiorno(g.data))}</span></div><div class="row">${avatari(g.chi)}<span class="small">${g.chi.length} del gruppo${g.mia ? ", tu compreso" : ""} ›</span></div></a>`).join("")}</div>` : `<p class="sub">Ancora nessuna gara condivisa.</p>`}</section>
      <p class="sub">Ognuno sceglie cosa condividere: le tue gare si vedono solo se lo hai scelto (Io → Gruppo).</p>`;
  }

  // Classifica dei personali in cima al gruppo: una distanza per volta (scelta con i chip), i primi 3 + la tua posizione,
  // e un pulsante esplicito per la classifica completa.
  let distGruppo = null;
  function cardClassifica(d) {
    const per = (x) => d.classifica.filter((c) => c.distanza === x).sort((a, b) => a.secondi - b.secondi);
    const conDati = DISTANZE.filter((x) => per(x).length);
    if (!conDati.length) return `<section class="card" aria-label="Classifica dei personali"><div class="between"><h2>I personali del gruppo</h2><a class="small" href="#/pb">I tuoi ›</a></div>
      <span class="small">Ancora nessun personale. <a href="#/pb">Inserisci i tuoi</a>: bastano tempo, gara e data.</span></section>`;
    const dist = conDati.includes(distGruppo) ? distGruppo : conDati.find((x) => per(x).some((c) => c.mio)) || (conDati.includes("21") ? "21" : conDati[0]);
    const l = per(dist), io = l.findIndex((c) => c.mio);
    const riga = (c, i) => `<div class="post ${c.mio ? "mio" : ""}"><span class="pos">${i + 1}</span>${avatar(c.membro, 30)}<span style="flex:1;min-width:0"><b>${esc(c.mio ? "Tu" : c.membro)}</b></span><b style="font:700 18px var(--display)">${esc(c.tempo)}</b></div>`;
    const chip = (x) => `<button class="chip" data-act="g-dist" data-d="${x}" aria-pressed="${x === dist}" ${per(x).length ? "" : "disabled"}>${esc(L.DIST_LABEL[x])}</button>`;
    return `<section class="card" aria-label="Classifica dei personali"><div class="between"><h2>I personali del gruppo</h2><a class="small" href="#/pb">I tuoi ›</a></div>
      <div class="chips">${DISTANZE.map(chip).join("")}</div>
      <div>${l.slice(0, 3).map(riga).join("")}${io >= 3 ? `<div class="post small muted" style="justify-content:center;padding:2px 0">···</div>${riga(l[io], io)}` : ""}</div>
      <a class="btn ghost block" href="#/gruppo/classifica?d=${dist}">Classifica completa · ${l.length} runner ›</a></section>`;
  }

  function vistaGaraGruppo(id) {
    const d = GD(); if (!d) return vistaGruppo();
    const g = gareInComune().find((x) => x.gara_id === id);
    const chi = d.gare.filter((x) => x.gara_id === id);
    if (!g) return `<header class="head-back">${back("#/gruppo")}<h1 style="font-size:28px">Gara</h1></header><p class="sub">Nessuno del gruppo ha condiviso questa gara.</p>`;
    return `${bannerProva()}<header class="head-back">${back("#/gruppo")}<div><span class="eyebrow">Il gruppo alla gara · ${esc(L.fmtGiorno(g.data))}</span><h1 style="font-size:28px">${esc(titoloGara(g.nome))}</h1></div></header>
      <section class="card" style="gap:0"><h2 style="margin-bottom:4px">Chi corre · ${chi.length}</h2>${chi.map((x) => `<div class="post">${avatar(x.membro, 34)}<span style="flex:1"><b>${esc(x.membro)}</b><br><span class="small muted">${esc(L.RUOLO_LABEL[x.ruolo] || "")}${x.tempo ? ` · ${esc(x.tempo)}` : ""}</span></span></div>`).join("")}</section>
      ${S.gare.some((x) => x.id === id) ? `<a class="btn ghost" href="#/gara/${encodeURIComponent(id)}">La mia scheda gara</a>` : `<a class="btn ghost" href="#/aggiungi/${encodeURIComponent(id)}">Corro anch'io: aggiungila</a>`}`;
  }

  function vistaClassifica(param) {
    const d = GD(); if (!d) return vistaGruppo();
    const dist = param.d || DISTANZE.find((x) => d.classifica.some((c) => c.distanza === x)) || "21";
    const lista = d.classifica.filter((c) => c.distanza === dist).sort((a, b) => a.secondi - b.secondi);
    const chip = (v, l) => `<a class="chip" href="#/gruppo/classifica?d=${v}" aria-pressed="${dist === v}" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit">${l}</a>`;
    return `${bannerProva()}<header class="head-back">${back("#/gruppo")}<div><span class="eyebrow">${esc(d.gruppo.nome)}</span><h1 style="font-size:28px">Classifica dei PB</h1></div></header>
      <div class="chips">${chip("10", "10 km")}${chip("21", "Mezza")}${chip("42", "Maratona")}</div>
      ${lista.length ? `<section class="card" style="gap:0">${lista.map((c, i) => `<div class="post ${c.mio ? "mio" : ""}"><span class="pos">${i + 1}</span>${avatar(c.membro, 32)}<span style="flex:1;min-width:0"><b>${esc(c.membro)}</b><br><span class="small muted">${esc(titoloGara(c.gara_nome || ""))} · ${esc(c.data_gara ? L.fmtBreve(c.data_gara) : "")}</span></span><b style="font:700 20px var(--display)">${esc(c.tempo)}</b></div>`).join("")}</section>` : `<p class="sub">Ancora nessun risultato condiviso su questa distanza.</p>`}
      <a class="btn ghost" href="#/pb">I tuoi personali</a>
      <p class="sub">Un personale a testa per distanza: quello che ognuno inserisce a mano o migliora dopo una gara. Ci sono solo i runner che hanno scelto di comparire.</p>`;
  }

  function vistaAdmin() {
    const d = GD(); if (!d) return vistaGruppo();
    GM = null; // le gare di tutti si ricaricano a ogni apertura
    const io = d.io, admin = io.ruolo === "admin";
    const link = d.gruppo.codice ? linkInvito(d.gruppo.codice) : "";
    const attivi = d.membri.filter((m) => m.visto && L.diffDays(L.todayISO(), m.visto) <= 7).length;
    const comuni = gareInComune().length;
    const membro = (m) => `<div class="post"><span style="flex:1;min-width:0"><b>${esc(m.nome)}</b>${m.id === io.id ? ' <span class="muted">(tu)</span>' : ""}<br><span class="small muted">visto ${esc(m.visto ? fa(m.visto) : "—")}</span></span>
      ${admin ? `<select class="input ruolo-sel" data-act-change="g-ruolo" data-id="${m.id}" aria-label="Ruolo di ${esc(m.nome)}">${Object.entries(RUOLI_G).map(([k, l]) => `<option value="${k}" ${m.ruolo === k ? "selected" : ""}>${l}</option>`).join("")}</select>${m.id !== io.id ? `<button class="btn ghost small" data-act="g-rimuovi" data-id="${m.id}" data-nome="${esc(m.nome)}" aria-label="Rimuovi ${esc(m.nome)}">✕</button>` : ""}` : `<span class="small muted">${RUOLI_G[m.ruolo]}</span>`}</div>`;
    return `${bannerProva()}<header class="head-back">${back("#/gruppo")}<span class="small" style="font-weight:600">Gruppo</span></header>
      <div><span class="eyebrow">${esc(d.gruppo.nome)} · ${RUOLI_G[io.ruolo]}</span><h1 style="font-size:36px">${io.ruolo === "membro" ? "Membri" : "Gestione"}</h1></div>
      ${cardClassificheAdmin(d)}
      ${link ? `<section class="card"><span class="eyebrow">Invito</span><div class="between" style="gap:12px"><span class="codice-invito">${esc(d.gruppo.codice)}</span><button class="btn ghost" data-act="g-condividi" data-link="${esc(link)}">Condividi</button></div>
        <span class="small muted">Condividi manda il link con un messaggio pronto: chi lo apre dal telefono entra in 3 minuti, guidato passo per passo.</span>
        <div class="row" style="gap:18px"><button class="linkbtn small" data-act="g-copia" data-link="${esc(link)}">Copia il link</button>${admin ? `<button class="linkbtn small" data-act="g-nuovocodice">Cambia codice</button>` : ""}</div></section>` : ""}
      <section class="card" style="gap:0"><div class="between" style="margin-bottom:2px"><span class="eyebrow">Membri · ${d.membri.length}</span>${admin ? `<span class="small muted">ruolo</span>` : ""}</div>
        <span class="small muted" style="margin-bottom:4px">${attivi} attivi in settimana · ${comuni} ${comuni === 1 ? "gara" : "gare"} in comune</span>
        ${d.membri.map(membro).join("")}
        ${admin ? `<span class="small muted" style="padding-top:8px">Gli <b>organizzatori</b> condividono l'invito e approvano i tempi. Gli <b>amministratori</b> gestiscono anche i membri.</span>` : ""}</section>
      ${admin ? `<form id="g-rinomina" class="card"><span class="eyebrow">Nome del gruppo</span><div class="row"><label class="sr" for="g-nn">Nome</label><input class="input" id="g-nn" value="${esc(d.gruppo.nome)}" maxlength="60"><button class="btn ghost" type="submit">Salva</button></div></form>` : ""}
      <div id="g-esci-box"><button class="btn ghost block" data-act="g-esci">Esci dal gruppo</button></div>
      <p class="sub">Uscendo, online si cancellano le tue gare condivise, i personali in classifica e i risultati delle classifiche; sul telefono resta tutto. Puoi rientrare con un nuovo invito.</p>`;
  }

  // ---------------------------------------------------------------- risultato dopo la gara
  const fmtDiff = (s) => { s = Math.abs(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  function garaDaRaccontare() {
    const o = oggi();
    return S.gare.filter((g) => cicloGara(g, o) === "postgara" && !(S.risultati || {})[g.id] && !g.esito).sort((a, b) => (a.data < b.data ? 1 : -1))[0] || null;
  }
  // ---------------------------------------------------------------- immagine del risultato da condividere
  // Tutto sul telefono: la foto scelta e l'immagine non vanno online.
  const CND = { id: null, formato: "storia", stile: "blu", parole: true, posizione: false, foto: null, citta: {} };
  const DIST_SU = { "10": "sui 10 km", "21": "sulla mezza", "42": "sulla maratona" };
  const chiaveCitta = (g) => String(g.luogo || "").trim().toLowerCase();
  function posizioneNelGruppo(g, r) {
    const d = GD();
    if (!d || !S.gruppo || !S.gruppo.dentro || d.io.mostra_pb === false) return 0;
    const lista = (d.classifica || []).filter((c) => c.distanza === g.distanza).sort((a, b) => a.secondi - b.secondi);
    const i = lista.findIndex((c) => c.mio);
    return i >= 0 && lista[i].secondi === r.secondi ? i + 1 : 0; // solo se in classifica c'è proprio questo tempo
  }
  function datiImmagine(g, r) {
    const t = (L.leggiTempo(g.distanza, r.tempo).tempo || r.tempo).replace(/^0:/, "");
    const quando = new Date(g.data + "T12:00:00").toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
    const pos = CND.posizione ? posizioneNelGruppo(g, r) : 0, sf = (D.sfondi || {})[chiaveCitta(g)];
    return {
      gara: titoloGara(g.nome), sottotitolo: `${L.DIST_LABEL[g.distanza]} · ${quando}`, tempo: t,
      badge: r.pb && r.precedente ? `Nuovo personale · −${fmtDiff(r.precedente.secondi - r.secondi)}` : "",
      posizione: pos ? `${pos}° nel gruppo ${DIST_SU[g.distanza]}` : "", frase: CND.parole ? r.testo || "" : "",
      credito: CND.stile === "citta" && sf ? `Foto: ${sf.autore} · Wikimedia Commons (${sf.licenza})` : "",
    };
  }
  const caricaImg = (src) => new Promise((ok, ko) => { const im = new Image(); im.onload = () => ok(im); im.onerror = ko; im.src = src; });
  async function disegnaAnteprima() {
    const cv = document.getElementById("cnd-canvas"), g = S.gare.find((x) => x.id === CND.id), r = (S.risultati || {})[CND.id];
    if (!cv || !g || !r || !window.RBImmagine) return;
    const ctx = cv.getContext && cv.getContext("2d");
    if (!ctx) return;
    try { if (document.fonts) await Promise.all(['700 100px "Barlow Condensed"', '700 40px "Barlow"', '600 40px "Barlow"', '500 40px "Barlow"'].map((f) => document.fonts.load(f))); } catch (e) { /* caratteri di riserva */ }
    let immagine = null, fuoco = null;
    const sf = (D.sfondi || {})[chiaveCitta(g)];
    if (CND.stile === "citta" && sf) {
      try { immagine = CND.citta[sf.file] || (CND.citta[sf.file] = await caricaImg(sf.file)); fuoco = sf.fuoco; } catch (e) { toast("Foto della città non disponibile"); }
    } else if (CND.stile === "foto" && CND.foto) { immagine = CND.foto; fuoco = [0.5, 0.4]; }
    const [W, H] = window.RBImmagine.FORMATI[CND.formato];
    cv.width = W; cv.height = H;
    window.RBImmagine.disegna(ctx, datiImmagine(g, r), { formato: CND.formato, stile: CND.stile, immagine, fuoco });
  }
  function fileImmagine() {
    const cv = document.getElementById("cnd-canvas"), g = S.gare.find((x) => x.id === CND.id);
    const foto = CND.stile === "citta" || CND.stile === "foto", tipo = foto ? "image/jpeg" : "image/png";
    const nome = `racebuddy-${titoloGara(g.nome).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.${foto ? "jpg" : "png"}`;
    return new Promise((ok, ko) => cv.toBlob((b) => (b ? ok(new File([b], nome, { type: tipo })) : ko(new Error("Immagine non pronta"))), tipo, 0.9));
  }
  const scaricaFile = (f) => { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
  function vistaCondividi(id) {
    const g = S.gare.find((x) => x.id === id), r = (S.risultati || {})[id];
    if (!g) return garaMancante();
    if (!r || !r.tempo) return `<header class="head-back">${back(urlGara(id))}<h1 style="font-size:28px">Condividi</h1></header><p class="sub">Prima segna il tuo tempo.</p><a class="btn" href="#/risultato/${encodeURIComponent(id)}">Com'è andata?</a>`;
    if (CND.id !== id) Object.assign(CND, { id, formato: "storia", stile: "blu", parole: true, posizione: false, foto: null });
    const sf = (D.sfondi || {})[chiaveCitta(g)], pos = posizioneNelGruppo(g, r);
    if (CND.stile === "citta" && !sf) CND.stile = "blu";
    setTimeout(disegnaAnteprima, 0);
    const chip = (k, v, l) => `<button class="chip" data-act="cnd" data-k="${k}" data-v="${v}" aria-pressed="${CND[k] === v}">${l}</button>`;
    const sfondo = (v, l, cls) => `<button class="cnd-sfondo ${cls}" data-act="cnd" data-k="stile" data-v="${v}" aria-pressed="${CND.stile === v}">${l}</button>`;
    const interr = (k, l, sub) => `<label class="check" style="border:0;padding:6px 0"><input type="checkbox" data-act-change="cnd-flag" data-k="${k}" ${CND[k] ? "checked" : ""}><span><span class="t">${l}</span>${sub ? `<br><span class="d">${sub}</span>` : ""}</span></label>`;
    return `${bannerProva()}<header class="head-back">${back(urlGara(id))}<div style="min-width:0"><span class="eyebrow">${esc(titoloGara(g.nome))} · ${esc(L.fmtBreve(g.data))}</span><h1 style="font-size:28px">Condividi il risultato</h1></div></header>
      <div class="cnd-anteprima ${CND.formato}"><canvas id="cnd-canvas" width="1080" height="1920" role="img" aria-label="Anteprima dell'immagine del risultato"></canvas></div>
      <section style="display:flex;flex-direction:column;gap:8px"><h2>Formato</h2><div class="grid2">${chip("formato", "storia", "Storia")}${chip("formato", "quadrato", "Quadrato")}</div></section>
      <section style="display:flex;flex-direction:column;gap:8px"><h2>Sfondo</h2><div class="row" style="flex-wrap:wrap">${sfondo("blu", "Blu", "blu")}${sfondo("arancio", "Arancio", "arancio")}${sfondo("chiaro", "Chiaro", "chiaro")}${sf ? sfondo("citta", esc(nomeLuogo(g.luogo)), "citta") : ""}
        <label class="cnd-sfondo foto ${CND.stile === "foto" ? "on" : ""}">Tua foto<input type="file" accept="image/*" id="cnd-foto" class="sr"></label></div>
        ${sf && CND.stile === "citta" ? `<span class="small muted">${esc(sf.titolo)}: foto di ${esc(sf.autore)}, licenza ${esc(sf.licenza)}.</span>` : ""}
        ${CND.stile === "foto" ? `<span class="small muted">La tua foto resta sul telefono.</span>` : ""}</section>
      <section class="card" style="gap:0">${interr("parole", "Le tue due parole", r.testo ? "" : "Non le hai scritte: aggiungile in Com'è andata?")}${pos ? interr("posizione", `Posizione nel gruppo`, `${pos}° ${DIST_SU[g.distanza]}`) : ""}</section>
      <button class="btn block" data-act="cnd-condividi">Condividi</button>
      <button class="btn ghost block" data-act="cnd-salva">Salva l'immagine</button>
      <p class="sub">L'immagine si crea su questo telefono: non va online niente.</p>`;
  }

  function vistaRisultato(id, param = {}) {
    const g = S.gare.find((x) => x.id === id);
    if (!g) return `<p class="sub">Gara non trovata.</p>`;
    const r = (S.risultati || {})[id] || {}, pb = (S.pb || {})[g.distanza];
    const inGruppo = S.gruppo && S.gruppo.dentro;
    setTimeout(() => stravaRisultato(id), 0);
    if (clOn()) setTimeout(aggiornaClassifiche, 0);
    return `${bannerProva()}<header class="head-back">${back("#/oggi")}<div><span class="eyebrow">${esc(titoloGara(g.nome))} · ${esc(L.fmtGiorno(g.data))}</span><h1 style="font-size:30px">Com'è andata?</h1></div></header>
      <form id="risultato" data-id="${esc(id)}" style="display:flex;flex-direction:column;gap:12px">
      <section class="card" style="align-items:center;text-align:center"><span class="eyebrow" id="ris-tempo-l">Il tuo tempo ufficiale</span>
        ${campoTempo("ris-tempo", g.distanza, param.t || r.tempo, "ris-tempo-l", true)}
        ${param.t && FONTE_TEMPI[param.f] ? `<span class="small" style="color:var(--accent-strong);font-weight:700">Tempo da ${FONTE_TEMPI[param.f]}: controllalo e salva.</span>` : ""}
        <div id="ris-strava" style="width:100%"></div>
        ${r.tempo ? "" : `<div class="trova-tempo" aria-label="Trova il tempo ufficiale"><span class="small muted">Non ce l'hai sotto mano? Cercalo:</span><div class="chips">
          ${C().tempi ? `<a class="chip" href="#/tempi?gara=${encodeURIComponent(id)}">Classifiche</a>` : ""}
          ${S.strava && S.strava.attivo ? `<button type="button" class="chip" data-act="ris-strava-cerca" data-id="${esc(id)}">Strava</button>` : ""}
          <a class="chip" href="https://www.endu.net/it/results" rel="noopener">ENDU ↗</a></div>
          <span class="small muted">Classifiche: Gare Podistiche Lazio e FIDAL. ENDU si apre nel browser: torni qui con Fine o indietro.</span></div>`}
        <span class="small muted" id="ris-pb">${pb ? `Il tuo personale: ${esc(L.leggiTempo(g.distanza, pb.tempo).tempo || pb.tempo)}` : "Solo numeri: si passa da solo alla casella dopo"}</span></section>
      <div class="field"><label for="ris-testo">Due parole <span class="muted">(facoltativo)</span></label><textarea class="input" id="ris-testo" maxlength="280" placeholder="es. Crisi al 16, poi il traguardo mi ha tirato su.">${esc(r.testo || "")}</textarea></div>
      ${bilancio(r.debrief || {})}
      ${inGruppo && GD() && GD().io && GD().io.mostra_pb !== false ? `<p class="sub">Se è un nuovo personale, si aggiorna anche nella classifica del gruppo.</p>` : ""}
      <button class="btn block" type="submit">Salva</button>
      ${r.tempo ? `<a class="btn ghost block" href="#/condividi/${encodeURIComponent(id)}">Crea l'immagine da condividere</a>` : ""}
      </form>
      ${cardRisultatoCl(g, r)}
      <section class="card" aria-label="Non l'hai finita"><span class="title" style="font-size:16px">Non hai un tempo?</span>
        <div class="chips" role="group" aria-label="Esito della gara">${Object.entries(ESITO).map(([k, l]) => `<button class="chip" data-act="esito" data-id="${esc(id)}" data-v="${k}" aria-pressed="${g.esito === k && !r.tempo}">${l}</button>`).join("")}</div>
        <span class="small muted">La gara va in archivio dal giorno dopo, come con il tempo.</span></section>`;
  }
  // Bilancio della gara (facoltativo): tre risposte e una nota, solo sul telefono. Torna nella borsa della gara dopo.
  function bilancio(d) {
    const riga = (k, dom, ops) => `<fieldset class="scelta-riga"><legend class="small" style="font-weight:700">${dom}</legend><div class="scelta">${ops.map(([v, l]) => `<input type="radio" name="deb-${k}" id="deb-${k}-${v}" value="${v}" ${d[k] === v ? "checked" : ""}><label for="deb-${k}-${v}">${l}</label>`).join("")}</div></fieldset>`;
    return `<details class="card" ${d.rifornimento || d.nota ? "open" : ""}><summary>Bilancio per la prossima gara <span class="muted small" style="font-weight:500">&nbsp;· facoltativo</span></summary>
      ${riga("rifornimento", "Il rifornimento ha funzionato?", [["ok", "Sì"], ["rivedere", "Da rivedere"]])}
      ${riga("scarpe", "Le scarpe sono andate bene?", [["ok", "Sì"], ["rivedere", "Da rivedere"]])}
      ${riga("fastidi", "Hai avuto fastidi?", [["no", "No"], ["si", "Sì"]])}
      <div class="field"><label for="deb-nota">Una cosa da ricordare alla prossima</label><input class="input" id="deb-nota" maxlength="140" value="${esc(d.nota || "")}" placeholder="es. Gel al 15 e al 30, non prima"></div>
      <span class="small muted">Resta sul telefono. Te lo ripropongo nella borsa della prossima gara.</span></details>`;
  }

  // ---------------------------------------------------------------- statistiche d'uso
  // Aperture anonime: un +1 al giorno, alla settimana e alla prima apertura. Il telefono ricorda da sé cosa ha già
  // contato: online arriva solo il +1, senza nessun identificativo.
  function contaApertura() {
    const oggiV = L.todayISO(), lun = L.addDays(oggiV, -((new Date(oggiV + "T12:00:00").getDay() + 6) % 7));
    const c = { ...(S.conta || {}) };
    if (!S.conta && (S.gare.length || S.benvenuto)) c.nuovo = true; // chi usava già l'app prima del contatore non è "nuovo"
    const tipi = [c.giorno !== oggiV && "giorno", c.settimana !== lun && "settimana", !c.nuovo && "nuovo"].filter(Boolean);
    if (!tipi.length) return;
    rpc("conta_apertura", { p_tipi: tipi }).then(() => { S.conta = { giorno: oggiV, settimana: lun, nuovo: true }; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* niente */ } }).catch(() => { /* riprova alla prossima apertura */ });
  }

  // Pagina riservata (Io → Strumenti di prova → Statistiche): solo totali, con parola d'ordine.
  const STAT_KEY = "racebuddy.statistiche";
  let STAT = null, statPeriodo = 30, statProvata = false;
  const parolaStat = () => { try { return sessionStorage.getItem(STAT_KEY) || localStorage.getItem(STAT_KEY) || ""; } catch (e) { return ""; } };
  const dimenticaStat = () => { STAT = null; statProvata = false; try { sessionStorage.removeItem(STAT_KEY); localStorage.removeItem(STAT_KEY); } catch (e) { /* niente */ } };
  async function caricaStatistiche(parola, ricorda) {
    STAT = await rpc("statistiche", { p_parola: parola });
    STAT.letto = new Date();
    try { sessionStorage.setItem(STAT_KEY, parola); if (ricorda) localStorage.setItem(STAT_KEY, parola); } catch (e) { /* niente */ }
  }
  const TEMA_BUDDY = { scarpe: "Scarpe", integratori: "Integratori", allenamento: "Allenamento", fuori_tema: "Fuori tema", altro: "Altro" };
  const INVIO_LABEL = { mattino: "Mattino", meteo: "Meteo", novita: "Novità gara", vigilia: "Vigilia", gara: "Mattina di gara", fase: "Per la fase", altro: "Altro" };
  const INTERR_LABEL = { percorso: "Tappe", gara: "La tua gara", meteo: "Meteo", novita: "Novità gara", documenti: "Scadenze", fase: "Per la fase" };
  const barreOrizz = (righe, valore) => `<div class="hbar">${righe.map(([l, n, max]) => `<span>${esc(l)}</span><div class="hbar-t"><div style="width:${max ? Math.max(2, Math.round((n / max) * 100)) : 0}%"></div></div><b>${esc(valore(n))}</b>`).join("")}</div>`;
  function vistaStatistiche() {
    const testa = `<header class="head-back">${back("#/io")}<div style="min-width:0"><span class="eyebrow">RaceBuddy · solo per te</span><h1 style="font-size:32px">Statistiche</h1></div></header>`;
    if (!STAT) {
      const p = parolaStat();
      if (p && !statProvata) {
        statProvata = true;
        caricaStatistiche(p).then(rerender).catch(() => { dimenticaStat(); statProvata = true; rerender(); });
        return `${testa}<p class="sub">Carico le statistiche…</p>`;
      }
      return `${testa}<p class="sub">Pagina riservata. Scrivi la parola d'ordine che hai impostato in Supabase.</p>
        <form id="stat-accesso" class="card"><div class="field"><label for="stat-pw">Parola d'ordine</label><input class="input" id="stat-pw" type="password" autocomplete="current-password" required></div>
        <label class="check" style="border:0;padding:4px 0"><input type="checkbox" id="stat-ricorda"><span><span class="t">Ricordala su questo telefono</span></span></label>
        <button class="btn block" type="submit">Entra</button></form>
        <p class="sub">Nel database c'è solo l'impronta della parola d'ordine.</p>`;
    }
    const d = STAT, att = d.attivi || {}, oggiS = d.oggi;
    const giorni = Array.from({ length: statPeriodo }, (_, i) => L.addDays(oggiS, i - statPeriodo + 1));
    const valori = giorni.map((g) => att[g] || 0), max = Math.max(1, ...valori);
    const primo = Object.keys(att).sort()[0] || oggiS, conDati = valori.filter((_, i) => giorni[i] >= primo); // si conta dal primo giorno del contatore
    const media = conDati.length ? Math.round(conDati.reduce((a, b) => a + b, 0) / conDati.length) : 0;
    const chip = (n) => `<button class="chip" data-act="stat-periodo" data-n="${n}" aria-pressed="${statPeriodo === n}" style="height:30px;font-size:13px">${n} g</button>`;
    const invii = Object.entries(d.invii7 || {}).filter(([k]) => k !== "scadute").sort((a, b) => b[1] - a[1]);
    const maxInv = Math.max(0, ...invii.map(([, n]) => n)), totInv = invii.reduce((a, [, n]) => a + n, 0);
    const interr = Object.entries(INTERR_LABEL).map(([k, l]) => [l, (d.interruttori || {})[k] || 0, d.iscritti]).sort((a, b) => b[1] - a[1]);
    const kpi = (t, n, sotto, scuro) => `<div class="stat-kpi ${scuro ? "dark" : ""}"><span class="eyebrow">${t}</span><b>${esc(n)}</b><span class="small">${sotto}</span></div>`;
    const gr = d.gruppo || {};
    return `${testa}<div class="between"><span class="small muted">Aggiornate alle ${esc(d.letto.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }))}</span><div class="row"><button class="btn ghost small" data-act="stat-aggiorna">Aggiorna</button><button class="btn ghost small" data-act="stat-esci">Esci</button></div></div>
      <div class="grid2">${kpi("Attivi oggi", att[oggiS] || 0, `ieri ${att[L.addDays(oggiS, -1)] || 0}`, true)}${kpi("Questa settimana", d.settimana, `telefoni diversi · scorsa ${d.settimana_prima}`)}${kpi("Nuovi in 7 giorni", d.nuovi7, "prima apertura")}${kpi("Con notifiche", d.iscritti, "iscrizioni attive")}</div>
      <section class="card"><div class="between"><h2>Attivi al giorno</h2><div class="row" style="gap:4px">${chip(7)}${chip(30)}${chip(90)}</div></div>
        <div class="stat-chart" role="img" aria-label="Attivi al giorno negli ultimi ${statPeriodo} giorni: massimo ${max}, oggi ${att[oggiS] || 0}">
          <span class="stat-max">${max}</span>
          ${giorni.map((g, i) => `<button class="stat-barra ${g === oggiS ? "oggi" : ""}" data-act="stat-giorno" data-t="${esc(L.fmtGiorno(g))}: ${valori[i]} attivi" title="${esc(L.fmtGiorno(g))}: ${valori[i]} attivi" aria-label="${esc(L.fmtGiorno(g))}: ${valori[i]} attivi"><span style="height:${Math.round((valori[i] / max) * 100)}%"></span></button>`).join("")}</div>
        <div class="between small muted"><span>${esc(L.fmtBreve(giorni[0]))}</span><span>oggi</span></div>
        <span class="small" id="stat-sel">Media ${media} al giorno · tocca una barra per il numero esatto</span>
        <details><summary class="small">Vedi come tabella</summary><div class="stat-tab">${giorni.slice().reverse().map((g) => `<span>${esc(L.fmtGiorno(g))}</span><b>${att[g] || 0}</b>`).join("")}</div></details></section>
      <section class="card"><div class="between"><h2>Notifiche inviate · 7 giorni</h2><b style="font:700 22px var(--display)">${totInv}</b></div>
        ${invii.length ? barreOrizz(invii.map(([k, n]) => [INVIO_LABEL[k] || k, n, maxInv]), (n) => n) : `<span class="small">Nessuna notifica negli ultimi 7 giorni.</span>`}
        ${(d.invii7 || {}).scadute ? `<span class="small muted">${d.invii7.scadute} iscrizioni scadute rimosse (telefono cambiato o notifiche tolte).</span>` : ""}</section>
      <section class="card"><h2>Interruttori accesi · su ${esc(d.iscritti)}</h2>${d.iscritti ? barreOrizz(interr, (n) => `${Math.round((n / d.iscritti) * 100)}%`) : `<span class="small">Nessuno ha ancora attivato le notifiche.</span>`}</section>
      <section class="card" style="gap:0"><div class="between" style="margin-bottom:4px"><h2>Gare più seguite</h2><span class="small muted">${esc(d.gare_totali)} gare in tutto</span></div>
        ${(d.gare || []).map((g) => `<div class="post"><span style="flex:1;min-width:0"><b>${esc(titoloGara(g.nome))}</b><br><span class="small muted">${esc(L.fmtGiorno(g.data))} · ${esc(L.DIST_LABEL[g.distanza] || "")}</span></span><b style="font:700 20px var(--display)">${esc(g.n)}</b></div>`).join("") || `<span class="small">Nessuna gara seguita.</span>`}
        <span class="small muted" style="padding-top:6px">Numero di telefoni che seguono la gara.</span></section>
      <section class="card"><h2>Gruppo</h2><div class="grid2 stat-num">
        <div><b>${esc(gr.membri)}</b><span class="small muted">membri</span></div><div><b>${esc(gr.attivi7)}</b><span class="small muted">attivi in 7 giorni</span></div>
        <div><b>${esc(gr.risultati30)}</b><span class="small muted">risultati in bacheca · 30 g</span></div><div><b>${esc(gr.personali)}</b><span class="small muted">personali in classifica</span></div></div></section>
      ${d.buddy ? (() => {
        const bu = d.buddy, temi = Object.entries(bu.temi30 || {}).sort((a, b) => b[1] - a[1]), maxT = Math.max(0, ...temi.map(([, n]) => n)), tot = temi.reduce((a, [, n]) => a + n, 0);
        return `<section class="card"><div class="between"><h2>Buddy · temi in 30 giorni</h2><b style="font:700 22px var(--display)">${tot}</b></div>
          ${temi.length ? barreOrizz(temi.map(([k, n]) => [TEMA_BUDDY[k] || k, n, maxT]), (n) => `${Math.round((n / tot) * 100)}%`) : `<span class="small">Ancora nessuna domanda al buddy.</span>`}
          <span class="small muted">Oggi ${esc(bu.oggi)} domande (${esc(Math.round((bu.token_oggi || 0) / 1000))}k token su ~200k gratuiti) · 7 giorni ${esc(bu.domande7)}. Il testo delle domande non si salva: solo il tema.</span></section>`;
      })() : ""}
      <p class="sub">Solo totali: nessun nome, nessuna gara dei singoli. Le aperture si contano senza riconoscere il telefono, dal ${esc(L.fmtBreve(Object.keys(att).sort()[0] || oggiS))}.</p>`;
  }

  // ---------------------------------------------------------------- personali
  // Tempo in tre caselle (ore · min · sec) con la tastiera numerica: niente due punti da scrivere.
  function campoTempo(id, distanza, valore, etichetta, grande) {
    const t = valore ? L.leggiTempo(distanza, valore).tempo : "";
    const [h, m, s] = t ? t.split(":") : ["", "", ""];
    const ph = { "10": ["0", "47", "30"], "21": ["1", "45", "00"], "42": ["3", "45", "00"] }[distanza];
    const box = (k, v, max, p, nome) => `<input class="input" id="${id}-${k}" inputmode="numeric" pattern="[0-9]*" maxlength="${max}" autocomplete="off" placeholder="${p}" value="${esc(v)}" aria-label="${nome}">`;
    return `<div class="tempo3${grande ? " grande" : ""}" role="group" aria-labelledby="${etichetta}">${box("h", h, 1, ph[0], "Ore")}<span>h</span>${box("m", m, 2, ph[1], "Minuti")}<span>min</span>${box("s", s, 2, ph[2], "Secondi")}<span>s</span></div>`;
  }
  // Tempo facoltativo: caselle tutte vuote = nessun tempo; altrimenti come leggiCampoTempo.
  function leggiTempoFacoltativo(id, distanza) {
    const vuote = ["h", "m", "s"].every((k) => !((document.getElementById(`${id}-${k}`) || {}).value || "").trim());
    return vuote ? { tempo: "" } : leggiCampoTempo(id, distanza);
  }
  function leggiCampoTempo(id, distanza) {
    const t = L.tempoDaParti(...["h", "m", "s"].map((k) => (document.getElementById(`${id}-${k}`) || {}).value || ""));
    return t ? L.leggiTempo(distanza, t) : { errore: "Scrivi il tempo: ore, minuti e secondi" };
  }
  function sezionePB() {
    const pb = S.pb || {}, inG = S.gruppo && S.gruppo.dentro && GD();
    const riga = (d) => {
      const x = pb[d];
      return `<form class="pb-riga" data-form="pb" data-d="${d}">
        <div class="between"><span class="title">${esc(L.DIST_LABEL[d])}${x && FONTE_TEMPI[x.fonte] ? ` <span class="small muted" style="font-weight:700">· da ${FONTE_TEMPI[x.fonte]}</span>` : ""}</span>${x ? `<b class="pb-tempo">${esc(L.leggiTempo(d, x.tempo).tempo || x.tempo)}</b>` : `<span class="small muted">da inserire</span>`}</div>
        ${x && (x.gara || x.data) ? `<span class="small muted">${esc([titoloGara(x.gara), x.data && L.fmtBreve(x.data)].filter(Boolean).join(" · "))}</span>` : ""}
        <details><summary class="small">${x ? "Modifica" : "Inserisci il personale"}</summary><div style="display:flex;flex-direction:column;gap:10px;padding-top:10px">
          <div class="field"><span class="lbl" id="pb-t-${d}-l">Tempo ufficiale</span>${campoTempo(`pb-t-${d}`, d, x && x.tempo, `pb-t-${d}-l`)}</div>
          <div class="grid2"><div class="field"><label for="pb-g-${d}">Gara <span class="muted">(facoltativo)</span></label><input class="input" id="pb-g-${d}" maxlength="120" value="${esc(x ? x.gara || "" : "")}" placeholder="es. Roma-Ostia"></div>
          <div class="field"><label for="pb-d-${d}">Quando</label><input class="input" id="pb-d-${d}" type="date" max="${L.todayISO()}" value="${esc(x ? x.data || "" : "")}"></div></div>
          <div class="row"><button class="btn" type="submit">Salva</button>${x ? `<button class="btn ghost" type="button" data-act="pb-togli" data-d="${d}">Togli</button>` : ""}</div></div></details></form>`;
    };
    return `${DISTANZE.map(riga).join("")}
      ${inG ? `<label class="check" style="border:0;padding:4px 0"><input type="checkbox" id="io-mostra-pb" ${GD().io.mostra_pb !== false ? "checked" : ""}><span><span class="t">Metti i miei personali nella classifica del gruppo</span><br><span class="d">Al gruppo vanno solo tempo, gara e data.</span></span></label><a class="small" href="#/gruppo/classifica">Classifica del gruppo ›</a>` : ""}
      ${C().tempi ? `<a class="btn ghost" href="#/tempi">Cerca i miei tempi nelle classifiche</a>` : ""}
      ${S.strava && S.strava.attivo ? `<a class="btn ghost" href="#/pb?strava=1">Cerca i miei personali su Strava</a>` : ""}
      <span class="small muted">Restano su questo telefono. Dopo ogni gara, se fai meglio, il personale si aggiorna da solo.</span>`;
  }
  const riassuntoPB = () => DISTANZE.filter((d) => (S.pb || {})[d]).map((d) => `${L.DIST_LABEL[d]} ${L.leggiTempo(d, S.pb[d].tempo).tempo || S.pb[d].tempo}`).join(" · ");
  function vistaPB(param = {}) {
    if (param.strava && !STRAVA_PB && S.strava && S.strava.attivo) caricaPBStrava();
    return `${bannerProva()}<header class="head-back">${back("#/io")}<div><span class="eyebrow">Io</span><h1 style="font-size:28px">I tuoi personali</h1></div></header>
      ${param.strava ? sezioneStravaPB() : ""}
      <p class="sub">Il tuo miglior tempo su 10 km, mezza e maratona, anche di gare corse prima di RaceBuddy.</p>
      <section class="card" style="gap:14px">${sezionePB()}</section>`;
  }
  const cardInvitoPB = () => (DISTANZE.some((d) => (S.pb || {})[d]) || (S.letti || {})["pb-invito"] ? ""
    : `<section class="card soft"><span class="title">Hai già dei personali?</span><span class="small">Inseriscili una volta: dopo ogni gara ti dico se hai fatto meglio${S.gruppo && S.gruppo.dentro ? " e, se vuoi, entrano nella classifica del gruppo" : ""}.</span>
      <div class="grid2"><a class="btn" href="#/pb">Inseriscili</a><button class="btn ghost" data-act="letto" data-k="pb-invito">Non ora</button></div></section>`);

  // ---------------------------------------------------------------- account e Strava (in Io)
  const ACC = { email: "", inviato: false };
  async function dopoLogin() {
    try {
      const r = await rpcAccount("collega_account", { p_token: token(), p_endpoint: await endpointPush() });
      if (r && r.stato === "ritrovato") { G().dentro = true; salva(); await aggiornaGruppo(true); toast(`Bentornato: sei di nuovo in «${r.gruppo}»`); }
      else if (r && r.stato === "conflitto") toast("Su questo telefono sei già nel gruppo con un altro profilo: esci dal gruppo qui e rientra dopo il login");
      else toast("Sei entrato");
    } catch (e) { toast("Sei entrato, ma il gruppo non risponde: riprovo alla prossima apertura"); }
  }
  function sezioneAccount() {
    if (AUTH) return `<span class="small">Sei entrato come <b>${esc(AUTH.email)}</b>.</span><span class="small muted">Gruppo e notifiche sono legati all'account: li ritrovi su un altro telefono dopo il login.</span>
      <div id="acc-box" class="grid2"><button class="btn ghost" data-act="acc-esci">Esci</button><button class="btn ghost" data-act="acc-cancella" style="color:#B91C1C">Cancella account</button></div>`;
    if (ACC.inviato) return `<form id="acc-codice" style="display:flex;flex-direction:column;gap:10px"><span class="small">Ti abbiamo scritto a <b>${esc(ACC.email)}</b>. Inserisci il codice di 6 cifre.</span>
      <label class="sr" for="acc-cod">Codice di 6 cifre</label><input class="input codice-otp" id="acc-cod" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
      <button class="btn" type="submit">Entra</button>
      <div class="between"><button type="button" class="linkbtn small" data-act="acc-rimanda">Non è arrivato? Rimandalo</button><button type="button" class="linkbtn small" data-act="acc-cambia">Cambia email</button></div>
      <span class="small muted">Il codice vale qualche minuto.</span></form>`;
    return `<span class="small">Facoltativo. Con l'account ritrovi gruppo, personali in classifica e notifiche anche su un altro telefono, e puoi collegare Strava. Profilo, preparazione e documenti restano su questo telefono.</span>
      <form id="acc-email" style="display:flex;flex-direction:column;gap:10px"><div class="field"><label for="acc-mail">La tua email</label><input class="input" id="acc-mail" type="email" autocomplete="email" required value="${esc(ACC.email)}"></div>
      <button class="btn" type="submit">Mandami il codice</button></form><span class="small muted">Online va solo l'email. Puoi uscire o cancellare l'account quando vuoi.</span>`;
  }

  let STRAVA_STATO = null, STRAVA_PB = null, stravaInCarico = false;
  const STRAVA_GIORNO = {};
  async function caricaStatoStrava() {
    if (!C().strava || stravaInCarico) return;
    stravaInCarico = true;
    try {
      STRAVA_STATO = await rpc("strava_stato", { p_token: token() });
      if (STRAVA_STATO.collegato && !(S.strava && S.strava.attivo)) { S.strava = { attivo: true, dal: oggi() }; salva(); aggiornaScarpeStrava(true); }
      if (!STRAVA_STATO.collegato && S.strava && S.strava.attivo) scollegaLocale();
    } catch (e) { STRAVA_STATO = { errore: true }; }
    stravaInCarico = false;
    if (/^#\/io/.test(location.hash)) rerender();
  }
  // Scarpe da Strava: una sola fonte alla volta, ma solo se su Strava c'è almeno una scarpa attiva: allora le manuali vanno
  // in Archivio. Se su Strava non ce ne sono (o non più), restano o tornano quelle inserite a mano.
  async function aggiornaScarpeStrava(forza) {
    if (!S.strava || !S.strava.attivo) return;
    if (!forza && S.strava.letto && Date.now() - S.strava.letto < 3600e3) return;
    try {
      const { scarpe } = await funzioneStrava({ azione: "scarpe" });
      const attive = (scarpe || []).filter((x) => !x.ritirata);
      if (!attive.length) {
        S.scarpe = S.scarpe.filter((x) => !x.strava);
        if (S.strava.archiviato) { S.scarpe = [...S.scarpe, ...(S.scarpeArchivio || [])]; S.scarpeArchivio = []; S.strava.archiviato = false; }
      } else {
        if (!S.strava.archiviato) { S.scarpeArchivio = [...(S.scarpeArchivio || []), ...S.scarpe.filter((x) => !x.strava)]; S.scarpe = S.scarpe.filter((x) => x.strava); S.strava.archiviato = true; }
        const prima = Object.fromEntries(S.scarpe.filter((x) => x.strava).map((x) => [x.stravaId, x]));
        S.scarpe = attive.map((x) => ({ tipo: "allenamento", limite: 800, ...(prima[x.id] || {}), id: "st-" + x.id, stravaId: x.id, nome: x.nome, km: x.km, strava: true }));
        S.scarpe.forEach(annotaKm);
      }
      S.strava.letto = Date.now(); salva();
      if (/^#\/io/.test(location.hash)) rerender();
    } catch (e) { /* riprova alla prossima apertura */ }
  }
  // Scollegato (o account cancellato): scarpe e personali importati restano e diventano manuali.
  // Una foto dei km di oggi per scarpa (una al giorno, ultimi 60 giorni): serve a stimare quanti km fa a settimana.
  function annotaKm(sc) {
    const o = L.todayISO(), st = (sc.storia || []).filter((x) => x.d !== o && L.diffDays(o, x.d) <= 60);
    sc.storia = [...st, { d: o, km: Math.round(Number(sc.km) || 0) }];
  }
  function scollegaLocale() {
    S.scarpe.forEach((x, i) => { if (x.strava) { x.strava = false; delete x.stravaId; x.id = "S" + Date.now().toString(36) + i; } });
    for (const d of DISTANZE) if (S.pb && S.pb[d] && S.pb[d].fonte === "strava") delete S.pb[d].fonte;
    S.strava = null; STRAVA_PB = null; salva();
  }
  function sezioneStrava() {
    if (!STRAVA_STATO) { setTimeout(caricaStatoStrava, 0); return `<span class="small muted">Controllo Strava…</span>`; }
    if (STRAVA_STATO.errore) return `<span class="small">Strava non è raggiungibile al momento.</span><button class="btn ghost small" data-act="strava-ricarica" style="align-self:flex-start">Riprova</button>`;
    const liberi = Math.max(0, STRAVA_STATO.massimo - STRAVA_STATO.posti);
    if (STRAVA_STATO.collegato) return `<span class="small">Collegato. ${S.strava && S.strava.archiviato ? "Le scarpe e i loro km arrivano da Strava" : "Su Strava non hai scarpe attive: tieni quelle inserite qui"}; dopo ogni gara ti proponiamo il tempo. I dati di Strava li vedi solo tu.</span>
      <a class="riga-novita" href="#/pb?strava=1"><span style="flex:1">Cerca i miei personali su Strava</span><span aria-hidden="true">›</span></a>
      ${S.strava && S.strava.letto ? `<span class="small muted">Scarpe aggiornate alle ${esc(new Date(S.strava.letto).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }))}</span>` : ""}
      <div id="strava-box"><button class="btn ghost" data-act="strava-scollega">Scollega Strava</button></div>
      <span class="small muted">Se scolleghi, scarpe e personali importati restano e diventano manuali.</span>`;
    if (!liberi) return `<span class="small">L'integrazione con Strava è in prova con un gruppo di ${STRAVA_STATO.massimo} tester e i posti sono esauriti. Arriverà per tutti: intanto scarpe e personali si inseriscono a mano.</span><button class="btn ghost" disabled>Collega Strava</button>
      <button class="linkbtn small" data-act="strava-collega" data-gia="1" style="align-self:flex-start">Sei già tester e hai cambiato telefono? Ricollegati</button>`;
    return `<span class="small">Le scarpe e i loro km arrivano da Strava, e dopo ogni gara ti proponiamo il tempo. È in prova con un gruppo di tester: ${liberi} ${liberi === 1 ? "posto libero" : "posti liberi"}.</span>
      ${S.scarpe.some((x) => !x.strava) ? `<span class="small muted">Se su Strava hai delle scarpe, quelle inserite a mano andranno in Archivio: non contano più finché Strava è collegato. Se non ne hai, restano queste.</span>` : ""}
      <button class="btn" data-act="strava-collega">Collega Strava</button>`;
  }
  function ritornoStrava(esito) {
    S.ioAperto = { ...(S.ioAperto || {}), strava: true };
    const MSG = { ok: "Strava collegato: arrivano scarpe e km", pieno: "I posti per i tester di Strava sono esauriti", negato: "Collegamento a Strava annullato",
      permessi: "Servono i permessi su profilo e attività: riprova lasciandoli spuntati", scaduto: "Collegamento scaduto: riprova", errore: "Collegamento a Strava non riuscito: riprova" };
    toast(MSG[esito] || MSG.errore);
    if (esito === "ok") { S.strava = { attivo: true, dal: oggi() }; salva(); aggiornaScarpeStrava(true); }
    STRAVA_STATO = null;
  }
  // Personali da Strava: le corse sulle distanze di gara (segnate come gara o no), la migliore per distanza, da confermare una per una.
  // A pagine da 200 attività: l'avanzamento (attività lette, fino a quando, corse trovate) si aggiorna nel riquadro.
  async function caricaPBStrava() {
    const gare = [];
    STRAVA_PB = { carico: true, lette: 0, trovate: 0, finoA: "" };
    try {
      for (let p = 1; p <= 10; p++) {
        const r = await funzioneStrava({ azione: "gare", pagina: p });
        gare.push(...(r.gare || []));
        STRAVA_PB = { carico: true, lette: STRAVA_PB.lette + (r.lette || 0), trovate: gare.length, finoA: r.finoA || STRAVA_PB.finoA };
        aggiornaAvanzamentoPB();
        if (r.fine || r.lette == null) break;
      }
      STRAVA_PB = { ...L.candidatiPersonali(gare), totale: gare.length, lette: STRAVA_PB.lette };
    } catch (e) { STRAVA_PB = { errore: e.message }; }
    if (/^#\/pb/.test(location.hash)) rerender();
  }
  const meseAnno = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("it-IT", { month: "long", year: "numeric" }) : "");
  function avanzamentoPB() {
    const a = STRAVA_PB || {};
    return a.lette
      ? `Lette <b>${a.lette}</b> attività${a.finoA ? `, fino a ${esc(meseAnno(a.finoA))}` : ""}.<br>Trovate <b>${a.trovate}</b> corse sulle distanze di gara (10 km, mezza, maratona).`
      : "Mi collego a Strava…";
  }
  function aggiornaAvanzamentoPB() { const el = document.getElementById("strava-pb-avanz"); if (el) el.innerHTML = avanzamentoPB(); }
  function sezioneStravaPB() {
    if (!STRAVA_PB) return "";
    if (STRAVA_PB.carico) return `<section class="card" aria-live="polite" aria-busy="true"><div class="row" style="gap:10px"><span class="spinner" aria-hidden="true"></span><span class="title">Cerco i tuoi personali su Strava</span></div>
      <span class="small" id="strava-pb-avanz">${avanzamentoPB()}</span><div class="meter attesa" aria-hidden="true"><div></div></div>
      <span class="small muted">Leggo tutte le tue attività, dalla più recente: con qualche anno di corse ci vuole fino a mezzo minuto. Poi scelgo la migliore per distanza e te la faccio confermare.</span></section>`;
    if (STRAVA_PB.errore) return `<section class="card"><span class="small">${esc(STRAVA_PB.errore)}</span><button class="btn ghost small" data-act="strava-pb" style="align-self:flex-start">Riprova</button></section>`;
    const voce = (d) => {
      const lista = STRAVA_PB[d] || [], c = lista[0], att = (S.pb || {})[d];
      if (!c) return `<section class="card"><div class="between"><span class="title">${esc(L.DIST_LABEL[d])}</span><span class="small muted">nessuna su Strava</span></div><span class="small muted">Nessuna corsa di questa distanza su Strava. Puoi inserirla a mano.</span></section>`;
      const meglio = !att || c.secondi < att.secondi, km = (c.metri / 1000).toFixed(1).replace(".", ",");
      const altre = lista.slice(1, 8);
      return `<section class="card ${meglio ? "strava-meglio" : ""}"><div class="between"><span class="title">${esc(L.DIST_LABEL[d])}</span><span class="small muted">${att ? `oggi nell'app: ${esc(L.leggiTempo(d, att.tempo).tempo || att.tempo)}` : "non ancora inserito"}</span></div>
        <div class="between"><span style="min-width:0"><b>${esc(c.nome)}</b><br><span class="small muted">${esc(L.fmtBreve(c.data))} · ${km} km sul GPS${c.gara ? "" : " · non segnata come gara"}</span></span><b class="pb-tempo">${esc(c.tempo)}</b></div>
        ${meglio ? `${att ? `<span class="small" style="color:var(--accent-strong);font-weight:700">Migliore di quello che hai: −${esc(fmtDiff(att.secondi - c.secondi))}</span>` : ""}
          <div class="grid2"><button class="btn" data-act="strava-pb-salva" data-d="${d}" data-id="${esc(c.id)}">Salva come personale</button><button class="btn ghost" data-act="strava-pb-correggi" data-d="${d}" data-id="${esc(c.id)}">Correggi il tempo</button></div>`
          : `<span class="small muted">${c.secondi === att.secondi ? "È già il tuo personale." : `Più lento di quello che hai: resta ${esc(L.leggiTempo(d, att.tempo).tempo || att.tempo)}.`}</span>`}
        ${altre.length ? `<details><summary class="small">Altre ${altre.length} trovate</summary>${altre.map((x) => `<div class="between small" style="padding:6px 0"><span>${esc(x.nome)} · ${esc(L.fmtBreve(x.data))}</span><span class="row"><b>${esc(x.tempo)}</b><button class="linkbtn" data-act="strava-pb-salva" data-d="${d}" data-id="${esc(x.id)}">Usa questa</button></span></div>`).join("")}</details>` : ""}</section>`;
    };
    return `<p class="sub">Ho letto ${STRAVA_PB.lette || "le tue"} attività su Strava e trovato ${STRAVA_PB.totale} corse sulle distanze di gara, segnate come gara o no. Conferma il tempo ufficiale (quello del chip), che può differire da quello del GPS.</p>${DISTANZE.map(voce).join("")}
      <p class="sub">I tempi da Strava restano sul telefono. Entrano nella classifica del gruppo solo quelli che salvi, e solo se hai scelto di comparire.</p>`;
  }
  // ---------------------------------------------------------------- tempi dalle classifiche
  // Una sola ricerca su due fonti (Gare Podistiche Lazio e FIDAL) con la funzione "tempi", che non salva niente.
  // Si apre da I tuoi personali (#/tempi) e da "Com'è andata?" (#/tempi?gara=id). Chi sei tra gli omonimi lo sceglie
  // l'utente; nome, cognome e scelta restano sul telefono (S.tempi) per la volta dopo.
  let TEMPI = null; // { chiave, carico, errore, persone, fonti, scelti }
  const FONTE_TEMPI = { gpl: "Gare Podistiche Lazio", fidal: "FIDAL", strava: "Strava" };
  function nomeTempi() {
    const t = S.tempi || {};
    if (t.nome || t.cognome) return { nome: t.nome || "", cognome: t.cognome || "" };
    const p = String(S.profilo.nome || "").trim().split(/\s+/);
    return { nome: p[0] || "", cognome: p.slice(1).join(" ") };
  }
  async function cercaTempi(nome, cognome, anno) {
    const chiave = `${nome}|${cognome}|${anno || ""}`, tess = (S.documenti || {}).tessera || {};
    TEMPI = { chiave, carico: true }; rerender();
    try {
      const r = await fetch(`${C().supabaseUrl}/functions/v1/tempi`, { method: "POST", headers: { apikey: C().supabaseKey, "Content-Type": "application/json" },
        body: JSON.stringify({ nome, cognome, ...(anno ? { anno } : {}), ...(tess.codiceSocieta ? { codice: tess.codiceSocieta } : {}) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.errore || "");
      const persone = j.persone || [], noti = ((S.tempi || {}).scelti || []).filter((id) => persone.some((x) => x.id === id));
      TEMPI = { chiave, persone, fonti: j.fonti || {}, scelti: noti.length ? noti : L.personeProposte(persone, tess), ricordati: noti.length > 0 };
    } catch (e) { TEMPI = { chiave, errore: "Le classifiche non rispondono adesso: riprova tra poco." }; }
    if (/^#\/(tempi|gruppo\/recupero|entra)/.test(location.hash)) rerender();
  }
  function vistaTempi(param = {}) {
    const g = param.gara ? S.gare.find((x) => x.id === param.gara) : null;
    const { nome, cognome } = nomeTempi(), anno = g ? Number(g.data.slice(0, 4)) : null;
    // con il nome già noto, la ricerca parte da sola
    if (nome && cognome && (S.tempi || {}).nome && (!TEMPI || TEMPI.chiave !== `${nome}|${cognome}|${anno || ""}`)) setTimeout(() => cercaTempi(nome, cognome, anno), 0);
    let corpo = "";
    if (TEMPI && TEMPI.carico) corpo = `<section class="card" aria-live="polite" aria-busy="true"><div class="row" style="gap:10px"><span class="spinner" aria-hidden="true"></span><span class="title">Cerco nelle classifiche</span></div><span class="small muted">Gare Podistiche Lazio${g ? ` (${anno})` : " dal 2019"} e FIDAL: qualche secondo.</span><div class="meter attesa" aria-hidden="true"><div></div></div></section>`;
    else if (TEMPI && TEMPI.errore) corpo = `<section class="card"><span class="small">${esc(TEMPI.errore)}</span></section>`;
    else if (TEMPI && TEMPI.persone) corpo = risultatiTempi(g);
    return `${bannerProva()}<header class="head-back">${back(g ? `#/risultato/${encodeURIComponent(g.id)}` : "#/pb")}<div><span class="eyebrow">${g ? esc(titoloGara(g.nome)) + " · " + esc(L.fmtGiorno(g.data)) : "I tuoi personali"}</span><h1 style="font-size:28px">Trova i tuoi tempi</h1></div></header>
      <form id="tempi-cerca" data-anno="${anno || ""}" class="card" style="gap:10px">
        <div class="grid2"><div class="field"><label for="tc-nome">Nome</label><input class="input" id="tc-nome" required maxlength="40" autocomplete="given-name" value="${esc(nome)}"></div>
        <div class="field"><label for="tc-cognome">Cognome</label><input class="input" id="tc-cognome" required maxlength="40" autocomplete="family-name" value="${esc(cognome)}"></div></div>
        <button class="btn" type="submit">${TEMPI && TEMPI.persone ? "Cerca di nuovo" : "Cerca"}</button>
        <span class="small muted">Scrivili come nelle classifiche. Cerco su Gare Podistiche Lazio (anche le non competitive) e su FIDAL; il nome serve solo alla ricerca e online non resta.</span></form>
      ${corpo}`;
  }
  function risultatiTempi(g) {
    const P = TEMPI.persone, scelti = TEMPI.scelti || [];
    const giu = Object.entries(TEMPI.fonti || {}).filter(([, v]) => v !== "ok").map(([k]) => FONTE_TEMPI[k]);
    const avviso = giu.length ? `<span class="small" style="color:var(--warn)">${esc(giu.join(" e "))} non ${giu.length > 1 ? "rispondono" : "risponde"} adesso: riprova più tardi per avere tutto.</span>` : "";
    if (!P.length) return `<section class="card"><span class="title">Nessun risultato</span><span class="small">Non trovo gare a nome di <b>${esc(nomeTempi().nome)} ${esc(nomeTempi().cognome)}</b>. Controlla come sei scritto nelle classifiche (un secondo nome, un cognome doppio).</span>${avviso}</section>`;
    const quante = (p) => p.risultati.length;
    const chiuso = TEMPI.ricordati && scelti.length, nomiScelti = P.filter((p) => scelti.includes(p.id)).map((p) => p.societa || FONTE_TEMPI[p.fonte]);
    const chi = `<${chiuso ? "details" : "section"} class="card" style="gap:0">${chiuso ? `<summary><span>Sei tu: <span style="font-weight:600;color:var(--fg)">${esc(nomiScelti.join(", "))}</span> · cambia</span></summary>` : ""}<h2 style="margin-bottom:4px">${P.length > 1 ? "Quale sei tu?" : "Ti ho trovato qui"}</h2>
      ${P.length > 1 ? `<span class="small muted" style="margin-bottom:6px">Ci sono più persone con questo nome: spunta quelle che sei tu (anche più di una, se hai cambiato società).</span>` : ""}
      ${P.map((p) => { const u = p.risultati[0]; return `<label class="check"><input type="checkbox" data-act-change="tempi-persona" data-id="${esc(p.id)}" ${scelti.includes(p.id) ? "checked" : ""}><span><span class="t">${esc(p.societa || "Senza società")}${p.categoria ? " · " + esc(p.categoria) : ""}</span><br><span class="d">${esc(FONTE_TEMPI[p.fonte])} · ${quante(p) ? `${quante(p)} ${quante(p) === 1 ? "gara" : "gare"} su 10 km, mezza o maratona${u ? `, l'ultima ${esc(L.nomeRisultato(u))} (${esc(L.fmtBreve(u.data))} ${esc(u.data.slice(0, 4))})` : ""}` : `${p.gare} ${p.gare === 1 ? "gara" : "gare"}, nessuna su 10 km, mezza o maratona`}</span></span></label>`; }).join("")}${avviso}</${chiuso ? "details" : "section"}>`;
    if (!scelti.length) return chi;
    const uniti = L.tempiUniti(P, scelti), riga = (r, bottone) => `<div class="between" style="gap:10px;padding:6px 0"><span style="min-width:0"><b>${esc(L.nomeRisultato(r))}</b><br><span class="small muted">${esc(L.fmtBreve(r.data))} ${esc(r.data.slice(0, 4))} · ${esc(FONTE_TEMPI[r.fonte])}</span></span><span class="row" style="gap:8px"><b class="pb-tempo">${esc(L.leggiTempo(r.distanza, r.tempo).tempo || r.tempo)}</b>${bottone}</span></div>`;
    if (g) {
      const trovati = L.tempiDellaGara(uniti, g);
      return chi + (trovati.length ? `<section class="card soft"><span class="eyebrow" style="color:var(--accent-strong)">Il tuo tempo ufficiale</span>${trovati.map((r) => riga(r, `<button class="btn small" data-act="tempi-usa" data-gara="${esc(g.id)}" data-id="${esc(r.id)}">Usa</button>`)).join("")}</section>`
        : `<section class="card"><span class="title">Non c'è ancora</span><span class="small">La ${esc(titoloGara(g.nome))} del ${esc(L.fmtGiorno(g.data))} non è ancora nelle classifiche. Gare Podistiche Lazio di solito la pubblica in giornata o il giorno dopo, FIDAL dopo qualche giorno.</span><button class="btn ghost" data-act="tempi-riprova">Riprova</button></section>`);
    }
    const per = L.tempiPerDistanza(uniti);
    return chi + DISTANZE.map((d) => {
      const lista = per[d], c = lista[0], att = (S.pb || {})[d];
      if (!c) return `<section class="card"><div class="between"><span class="title">${esc(L.DIST_LABEL[d])}</span><span class="small muted">nessuna in classifica</span></div></section>`;
      const meglio = !att || c.secondi < att.secondi;
      return `<section class="card ${meglio ? "strava-meglio" : ""}"><div class="between"><span class="title">${esc(L.DIST_LABEL[d])}</span><span class="small muted">${att ? `oggi nell'app: ${esc(L.leggiTempo(d, att.tempo).tempo || att.tempo)}` : "non ancora inserito"}</span></div>
        ${riga(c, "")}
        ${meglio ? `${att ? `<span class="small" style="color:var(--accent-strong);font-weight:700">Migliore di quello che hai: −${esc(fmtDiff(att.secondi - c.secondi))}</span>` : ""}<button class="btn" data-act="tempi-pb" data-d="${d}" data-id="${esc(c.id)}">Salva come personale</button>`
          : `<span class="small muted">${c.secondi === att.secondi ? "È già il tuo personale." : `Più lento di quello che hai: resta ${esc(L.leggiTempo(d, att.tempo).tempo || att.tempo)}.`}</span>`}
        ${lista.length > 1 ? `<details><summary class="small">Tutte le ${lista.length} trovate</summary>${lista.slice(1).map((r) => riga(r, `<button class="linkbtn small" data-act="tempi-pb" data-d="${d}" data-id="${esc(r.id)}">Usa</button>`)).join("")}</details>` : ""}</section>`;
    }).join("") + `<p class="sub">Controlla che siano gare tue: con gli omonimi può scappare un tempo di qualcun altro. I tempi restano sul telefono; in classifica del gruppo va solo il personale che salvi, se hai scelto di comparire.</p>`;
  }
  const tempoTrovato = (id) => L.tempiUniti(TEMPI && TEMPI.persone || [], TEMPI && TEMPI.scelti || []).find((r) => r.id === id);

  // "Com'è andata?": il tempo della corsa su Strava, da confermare (vale il chip).
  function riempiTempo(id, tempo) {
    const [h, m, s] = tempo.split(":");
    for (const [k, v] of [["h", String(Number(h))], ["m", m], ["s", s]]) { const el = document.getElementById(`${id}-${k}`); if (el) el.value = v; }
  }
  async function stravaRisultato(id) {
    const g = S.gare.find((x) => x.id === id);
    if (!g || !S.strava || !S.strava.attivo || (S.stravaIgnora || {})[id]) return;
    const n = L.diffDays(oggi(), g.data);
    if (n < 0 || n > 7) return;
    let dati = STRAVA_GIORNO[id];
    if (!dati) { try { dati = STRAVA_GIORNO[id] = await funzioneStrava({ azione: "giorno", data: g.data }); } catch (e) { return; } }
    const box = document.getElementById("ris-strava");
    if (!box) return;
    const { scelta, altre } = L.corsaDellaGara(dati.corse, g.distanza), r = (S.risultati || {})[id];
    if (!scelta) { box.innerHTML = `<span class="small muted">Su Strava questa gara non c'è ancora: riprovo alla prossima apertura.</span>`; return; }
    const km = (scelta.metri / 1000).toFixed(1).replace(".", ","), simili = L.candidatiPersonali(altre)[g.distanza] || [];
    const alternative = simili.length ? `<span class="small">Non è questa? ${simili.map((x) => `<button type="button" class="linkbtn" data-act="ris-strava-usa" data-t="${esc(x.tempo)}">${esc(x.nome)} ${esc(x.tempo)}</button>`).join(" · ")}</span>` : "";
    if (!r || !r.tempo) {
      if (["h", "m", "s"].every((k) => !(document.getElementById(`ris-tempo-${k}`) || {}).value)) riempiTempo("ris-tempo", scelta.tempo);
      else if (/[?&]t=/.test(location.hash)) return; // il tempo arriva dalle classifiche: vale quello
      box.innerHTML = `<section class="card soft"><span class="eyebrow" style="color:var(--accent-strong)">Da Strava</span><span class="small">Tempo da Strava: <b>${esc(scelta.tempo)}</b> (${km} km sul GPS). Controlla il tempo ufficiale del chip prima di salvare.</span>${alternative}</section>`;
    } else if (L.leggiTempo(g.distanza, r.tempo).secondi !== L.leggiTempo(g.distanza, scelta.tempo).secondi) {
      box.innerHTML = `<section class="card soft"><span class="eyebrow" style="color:var(--accent-strong)">Arrivato da Strava</span><span class="small">Su Strava questa gara risulta <b>${esc(scelta.tempo)}</b> (${km} km sul GPS). Il tuo tempo salvato è <b>${esc(L.leggiTempo(g.distanza, r.tempo).tempo || r.tempo)}</b>.</span>
        <div class="grid2"><button type="button" class="btn" data-act="ris-strava-tieni" data-id="${esc(id)}">Tieni il mio</button><button type="button" class="btn ghost" data-act="ris-strava-usa" data-t="${esc(scelta.tempo)}">Usa Strava</button></div>
        <span class="small muted">Il tempo ufficiale è quello del chip: di solito vale il tuo.</span>${alternative}</section>`;
    }
  }

  function vistaIo() {
    const P = S.profilo;
    const USI = { allenamento: "Allenamento", ritmo: "Ritmo e lunghi", gara: "Gara", trail: "Trail" };
    const opzioni = (vals, att, fmt) => vals.map((v) => `<option value="${v}" ${String(att) === String(v) ? "selected" : ""}>${fmt(v)}</option>`).join("");
    const scarpe = S.scarpe.map((s) => {
      const st = L.statoScarpa(s);
      if (s.strava) return `<article class="card"><div class="between"><span class="title">${esc(s.nome)}</span><span class="small muted" style="font-weight:700">da Strava</span></div>
        <div class="meter ${st.livello}" aria-hidden="true"><div style="width:${Math.max(3, Math.round(st.quota * 100))}%"></div></div>
        <div class="between small"><span><b>${Math.round(st.km)}</b> di ${st.limite} km</span><span style="font-weight:700;color:${st.livello === "attenzione" ? "var(--warn)" : st.livello === "info" ? "var(--accent)" : "var(--ok)"}">${esc(st.etichetta)}</span></div>
        <div class="grid2"><div class="field"><label for="su-${esc(s.id)}">Uso</label><select class="input" id="su-${esc(s.id)}" data-act-change="scarpa-uso" data-id="${esc(s.id)}">${opzioni(Object.keys(USI), s.tipo, (v) => USI[v])}</select></div>
        <div class="field"><label for="sl-${esc(s.id)}">Da cambiare a</label><select class="input" id="sl-${esc(s.id)}" data-act-change="scarpa-limite" data-id="${esc(s.id)}">${opzioni([300, 400, 500, 600, 700, 800, 900, 1000], s.limite, (v) => `${v} km`)}</select></div></div></article>`;
      return `<article class="card"><div class="between"><span class="title">${esc(s.nome)}</span><span class="small muted">${esc({ allenamento: "allenamento", ritmo: "ritmo e lunghi", gara: "gara", trail: "trail" }[s.tipo] || s.tipo)}</span></div>
        <div class="meter ${st.livello}" aria-hidden="true"><div style="width:${Math.max(3, Math.round(st.quota * 100))}%"></div></div>
        <div class="between small"><span><b>${Math.round(st.km)}</b> di ${st.limite} km</span><span style="font-weight:700;color:${st.livello === "attenzione" ? "var(--warn)" : st.livello === "info" ? "var(--accent)" : "var(--ok)"}">${esc(st.etichetta)}</span></div>
        <form class="row" data-form="km" data-id="${esc(s.id)}"><label class="sr" for="km-${esc(s.id)}">Aggiungi km a ${esc(s.nome)}</label><input class="input" id="km-${esc(s.id)}" type="number" inputmode="decimal" min="0" step="0.1" placeholder="+ km corsi"><button class="btn ghost" type="submit">Aggiungi</button><button class="btn ghost" type="button" data-act="del-scarpa" data-id="${esc(s.id)}" aria-label="Elimina ${esc(s.nome)}">✕</button></form></article>`;
    }).join("");
    const aperto = S.ioAperto || {};
    const acc = (k, titolo, stato, corpo) => `<details class="card acc" data-acc="${k}" ${aperto[k] ? "open" : ""}><summary><span class="acc-t">${titolo}</span><span class="acc-s">${stato}</span></summary><div class="acc-body">${corpo}</div></details>`;
    const on = S.push && S.push.attivo, sp = supportoPush();
    const daCambiare = S.scarpe.filter((x) => L.statoScarpa(x).livello === "attenzione").length;
    const inG = S.gruppo && S.gruppo.dentro && GD();
    const stravaOn = !!(S.strava && S.strava.attivo && S.strava.archiviato), archivio = S.scarpeArchivio || [];
    return `${bannerProva()}<header class="head"><h1>Io</h1></header>
      ${C().login ? acc("account", "Account", AUTH ? '<span class="pill ok">connesso</span>' : "facoltativo", sezioneAccount()) : ""}
      ${acc("profilo", "Profilo", esc([P.nome, P.citta, P.ora && oraInput(P.ora), P.kmSettimana && `${P.kmSettimana} km/sett`].filter(Boolean).join(" · ") || "da completare"), `<form id="profilo" autocomplete="off" style="display:flex;flex-direction:column;gap:10px">
        <div class="field"><label for="p-nome">Come ti chiami</label><input class="input" id="p-nome" data-auto="nome" value="${esc(P.nome)}" placeholder="es. Mario Rossi" autocomplete="name" maxlength="40"><span class="small muted">Usa nome e cognome: comparirà anche nel tuo gruppo.</span></div>
        <div class="field"><label for="p-citta">Dove corri di solito</label><input class="input" id="p-citta" data-auto="citta" value="${esc(P.citta)}" placeholder="es. Roma">
          <div class="between">${bottoneGps("p-citta")}${P.coord ? `<span class="small muted">dal GPS</span>` : ""}</div></div>
        <div class="field"><label for="p-ora">A che ora esci di solito</label><input class="input" id="p-ora" data-auto="ora" type="time" step="900" value="${esc(oraInput(P.ora))}"></div>
        <div class="field"><label for="p-km">Quanti km corri a settimana</label><input class="input" id="p-km" data-auto="kmSettimana" type="number" inputmode="numeric" min="1" max="250" step="1" value="${esc(P.kmSettimana || "")}" placeholder="es. 40" style="max-width:140px"><span class="small muted">Serve a stimare con quanti km le scarpe arrivano alla gara.</span></div>
        <span class="small muted">Si salva da solo.</span></form>`)}
      ${acc("documenti", "Tessera e certificato", (() => { const a = statoDoc((S.documenti || {}).tessera), b = statoDoc((S.documenti || {}).certificato); const peggio = [a, b].find((x) => ["scaduto", "urgente", "presto"].includes(x.livello)); return peggio ? pillDoc(peggio) : a.livello === "ok" && b.livello === "ok" ? '<span class="pill ok">in regola</span>' : "da inserire"; })(), sezioneDocumenti())}
      ${acc("notifiche", "Notifiche", on ? '<span class="pill ok">attive</span>' : sp === "ok" ? "da attivare" : sp === "non-pronto" ? "in arrivo" : "non disponibili", cardPush(false, true))}
      ${acc("gruppo", "Gruppo", inG ? `${esc(GD().gruppo.nome)} · ${esc(RUOLI_G[GD().io.ruolo].toLowerCase())}` : "non sei in un gruppo", inG ? `<span class="small">Sei in <b>${esc(GD().gruppo.nome)}</b> come «${esc(GD().io.nome)}».</span>${S.profilo.nome && S.profilo.nome.trim() !== GD().io.nome ? `<button class="btn ghost small" data-act="g-usa-nome" style="align-self:flex-start">Fatti vedere come «${esc(S.profilo.nome.trim())}»</button>` : ""}
        <label class="check" style="border:0;padding:4px 0"><input type="checkbox" id="io-mostra" ${GD().io.mostra_gare ? "checked" : ""}><span><span class="t">Mostra al gruppo le mie gare</span><br><span class="d">Nome della gara, ruolo e tempo obiettivo.</span></span></label>
        ${clAttive() ? `<label class="check" style="border:0;padding:4px 0"><input type="checkbox" id="cl-partecipo" ${partecipo() ? "checked" : ""}><span><span class="t">Partecipo alle classifiche</span><br><span class="d">${partecipo() ? "Spegnendo, i tuoi risultati online si cancellano; sul telefono restano." : "Gare corse, PB della stagione e Albo d'oro del gruppo."}</span></span></label>${partecipo() ? `<a class="btn ghost" href="#/gruppo/carriera">La mia carriera</a><a class="btn ghost" href="#/gruppo/mie?da=io">Le mie gare in classifica</a>` : ""}<a class="link-regole" href="#/gruppo/regole?da=io">Come funzionano le classifiche ›</a>` : ""}
        <a class="btn ghost" href="#/gruppo/admin">${GD().io.ruolo === "membro" ? "Membri del gruppo" : "Gestisci il gruppo"}</a><button class="btn ghost" type="button" data-act="g-esci">Esci dal gruppo</button>` : `<span class="small">Entra nel gruppo della tua società con il link d'invito, oppure crealo se sei il presidente.</span><a class="btn ghost" href="#/gruppo">Vai al gruppo</a>`)}
      ${acc("personali", "I miei personali", esc(riassuntoPB()) || "da inserire", sezionePB())}
      ${C().strava ? acc("strava", "Strava", STRAVA_STATO && STRAVA_STATO.collegato ? '<span class="pill ok">collegato</span>' : "in prova", sezioneStrava()) : ""}
      ${acc("scarpe", "Le mie scarpe", S.scarpe.length ? `${S.scarpe.length} ${stravaOn ? "da Strava" : S.scarpe.length === 1 ? "paio" : "paia"}${daCambiare ? ` · <b style="color:var(--warn)">${daCambiare} da cambiare</b>` : ""}` : "nessuna", `${scarpe || `<span class="small">Nessuna scarpa ancora.</span>`}
        ${stravaOn ? `<span class="small muted">I km arrivano da Strava${S.strava.letto ? `, aggiornati alle ${esc(new Date(S.strava.letto).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }))}` : ""}. Una scarpa nuova si aggiunge su Strava; quelle ritirate lì spariscono da qui.</span>` : S.strava && S.strava.attivo ? `<span class="small muted">Su Strava non hai scarpe attive, quindi usiamo quelle inserite qui. Se ne aggiungi una su Strava, i km arriveranno da lì e queste andranno in Archivio.</span>` : ""}
        ${archivio.length ? `<details class="card"><summary>Archivio · ${archivio.length} ${archivio.length === 1 ? "scarpa inserita" : "scarpe inserite"} a mano</summary>${archivio.map((x) => `<div class="between" style="padding:6px 0"><span>${esc(x.nome)} <span class="small muted">· ${Math.round(Number(x.km) || 0)} km</span></span><button class="btn ghost small" data-act="arch-del" data-id="${esc(x.id)}">Elimina</button></div>`).join("")}<span class="small muted">${stravaOn ? "Non contano finché Strava è collegato." : "Se sono le stesse scarpe che hai già, eliminale."}</span></details>` : ""}
        ${stravaOn ? "" : `<details class="card"><summary>+ Aggiungi una scarpa</summary><form id="scarpa" style="display:flex;flex-direction:column;gap:10px">
        <div class="field"><label for="s-nome">Modello</label><input class="input" id="s-nome" required placeholder="es. la mia scarpa da lento"></div>
        <div class="grid2"><div class="field"><label for="s-tipo">Uso</label><select class="input" id="s-tipo"><option value="allenamento">Allenamento</option><option value="ritmo">Ritmo e lunghi</option><option value="gara">Gara</option><option value="trail">Trail</option></select></div>
        <div class="field"><label for="s-km">Km attuali</label><input class="input" id="s-km" type="number" min="0" value="0"></div></div>
        <div class="field"><label for="s-lim">Da cambiare a (km)</label><input class="input" id="s-lim" type="number" min="300" step="50" value="800"></div>
        <button class="btn" type="submit">Aggiungi scarpa</button></form></details>
        <span class="small muted">I km si aggiornano a mano${C().strava ? "; con Strava arrivano da soli" : ""}.</span>`}`)}
      <details class="card"><summary>Strumenti di prova</summary>
        <form id="prova" style="display:flex;flex-direction:column;gap:10px"><div class="field"><label for="d-prova">Fai finta che oggi sia</label><input class="input" id="d-prova" type="date" value="${esc(S.prova)}"></div>
        <div class="grid2"><button class="btn" type="submit">Applica</button><button class="btn ghost" type="button" data-act="prova-off">Torna a oggi</button></div></form>
        <div class="row" style="gap:18px"><a class="small" href="#/statistiche">Statistiche ›</a><a class="small" href="#/super">Superamministratore ›</a></div>
        <div id="reset-box" style="display:flex;flex-direction:column;gap:8px"><button class="btn ghost" type="button" data-act="reset-ask">Cancella tutti i miei dati</button></div></details>
      <section class="card" aria-label="Rivedi i percorsi guidati" style="gap:0"><span class="eyebrow" style="margin-bottom:4px">Rivedi i percorsi guidati</span>
        <a class="link-card riga-percorso" href="#/benvenuto"><span><b>Benvenuto</b><br><span class="small muted">Le 5 schermate del primo avvio</span></span><span aria-hidden="true">›</span></a>
        <a class="link-card riga-percorso" href="#/prepara/ora?rivedi=1"><span><b>Prepara RaceBuddy</b><br><span class="small muted">Uscita, zona, tessera e certificato, notifiche, gara</span></span><span aria-hidden="true">›</span></a>
        ${S.gruppo && S.gruppo.dentro && GD() ? `<a class="link-card riga-percorso" href="#/invito/anteprima?rivedi=1"><span><b>Entra nel gruppo</b><br><span class="small muted">Dall'invito ai 6 passi fino a "Sei dentro"</span></span><span aria-hidden="true">›</span></a>
        <a class="link-card riga-percorso" href="#/invito/anteprima?rivedi=1&home=1"><span><b>Entra nel gruppo da iPhone</b><br><span class="small muted">Come lo vede chi apre l'invito in Safari</span></span><span aria-hidden="true">›</span></a>` : `<span class="small muted" style="padding-top:8px">Entra nel gruppo: lo rivedi quando sei in un gruppo.</span>`}
        <span class="small muted" style="padding-top:8px">Ogni passo si vede dall'inizio, anche quelli già fatti. Quello che confermi si salva come sempre.</span></section>
      <p class="sub">Versione ${esc(window.RB_VERSION || "?")} · gare condivise: ${Object.keys(S.segnalate || {}).length} di ${S.gare.length}${S.erroreSegnala ? ` · ultimo errore: ${esc(S.erroreSegnala)}` : ""}</p>
      <p class="sub">Profilo, preparazione e scarpe restano su questo telefono.</p>`;
  }

  // ---------------------------------------------------------------- Buddy: chat AI su scarpe, integratori e allenamento
  // La chat resta su questo telefono (S.buddy.chat). Le domande vanno alla Edge Function "buddy" (Groq, piano gratuito di
  // Luca) con il contesto di L.contestoBuddy: gara, obiettivo, personali, scarpe inserite a mano. Mai nomi, documenti o
  // dati di Strava. Quota del giorno per telefono calcolata dalla funzione sui telefoni attivi della settimana.
  const B = () => (S.buddy = S.buddy || { ok: false, chat: [] });
  const BUDDY_ESEMPI = ["Che scarpa prendo dopo le mie?", "Come imposto le prossime settimane?", "Gel e integratori: consigli?"];
  let buddyAttesa = false, buddyQuotaLetta = null;
  const pulsanteBuddy = () => (C().buddy ? `<a class="buddy-btn" href="#/buddy" aria-label="Chiedi al buddy"><span aria-hidden="true">✦</span> Buddy</a>` : "");
  // Markdown minimo delle risposte: grassetto, link, elenchi, paragrafi. Tutto passa da esc prima.
  function mdBuddy(t) {
    const link = (x) => x.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, a, u) => `<a href="${u}" target="_blank" rel="noopener">${a}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}</a>`);
    const riga = (x) => link(esc(x.replace(/^\s*#{1,6}\s+(.*)$/, "**$1**"))).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    return String(t || "").split(/\n{2,}/).map((blocco) => {
      const r = blocco.split("\n").filter((x) => x.trim());
      if (r.length && r.every((x) => /^\s*([-*•]|\d+[.)])\s+/.test(x))) {
        const num = /^\s*\d/.test(r[0]);
        return `<${num ? "ol" : "ul"}>${r.map((x) => `<li>${riga(x.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))}</li>`).join("")}</${num ? "ol" : "ul"}>`;
      }
      return `<p>${r.map(riga).join("<br>")}</p>`;
    }).join("");
  }
  async function chiamaBuddy(corpo) {
    const r = await fetch(`${C().supabaseUrl}/functions/v1/buddy`, { method: "POST", headers: { apikey: C().supabaseKey, "x-racebuddy-token": token(), "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
    return r.json();
  }
  function leggiQuotaBuddy() {
    if (buddyQuotaLetta === oggi()) return;
    buddyQuotaLetta = oggi();
    chiamaBuddy({ azione: "quota" }).then((j) => { if (j && typeof j.restano === "number") { B().restano = j.restano; B().budget = j.budget; B().giorno = oggi(); salva(); const el = document.getElementById("buddy-quota"); if (el) el.textContent = testoQuota(); } }).catch(() => { buddyQuotaLetta = null; });
  }
  // In fase di test la quota per telefono è alta: conta il budget gratuito di Groq del giorno (in %), con avviso dall'80%.
  const testoQuota = () => {
    const b = B();
    if (b.giorno !== oggi() || typeof b.restano !== "number") return "";
    if (b.restano <= 0) return "Domande di oggi finite";
    if (typeof b.budget === "number") return b.budget >= 100 ? "Budget gratuito di oggi finito" : `Budget gratuito di oggi: ${b.budget}% usato${b.budget >= 80 ? " · quasi finito" : ""}`;
    return `Oggi ancora ${b.restano} ${b.restano === 1 ? "domanda" : "domande"}`;
  };
  async function inviaBuddy(testo) {
    const b = B(), t = String(testo || "").trim().slice(0, 1000);
    if (!t || buddyAttesa) return;
    b.chat = [...(b.chat || []), { r: "u", t }].slice(-40); buddyAttesa = true; salva(); rerender(); scorriChat();
    const contesto = L.contestoBuddy({ oggi: oggi(), gare: S.gare, fasi: D.fasi, risultati: S.risultati || {}, pb: S.pb || {}, scarpe: S.scarpe || [], kmSettimana: S.profilo.kmSettimana });
    try {
      const j = await chiamaBuddy({ messaggi: b.chat.filter((m) => m.r === "u" || m.r === "b").slice(-10), contesto });
      if (j.esito === "ok") b.chat.push({ r: "b", t: j.risposta, tema: j.tema });
      else b.chat.push({ r: "n", t: j.messaggio || "Il buddy non ha risposto, riprova tra poco." });
      if (typeof j.restano === "number") { b.restano = j.restano; b.giorno = oggi(); }
      if (typeof j.budget === "number") { const prima = b.budget || 0; b.budget = j.budget; if (prima < 80 && j.budget >= 80 && j.budget < 100) b.chat.push({ r: "n", t: `Attenzione: hai usato l'${j.budget}% del budget gratuito di oggi. Una domanda sulle scarpe (con ricerca web) ne consuma circa un quinto.` }); }
    } catch (e) { b.chat.push({ r: "n", t: "Sei offline o il buddy non è raggiungibile: riprova tra poco." }); }
    buddyAttesa = false; salva(); rerender(); scorriChat();
  }
  const scorriChat = () => requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  function vistaBuddy() {
    const b = B();
    const testa = `<header class="head-back buddy-testa">${back("#/oggi")}<div style="min-width:0;flex:1"><span class="eyebrow">Scarpe · integratori · allenamento</span><h1 style="font-size:28px">Il tuo buddy</h1></div>${b.ok && (b.chat || []).length ? `<button class="btn ghost buddy-nuova" data-act="buddy-nuova">Nuova chat</button>` : ""}</header>`;
    if (!b.ok) return `${testa}
      <section class="card buddy-intro"><span class="buddy-ico" aria-hidden="true">✦</span><span class="title">Chiedimi di scarpe, integratori e allenamento</span>
        <span class="small">Conosco già la tua gara, l'obiettivo, i tuoi personali e le tue scarpe: non serve ripetermeli.</span>
        <ul class="small buddy-punti"><li>Le domande vanno a un modello AI con il minimo indispensabile: gara, obiettivo, personali e scarpe. Mai il tuo nome, i documenti o i dati di Strava.</li><li>Le conversazioni restano su questo telefono.</li><li>Le risposte sono generate da un'AI: non sostituiscono medico o allenatore.</li></ul>
        <button class="btn block" data-act="buddy-ok">Iniziamo</button></section>`;
    leggiQuotaBuddy();
    const chat = b.chat || [];
    const msg = (m) => m.r === "u" ? `<div class="msg tu">${esc(m.t).replace(/\n/g, "<br>")}</div>` : m.r === "b" ? `<div class="msg buddy">${mdBuddy(m.t)}</div>` : `<div class="msg nota">${esc(m.t)}</div>`;
    const vuota = `<div class="buddy-vuota"><span class="buddy-ico" aria-hidden="true">✦</span><span class="title">Ciao! Di cosa parliamo?</span><div class="buddy-esempi">${BUDDY_ESEMPI.map((x) => `<button class="chip" data-act="buddy-esempio" data-t="${esc(x)}">${esc(x)}</button>`).join("")}</div></div>`;
    return `${testa}<div class="chat" aria-live="polite">${chat.length ? chat.map(msg).join("") : vuota}${buddyAttesa ? `<div class="msg buddy attesa" aria-label="Il buddy sta scrivendo"><span></span><span></span><span></span></div>` : ""}</div>
      <form id="buddy-form" class="buddy-scrivi"><textarea id="buddy-testo" class="input" rows="1" maxlength="1000" placeholder="Scrivi al buddy…" aria-label="Domanda al buddy" ${buddyAttesa ? "disabled" : ""}></textarea><button class="btn buddy-invia" type="submit" aria-label="Invia" ${buddyAttesa ? "disabled" : ""}>↑</button>
        <span class="buddy-piede"><span id="buddy-quota">${esc(testoQuota())}</span> · Risposte generate da un'AI: non sostituiscono medico o allenatore.</span></form>`;
  }

  // ---------------------------------------------------------------- router
  function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [path, query] = h.split("?");
    const parts = path.split("/").map(decodeURIComponent);
    const param = Object.fromEntries(new URLSearchParams(query || ""));
    const tab = parts[0] || "oggi";
    document.querySelectorAll("nav.tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.tab === ({ prepara: "oggi", aggiungi: "gare", gara: "gare", checklist: "gare", percorso: "gare", meteo: "oggi", pillole: "oggi", invito: "gruppo", entra: "gruppo", risultato: "oggi", pb: "io", tempi: "io", estera: "gare", statistiche: "io", super: "io", condividi: "gare" }[tab] || tab) ? "page" : "false"));
    if (D.errore) { $app.innerHTML = `<section class="card"><span class="title">Qualcosa non va</span><span class="small">${esc(D.errore)}</span></section>`; return; }
    let html;
    if (param.rivedi) { RIVEDI = tab === "prepara" ? "prepara" : "entra"; invitoInSafari = false; }
    else if (!["prepara", "entra", "invito"].includes(tab)) RIVEDI = null;
    const benvenuto = !S.benvenuto && !S.gare.length && (tab === "oggi" || tab === "benvenuto");
    document.body.classList.toggle("onboarding", benvenuto);
    if (benvenuto || tab === "benvenuto") { $app.innerHTML = vistaBenvenuto(); document.body.classList.add("onboarding"); avviaBenvenuto(); return; }
    switch (tab) {
      case "gare": html = vistaGare(param); break;
      case "aggiungi": html = vistaAggiungi(parts[1]); break;
      case "percorso": { const fid = parts[1] || (L.gareAttive(S.gare, D.fasi, oggi(), S.risultati || {}).focus || S.gare[0] || {}).id; html = fid ? vistaPreparazione(fid) : vistaVuota(); break; }
      case "checklist": html = vistaBorsa(parts[1]); break;
      case "gruppo":
        html = parts[1] === "gara" ? vistaGaraGruppo(parts[2]) : parts[1] === "classifica" ? vistaClassifica(param) : parts[1] === "admin" ? vistaAdmin()
          : parts[1] === "partecipa" ? vistaEntra("classifiche") : parts[1] === "regole" ? vistaRegole(param) : parts[1] === "recupero" ? vistaRecupero(param) : parts[1] === "classifiche" ? vistaClassifiche(param) : parts[1] === "mie" ? vistaMieGare(param) : parts[1] === "societa" ? vistaSocieta(param) : parts[1] === "carriera" ? vistaCarriera() : parts[1] === "gare" ? vistaGareMembri(param) : vistaGruppo();
        break;
      case "invito": html = vistaInvito(parts[1], param); break;
      case "entra": html = vistaEntra(parts[1]); break;
      case "estera": {
        const id = parts[1], ge = garaEsteraDati(id);
        if (S.gare.some((x) => x.id === id)) { location.replace(urlGara(id)); return; }
        if (ge && !(S.introEstere || {})[id]) { $app.innerHTML = vistaIntroEstera(ge); document.body.classList.add("onboarding"); avviaBenvenuto(); return; }
        html = vistaEstera(id); break;
      }
      case "pb": html = vistaPB(param); break;
      case "tempi": html = C().tempi ? vistaTempi(param) : vistaPB(); break;
      case "condividi": html = vistaCondividi(parts[1]); break;
      case "statistiche": html = vistaStatistiche(); break;
      case "super": html = vistaSuper(); break;
      case "buddy": html = C().buddy ? vistaBuddy() : vistaOggi(); break;
      case "risultato": html = vistaRisultato(parts[1], param); break;
      case "io": if (param.strava) { ritornoStrava(param.strava); history.replaceState(null, "", "#/io"); }
        if (parts[1] === "documenti" || parts[1] === "scarpe") S.ioAperto = { ...(S.ioAperto || {}), [parts[1]]: true }; html = vistaIo(); break;
      case "gara": html = parts[2] === "novita" ? vistaNovitaGara(parts[1], param) : parts[2] === "preparazione" ? vistaPreparazione(parts[1]) : parts[2] === "info" ? vistaInfoGara(parts[1], param) : parts[2] === "borsa" ? vistaBorsa(parts[1]) : vistaGaraHome(parts[1], param); break;
      case "prepara": html = vistaPrepara(parts[1]); break;
      case "meteo": html = vistaMeteo(); break;
      case "pillole": html = vistaPillole(parts[1]); break;
      case "perte": html = vistaPerTe(param); break;
      default: html = vistaOggi();
    }
    $app.innerHTML = html;
    // dopo uno swipe: la nuova sezione entra dal lato giusto; la voce attiva della barra resta in vista
    $app.classList.remove("da-destra", "da-sinistra");
    if (entrata) { void $app.offsetWidth; $app.classList.add(entrata); entrata = null; }
    const seg = $app.querySelector('nav.seg[aria-label="Sezioni della gara"]'), att = seg && seg.querySelector('[aria-current="page"]');
    if (att) seg.scrollLeft = att.offsetLeft - (seg.clientWidth - att.offsetWidth) / 2;
    const inv = tab === "invito" && (!(S.gruppo && S.gruppo.dentro) || parts[1] === "anteprima"), fineEntra = tab === "entra" && parts[1] === "fine" && S.gruppo && S.gruppo.dentro;
    document.body.classList.toggle("onboarding", !!fineEntra);
    document.body.classList.toggle("funnel-on", tab === "prepara" || (tab === "entra" && !fineEntra) || inv);
    document.body.classList.toggle("chat-on", tab === "buddy" && !!C().buddy);
    if (tab === "oggi" || !tab) riempiMeteo();
    riempiMeteoGaraBox();
    // "Imposta il tempo obiettivo" dalla preparazione: si apre la Panoramica già sul campo, con le ore pronte da scrivere
    if (tab === "gara" && !parts[2] && param.modifica) {
      const f = document.getElementById("gara-imp"), h = document.getElementById("gi-tempo-h");
      if (f && h) setTimeout(() => { f.closest("details").open = true; f.scrollIntoView({ block: "center", behavior: "smooth" }); h.focus({ preventScroll: true }); f.classList.add("evidenzia"); }, 80);
    }
    if (tab === "io") { mostraFotoDoc(); if (parts[1] === "documenti" || parts[1] === "scarpe") { const el = document.querySelector(`[data-acc="${parts[1]}"]`); if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 50); } }
    if (tab === "meteo") riempiMeteoDettaglio();
    if (tab === "gare" && param.focus) { const c = document.getElementById("cerca"); if (c) { c.focus(); c.setSelectionRange(c.value.length, c.value.length); } }
  }
  const rerender = () => { const y = window.scrollY; route(); window.scrollTo(0, y); };

  // ---------------------------------------------------------------- azioni
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "buddy-ok") { B().ok = true; salva(); rerender(); return; }
    if (act === "cl-tab") { tabCl = t.dataset.t; rerender(); return; }
    if (act === "cl-dist") { distAlbo = t.dataset.d; rerender(); return; }
    if (act === "cl-partecipa") {
      t.disabled = true;
      rpc("partecipa_classifiche", { p_token: token(), p_on: true }).then(async () => { await aggiornaClassifiche(); toast("Partecipi alle classifiche"); location.hash = "#/gruppo/recupero"; })
        .catch((e) => { t.disabled = false; toast(e.message || "Non riuscito"); });
      return;
    }
    if (act === "entra-partecipo") {
      t.disabled = true;
      rpc("partecipa_classifiche", { p_token: token(), p_on: true }).then(async () => { ENTRA(); await aggiornaClassifiche(); toast("Partecipi alle classifiche"); vaiEntra("classifiche"); })
        .catch((e) => { t.disabled = false; toast(e.message || "Non riuscito"); });
      return;
    }
    if (act === "super-vai") {
      const qui = GD() ? GD().gruppo.nome : "";
      const resta = !!t.dataset.qui;
      confirmBox(t, resta ? `Torni amministratore di «${t.dataset.nome}»?` : `${qui ? `Esci da «${qui}» ed entri` : "Entri"} in «${t.dataset.nome}» come amministratore?`, async () => {
        try {
          const tk = token();
          await rpc("super_vai", { p_token: tk, p_gruppo: t.dataset.id, p_nome: (S.profilo.nome || "Luca").trim() });
          if (!resta) { S.gruppo = { token: tk, dentro: true, entra: { dal: oggi(), saltati: {} } }; salva(); }
          SUPER = null; CODA = null; await aggiornaGruppo(true); await aggiornaClassifiche();
          toast(resta ? "Sei di nuovo amministratore" : `Sei in «${t.dataset.nome}» come amministratore`); location.hash = resta ? "#/gruppo/admin" : "#/gruppo";
        } catch (e) { toast(e.message || "Non riuscito"); rerender(); }
      });
      return;
    }
    if (act === "entra-salta") { saltaEntra(t.dataset.k); return; }
    if (act === "entra-dopo") { ENTRA().dopo = oggi(); salva(); toast("Lo ritrovi qui tra qualche giorno, o in Gruppo"); rerender(); return; }
    if (act === "entra-push") { attivaPush(t).then(() => { if (S.push && S.push.attivo) vaiEntra("notifiche"); }); return; }
    if (act === "entra-tempi") {
      if (!TEMPI || !TEMPI.persone) return;
      const uniti = L.tempiUniti(TEMPI.persone, TEMPI.scelti || []), per = L.tempiPerDistanza(uniti);
      S.pb = S.pb || {};
      for (const d of DISTANZE) { const c = per[d][0], att = S.pb[d]; if (c && (!att || !att.secondi || c.secondi < att.secondi)) S.pb[d] = { tempo: L.leggiTempo(d, c.tempo).tempo || c.tempo, secondi: c.secondi, gara: L.nomeRisultato(c), data: c.data, fonte: c.fonte }; }
      ENTRA().tempi = true; salva(); sincronizzaPBGruppo();
      const ids = partecipo() ? L.daRecuperare(uniti, CL().io, CL().miei).map((r) => r.id).filter((id) => !REC_NO.has(id)) : [];
      if (!ids.length) { toast("Personali salvati"); vaiEntra("tempi"); return; }
      const [nome, cognome] = String(TEMPI.chiave || "").split("|");
      t.disabled = true; t.textContent = "Porto dentro le tue gare…";
      certificaRisultati({ nome, cognome, anno: null, persone: TEMPI.scelti || [], risultati: ids })
        .then(async (j) => { ENTRA().recuperate = (j.certificati || 0) + (j.in_approvazione || 0); salva(); toast(j.in_approvazione && j.certificati ? `${j.certificati} certificate, ${j.in_approvazione} al referente` : esitoCertifica(j)); await aggiornaClassifiche(); vaiEntra("tempi"); })
        .catch((e) => { toast(e.message); t.disabled = false; t.textContent = "Sono io: usa questi dati"; });
      return;
    }
    if (act === "inv-copia") {
      const ok = () => { const p = document.getElementById("inv-copiato"); if (p) p.textContent = "✓ Copiato: incollalo nell'app"; };
      (navigator.clipboard ? navigator.clipboard.writeText(t.dataset.link) : Promise.reject()).then(() => { ok(); toast("Invito copiato"); }).catch(() => toast("Tieni premuto sul codice per copiarlo"));
      return;
    }
    if (act === "inv-safari") { invitoInSafari = true; rerender(); return; }
    if (act === "inv-incolla" || act === "ob-invito") {
      if (act === "ob-invito") { S.benvenuto = true; salva(); document.body.classList.remove("onboarding"); }
      const vai = (testo) => { const c = (String(testo || "").match(/([A-Z2-9]{8})\s*$/i) || [])[1]; if (c) location.hash = `#/invito/${c.toUpperCase()}`; else { if (act === "inv-incolla") toast("Negli appunti non c'è un invito: scrivi il codice"); location.hash = "#/gruppo"; route(); } };
      (navigator.clipboard && navigator.clipboard.readText ? navigator.clipboard.readText() : Promise.reject()).then(vai).catch(() => vai(""));
      return;
    }
    if (act === "cl-recupera") {
      if (!TEMPI || !TEMPI.persone) return;
      const [nome, cognome] = String(TEMPI.chiave || "").split("|");
      const ids = L.daRecuperare(L.tempiUniti(TEMPI.persone, TEMPI.scelti || []), CL().io, CL().miei).map((r) => r.id).filter((id) => !REC_NO.has(id));
      if (!ids.length) return;
      t.disabled = true; t.textContent = "Recupero…";
      certificaRisultati({ nome, cognome, anno: null, persone: TEMPI.scelti || [], risultati: ids })
        .then(async (j) => { toast(j.in_approvazione && j.certificati ? `${j.certificati} certificate, ${j.in_approvazione} al referente` : esitoCertifica(j)); await aggiornaClassifiche(); location.hash = /[?&]da=mie/.test(location.hash) ? "#/gruppo/mie" : "#/gruppo"; })
        .catch((e) => { toast(e.message); rerender(); });
      return;
    }
    if (act === "gs-add") {
      t.disabled = true;
      rpc("gare_societa_aggiungi", { p_token: token(), p: { data: t.dataset.data, distanza: t.dataset.dist, nome: t.dataset.nome, luogo: t.dataset.luogo, gara_id: t.dataset.gid } })
        .then(async () => { toast("Aggiunta alle gare della società"); await aggiornaClassifiche(); const c = document.getElementById("gs-cerca"); location.hash = `#/gruppo/societa${c && c.value.trim() ? `?q=${encodeURIComponent(c.value.trim())}` : ""}`; rerender(); })
        .catch((e) => { t.disabled = false; toast(e.message || "Non riuscito"); });
      return;
    }
    if (act === "gs-togli") {
      confirmBox(t, `Togli ${t.dataset.nome} dalle gare della società? I punti si ricalcolano.`, () => azioneGruppo(async () => { await rpc("gare_societa_togli", { p_token: token(), p_id: t.dataset.id }); await aggiornaClassifiche(); }, "Gara tolta"));
      return;
    }
    if (act === "mio-invito") {
      t.disabled = true;
      (S.gruppo.mioInvito ? Promise.resolve(S.gruppo.mioInvito) : rpc("mio_invito", { p_token: token() })).then((c) => {
        S.gruppo.mioInvito = c; salva(); t.disabled = false;
        const link = linkInvito(c), testo = `Ciao! Corri con noi in ${GD().gruppo.nome}: su RaceBuddy ci sono le nostre gare e le classifiche della società. Ci vogliono 3 minuti: tieni a portata la tessera FIDAL (anche il PDF). Apri il link dal telefono:`;
        if (navigator.share) navigator.share({ title: "RaceBuddy", text: testo, url: link }).catch(() => {}); else copia(`${testo} ${link}`, "Messaggio");
      }).catch((e) => { t.disabled = false; toast(e.message || "Non riuscito"); });
      return;
    }
    if (act === "cl-togli") {
      confirmBox(t, "Togli questa gara? Esce dalla coda del referente.", () => azioneGruppo(async () => { await rpc("togli_risultato", { p_token: token(), p_id: t.dataset.id }); await aggiornaClassifiche(); }, "Gara tolta"));
      return;
    }
    if (act === "cl-decidi") {
      t.disabled = true;
      rpc("decidi_risultato", { p_token: token(), p_id: t.dataset.id, p_ok: t.dataset.ok === "1" }).then(async () => { toast(t.dataset.ok === "1" ? "Approvato: entra in classifica" : "Rifiutato"); CODA = null; if (GM) await caricaGareMembri(); await aggiornaClassifiche(); rerender(); })
        .catch((e) => { toast(e.message || "Non riuscito"); rerender(); });
      return;
    }
    if (act === "cl-annulla") {
      confirmBox(t, `Annulli il tempo di ${t.dataset.nome}? Esce dalle classifiche.`, () => azioneGruppo(async () => { await rpc("annulla_risultato", { p_token: token(), p_id: t.dataset.id }); if (GM) await caricaGareMembri(); await aggiornaClassifiche(); }, "Tempo annullato"));
      return;
    }
    if (act === "gm-ricarica") {
      GM = null; rerender();
      return;
    }
    if (act === "buddy-esempio") { inviaBuddy(t.dataset.t); return; }
    if (act === "buddy-nuova") { B().chat = []; salva(); rerender(); return; }
    if (act === "spunta") {
      if (t.tagName === "INPUT") S.spunte[t.dataset.k] = t.checked; else S.spunte[t.dataset.k] = true;
      if (!S.spunte[t.dataset.k]) delete S.spunte[t.dataset.k];
      salva(); if (t.tagName !== "INPUT") toast("Fatto"); rerender();
    } else if (act === "ob-avanti") {
      const tr = document.getElementById("ob-track"); tr.scrollBy({ left: tr.clientWidth, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    } else if (act === "intro-fine" || act === "mirino-si" || act === "intro-rivedi") {
      const id = t.dataset.id, g = garaEsteraDati(id);
      S.introEstere = { ...(S.introEstere || {}), [id]: act !== "intro-rivedi" };
      if (act === "mirino-si" && g && !inMirino(id)) {
        S.mirino = [...(S.mirino || []), { id: g.id, nome: g.nome, data: g.data, luogo: g.luogo, paese: g.paese || "", distanza: g.distanza, aggiunta: oggi() }];
        toast("Nel mirino ⭐ La trovi in Le mie gare");
      }
      salva(); document.body.classList.remove("onboarding");
      if (location.hash === `#/estera/${encodeURIComponent(id)}`) route(); else location.hash = `#/estera/${encodeURIComponent(id)}`;
    } else if (act === "mirino-no") {
      confirmBox(t, "Non la segui più?", () => { S.mirino = (S.mirino || []).filter((x) => x.id !== t.dataset.id); salva(); toast("Tolta dal mirino"); location.hash = "#/gare?v=mie"; });
    } else if (act === "ob-fine") {
      S.benvenuto = true; salva(); document.body.classList.remove("onboarding");
      if (t.dataset.vai) location.hash = t.dataset.vai; else if (location.hash === "#/benvenuto") location.hash = "#/oggi"; else route();
    } else if (act === "g-usa-nome") {
      azioneGruppo(() => rpc("aggiorna_profilo", { p_token: token(), p_nome: S.profilo.nome.trim().slice(0, 40), p_mostra: null }), "Nome aggiornato nel gruppo");
    } else if (act === "g-dist") {
      distGruppo = t.dataset.d; rerender();
    } else if (act === "g-applaudi") {
      t.classList.toggle("on"); azioneGruppo(() => rpc("applaudi", { p_token: token(), p_post: t.dataset.id }));
    } else if (act === "g-togli") {
      azioneGruppo(() => rpc("togli_post", { p_token: token(), p_post: t.dataset.id }), "Tolto dalla bacheca");
    } else if (act === "g-rimuovi") {
      confirmBox(t, `Tolgo ${t.dataset.nome} dal gruppo?`, () => azioneGruppo(() => rpc("admin_rimuovi", { p_token: token(), p_membro: t.dataset.id }), "Membro rimosso"));
    } else if (act === "g-nuovocodice") {
      confirmBox(t, "Creo un link nuovo? Quello vecchio smette di funzionare.", () => azioneGruppo(() => rpc("admin_gruppo", { p_token: token(), p_nome: null, p_nuovo_codice: true }), "Nuovo link creato"));
    } else if (act === "g-condividi") {
      const testo = `Ciao! Ti aspetto in ${GD().gruppo.nome} su RaceBuddy, l'app del gruppo per gare${clAttive() ? " e classifiche" : ""}. Ci vogliono 3 minuti: tieni a portata la tessera FIDAL (anche il PDF). Apri il link dal telefono:`;
      if (navigator.share) navigator.share({ title: "RaceBuddy", text: testo, url: t.dataset.link }).catch(() => {});
      else copia(`${testo} ${t.dataset.link}`, "Messaggio");
    } else if (act === "g-copia") {
      copia(t.dataset.link);
    } else if (act === "g-esci") {
      confirmBox(t, "Esci dal gruppo? Online si cancellano le tue gare condivise, i personali e i risultati delle classifiche; sul telefono resta tutto.", async () => {
        try { await rpc("esci_gruppo", { p_token: token() }); S.gruppo = { token: S.gruppo.token }; salva(); toast("Sei uscito dal gruppo"); location.hash = "#/gruppo"; }
        catch (e) { toast(e.message); rerender(); }
      });
    } else if (act === "perte-tipo") {
      location.hash = `#/perte?t=${t.dataset.t}`;
      return;
    } else if (act === "novita-letta") {
      S.letti = S.letti || {}; S.letti["n:" + t.dataset.id] = oggi(); salva(); toast("Segnata come letta"); rerender();
    } else if (act === "apri-novita") {
      S.letti = S.letti || {}; S.letti["n:" + t.dataset.id] = oggi(); salva();
      return;
    } else if (act === "apri-contenuto") {
      S.letti = S.letti || {}; S.letti["c:" + t.dataset.id] = oggi(); salva(); // il link si apre comunque
      return;
    } else if (act === "doc-dopo") {
      if (t.dataset.funnel === "entra") { if (!RIVEDI) { ENTRA().saltati = { ...(ENTRA().saltati || {}), documenti: true }; salva(); } vaiEntra("documenti"); }
      else vaiPasso("documenti");
      toast("Va bene: te lo ricordo in Oggi");
    } else if (act === "non-tesserato" && RIVEDI && t.dataset.dalFunnel) {
      if (t.dataset.dalFunnel === "entra") vaiEntra("documenti"); else vaiPasso("documenti");
    } else if (act === "non-tesserato") {
      S.nonTesserato = true; salva();
      toast("Ok: tessera e certificato li puoi aggiungere quando vuoi da Io");
      if (t.dataset.dalFunnel === "entra") vaiEntra("documenti"); else if (t.dataset.dalFunnel) vaiPasso("documenti"); else rerender();
    } else if (act === "prepara-dopo") {
      S.preparaDopo = oggi(); salva(); toast("Te lo ricordo tra qualche giorno"); rerender();
    } else if (act === "prepara-push") {
      attivaPush(t).then(() => { if (S.push && S.push.attivo) vaiPasso("notifiche"); });
    } else if (act === "push-on") {
      attivaPush(t);
    } else if (act === "push-off") {
      disattivaPush();
    } else if (act === "push-prova") {
      provaNotifica();
    } else if (act === "push-pref") {
      S.prefPush = { ...(S.prefPush || {}), [t.dataset.k]: t.checked }; salva(); toast("Preferenze salvate");
    } else if (act === "push-nonora") {
      S.pushNonOra = true; salva(); rerender();
    } else if (act === "doc-copia") {
      copia(doc("tessera").numero || "", "Numero di tessera");
    } else if (act === "doc-apri") {
      apriFoto(t.src);
    } else if (act === "doc-scarica") {
      scaricaDoc(t.dataset.k);
    } else if (act === "doc-togli-foto") {
      fotoTogli(t.dataset.k).catch(() => {}); doc(t.dataset.k).foto = false; doc(t.dataset.k).file = null; salva(); toast("File tolto"); rerender();
    } else if (act === "gps") {
      usaGps(t);
    } else if (act === "cnd") {
      CND[t.dataset.k] = t.dataset.v; rerender();
    } else if (act === "cnd-condividi" || act === "cnd-salva") {
      fileImmagine().then(async (f) => {
        if (act === "cnd-condividi" && navigator.canShare && navigator.canShare({ files: [f] })) {
          try { await navigator.share({ files: [f], title: "Il mio risultato" }); } catch (e) { if (e.name !== "AbortError") scaricaFile(f); }
        } else { scaricaFile(f); if (act === "cnd-condividi") toast("Immagine salvata: condividila dalla galleria"); }
      }).catch((e) => toast(e.message || "Non riuscito"));
    } else if (act === "stat-periodo") {
      statPeriodo = Number(t.dataset.n) || 30; rerender();
    } else if (act === "stat-giorno") {
      const el = document.getElementById("stat-sel"); if (el) el.textContent = t.dataset.t;
    } else if (act === "stat-aggiorna") {
      caricaStatistiche(parolaStat()).then(rerender).catch((e) => toast(e.message || "Non riuscito"));
    } else if (act === "stat-esci") {
      dimenticaStat(); rerender();
    } else if (act === "pb-togli") {
      delete (S.pb || {})[t.dataset.d]; salva(); toast("Personale tolto"); rerender();
    } else if (act === "letto") {
      S.letti = S.letti || {}; S.letti[t.dataset.k] = true; salva(); rerender();
    } else if (act === "rinvia") {
      S.rinvii[t.dataset.k] = L.addDays(oggi(), 1); salva(); toast("Te lo ricordo domani"); rerender();
    } else if (act === "filtro" || act === "filtro-soc") {
      const q = document.getElementById("cerca").value, h = location.hash;
      const d = act === "filtro" ? t.dataset.d : (h.match(/[?&]d=(\d*)/) || [])[1] || "";
      const soc = act === "filtro-soc" ? t.getAttribute("aria-pressed") !== "true" : /[?&]s=1/.test(h);
      location.hash = `#/gare?v=italia&q=${encodeURIComponent(q)}&d=${d}${soc ? "&s=1" : ""}`;
    } else if (act === "ris-strava-cerca") {
      const id = t.dataset.id; delete STRAVA_GIORNO[id]; if (S.stravaIgnora) delete S.stravaIgnora[id];
      const box = document.getElementById("ris-strava"); if (box) box.innerHTML = `<span class="small muted">Cerco su Strava…</span>`;
      stravaRisultato(id);
    } else if (act === "tempi-pb") {
      const d = t.dataset.d, r = tempoTrovato(t.dataset.id);
      if (!r) return;
      S.pb = S.pb || {}; S.pb[d] = { tempo: L.leggiTempo(d, r.tempo).tempo || r.tempo, secondi: r.secondi, gara: L.nomeRisultato(r), data: r.data, fonte: r.fonte };
      salva(); toast(`${L.DIST_LABEL[d]}: personale salvato`); rerender();
    } else if (act === "tempi-usa") {
      const r = tempoTrovato(t.dataset.id), g = S.gare.find((x) => x.id === t.dataset.gara);
      if (r && g && partecipo()) {
        const [nome, cognome, anno] = String(TEMPI.chiave || "").split("|");
        certificaRisultati({ nome, cognome, anno: anno ? Number(anno) : null, persone: TEMPI.scelti || [], risultati: [r.id] })
          .then((j) => { toast(esitoCertifica(j)); aggiornaClassifiche(); }).catch((e) => toast(e.message));
      }
      if (r && g) location.hash = `#/risultato/${encodeURIComponent(g.id)}?t=${encodeURIComponent(L.leggiTempo(g.distanza, r.tempo).tempo || r.tempo)}&f=${r.fonte}`;
    } else if (act === "tempi-riprova") {
      const { nome, cognome } = nomeTempi(), f = document.getElementById("tempi-cerca");
      cercaTempi(nome, cognome, f && f.dataset.anno ? Number(f.dataset.anno) : null);
    } else if (act === "archivia" || act === "riporta") {
      const g = S.gare.find((x) => x.id === t.dataset.id);
      if (g) { g.archiviata = act === "archivia" ? oggi() : null; if (!g.archiviata) delete g.archiviata; salva(); toast(act === "archivia" ? "Gara archiviata" : "Di nuovo tra le tue gare"); rerender(); }
    } else if (act === "esito") {
      const g = S.gare.find((x) => x.id === t.dataset.id), r = (S.risultati || {})[t.dataset.id];
      if (!g) return;
      const fai = () => {
        const esitoOnline = (e) => { if (partecipo() && DISTANZE.includes(g.distanza)) rpc("segna_esito", { p_token: token(), p: { data: g.data, distanza: g.distanza, esito: e, gara_nome: g.nome } }).then(aggiornaClassifiche).catch(() => {}); };
        if (g.esito === t.dataset.v && !r) { delete g.esito; delete g.esitoData; salva(); esitoOnline("nessuno"); toast("Esito tolto"); rerender(); return; }
        if (r) { delete S.risultati[g.id]; if (r.pb && S.pb && S.pb[g.distanza] && S.pb[g.distanza].data === g.data) { if (r.precedente) S.pb[g.distanza] = { ...r.precedente }; else delete S.pb[g.distanza]; } }
        g.esito = t.dataset.v; g.esitoData = oggi(); S.spunte[`${g.id}:P051`] = true; salva(); esitoOnline(g.esito);
        toast(`Segnata: ${ESITO[g.esito].toLowerCase()}. In archivio da domani`); location.hash = urlGara(g.id);
      };
      if (r) confirmBox(t, `Tolgo il tempo ${r.tempo} e segno «${ESITO[t.dataset.v]}»?`, fai); else fai();
    } else if (act === "rimuovi") {
      confirmBox(t, "Togli questa gara e la sua preparazione?", () => { S.gare = S.gare.filter((g) => g.id !== t.dataset.id); salva(); toast("Gara tolta"); location.hash = "#/gare"; });
    } else if (act === "del-scarpa") {
      S.scarpe = S.scarpe.filter((s) => s.id !== t.dataset.id); salva(); rerender();
    } else if (act === "prova-off") {
      S.prova = ""; salva(); toast("Torniamo a oggi"); rerender();
    } else if (act === "svuota-personali") {
      if (confirmBox(t, "Cancellare le tue voci personali?", () => { S.personali = []; salva(); rerender(); })) return;
    } else if (act === "reset-ask") {
      // Cancella anche quello che è online: iscrizione alle notifiche e profilo nel gruppo (l'account, se c'è, si cancella da Account).
      confirmBox(t, "Cancello gare, spunte, scarpe e documenti da questo telefono, e online la tua iscrizione alle notifiche, il tuo profilo nel gruppo e il collegamento a Strava?", async () => {
        if (S.gruppo && S.gruppo.dentro) {
          try { await rpc("esci_gruppo", { p_token: token() }); }
          catch (e) { if (/nomina prima/.test(e.message || "")) { toast("Sei l'unico amministratore del gruppo: nomina prima un altro amministratore (Gruppo → Gestisci)"); rerender(); return; } }
        }
        if (S.push && S.push.attivo) await disattivaPush(true);
        if (S.strava && S.strava.attivo) await funzioneStrava({ azione: "scollega" }).catch(() => {});
        fotoTogli("tessera").catch(() => {}); fotoTogli("certificato").catch(() => {});
        S = vuoto(); salva(); toast(AUTH ? "Dati cancellati. L'account resta: per cancellarlo vai in Io → Account" : "Dati cancellati"); location.hash = "#/oggi"; route();
      });
    } else if (act === "acc-rimanda") {
      chiamaAuth("otp", { email: ACC.email, create_user: true }).then(() => toast("Codice rimandato")).catch((e) => toast(e.message));
    } else if (act === "acc-cambia") {
      ACC.inviato = false; rerender();
    } else if (act === "acc-esci") {
      const tk = AUTH && AUTH.access; AUTH = null; salvaAuth(); STRAVA_STATO = null;
      if (tk) chiamaAuth("logout", {}, tk).catch(() => {});
      toast("Sei uscito dall'account"); rerender();
    } else if (act === "acc-cancella") {
      confirmBox(t, "Cancello l'account e tutto quello che è online: profilo nel gruppo, notifiche, Strava? I dati su questo telefono restano.", async () => {
        try { await rpcAccount("cancella_account", {}); } catch (e) { toast(e.message || "Non riuscito"); rerender(); return; }
        if (S.push && S.push.attivo) await disattivaPush(true);
        if (S.strava) scollegaLocale();
        S.gruppo = null; AUTH = null; salvaAuth(); STRAVA_STATO = null; salva(); toast("Account cancellato"); rerender();
      });
    } else if (act === "strava-collega") {
      t.disabled = true;
      funzioneStrava({ azione: "inizio", giaTester: t.dataset.gia === "1" }).then((r) => { if (r.pieno) { toast("I posti per i tester di Strava sono esauriti"); STRAVA_STATO = null; rerender(); } else location.href = r.url; })
        .catch((e) => { t.disabled = false; toast(e.message); });
    } else if (act === "strava-scollega") {
      confirmBox(t, "Scollego Strava? Scarpe e personali importati restano e diventano manuali.", () => {
        funzioneStrava({ azione: "scollega" }).catch(() => {}).then(() => { scollegaLocale(); STRAVA_STATO = null; toast("Strava scollegato"); rerender(); });
      });
    } else if (act === "strava-ricarica") {
      STRAVA_STATO = null; rerender();
    } else if (act === "strava-pb") {
      caricaPBStrava(); rerender();
    } else if (act === "strava-pb-salva" || act === "strava-pb-correggi") {
      const d = t.dataset.d, c = ((STRAVA_PB || {})[d] || []).find((x) => x.id === t.dataset.id);
      if (!c) return;
      if (act === "strava-pb-salva") { S.pb = S.pb || {}; S.pb[d] = { tempo: c.tempo, secondi: c.secondi, gara: c.nome, data: c.data, fonte: "strava" }; salva(); toast(`${L.DIST_LABEL[d]}: personale salvato`); rerender(); }
      else {
        const det = document.querySelector(`form[data-form="pb"][data-d="${d}"] details`);
        if (det) { det.open = true; riempiTempo(`pb-t-${d}`, c.tempo); document.getElementById(`pb-g-${d}`).value = c.nome; document.getElementById(`pb-d-${d}`).value = c.data; det.scrollIntoView({ block: "center" }); document.getElementById(`pb-t-${d}-h`).focus(); }
      }
    } else if (act === "ris-strava-usa") {
      riempiTempo("ris-tempo", t.dataset.t); toast("Tempo di Strava inserito: controlla e salva");
    } else if (act === "ris-strava-tieni") {
      S.stravaIgnora = { ...(S.stravaIgnora || {}), [t.dataset.id]: true }; salva(); const b = document.getElementById("ris-strava"); if (b) b.innerHTML = "";
    } else if (act === "arch-del") {
      S.scarpeArchivio = (S.scarpeArchivio || []).filter((x) => x.id !== t.dataset.id); salva(); rerender();
    }
  });
  async function azioneGruppo(fn, msg) {
    try { await fn(); if (msg) toast(msg); await aggiornaGruppo(true); rerender(); }
    catch (e) { toast(e.message || "Non riuscito"); rerender(); }
  }
  function copia(testo, cosa = "Link") {
    (navigator.clipboard ? navigator.clipboard.writeText(testo) : Promise.reject()).then(() => toast(`${cosa} copiato`)).catch(() => toast("Tieni premuto sul testo per copiarlo"));
  }
  function confirmBox(anchor, domanda, si) {
    const box = document.createElement("div");
    box.className = "card soft"; box.setAttribute("role", "alertdialog");
    box.innerHTML = `<span class="small"><b>${esc(domanda)}</b></span><div class="grid2"><button class="btn" type="button">Sì</button><button class="btn ghost" type="button">No</button></div>`;
    anchor.replaceWith(box);
    const [ok, no] = box.querySelectorAll("button");
    ok.addEventListener("click", si); no.addEventListener("click", rerender);
    ok.focus();
    return true;
  }

  document.addEventListener("change", (e) => {
    if (e.target.dataset && (e.target.dataset.actChange === "scarpa-uso" || e.target.dataset.actChange === "scarpa-limite")) {
      const sc = S.scarpe.find((x) => x.id === e.target.dataset.id);
      if (sc) { if (e.target.dataset.actChange === "scarpa-uso") sc.tipo = e.target.value; else sc.limite = Math.max(300, Number(e.target.value) || 800); salva(); rerender(); }
    } else if (e.target.dataset && e.target.dataset.actChange === "scarpa-gara") {
      const g = S.gare.find((x) => x.id === e.target.dataset.gara);
      if (g) { if (e.target.value) g.scarpa = e.target.value; else delete g.scarpa; salva(); toast(e.target.value ? "Scarpe della gara scelte" : "Scelta tolta"); rerender(); }
    } else if (e.target.dataset && e.target.dataset.actChange === "tempi-persona") {
      if (!TEMPI || !TEMPI.persone) return;
      const id = e.target.dataset.id, sc = new Set(TEMPI.scelti || []);
      if (e.target.checked) sc.add(id); else sc.delete(id);
      TEMPI.scelti = [...sc]; S.tempi = { ...(S.tempi || {}), scelti: TEMPI.scelti }; salva(); rerender();
    } else if (e.target.dataset && e.target.dataset.actChange === "cnd-flag") {
      CND[e.target.dataset.k] = e.target.checked; disegnaAnteprima();
    } else if (e.target.id === "cnd-foto" && e.target.files && e.target.files[0]) {
      const url = URL.createObjectURL(e.target.files[0]);
      caricaImg(url).then((im) => { CND.foto = im; CND.stile = "foto"; rerender(); }).catch(() => toast("Non riesco ad aprire la foto"));
    } else if (e.target.dataset && e.target.dataset.actChange === "g-ruolo") {
      azioneGruppo(() => rpc("admin_ruolo", { p_token: token(), p_membro: e.target.dataset.id, p_ruolo: e.target.value }), "Ruolo aggiornato");
    } else if (e.target.dataset && e.target.dataset.actChange === "rec-tog") {
      if (e.target.checked) REC_NO.delete(e.target.dataset.id); else REC_NO.add(e.target.dataset.id);
      rerender();
    } else if (e.target.id === "cl-gruppo") {
      const on = e.target.checked;
      azioneGruppo(async () => { await rpc("admin_classifiche", { p_token: token(), p_on: on }); await aggiornaClassifiche(); }, on ? "Classifiche accese: ognuno sceglie se partecipare" : "Classifiche spente per il gruppo");
    } else if (e.target.id === "cl-partecipo") {
      if (e.target.checked) { location.hash = "#/entra/classifiche"; return; }
      e.target.checked = true;
      confirmBox(e.target.closest("label"), "Esci dalle classifiche? I tuoi risultati online si cancellano; sul telefono restano.", () =>
        azioneGruppo(async () => { await rpc("partecipa_classifiche", { p_token: token(), p_on: false }); await aggiornaClassifiche(); }, "Non partecipi più alle classifiche"));
    } else if (e.target.id === "io-mostra-pb") {
      const on = e.target.checked;
      azioneGruppo(async () => { await rpc("imposta_mostra_pb", { p_token: token(), p_mostra: on }); if (on) await sincronizzaPBGruppo(true); }, on ? "I tuoi personali sono in classifica" : "I tuoi personali non sono più in classifica");
    } else if (e.target.id === "io-mostra") {
      azioneGruppo(async () => { await rpc("aggiorna_profilo", { p_token: token(), p_nome: null, p_mostra: e.target.checked }); if (e.target.checked) await sincronizzaGareGruppo(); }, e.target.checked ? "Il gruppo vede le tue gare" : "Le tue gare ora sono private");
    }
  });
  // Documenti: salvataggio automatico dei campi e delle foto.
  document.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.docf) {
      const [k, f] = el.dataset.docf.split(":"); doc(k)[f] = f === "codiceSocieta" || f === "numero" ? el.value.trim().toUpperCase() : el.value.trim(); salva(); toast("Salvato");
      if (f === "tipo" || f === "scadenza" || f === "numero") rerender();
    } else if (el.dataset && el.dataset.carica && el.files && el.files[0]) {
      const k = el.dataset.carica;
      try { await caricaFile(k, el.files[0]); toast(`${DOCS[k]} salvato sul telefono`); if (!document.getElementById("prepara-form")) { rerender(); mostraFotoDoc(); } else { const lab = el.closest("label"); if (lab) lab.firstChild.textContent = "📎 Sostituisci il certificato (foto o PDF)"; } }
      catch (err) { toast("Non riesco a salvare il file"); }
      el.value = "";
    } else if (el.dataset && el.dataset.scan && el.files && el.files[0]) {
      const k = el.dataset.scan, nelFunnel = !!document.getElementById("prepara-form"), pdf = /pdf/i.test(el.files[0].type) || /\.pdf$/i.test(el.files[0].name || "");
      const stato = (t) => { const x = document.querySelector(`[data-scan-stato="${k}"]`); if (x) x.textContent = t; };
      el.closest("label").classList.add("disabled");
      try {
        const r = await scansiona(k, el.files[0], stato);
        const letti = descriviLetti(r, k);
        const dm = document.querySelector(".doc-mano");
        if (!letti) { if (dm) dm.open = true; stato("Non sono riuscito a leggere i dati: inseriscili a mano. La foto è salvata."); return; }
        if (dm) { dm.open = true; const sm = dm.querySelector("summary"); if (sm) sm.textContent = "Controlla i dati e vai avanti"; }
        const d = doc(k);
        if (r.tipo) d.tipo = r.tipo;
        if (r.certificato) { const c = doc("certificato"); if (r.certificato.tipo) c.tipo = r.certificato.tipo; if (!nelFunnel && r.certificato.scadenza) c.scadenza = r.certificato.scadenza; }
        if (nelFunnel) { // campi da confermare con "Avanti"
          const metti = (id, val) => { const f = document.getElementById(id); if (f && val) f.value = val; };
          if (k === "tessera") { metti("pf-tipo", r.tipo); metti("pf-numero", r.numero); metti("pf-tess-scadenza", r.scadenza); metti("pf-codice", r.codiceSocieta); metti("pf-societa", r.societa); metti("pf-cert-scadenza", r.certificato && r.certificato.scadenza); }
          else metti("pf-cert-scadenza", r.scadenza);
          salva();
          const manca = k === "tessera" && !(r.certificato && r.certificato.scadenza) ? " La scadenza del certificato non si legge: inseriscila a mano (con il PDF del tesserino la lettura è esatta)." : "";
          stato(`Letti ${pdf ? "dal PDF" : "dalla foto"}: ${letti}. Controlla e correggi se serve.${manca}${r.calcolata ? (k === "tessera" ? (r.tipo === "FIDAL" ? " La scadenza della tessera è calcolata: la FIDAL vale fino al 31 dicembre dell'anno stampato sul tesserino." : " La scadenza è calcolata: 12 mesi dall'emissione.") : " La scadenza è calcolata: un anno dalla visita.") : ""}`);
        } else {
          if (r.numero) d.numero = r.numero;
          if (r.scadenza) d.scadenza = r.scadenza;
          if (r.societa) d.societa = r.societa;
          if (r.codiceSocieta) d.codiceSocieta = r.codiceSocieta;
          salva(); rerender(); mostraFotoDoc();
          toast(`Letti ${pdf ? "dal PDF" : "dalla foto"}: ${letti}. Controllali${r.calcolata ? " (scadenza calcolata)" : ""}`);
        }
      } catch (err) {
        stato("Non riesco a leggere la foto adesso: inserisci i dati a mano. La foto è salvata.");
      } finally { const lab = el.closest("label"); if (lab) lab.classList.remove("disabled"); el.value = ""; }
    } else if (el.dataset && el.dataset.docfoto && el.files && el.files[0]) {
      try { await fotoSalva(el.dataset.docfoto, await comprimi(el.files[0])); doc(el.dataset.docfoto).foto = true; salva(); toast("Foto salvata sul telefono"); rerender(); }
      catch (err) { toast("Non riesco a salvare la foto"); }
    }
  });
  // Profilo: salvataggio automatico quando lasci un campo.
  document.addEventListener("change", (e) => {
    const k = e.target.dataset && e.target.dataset.auto;
    if (!k) return;
    let val = e.target.value.trim();
    if (k === "kmSettimana") val = val ? String(Math.min(250, Math.max(1, Math.round(Number(val) || 0)))) : "";
    if ((S.profilo[k] || "") === val) return;
    S.profilo = { ...S.profilo, [k]: val };
    if (k === "citta") delete S.profilo.coord;
    salva();
    // Il nome del profilo è anche il nome con cui ti vede il gruppo
    if (k === "nome" && val && S.gruppo && S.gruppo.dentro) azioneGruppo(() => rpc("aggiorna_profilo", { p_token: token(), p_nome: val.slice(0, 40), p_mostra: null }), "Salvato, anche nel gruppo");
    else toast("Salvato");
    if (k === "kmSettimana" && !e.target.closest("#profilo")) rerender();
  });

  // Caselle del tempo: solo cifre, si passa da sole alla casella dopo, il tasto cancella su una casella vuota torna indietro.
  const caselleTempo = (el) => (el && el.closest && el.closest(".tempo3") ? [...el.closest(".tempo3").querySelectorAll("input")] : null);
  // Buddy: la casella cresce mentre si scrive (fino a 5 righe)
  document.addEventListener("input", (e) => {
    if (e.target.id !== "buddy-testo") return;
    e.target.style.height = "auto"; e.target.style.height = Math.min(140, e.target.scrollHeight) + "px";
  });
  document.addEventListener("input", (e) => {
    const tutte = caselleTempo(e.target);
    if (!tutte) return;
    const el = e.target, pulito = el.value.replace(/\D/g, "").slice(0, el.maxLength);
    if (pulito !== el.value) el.value = pulito;
    const dopo = tutte[tutte.indexOf(el) + 1];
    if (pulito.length === el.maxLength && dopo) dopo.focus();
  });
  document.addEventListener("keydown", (e) => {
    const tutte = caselleTempo(e.target);
    if (!tutte || e.key !== "Backspace" || e.target.value) return;
    const prima = tutte[tutte.indexOf(e.target) - 1];
    if (prima) { e.preventDefault(); prima.focus(); }
  });
  document.addEventListener("focusin", (e) => { if (caselleTempo(e.target)) e.target.select(); });

  let timer;
  document.addEventListener("input", (e) => {
    if (e.target.id !== "cerca") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const d = (location.hash.match(/[?&]d=(\d*)/) || [])[1] || "", soc = /[?&]s=1/.test(location.hash) && !!document.querySelector('[data-act="filtro-soc"]');
      document.getElementById("risultati").innerHTML = risultatiItalia(e.target.value, d, soc, oggi());
      history.replaceState(null, "", `#/gare?v=italia&q=${encodeURIComponent(e.target.value)}&d=${d}${soc ? "&s=1" : ""}`);
    }, 150);
  });

  let timerMie;
  document.addEventListener("input", (e) => {
    if (e.target.id === "mie-cerca") {
      clearTimeout(timerMie);
      timerMie = setTimeout(() => {
        const box = document.getElementById("mie-lista"); if (!box || !partecipo()) return;
        const p = box.dataset.p, da = (location.hash.match(/[?&]da=(\w+)/) || [])[1] || "";
        box.innerHTML = listaMie(e.target.value.trim(), p);
        history.replaceState(null, "", `#/gruppo/mie?p=${p}${da ? `&da=${da}` : ""}${e.target.value.trim() ? `&q=${encodeURIComponent(e.target.value.trim())}` : ""}`);
      }, 150);
    } else if (e.target.id === "gm-cerca") {
      clearTimeout(timerMie);
      timerMie = setTimeout(() => {
        const v = e.target.value.trim(), box = document.getElementById("gm-lista");
        const m = box ? box.dataset.m : (location.hash.match(/[?&]m=([^&]+)/) || [])[1] || "", p = box ? box.dataset.p : /[?&]p=tutte/.test(location.hash) ? "tutte" : "stagione";
        const url = `#/gruppo/gare?p=${p}${m ? `&m=${encodeURIComponent(decodeURIComponent(m))}` : ""}${v ? `&q=${encodeURIComponent(v)}` : ""}`;
        if (box && (m || v)) { box.innerHTML = listaGM(v, p, decodeURIComponent(m)); history.replaceState(null, "", url); }
        else { history.replaceState(null, "", url); rerender(); const f = document.getElementById("gm-cerca"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
      }, 150);
    } else if (e.target.id === "gs-cerca") {
      clearTimeout(timerMie);
      timerMie = setTimeout(() => {
        const box = document.getElementById("gs-risultati"); if (!box) return;
        box.innerHTML = listaCandidatiSoc(e.target.value);
        history.replaceState(null, "", `#/gruppo/societa${e.target.value.trim() ? `?q=${encodeURIComponent(e.target.value.trim())}` : ""}`);
      }, 150);
    } else if (e.target.id === "ma-nome") {
      // nome di una gara dell'app: data e distanza si compilano da sole
      const g = (S.gare || []).find((x) => x.nome === e.target.value && DISTANZE.includes(x.distanza) && x.data <= oggi());
      if (!g) return;
      const d = document.getElementById("ma-data"), ds = document.getElementById("ma-dist");
      if (d) d.value = g.data; if (ds) ds.value = g.distanza;
      const r = (S.risultati || {})[g.id], h = document.getElementById("ma-tempo-h");
      if (r && r.secondi && h && !h.value) { const [a, b, c] = hms(r.secondi).split(":"); h.value = a; document.getElementById("ma-tempo-m").value = b; document.getElementById("ma-tempo-s").value = c; }
    }
  });

  document.addEventListener("submit", (e) => {
    const f = e.target; e.preventDefault();
    const v = (id) => (document.getElementById(id) || {}).value || "";
    if (f.id === "buddy-form") { inviaBuddy(v("buddy-testo")); return; }
    if (f.id === "prepara-form") {
      const passo = f.dataset.passo;
      if (passo === "uscita" && !v("pf-citta").trim() && !S.profilo.coord) { toast("Scrivi la città o usa la posizione"); return; }
      if (passo === "ora" || passo === "uscita") S.profilo = { ...S.profilo, ora: v("pf-ora") };
      if (passo === "uscita" && v("pf-citta").trim()) { const c = v("pf-citta").trim(); if (c !== (S.profilo.citta || "")) { S.profilo = { ...S.profilo, citta: c }; delete S.profilo.coord; } }
      else if (passo === "zona") { const c = v("pf-citta").trim(); if (c !== (S.profilo.citta || "")) { S.profilo = { ...S.profilo, citta: c }; delete S.profilo.coord; } }
      else if (passo === "documenti") {
        const t = doc("tessera"); t.tipo = v("pf-tipo"); t.numero = v("pf-numero").trim().toUpperCase(); t.scadenza = v("pf-tess-scadenza");
        t.codiceSocieta = v("pf-codice").trim().toUpperCase(); t.societa = v("pf-societa").trim();
        const c = doc("certificato"); c.scadenza = v("pf-cert-scadenza"); c.tipo = c.tipo || "agonistico (atletica leggera)";
      }
      salva(); if (f.dataset.funnel === "entra") vaiEntra(passo); else vaiPasso(passo); return;
    }
    if (f.id === "entra-gare") {
      const scelte = [...f.querySelectorAll('input[name="eg"]:checked')];
      if (!scelte.length) { toast("Tocca «Ci sono» su una gara, oppure «Non ho gare in programma»"); return; }
      const comuni = gareInComune(), nuove = [];
      for (const cb of scelte) {
        const g = comuni.find((x) => x.gara_id === cb.value); if (!g) continue;
        const t = DISTANZE.includes(g.distanza) ? leggiTempoFacoltativo(`eg-${cb.dataset.i}`, g.distanza) : { tempo: "" };
        if (t.errore) { toast(`${titoloGara(g.nome)}: ${t.errore}`); return; }
        nuove.push({ id: g.gara_id, nome: g.nome, data: g.data, luogo: g.luogo || "", distanza: g.distanza, tempo: t.tempo });
      }
      for (const g of nuove) {
        const ruolo = S.gare.some((x) => x.ruolo === "obiettivo" && x.data >= oggi()) ? "tappa" : "obiettivo";
        S.gare = S.gare.filter((x) => x.id !== g.id); S.gare.push({ ...g, ruolo, aggiunta: oggi() });
        segnalaGara(S.gare[S.gare.length - 1], g.id.startsWith("M") ? "manuale" : "FIDAL");
      }
      salva(); sincronizzaGareGruppo(); toast(nuove.length === 1 ? "Gara aggiunta: la preparazione è pronta" : `${nuove.length} gare aggiunte`); vaiEntra("gara"); return;
    }
    if (f.id === "manuale") {
      const id = "M" + Date.now().toString(36);
      S._bozza = { id, nome: v("m-nome"), data: v("m-data"), distanza: v("m-dist"), luogo: v("m-luogo"), fonte: "manuale" };
      salva(); location.hash = `#/aggiungi/${id}`;
    } else if (f.id === "aggiungi") {
      const id = f.dataset.id;
      const base = D.gare.find((x) => x.id === id) || (D.estero || []).find((x) => x.id === id) || S._bozza;
      const ruolo = (f.querySelector('input[name="ruolo"]:checked') || {}).value || "obiettivo";
      const ta = leggiTempoFacoltativo("a-tempo", base.distanza);
      if (ta.errore) { toast(ta.errore); return; }
      S.gare = S.gare.filter((g) => g.id !== id);
      S.gare.push({ id, nome: base.nome, data: base.data, luogo: base.luogo || "", distanza: base.distanza, ruolo, tempo: ta.tempo, aggiunta: oggi() });
      S.mirino = (S.mirino || []).filter((x) => x.id !== id); S.introEstere = { ...(S.introEstere || {}), [id]: true };
      if (v("a-citta")) S.profilo.citta = v("a-citta");
      if (v("a-ora")) S.profilo.ora = v("a-ora");
      delete S._bozza; salva(); toast("Preparazione creata");
      segnalaGara(S.gare[S.gare.length - 1], base.fonte);
      location.hash = urlGara(id);
    } else if (f.id === "g-codice") {
      const c = (v("g-cod").match(/([A-Z2-9]{8})\s*$/i) || [])[1];
      if (c) location.hash = `#/invito/${c.toUpperCase()}`; else toast("Codice non valido: sono 8 caratteri");
    } else if (f.id === "g-entra" && f.dataset.anteprima) {
      location.hash = "#/entra";
    } else if (f.id === "g-crea" || f.id === "g-entra") {
      const nome = v("g-io").trim(), btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      (async () => {
        try {
          if (f.id === "g-crea") await rpc("crea_gruppo", { p_token: token(), p_gruppo: v("g-nome").trim(), p_nome: nome });
          else await rpc("entra_gruppo", { p_token: token(), p_codice: f.dataset.codice, p_nome: nome, p_mostra: (document.getElementById("g-mostra") || { checked: true }).checked });
          G().dentro = true; if (f.id === "g-entra") { S.profilo.nome = nome; S.benvenuto = true; G().entra = { dal: oggi(), saltati: {} }; } else if (!S.profilo.nome) S.profilo.nome = nome; salva();
          const pbNo = document.getElementById("g-mostra-pb") && !document.getElementById("g-mostra-pb").checked;
          if (pbNo) await rpc("imposta_mostra_pb", { p_token: token(), p_mostra: false }).catch(() => {});
          await sincronizzaGareGruppo(); if (!pbNo) await sincronizzaPBGruppo(true); await aggiornaGruppo(true); await aggiornaClassifiche();
          document.body.classList.remove("onboarding");
          toast(f.id === "g-crea" ? "Gruppo creato: ora invita gli altri" : "Benvenuto nel gruppo!");
          location.hash = f.id === "g-crea" ? "#/gruppo/admin" : "#/entra";
        } catch (e) { btn.disabled = false; toast(e.message || "Non riuscito"); }
      })();
    } else if (f.id === "g-rinomina") {
      azioneGruppo(() => rpc("admin_gruppo", { p_token: token(), p_nome: v("g-nn").trim(), p_nuovo_codice: false }), "Nome aggiornato");
    } else if (f.id === "tempi-cerca") {
      const nome = v("tc-nome").trim().replace(/\s+/g, " "), cognome = v("tc-cognome").trim().replace(/\s+/g, " ");
      if (!nome || !cognome) { toast("Scrivi nome e cognome"); return; }
      const cambiato = (S.tempi || {}).nome !== nome || (S.tempi || {}).cognome !== cognome;
      S.tempi = { nome, cognome, scelti: cambiato ? [] : (S.tempi || {}).scelti || [] }; salva();
      cercaTempi(nome, cognome, f.dataset.anno ? Number(f.dataset.anno) : null);
    } else if (f.id === "gs-mano") {
      const nome = v("gm-nome").trim(), data = v("gm-data"), dist = v("gm-dist");
      if (!nome || !/^\d{4}-\d{2}-\d{2}$/.test(data)) { toast("Scrivi nome e data della gara"); return; }
      const btn = f.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
      rpc("gare_societa_aggiungi", { p_token: token(), p: { data, distanza: dist, nome } })
        .then(async () => { toast("Aggiunta alle gare della società"); await aggiornaClassifiche(); rerender(); })
        .catch((e) => { if (btn) btn.disabled = false; toast(e.message || "Non riuscito"); });
    } else if (f.id === "eta-form") {
      const a = v("eta-anno").trim(), sx = v("eta-sesso");
      const btn = f.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
      rpc("dati_eta", { p_token: token(), p_anno: a ? Number(a) : null, p_sesso: sx || null })
        .then(async () => { toast("Salvato: le percentuali si ricalcolano"); await aggiornaClassifiche(); rerender(); })
        .catch((e) => { if (btn) btn.disabled = false; toast(e.message || "Non riuscito"); });
    } else if (f.id === "mie-aggiungi") {
      const nome = v("ma-nome").trim().replace(/\s+/g, " "), data = v("ma-data"), dist = v("ma-dist"), link = v("ma-link").trim();
      if (!nome) { toast("Scrivi il nome della gara"); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) { toast("Scegli la data della gara"); return; }
      if (data > oggi()) { toast("Si aggiungono solo le gare già corse"); return; }
      const lt = leggiCampoTempo("ma-tempo", dist);
      if (lt.errore) { toast(lt.errore); return; }
      if (!L.registrabile(CL().io, data, oggi())) { toast("Gara corsa prima della tua adesione: dopo i primi 30 giorni si aggiungono solo le gare nuove"); return; }
      if ((CL().miei || []).some((x) => x.data === data && x.distanza === dist && x.stato === "certificato")) { toast("Questa gara ha già un tempo certificato"); return; }
      if (link && !/^https?:\/\//i.test(link)) { toast("Il link deve iniziare con https://"); return; }
      const btn = f.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
      rpc("invia_risultato", { p_token: token(), p: { data, distanza: dist, tempo: lt.tempo, gara_nome: nome, link, nota: v("ma-nota").trim() } })
        .then(async () => { toast("Mandata al referente: la trovi «In approvazione»"); await aggiornaClassifiche(); if (location.hash === "#/gruppo/mie") rerender(); else location.hash = "#/gruppo/mie"; window.scrollTo(0, 0); })
        .catch((e) => { if (btn) btn.disabled = false; toast(e.message || "Non riuscito"); });
    } else if (f.id === "cl-invia") {
      const g = S.gare.find((x) => x.id === f.dataset.id), r = g && (S.risultati || {})[g.id];
      if (!g || !r || !r.tempo) return;
      const link = v("cl-link").trim();
      if (link && !/^https?:\/\//i.test(link)) { toast("Il link deve iniziare con https://"); return; }
      const btn = f.querySelector("button[type=submit]"); if (btn) btn.disabled = true;
      rpc("invia_risultato", { p_token: token(), p: { data: g.data, distanza: g.distanza, tempo: L.leggiTempo(g.distanza, r.tempo).tempo || r.tempo, gara_nome: g.nome, link, nota: v("cl-nota").trim() } })
        .then(async () => { toast("Mandato al referente"); await aggiornaClassifiche(); rerender(); })
        .catch((e) => { if (btn) btn.disabled = false; toast(e.message || "Non riuscito"); });
    } else if (f.id === "risultato") {
      const id = f.dataset.id, g = S.gare.find((x) => x.id === id);
      const lt = g ? leggiCampoTempo("ris-tempo", g.distanza) : { errore: "Gara non trovata" };
      if (lt.errore) { toast(lt.errore); return; }
      const tempo = lt.tempo, sec = lt.secondi;
      S.pb = S.pb || {}; S.risultati = S.risultati || {};
      // Il confronto è con il personale di PRIMA di questa gara: se la si risalva (o corregge), non si confronta con sé stessa.
      const r0 = S.risultati[id], att = S.pb[g.distanza];
      const daQuesta = att && att.gara === g.nome && att.data === g.data;
      const prec = r0 && "precedente" in r0 ? r0.precedente : daQuesta ? null : att || null;
      const pb = !prec || sec < prec.secondi;
      const scelto = (k) => (f.querySelector(`input[name="deb-${k}"]:checked`) || {}).value || "";
      const debrief = { rifornimento: scelto("rifornimento"), scarpe: scelto("scarpe"), fastidi: scelto("fastidi"), nota: v("deb-nota").trim() };
      S.risultati[id] = { tempo, secondi: sec, testo: v("ris-testo").trim(), pb, precedente: prec ? { tempo: prec.tempo, secondi: prec.secondi, gara: prec.gara || "", data: prec.data || "" } : null, salvato: (r0 && r0.salvato) || oggi(), ...(Object.values(debrief).some(Boolean) ? { debrief } : {}) };
      delete g.esito; delete g.esitoData;
      if (pb) S.pb[g.distanza] = { tempo, secondi: sec, gara: g.nome, data: g.data };
      else if (daQuesta && prec) S.pb[g.distanza] = { ...prec }; // corretto al ribasso: torna il personale di prima
      S.spunte[`${id}:P051`] = true; salva();
      // La bacheca del gruppo è nascosta per ora: il risultato resta sul telefono, il personale va in classifica con sincronizzaPBGruppo.
      toast(pb && prec ? `Nuovo personale! −${fmtDiff(prec.secondi - sec)}` : pb ? "Primo tempo registrato" : "Tempo salvato");
      location.hash = `#/condividi/${encodeURIComponent(id)}`;
    } else if (f.id === "gara-imp") {
      const g = S.gare.find((x) => x.id === f.dataset.id);
      const tg = g ? leggiTempoFacoltativo("gi-tempo", g.distanza) : {};
      if (tg.errore) { toast(tg.errore); return; }
      if (g) { g.ruolo = v("gi-ruolo") || g.ruolo; g.tempo = tg.tempo; salva(); toast("Salvato"); location.hash = urlGara(g.id); }
    } else if (f.id === "scheda") {
      const g = S.gare.find((x) => x.id === f.dataset.id);
      if (g) {
        const uff = (D.schede || {})[g.id] || {};
        g.info = {}; CAMPI.forEach(([k]) => {
          const val = v("i-" + k).trim();
          if (k === "partenza") { const u = oraInput((String(uff.partenza || "").match(/\d{1,2}[:.]\d{2}/) || [""])[0]); if (val && val !== u) g.info.partenza = val; return; } // orario dall'orologio, confrontato con quello ufficiale
          if (val && val !== uff[k]) g.info[k] = val;
        });
        salva(); toast("Info gara salvate");
        location.hash = urlGara(g.id, "info");
      }
    } else if (f.id === "personale") {
      const t = v("p-voce").trim(); if (!t) return;
      S.personali.push({ id: "U" + Date.now().toString(36), titolo: t }); salva(); rerender();
    } else if (f.id === "profilo") {
      document.activeElement && document.activeElement.blur();
    } else if (f.id === "scarpa") {
      S.scarpe.push({ id: "S" + Date.now().toString(36), nome: v("s-nome").trim(), tipo: v("s-tipo"), km: Number(v("s-km")) || 0, limite: Math.max(300, Number(v("s-lim")) || 800) }); annotaKm(S.scarpe[S.scarpe.length - 1]); salva(); toast("Scarpa aggiunta"); rerender();
    } else if (f.id === "acc-email") {
      const btn = f.querySelector("button[type=submit]"), email = v("acc-mail").trim().toLowerCase(); btn.disabled = true;
      chiamaAuth("otp", { email, create_user: true }).then(() => { ACC.email = email; ACC.inviato = true; rerender(); setTimeout(() => { const c = document.getElementById("acc-cod"); if (c) c.focus(); }, 50); })
        .catch((e) => { btn.disabled = false; toast(e.message); });
    } else if (f.id === "acc-codice") {
      const btn = f.querySelector("button[type=submit]"), cod = v("acc-cod").replace(/\D/g, ""); btn.disabled = true;
      chiamaAuth("verify", { type: "email", email: ACC.email, token: cod }).then(async (j) => { salvaSessione(j); ACC.inviato = false; await dopoLogin(); rerender(); })
        .catch((e) => { btn.disabled = false; toast(e.message); });
    } else if (f.id === "stat-accesso") {
      const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      caricaStatistiche(v("stat-pw"), document.getElementById("stat-ricorda").checked).then(rerender)
        .catch((e) => { btn.disabled = false; toast(/errata/.test(e.message || "") ? "Parola d'ordine errata" : e.message || "Non riuscito"); });
    } else if (f.dataset.form === "pb") {
      const d = f.dataset.d, lt = leggiCampoTempo(`pb-t-${d}`, d);
      if (lt.errore) { toast(lt.errore); return; }
      S.pb = S.pb || {};
      S.pb[d] = { tempo: lt.tempo, secondi: lt.secondi, gara: v(`pb-g-${d}`).trim(), data: v(`pb-d-${d}`) };
      salva(); toast("Personale salvato"); rerender();
    } else if (f.dataset.form === "km") {
      const s = S.scarpe.find((x) => x.id === f.dataset.id); const km = Number(f.querySelector("input").value);
      if (s && km > 0) { annotaKm(s); s.km = Math.round((Number(s.km) + km) * 10) / 10; annotaKm(s); salva(); toast(`+${km} km`); rerender(); }
    } else if (f.id === "prova") {
      S.prova = v("d-prova"); salva(); toast(S.prova ? "Modalità prova attiva" : "Torniamo a oggi"); location.hash = "#/oggi";
    }
  });

  document.addEventListener("toggle", (e) => {
    const k = e.target.dataset && e.target.dataset.acc;
    if (k) { S.ioAperto = { ...(S.ioAperto || {}), [k]: e.target.open }; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (err) { /* niente */ } }
  }, true);
  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

  // Swipe tra le sezioni della gara (Panoramica · Preparazione · Info gara · Borsa), come toccare la barra a segmenti.
  // Non parte da campi, dalla barra stessa o da elementi che scorrono in orizzontale. Regole in L.sezioneSwipe (testate).
  let tocco = null;
  const scorreInOrizzontale = (el) => {
    for (; el && el !== $app; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) return true;
    }
    return false;
  };
  $app.addEventListener("touchstart", (e) => {
    tocco = null;
    if (e.touches.length !== 1 || !$app.querySelector('nav.seg[aria-label="Sezioni della gara"]')) return;
    if (e.target.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, select, .seg, [data-noswipe]') || scorreInOrizzontale(e.target)) return;
    const p = e.touches[0];
    tocco = { x: p.clientX, y: p.clientY, t: Date.now() };
  }, { passive: true });
  $app.addEventListener("touchend", (e) => {
    if (!tocco || !e.changedTouches.length) return;
    const p = e.changedTouches[0], dx = p.clientX - tocco.x, dy = p.clientY - tocco.y, ms = Date.now() - tocco.t;
    tocco = null;
    const m = location.hash.match(/^#\/gara\/([^/?]+)(?:\/([^/?]*))?/);
    if (!m) return;
    const dove = L.sezioneSwipe(m[2] || "", dx, dy, ms);
    if (dove === null) return;
    entrata = dx < 0 ? "da-destra" : "da-sinistra";
    location.replace(urlGara(decodeURIComponent(m[1]), dove)); // replace: la freccia indietro resta quella della barra
  }, { passive: true });
  $app.addEventListener("touchcancel", () => { tocco = null; }, { passive: true });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  // iPhone fuori dalla Home: banner fisso che spiega come aggiungere RaceBuddy alla schermata Home
  // (su Android ci pensa il banner di installazione di Chrome). "✕" lo nasconde per 7 giorni.
  const ICO_CONDIVIDI = `<svg aria-label="Condividi" role="img" width="16" height="18" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M8 13V2M4.5 5.5 8 2l3.5 3.5M5 8H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-2"/></svg>`;
  function bannerHome() {
    const vecchio = document.getElementById("banner-home");
    const nascosto = S.bannerHomeDopo && S.bannerHomeDopo > L.todayISO();
    if (!iOS || standalone() || nascosto || /^#\/(invito|entra)/.test(location.hash)) { if (vecchio) vecchio.remove(); document.body.classList.remove("con-banner-home"); return; }
    if (vecchio) return;
    const webview = !/Safari\//.test(navigator.userAgent); // browser interno di Instagram, Facebook…: lì non si può aggiungere alla Home
    const el = document.createElement("aside");
    el.id = "banner-home"; el.className = "banner-home"; el.setAttribute("aria-label", "Aggiungi RaceBuddy alla schermata Home");
    el.innerHTML = `<img src="apple-touch-icon.png" alt="" width="44" height="44"><div style="flex:1;min-width:0"><b>Metti RaceBuddy nella Home</b><br>
      <span>${webview ? "Apri questa pagina in <b>Safari</b> (menu ··· → Apri nel browser), poi aggiungila alla schermata Home." : `Tocca ${ICO_CONDIVIDI} <b>Condividi</b>, poi <b>Aggiungi alla schermata Home</b>. Si apre come un'app e ricevi le notifiche.`}</span></div>
      <button class="banner-chiudi" type="button" aria-label="Chiudi, ricordamelo tra una settimana">✕</button>`;
    el.querySelector("button").addEventListener("click", () => { S.bannerHomeDopo = L.addDays(L.todayISO(), 7); salva(); bannerHome(); });
    document.body.appendChild(el); document.body.classList.add("con-banner-home");
  }
  carica().then(() => { bannerHome(); route(); contaApertura(); if (C().strava) aggiornaScarpeStrava(); S.gare.forEach((g) => segnalaGara(g, g.id.startsWith("M") ? "manuale" : "FIDAL")); if (S.push && S.push.attivo) sincronizzaPush(); if (S.gruppo && S.gruppo.dentro) { aggiornaGruppo(true).then(() => sincronizzaPBGruppo()); sincronizzaGareGruppo(); } });
})();
