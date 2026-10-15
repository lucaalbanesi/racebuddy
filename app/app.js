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
    if (S.gruppo && S.gruppo.dentro) { clearTimeout(timerGareGruppo); timerGareGruppo = setTimeout(() => { sincronizzaGareGruppo(); sincronizzaPBGruppo(); }, 2500); }
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
      [D.schede, D.contenuti, D.sorrisi, D.novita, D.sfondi] = await Promise.all([opz("content/schede.json", {}), opz("data/contenuti.json", { contenuti: [] }).then((x) => x.contenuti || []), opz("content/sorrisi.json", []), opz("data/novita_gare.json", { novita: [] }).then((x) => x.novita || []), opz("content/sfondi.json", {})]);
    } catch (e) {
      D.errore = "Non riesco a caricare i contenuti. Controlla la connessione e ricarica.";
    }
  }

  // ---------------------------------------------------------------- meteo (Open-Meteo, gratuito, senza chiave)
  // Luogo dell'utente: coordinate dal GPS se le ha date, altrimenti il nome della città.
  const mioLuogo = () => (S.profilo.coord ? { ...S.profilo.coord, nome: S.profilo.citta } : S.profilo.citta);
  async function coordinate(citta) {
    if (citta && typeof citta === "object") return citta;
    const k = "geo:" + citta.toLowerCase();
    if (meteoCache[k]) return meteoCache[k];
    const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(citta)}&count=1&language=it&countryCode=IT`;
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
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code,is_day&timezone=Europe%2FRome&forecast_days=16`;
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
    const o = oggi(), attive = S.gare.filter((g) => g.data >= L.addDays(o, -14));
    const ids = new Set(attive.map((g) => g.id));
    return {
      v: 1, ora: S.profilo.ora || "07:00", pref: { meteo: true, percorso: true, gara: true, documenti: true, novita: true, fase: true, ...(S.prefPush || {}) },
      documenti: Object.fromEntries(Object.entries(S.documenti || {}).filter(([, d]) => d && d.scadenza).map(([k, d]) => [k, k === "tessera" ? { tipo: d.tipo || "", scadenza: d.scadenza } : { scadenza: d.scadenza }])),
      luogo: S.profilo.coord ? { lat: S.profilo.coord.lat, lon: S.profilo.coord.lon } : S.profilo.citta ? { citta: S.profilo.citta } : null,
      gare: attive.map((g) => ({ id: g.id, nome: g.nome, data: g.data, distanza: g.distanza, ruolo: g.ruolo, aggiunta: g.aggiunta })),
      spunte: Object.keys(S.spunte).filter((k) => ids.has(k.split(":")[0])),
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
  const fotoTogli = (k) => idbFai("readwrite", (st) => st.delete(k));
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
  async function scansiona(k, file, stato) {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name || "")) {
      stato("Leggo il PDF…");
      const { testo, blob } = await leggiPdf(file);
      await fotoSalva(k, blob); doc(k).foto = true; salva();
      if (testo.replace(/\s/g, "").length >= 20) return L.leggiDocumento(testo, k, oggi());
      file = blob; // PDF senza testo (scansione): si passa all'OCR
    }
    const blob = await comprimi(file);
    await fotoSalva(k, blob); doc(k).foto = true; salva();
    stato("Leggo il documento…");
    const T = await caricaOcr();
    const w = await T.createWorker("ita", 1, { logger: (m) => { if (m.status === "recognizing text") stato(`Leggo il documento… ${Math.round((m.progress || 0) * 100)}%`); } });
    try { const { data } = await w.recognize(blob); return L.leggiDocumento(data.text, k, oggi()); } finally { w.terminate(); }
  }
  const bottoneScan = (k) => `<div class="scan"><label class="btn ghost block" style="cursor:pointer">📷 ${k === "tessera" ? "Scansiona la tessera o carica il PDF" : "Scansiona il certificato o carica il PDF"}<input type="file" accept="image/*,application/pdf" data-scan="${k}" hidden></label>
    <span class="small muted" data-scan-stato="${k}" aria-live="polite">${k === "tessera" ? "Foto o PDF del tesserino (quello che scarichi dalla FIDAL): " : "Foto o PDF: "}leggo i dati qui sul telefono, il file non viene inviato.</span></div>`;
  const descriviLetti = (r, k) => [r.tipo && `tipo ${r.tipo}`, r.numero && `numero ${r.numero}`, (r.codiceSocieta || r.societa) && `squadra ${[r.codiceSocieta, r.societa].filter(Boolean).join(" ")}`, r.tesseramento && `tesserata il ${L.fmtBreve(r.tesseramento)} ${r.tesseramento.slice(0, 4)}`, r.rilascio && `visita del ${L.fmtBreve(r.rilascio)} ${r.rilascio.slice(0, 4)}`, r.scadenza && `scadenza ${k === "tessera" ? "tessera " : ""}${L.fmtBreve(r.scadenza)} ${r.scadenza.slice(0, 4)}`, r.certificato && r.certificato.scadenza && `scadenza certificato ${L.fmtBreve(r.certificato.scadenza)} ${r.certificato.scadenza.slice(0, 4)}`].filter(Boolean).join(", ");

  function sezioneDocumenti() {
    const t = doc("tessera"), c = doc("certificato");
    const campo = (k, f, l, v, extra = "") => `<div class="field"><label for="doc-${k}-${f}">${l}</label><input class="input" id="doc-${k}-${f}" data-docf="${k}:${f}" value="${esc(v || "")}" ${extra}></div>`;
    const foto = (k) => `<div class="doc-foto"><img data-doc-thumb="${k}" alt="Foto ${DOCS[k].toLowerCase()}" hidden data-act="doc-apri">
      <label class="btn ghost small" style="cursor:pointer">📷 ${doc(k).foto ? "Cambia foto" : "Aggiungi foto"}<input type="file" accept="image/*" data-docfoto="${k}" hidden></label>
      ${doc(k).foto ? `<button class="btn ghost small" type="button" data-act="doc-togli-foto" data-k="${k}">Togli foto</button>` : ""}</div>`;
    return `<section class="card doc"><div class="between"><span class="title">Tessera</span>${pillDoc(statoDoc(t))}</div>
        ${bottoneScan("tessera")}
        <div class="field"><label for="doc-tessera-tipo">Tipo</label><select class="input" id="doc-tessera-tipo" data-docf="tessera:tipo">${["", "FIDAL", "Runcard", "Runcard EPS"].map((x) => `<option value="${x}" ${t.tipo === x ? "selected" : ""}>${x || "Scegli…"}</option>`).join("")}</select></div>
        <div class="field"><label for="doc-tessera-numero">Numero di tessera</label><div class="row"><input class="input" id="doc-tessera-numero" data-docf="tessera:numero" value="${esc(t.numero || "")}" inputmode="text" autocomplete="off"><button class="btn ghost" type="button" data-act="doc-copia" ${t.numero ? "" : "disabled"}>Copia</button></div></div>
        ${t.tipo === "FIDAL" ? `<div class="grid2 societa">${campo("tessera", "codiceSocieta", "Codice squadra", t.codiceSocieta, 'autocapitalize="characters" placeholder="es. RM123"')}${campo("tessera", "societa", "Nome squadra", t.societa)}</div>` : ""}
        ${campo("tessera", "scadenza", "Scadenza", t.scadenza, 'type="date"')}
        ${foto("tessera")}</section>
      <section class="card doc"><div class="between"><span class="title">Certificato medico</span>${pillDoc(statoDoc(c))}</div>
        ${bottoneScan("certificato")}
        <div class="field"><label for="doc-certificato-tipo">Tipo</label><select class="input" id="doc-certificato-tipo" data-docf="certificato:tipo">${["agonistico (atletica leggera)", "non agonistico"].map((x) => `<option ${c.tipo === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
        ${campo("certificato", "rilascio", "Data della visita", c.rilascio, 'type="date"')}
        ${campo("certificato", "scadenza", "Scadenza", c.scadenza, 'type="date"')}
        ${foto("certificato")}
        <span class="small muted">Per le gare FIDAL e con Runcard serve il certificato agonistico per l'atletica leggera, valido il giorno della gara.</span></section>
      <span class="small muted">Numero, date e foto restano solo su questo telefono. Se attivi le notifiche, online va solo la data di scadenza per avvisarti 30, 15 e 2 giorni prima.</span>`;
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
  const statoPrepara = () => L.passiPrepara({ profilo: S.profilo, documenti: S.documenti || {}, gare: S.gare }, oggi());
  const pushChiusa = () => !!(S.push && S.push.attivo) || ["no", "negato", "non-pronto"].includes(supportoPush());
  function prossimoPasso(dopo) {
    const st = statoPrepara(), fatto = Object.fromEntries(st.passi.map((x) => [x.k, x.fatto]));
    fatto.notifiche = pushChiusa();
    const i = dopo ? ORDINE_FUNNEL.indexOf(dopo) + 1 : 0;
    const obbligatori = new Set(st.passi.filter((x) => x.obbligatorio).map((x) => x.k));
    // prima i passi che vengono dopo, poi gli obbligatori rimasti indietro
    const giro = [...ORDINE_FUNNEL.slice(i), ...ORDINE_FUNNEL.slice(0, Math.max(0, i - 1)).filter((k) => obbligatori.has(k))];
    return giro.find((k) => !fatto[k]) || null;
  }
  const vaiPasso = (dopo) => { location.hash = `#/prepara/${prossimoPasso(dopo) || "fine"}`; };
  const oraMessaggio = () => { const m = String(S.profilo.ora || "07:00").match(/(\d{1,2})[:.](\d{2})/); if (!m) return "6:30"; const h = Number(m[1]), mi = Number(m[2]); if (h >= 12) return "7:00"; const t = Math.max(5 * 60, (h * 60 + mi - 30) - ((h * 60 + mi - 30) % 30)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
  function cardPrepara() {
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
      <div class="grid2"><a class="btn" href="#/prepara">${st.fatti ? "Continua" : "Inizia"} · 2 minuti</a><button class="btn ghost" type="button" data-act="prepara-dopo">Più tardi</button></div></section>`;
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
    else if (k === "documenti") corpo = `<h1>Tessera e certificato medico</h1><p class="sub">Senza non si corre: ti avviso 30, 15 e 2 giorni prima che scadano, e il numero di tessera è sempre a portata di mano quando ti iscrivi a una gara.</p>
      ${bottoneScan("tessera")}
      ${form(`<span class="title">Tessera</span>
        <div class="field"><label for="pf-tipo">Tipo</label><select class="input" id="pf-tipo" required>${["", "FIDAL", "Runcard", "Runcard EPS"].map((x) => `<option value="${x}" ${tessera.tipo === x ? "selected" : ""}>${x || "Scegli…"}</option>`).join("")}</select></div>
        <div class="field"><label for="pf-numero">Numero di tessera</label><input class="input" id="pf-numero" required minlength="3" autocomplete="off" autocapitalize="characters" value="${esc(tessera.numero || "")}"></div>
        <div class="field"><label for="pf-tess-scadenza">Scadenza della tessera</label><input class="input" id="pf-tess-scadenza" type="date" required value="${esc(tessera.scadenza || "")}"><span class="small muted">FIDAL: vale fino al 31 dicembre dell'anno stampato sul tesserino (il rinnovo di dicembre vale per l'anno dopo). Runcard: 12 mesi dall'emissione.</span></div>
        <span class="title">Certificato medico agonistico</span>
        <div class="field"><label for="pf-cert-scadenza">Scadenza del certificato</label><input class="input" id="pf-cert-scadenza" type="date" required value="${esc(cert.scadenza || "")}"><span class="small muted">Sulla tessera FIDAL la trovi stampata: la scansione la legge da sola. Serve il certificato agonistico per l'atletica leggera, valido il giorno della gara.</span></div>`,
        `<details class="scan-cert"><summary class="small">Il certificato non è sulla tessera? Scansiona il certificato</summary>${bottoneScan("certificato")}</details>`)}`;
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
    return `${testa(k === "fine" ? "Prepara RaceBuddy" : passoN)}<div class="funnel">${corpo}</div>`;
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

  function voceCheck(v, opts = {}) {
    const fatto = !!S.spunte[v.chiave];
    return `<label class="check ${fatto ? "done" : ""}"><input type="checkbox" data-act="spunta" data-k="${esc(v.chiave)}" ${fatto ? "checked" : ""}>
      <span><span class="t">${esc(v.titolo)}</span>${opts.nodesc ? "" : `<br><span class="d">${esc(v.messaggio)}</span>`}${opts.quando ? `<br><span class="d muted">${esc(opts.quando)}</span>` : ""}</span></label>`;
  }

  function cardGara(g, attiva) {
    const d = new Date(g.data + "T12:00:00");
    const mesi = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
    const giorni = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
    return `<div class="race"><div class="date" aria-hidden="true"><span class="m">${mesi[d.getMonth()]}</span><b>${d.getDate()}</b><span>${giorni[d.getDay()]}</span></div>
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
    const slides = [
      { k: "Ciao! · La preparazione", t: "Ogni giorno sai cosa fare", d: "Dall'iscrizione al traguardo: cosa provare, cosa preparare e cosa leggere, sulle date vere della tua gara.",
        ill: `<div class="ob-countdown"><span class="big ob-num" id="ob-num">46</span><span>giorni alla tua gara</span></div>
          <div class="card dark ob-barra">${barra}</div>
          <div class="card ob-mini"><span class="eyebrow" style="color:var(--accent)">Oggi</span>
            <label class="check"><input type="checkbox" tabindex="-1"><span><span class="t">Prova il gel nel lungo</span><br><span class="d">Lo stesso che userai in gara, al 10° km</span></span></label>
            <div class="ob-cont"><span class="thumb noimg t-video"><span class="play" aria-hidden="true">▶</span></span><span class="c-testo"><span class="c-meta">Per la tua fase · video · 6 min</span><span class="c-titolo">Il lungo a ritmo gara, spiegato bene</span></span></div></div>` },
      { k: "Meteo e avvisi", t: "Ti avviso quando serve", d: "Come vestirti all'ora della tua uscita. E una notifica solo se cambia qualcosa: al massimo una al mattino, la vigilia alle 19. Mai di notte.",
        nota: "Le notifiche le attivi da Io. Su iPhone prima aggiungi RaceBuddy alla schermata Home.",
        ill: `<div class="card ob-mini"><span class="eyebrow">Roma · uscita di domani alle 7:00</span><div class="meteo-top">${icona(m, 52)}<div style="flex:1;min-width:0"><div class="meteo-temp">${Math.round(m.temp)}°</div><span class="small muted">${esc(NOME_CIELO[L.tipoCielo(m)])}</span></div>${datiMeteo(m)}</div><span class="small">${esc(L.vestizione(m, false))}</span><span class="pill" style="align-self:flex-start">Rischio ghiaccio</span></div>
          ${notifica("6:00", "Il meteo cambia", "Alle 7: -1°, vento forte. Guanti e uno strato antivento.")}
          ${notifica("19:00", "Domani: Firenze Marathon", "Partenza alle 8:30. Prepara la borsa stasera: la checklist è pronta.")}` },
      { k: "La gara", t: "La tua gara, in una scheda", d: "Orari, ritiro pettorale, griglie, deposito e percorso, presi dal sito ufficiale e ricontrollati fino al via. Con la partenza su Maps.",
        ill: `<div class="card ob-mini"><div class="between"><b>Domenica · ore 8:30</b><span class="pill ok">dal sito ufficiale</span></div>${mappaDemo}<div class="list" style="display:flex;flex-direction:column">${riga("Pettorale", "Expo, ven 10-19 · sab 9-19")}${riga("Griglia", "Per tempo, ingresso 7:00-8:00")}${riga("Deposito", "In piazza dalle 7:00")}</div><span class="small" style="color:var(--accent);font-weight:700">Partenza in Maps ↗ · Percorso ↗</span></div>` },
      { k: "Il gruppo", t: "Corri con la tua società", d: "La classifica dei personali della squadra e chi corre le tue gare, con gli applausi a ogni traguardo. Condividi solo quello che scegli.",
        ill: `<div class="card ob-mini" style="gap:4px"><div class="between"><span style="font:700 22px/1 var(--display)">Classifica dei personali</span><span class="chip" aria-pressed="true" style="height:26px;font-size:12px;display:inline-flex;align-items:center">Mezza</span></div>
            ${pos(1, "Giulia", "1:38:00")}${pos(2, "Marco", "1:41:20")}${pos(3, "Tu", "1:43:30", true)}</div>
          <div class="card ob-mini ob-mini2"><div class="between" style="align-items:flex-end"><div><span class="eyebrow">Il gruppo alla gara</span><div style="font:700 22px/1 var(--display)">Firenze Marathon</div></div><span class="small" style="font-weight:700;color:var(--accent)">dom 29 nov</span></div>
            <div class="row">${avatari(["Giulia B", "Marco R", "Sara P", "Anna", "Paolo", "Luca"], 3)}<span class="small"><b>6 del gruppo</b> la corrono con te</span></div>
            <div style="display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--line2);padding-top:8px">${chi("Giulia", "Obiettivo", "3:25:00")}${chi("Marco", "Obiettivo", "3:40:00")}${chi("Sara", "Per divertimento", "")}</div></div>` },
    ];
    const tot = slides.length + 1;
    return `<section class="ob" aria-roledescription="tutorial" aria-label="Benvenuto in RaceBuddy">
      <div class="ob-top"><span class="ob-logo">RaceBuddy</span><button class="ob-salta" data-act="ob-fine">Salta</button></div>
      <div class="ob-track" id="ob-track">${slides.map((x, i) => `<article class="ob-slide" aria-label="${i + 1} di ${tot}"><div class="ob-ill">${x.ill}</div><span class="eyebrow">${x.k}</span><h1>${x.t}</h1><p>${x.d}</p>${x.nota ? `<p class="ob-nota">${x.nota}</p>` : ""}</article>`).join("")}
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
      av.style.visibility = i === dots.length - 1 ? "hidden" : "visible";
    }, { passive: true });
    // Prima schermata: il conto alla rovescia scende a 46 e la fase si riempie, una volta sola (niente se il telefono riduce le animazioni).
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const num = document.getElementById("ob-num"), fill = tr.querySelector(".ob-barra .fill");
    if (!num || !fill) return;
    const da = 60, a = 46, durata = 900, t0 = performance.now();
    fill.style.width = "0%";
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.transition = `width ${durata}ms ease-out`; fill.style.width = fill.dataset.obW; }));
    const passo = (t) => { const k = Math.min(1, (t - t0) / durata), e = 1 - Math.pow(1 - k, 3); num.textContent = String(Math.round(da - (da - a) * e)); if (k < 1) requestAnimationFrame(passo); };
    requestAnimationFrame(passo);
  }

  const cardMeteo = () => (S.profilo.citta ? `<a class="card" id="meteo" href="#/meteo" style="text-decoration:none;color:inherit;font-weight:inherit" aria-label="Meteo dell'uscita, apri il dettaglio"><span class="eyebrow">${esc(S.profilo.citta)} · uscita delle ${esc(S.profilo.ora || "7:00")}</span><span class="small muted">Meteo in arrivo…</span></a>`
    : `<a class="card" href="#/io" style="text-decoration:none;color:inherit"><span class="title">Meteo e vestizione</span><span class="small">Dimmi dove e a che ora corri di solito: ti dico come vestirti.</span></a>`);
  function cardPerTe(titolo) {
    const cx = contesto(), letti = Object.fromEntries(Object.keys(S.letti || {}).filter((k) => k.startsWith("c:")).map((k) => [k.slice(2), true]));
    const top = L.perTe(D.contenuti || [], { fase: cx.fase, distanza: cx.distanza, oggi: cx.o, letti }).filter((c) => !letti[c.id]).slice(0, 3);
    return top.length ? `<section aria-label="${titolo}"><div class="between" style="margin-bottom:8px"><h2>${titolo}</h2><a class="small" href="#/perte">Altro ›</a></div><div class="lista-c">${top.map((c, i) => cardContenuto(c, i === 0)).join("")}</div></section>` : "";
  }
  function vistaVuota(concluse) {
    const o = oggi(), pil = L.pillola(D.pillole, "nessuna", "21", o, Number(o.slice(5, 7)));
    return `${bannerProva()}<header class="head"><div><span class="eyebrow">${esc(L.fmtGiorno(o))}</span><h1>${S.profilo.nome ? "Ciao, " + esc(S.profilo.nome) : "Buongiorno"}</h1></div></header>
      ${cardPrepara()}
      <a class="card dark" href="#/gare" style="text-decoration:none;font-weight:inherit"><span class="eyebrow">${concluse ? "Tutte le tue gare sono concluse" : "Nessuna gara in vista"}</span><span style="font:700 24px/1.1 var(--display)">${concluse ? "Qual è la prossima?" : "Scegli la tua prossima gara"}</span><span class="sub">Ti preparo la strada fino al via: cosa fare e quando, info gara, borsa ›</span></a>
      ${cardMeteo()}
      ${cardInvitoPB()}
      ${cardSorriso(L.sorriso(D.sorrisi || [], "senza_gara", o))}
      ${pil ? `<section class="card soft" aria-label="Pillola del giorno"><span class="eyebrow" style="color:var(--accent-strong)">Pillola di stagione</span><span class="title">${esc(pil.titolo)}</span><span class="small">${esc(pil.testo)}</span></section>` : ""}
      ${cardPerTe("Da leggere e guardare")}
      <p class="sub">Indicazioni generali per runner amatoriali in salute: non sostituiscono medico, nutrizionista o allenatore.</p>`;
  }

  function vistaOggi() {
    if (!S.gare.length) return vistaVuota();
    const o = oggi();
    const { obiettivo, focus, tutte } = L.gareAttive(S.gare, D.fasi, o);
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
    </section>`;

    const st = L.stato(D.percorso, focus, o, S.spunte, S.rinvii);
    const stO = focus.id === obiettivo.id ? st : L.stato(D.percorso, obiettivo, o, S.spunte, S.rinvii);
    const daFare = [...st.oggi, ...(focus.id === obiettivo.id ? [] : stO.oggi)].filter((v) => v.tipo !== "momento" || true);
    const azioni = daFare.filter((v) => v.tipo === "cosa da fare");
    const momenti = daFare.filter((v) => v.tipo === "momento" && !(S.letti || {})[v.chiave]);
    const recuperi = stO.daRecuperare.length;
    let blocco = "";
    if (momenti.length) blocco += momenti.map((m) => `<section class="card soft"><div class="between"><span class="eyebrow" style="color:var(--accent-strong)">Momento della preparazione</span><button class="btn ghost small" data-act="letto" data-k="${esc(m.chiave)}" aria-label="Chiudi: ${esc(m.titolo)}">Ok, chiudi</button></div><span class="title">${esc(m.titolo)}</span><span class="small">${esc(m.messaggio)}</span></section>`).join("");
    if (azioni.length) {
      blocco += `<section class="card" aria-label="Da fare oggi"><h2>Da fare oggi</h2>${azioni.map((v) => {
        const fatto = !!S.spunte[v.chiave];
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

    return `${bannerProva()}<header class="head"><div><span class="eyebrow">${esc(L.fmtGiorno(o))}</span><h1>Buongiorno${S.profilo.nome ? ", " + esc(S.profilo.nome) : ""}</h1></div></header>${cardPrepara()}${hero}${avvisoDocumenti()}${meteo}${blocco}${statoPrepara().completo ? cardPush(true) : ""}${pill}${(() => {
      const cx = contesto(), letti = Object.fromEntries(Object.keys(S.letti || {}).filter((k) => k.startsWith("c:")).map((k) => [k.slice(2), true]));
      const top = L.perTe(D.contenuti || [], { fase: cx.fase, distanza: cx.distanza, oggi: cx.o, letti }).filter((c) => !letti[c.id]).slice(0, 2);
      return top.length ? `<section aria-label="Per te oggi"><div class="between" style="margin-bottom:8px"><h2>Per te oggi</h2><a class="small" href="#/perte">Altro ›</a></div><div class="lista-c">${top.map((c, i) => cardContenuto(c, i === 0)).join("")}</div></section>` : "";
    })()}`;
  }

  async function riempiMeteo() {
    const box = document.getElementById("meteo");
    if (!box || !S.profilo.citta) return;
    try {
      const quando = S.prova ? `${S.prova}T${oraISO(S.profilo.ora)}` : L.prossimaUscita(S.profilo.ora, new Date());
      const m = await meteoAlle(mioLuogo(), quando);
      if (!m) { box.innerHTML = `<span class="eyebrow">${esc(S.profilo.citta)}</span><span class="small">Previsioni non disponibili per questa data.</span>`; return; }
      const giorno = quando.slice(0, 10) === L.todayISO() ? "oggi" : "domani";
      box.innerHTML = `<span class="eyebrow">${esc(m.luogo)} · uscita di ${giorno} alle ${esc(S.profilo.ora || "7:00")}</span>${bloccoMeteo(m, false)}<span class="small" style="color:var(--accent);font-weight:700">Prossimi giorni e meteo gara ›</span>`;
    } catch (e) { box.innerHTML = `<span class="small muted">Meteo non disponibile al momento.</span>`; }
  }

  function vistaGare(param) {
    const o = oggi();
    const mie = [...S.gare].sort((a, b) => a.data.localeCompare(b.data));
    const q = param.q || "", dist = param.d || "";
    const ris = L.cercaGare(D.gare, q, dist, o);
    const chip = (v, l) => `<button class="chip" data-act="filtro" data-d="${v}" aria-pressed="${dist === v}">${l}</button>`;
    return `${bannerProva()}<header class="head"><h1>Gare</h1></header>
      ${mie.length ? `<section aria-label="Le mie gare" style="display:flex;flex-direction:column;gap:8px"><h2>Le mie gare</h2>${mie.map((g) => {
        const n = L.diffDays(g.data, o), f = L.fase(D.fasi, g.distanza, g.data, o);
        return `<a class="card mia-gara" href="${urlGara(g.id)}">${cardGara(g, `<span class="row" style="gap:6px;flex-wrap:wrap"><span class="pill ${n < 0 ? "ok" : ""}">${n > 1 ? `tra ${n} giorni` : n === 1 ? "domani" : n === 0 ? "oggi!" : "conclusa"}</span><span class="small muted">${esc(L.RUOLO_LABEL[g.ruolo])}${n >= 0 && !["prima", "conclusa"].includes(f.id) ? " · " + esc(f.nome) : ""}</span></span>`)}<span class="chev" aria-hidden="true">›</span></a>`;
      }).join("")}</section><h2 style="margin-top:6px">Aggiungi una gara</h2>` : ""}
      <div class="field"><label for="cerca">Cerca una gara o una città</label><input class="input" id="cerca" type="search" value="${esc(q)}" placeholder="es. Firenze" autocomplete="off"></div>
      <div class="chips" role="group" aria-label="Distanza">${chip("", "Tutte")}${chip("10", "10 km")}${chip("21", "Mezza")}${chip("42", "Maratona")}</div>
      <div id="risultati">${risultati(ris)}</div>
      <details class="card"><summary>Non la trovi? Aggiungila a mano</summary>
        <form id="manuale" style="display:flex;flex-direction:column;gap:10px">
          <div class="field"><label for="m-nome">Nome della gara</label><input class="input" id="m-nome" required></div>
          <div class="grid2"><div class="field"><label for="m-data">Data</label><input class="input" id="m-data" type="date" required min="${o}"></div>
          <div class="field"><label for="m-dist">Distanza</label><select class="input" id="m-dist"><option value="10">10 km</option><option value="21">Mezza</option><option value="42">Maratona</option></select></div></div>
          <div class="field"><label for="m-luogo">Città</label><input class="input" id="m-luogo"></div>
          <button class="btn" type="submit">Continua</button></form></details>
      <p class="sub">Calendario FIDAL su strada${D.aggiornato ? `, aggiornato il ${esc(L.fmtGiorno(D.aggiornato.slice(0, 10)))}` : ""}. Maratone e mezze del 2027 dal calendario FIDAL già pubblicato; le altre gare del 2027 compaiono man mano.</p>`;
  }
  function risultati(ris) {
    if (!ris.length) return `<p class="sub">Nessuna gara trovata. Prova con la città o aggiungila a mano.</p>`;
    const giaMie = new Set(S.gare.map((g) => g.id));
    return `<h2 style="margin-bottom:8px">Risultati · ${ris.length}${ris.length === 40 ? "+" : ""}</h2><div style="display:flex;flex-direction:column;gap:8px">${ris.map((g) =>
      `<article class="card">${cardGara(g, giaMie.has(g.id) ? `<span class="pill ok">già tra le tue gare</span>` : `<a class="btn small" style="align-self:flex-start" href="#/aggiungi/${encodeURIComponent(g.id)}">Scegli ${esc(L.DIST_LABEL[g.distanza])}</a>`)}</article>`).join("")}</div>`;
  }

  function vistaAggiungi(id) {
    const g = D.gare.find((x) => x.id === id) || (S._bozza && S._bozza.id === id ? S._bozza : null);
    if (!g) return `<p class="sub">Gara non trovata.</p><a class="btn" href="#/gare">Torna alle gare</a>`;
    const ha = S.gare.some((x) => x.ruolo === "obiettivo" && x.data >= oggi());
    const r = (v, t, d, chk) => `<label class="radio"><input type="radio" name="ruolo" value="${v}" ${chk ? "checked" : ""}><span><span class="title" style="font-size:16px">${t}</span><br><span class="small">${d}</span></span></label>`;
    const P = S.profilo;
    return `<header class="head-back">${back("#/gare")}<div><h1 style="font-size:26px">${esc(titoloGara(g.nome))}</h1><span class="sub">${esc(L.fmtGiorno(g.data))} · ${esc(L.DIST_LABEL[g.distanza])} · tra ${L.diffDays(g.data, oggi())} giorni</span></div></header>
      <form id="aggiungi" data-id="${esc(id)}" style="display:flex;flex-direction:column;gap:16px">
      <fieldset style="border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px"><legend class="title" style="margin-bottom:8px;padding:0">Che gara è per te?</legend>
        ${r("obiettivo", "Obiettivo", "Costruisco la preparazione su questa gara", !ha)}
        ${r("tappa", "Tappa", "Una gara di passaggio verso l'obiettivo", ha)}
        ${r("divertimento", "Per divertimento", "Solo checklist e promemoria", false)}</fieldset>
      <div class="field"><label for="a-tempo">Tempo obiettivo <span class="muted">(facoltativo)</span></label><input class="input" id="a-tempo" placeholder="es. 3:45:00"></div>
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
  const infoGara = (g) => Object.assign({}, (D.schede || {})[g.id] || {}, g.info || {});
  const oraPartenza = (g) => { const m = String(infoGara(g).partenza || "").match(/\d{1,2}[:.]\d{2}/); return m ? m[0].replace(".", ":") : null; };
  const urlGara = (id, sez = "") => `#/gara/${encodeURIComponent(id)}${sez ? "/" + sez : ""}`;
  // Link a Google Maps per la partenza: usa il campo "mappa" della scheda (indirizzo o "lat,lon"), altrimenti il testo + città.
  function mappa(info, g) {
    const q = info.mappa || `${String(info.luogoPartenza || "").split(/,|\barrivo\b/i)[0].replace(/^partenza (da|in)\s*/i, "")} ${nomeLuogo(g.luogo)}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q.trim())}`;
  }
  function testataGara(g, sez) {
    const tab = (k, l) => `<a href="${urlGara(g.id, k)}" ${sez === k ? 'aria-current="page"' : ""}>${l}</a>`;
    return `${bannerProva()}<header class="head-back">${back(sez ? urlGara(g.id) : "#/gare")}<div style="min-width:0"><span class="eyebrow">${esc(L.fmtGiorno(g.data))} · ${esc(L.DIST_LABEL[g.distanza])} · ${esc(L.RUOLO_LABEL[g.ruolo].toLowerCase())}</span><h1 style="font-size:28px">${esc(titoloGara(g.nome))}</h1></div></header>
      <nav class="seg" aria-label="Sezioni della gara">${tab("", "Panoramica")}${tab("preparazione", "Preparazione")}${tab("info", "Info gara")}${tab("borsa", "Borsa")}</nav>`;
  }
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
      const m = await meteoAlle(nomeLuogo(g.luogo) || S.profilo.citta || "", `${g.data}T${oraISO(ora || "9:00")}`);
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
    const st = L.stato(D.percorso, g, o, S.spunte, S.rinvii);
    const prossime = [...st.oggi.filter((v) => v.tipo === "cosa da fare"), ...st.settimana].filter((v, i, a) => !S.spunte[v.chiave] && a.findIndex((x) => x.chiave === v.chiave) === i).slice(0, 3);
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
      ${n < 0 ? `<a class="card soft" href="#/risultato/${encodeURIComponent(g.id)}" style="text-decoration:none;color:inherit;font-weight:inherit"><span class="title">${ris ? `Il tuo tempo: ${esc(ris.tempo)}${ris.pb ? " · personale!" : ""}` : "Com'è andata?"}</span><span class="small">${ris ? "Modifica o condividi ›" : "Segna il tuo tempo ›"}</span></a>` : ""}
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
        <div class="grid2"><div class="field"><label for="gi-ruolo">Ruolo</label><select class="input" id="gi-ruolo">${["obiettivo", "tappa", "divertimento"].map((r) => `<option value="${r}" ${g.ruolo === r ? "selected" : ""}>${L.RUOLO_LABEL[r]}</option>`).join("")}</select></div>
        <div class="field"><label for="gi-tempo">Tempo obiettivo</label><input class="input" id="gi-tempo" value="${esc(g.tempo || "")}" placeholder="es. 3:45:00"></div></div>
        <button class="btn" type="submit">Salva</button></form></details>
      <div><button class="btn danger block" data-act="rimuovi" data-id="${esc(g.id)}">Rimuovi gara</button></div>`;
  }

  function vistaPreparazione(id) {
    const o = oggi();
    if (!S.gare.length) return vistaVuota();
    const g = S.gare.find((x) => x.id === id);
    if (!g) return garaMancante();
    const f = L.fase(D.fasi, g.distanza, g.data, o);
    const st = L.stato(D.percorso, g, o, S.spunte, S.rinvii);
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
        ${CAMPI.map(([k, l, ph]) => `<div class="field"><label for="i-${k}">${l}</label>${k === "note" ? `<textarea class="input" id="i-${k}">${esc(info[k])}</textarea>` : `<input class="input" id="i-${k}" value="${esc(info[k])}" placeholder="${esc(ph)}" ${k === "sito" ? 'type="url" inputmode="url"' : ""}>`}</div>`).join("")}
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
      <p class="sub">Dati del calendario: ${g.fonte === "manuale" ? "inseriti da te" : "FIDAL"}. Fai sempre fede al regolamento ufficiale della gara.</p>`;
  }

  function vistaBorsa(id) {
    const g = S.gare.find((x) => x.id === id);
    if (!g) return garaMancante();
    const ck = L.checklist(D.percorso, g, S.personali);
    const tutte = ck.borsa; // la mattina della gara si legge e basta: niente caselle, non conta nelle pronte
    const fatte = tutte.filter((v) => S.spunte[v.chiave]).length;
    const pct = tutte.length ? Math.round((fatte / tutte.length) * 100) : 0;
    const n = L.diffDays(g.data, oggi()), i = infoGara(g);
    const prom = [["Partenza", oraPartenza(g)], ["Griglia", i.griglia], ["Deposito", i.deposito], ["Dove", i.luogoPartenza]].filter((x) => x[1]);
    return `${testataGara(g, "borsa")}
      <div style="display:flex;flex-direction:column;gap:6px"><div class="between small"><b>${fatte} di ${tutte.length} pronte</b><span class="muted">${n === 1 ? "la gara è domani" : n === 0 ? "la gara è oggi" : n > 1 ? "da preparare la sera prima" : ""}</span></div>
      <div class="meter acc" aria-hidden="true"><div style="width:${pct}%"></div></div></div>
      ${boxMeteoGara(g, "borsa")}
      <section class="card" style="gap:0;padding-top:4px;padding-bottom:4px" aria-label="Borsa">${ck.borsa.map((v) => voceCheck(v, { nodesc: !v.messaggio })).join("")}</section>
      <form id="personale" class="row"><label class="sr" for="p-voce">Aggiungi una voce tua</label><input class="input" id="p-voce" placeholder="Aggiungi una voce tua" required><button class="btn" type="submit">Aggiungi</button></form>
      ${S.personali.length ? `<p class="sub">Le tue voci restano salvate per le prossime gare. <button class="btn ghost small" data-act="svuota-personali">Svuota le mie voci</button></p>` : ""}
      <section class="card" aria-label="Mattina della gara"><h2>La mattina della gara</h2>
        ${prom.length ? `<div class="list" style="display:flex;flex-direction:column;margin-bottom:6px">${prom.map(([l, t]) => `<div class="line"><span class="when" style="width:76px">${l}</span><span>${esc(t)}${l === "Dove" ? ` · <a href="${mappa(i, g)}" target="_blank" rel="noopener">Maps ↗</a>` : ""}</span></div>`).join("")}</div>` : `<a class="small" href="${urlGara(g.id, "info")}?modifica=1">+ Annota orario, griglia e deposito in Info gara</a>`}
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
      const passata = !S.prova && new Date().getHours() > Number(ora.slice(0, 2));
      for (let d = passata ? 1 : 0; d < (passata ? 8 : 7); d++) { const dd = L.addDays(o, d), m = at(`${dd}T${ora}`); if (m) giorni.push([dd, m]); }
      const ore = [];
      const base = S.prova ? `${S.prova}T${ora}` : null;
      let i0 = base ? h.time.indexOf(base) : h.time.indexOf(`${L.todayISO()}T${String(new Date().getHours()).padStart(2, "0")}:00`);
      if (i0 >= 0) for (let i = i0; i < Math.min(h.time.length, i0 + 12); i += 2) ore.push([h.time[i].slice(11), { temp: h.temperature_2m[i], pioggia: h.precipitation_probability[i] ?? 0, codice: h.weather_code ? h.weather_code[i] : null, notte: h.is_day ? h.is_day[i] === 0 : false }]);
      const gareMeteo = S.gare.filter((g) => { const n = L.diffDays(g.data, o); return n >= 0 && n <= 15; });
      box.innerHTML = (giorni.length ? `<section class="card" style="gap:12px">${(() => { const [dd, m] = giorni[0]; return `<span class="eyebrow">${dd === L.todayISO() ? "Oggi" : esc(L.fmtGiorno(dd))} alle ${esc(S.profilo.ora || "7:00")} · ${esc(c.nome)}</span>${bloccoMeteo(m, false)}`; })()}</section>` : `<p class="sub">Previsioni non disponibili per questa data.</p>`)
        + (ore.length ? `<section class="card"><h2>Nelle prossime ore</h2><div style="display:flex;justify-content:space-between;gap:4px;text-align:center">${ore.map(([t, m]) => `<div style="display:flex;flex-direction:column;align-items:center;gap:2px"><span class="small muted">${esc(t)}</span>${icona(m, 28)}<b style="font:700 20px var(--display)">${Math.round(m.temp)}°</b><span class="small muted">${m.pioggia}%</span></div>`).join("")}</div><span class="small muted">Temperatura e probabilità di pioggia, alle ore indicate.</span></section>` : "")
        + (giorni.length > 1 ? `<section class="card list" style="padding-top:12px;padding-bottom:6px"><h2>Le prossime uscite</h2>${giorni.slice(1).map(([dd, m]) => `<div class="line" style="flex-direction:column;gap:4px"><div class="between"><span style="display:flex;align-items:center;gap:8px">${icona(m, 30)}<b>${esc(L.fmtGiorno(dd))}</b></span><span style="display:flex;align-items:center;gap:10px"><b style="font:700 20px var(--display)">${Math.round(m.temp)}°</b>${datiMeteo(m)}</span></div><span class="small">${esc(L.vestizione(m))}</span>${L.avvisiMeteo(m).filter((a) => a.livello === "attenzione").map((a) => `<span class="small" style="color:var(--warn);font-weight:600">${ICO_AVVISO[a.tipo] || "!"} ${esc(a.titolo)}</span>`).join("")}</div>`).join("")}</section>` : "")
        + gareMeteo.map((g) => `<a class="card soft" href="#/gara/${encodeURIComponent(g.id)}" style="text-decoration:none;color:inherit;font-weight:inherit"><span class="between"><span class="title">Meteo per ${esc(titoloGara(g.nome))}</span><span aria-hidden="true">›</span></span><span class="small">Il ${esc(L.fmtGiorno(g.data))}: apri la scheda gara.</span></a>`).join("");
    } catch (e) { box.innerHTML = `<p class="sub">Meteo non disponibile al momento.</p>`; }
  }

  function vistaPillole(id) {
    const o = oggi(), mese = Number(o.slice(5, 7));
    const g = S.gare.find((x) => x.id === id) || L.gareAttive(S.gare, D.fasi, o).focus;
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

  // ---------------------------------------------------------------- per te: articoli, video, podcast, sorrisi
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
    const mie = new Set(S.gare.filter((g) => g.data >= L.addDays(oggi(), -14)).map((g) => g.id));
    return (D.novita || []).filter((n) => mie.has(n.gara) && n.urgenza !== "app" && !novitaVista(n) && L.diffDays(oggi(), n.data) <= 7)
      .sort((a, b) => PRI_URG[a.urgenza] - PRI_URG[b.urgenza] || (a.data < b.data ? 1 : -1))[0] || null;
  }
  function cardDallaGara() {
    const n = novitaInEvidenza(), g = n && garaDiNovita(n);
    if (!n || !g) return "";
    return `<a class="card novita-top" href="${urlNovita(n)}">${thumbNovita(n)}<span class="nuovo-badge">Nuovo</span>
      <div class="novita-testo"><span class="eyebrow" style="color:var(--accent)">Dalla tua gara · ${esc(TEMA_LABEL[n.tema] || "Notizia")}</span><span class="novita-titolo">${esc(n.titolo)}</span>
      <span class="small muted">${esc(titoloGara(g.nome))} · ${fonteNovita(n)}</span><span class="small" style="color:var(--accent);font-weight:700">Tutte le novità della gara ›</span></div></a>`;
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
  const novitaMieGare = () => { const mie = new Set(S.gare.filter((g) => g.data >= L.addDays(oggi(), -14)).map((g) => g.id)); return (D.novita || []).filter((n) => mie.has(n.gara) && n.tema !== "altro").sort((a, b) => (novitaNuova(a) ? 0 : 1) - (novitaNuova(b) ? 0 : 1) || PRI_URG[a.urgenza] - PRI_URG[b.urgenza] || (a.data < b.data ? 1 : -1)); };
  function contesto() {
    const o = oggi(), { focus } = L.gareAttive(S.gare, D.fasi, o);
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
  function cardSorriso(sr) {
    return sr ? `<section class="card sorriso" aria-label="Sorriso del giorno"><span class="eyebrow">Sorriso del giorno</span><p>${esc(sr.testo)}</p></section>` : "";
  }
  function vistaPerTe(param) {
    const { o, fase, nomeFase, distanza } = contesto();
    const mieGare = novitaMieGare();
    const tipo = param.t || "", letti = Object.fromEntries(Object.keys(S.letti || {}).filter((k) => k.startsWith("c:")).map((k) => [k.slice(2), true]));
    const chip = (v, l) => `<button class="chip" data-act="perte-tipo" data-t="${v}" aria-pressed="${tipo === v}">${l}</button>`;
    const testa = `${bannerProva()}<header class="head"><div><span class="eyebrow">${esc(nomeFase)}</span><h1>Per te</h1></div></header>
      <div class="chips" role="group" aria-label="Tipo di contenuto">${chip("", "Tutto")}${mieGare.length ? chip("gare", `Le mie gare · ${mieGare.length}`) : ""}${chip("articolo", "Articoli")}${chip("video", "Video")}${chip("podcast", "Podcast")}${chip("sorrisi", "Sorrisi")}</div>`;
    if (tipo === "sorrisi") {
      const lista = [...(D.sorrisi || [])].sort((a, b) => (a.fase === fase ? -1 : 0) - (b.fase === fase ? -1 : 0));
      return `${testa}${lista.map((x) => `<section class="card sorriso"><p>${esc(x.testo)}</p></section>`).join("")}<p class="sub">Battute originali di RaceBuddy.</p>`;
    }
    if (tipo === "gare") return `${testa}<div class="lista-c">${mieGare.map(cardNovitaPerTe).join("")}</div><p class="sub">Novità ufficiali e articoli delle riviste sulle gare che segui. Tocca per aprirli alla fonte.</p>`;
    const lista = L.perTe(D.contenuti || [], { fase, distanza, oggi: o, letti, tipo });
    if (!lista.length) return `${testa}<p class="sub">Nessun contenuto per ora: le fonti si aggiornano due volte al giorno.</p>`;
    const perFase = fase ? lista.filter((c) => c.perLaFase && !letti[c.id]).slice(0, 6) : [];
    const usati = new Set(perFase.map((c) => c.id));
    const novita = lista.filter((c) => !usati.has(c.id)).sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
    const n = Number(param.n || 20);
    return `${testa}
      ${!tipo && mieGare.length ? `<section aria-label="Dalle tue gare"><div class="between" style="margin-bottom:8px"><h2>Dalle tue gare</h2><button class="linkbtn small" data-act="perte-tipo" data-t="gare">Tutte ›</button></div><div class="lista-c">${mieGare.slice(0, 3).map(cardNovitaPerTe).join("")}</div></section>` : ""}
      ${!tipo ? cardSorriso(L.sorriso(D.sorrisi || [], fase || "senza_gara", o)) : ""}
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
      if (prima !== JSON.stringify(d) && /^#\/(gruppo|risultato)/.test(location.hash)) rerender();
    } catch (e) {
      if (/non sei in un gruppo/.test(e.message)) { S.gruppo = { token: S.gruppo.token }; salva(); toast("Non fai più parte del gruppo"); rerender(); }
      else if (!silenzioso) toast("Gruppo non raggiungibile: riprova tra poco");
    } finally { caricando = false; }
  }
  async function sincronizzaGareGruppo() {
    if (!S.gruppo || !S.gruppo.dentro) return;
    const o = oggi();
    const gare = S.gare.filter((g) => g.data >= L.addDays(o, -2)).map((g) => ({ id: g.id, nome: g.nome, data: g.data, luogo: g.luogo, distanza: g.distanza, ruolo: g.ruolo, tempo: g.tempo || "" }));
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

  function vistaSenzaGruppo() {
    return `${bannerProva()}<header class="head"><div><span class="eyebrow">Il gruppo</span><h1>Corri con la tua società</h1></div></header>
      <section class="card"><span class="small">Nel gruppo vedi chi corre le tue gare e i risultati che ognuno sceglie di condividere.</span></section>
      <section class="card"><h2>Hai un invito?</h2><span class="small">Apri il link che ti hanno mandato, oppure incolla qui il codice.</span>
        <form id="g-codice" class="row"><label class="sr" for="g-cod">Codice invito</label><input class="input" id="g-cod" placeholder="es. K7MPQ2XA" autocapitalize="characters" required><button class="btn" type="submit">Vai</button></form></section>
      <details class="card"><summary>Sei il presidente? Crea il gruppo</summary>
        <form id="g-crea" style="display:flex;flex-direction:column;gap:10px">
        <div class="field"><label for="g-nome">Nome della società o del gruppo</label><input class="input" id="g-nome" required maxlength="60" placeholder="es. Podistica …"></div>
        <div class="field"><label for="g-io">Come ti vedono gli altri</label><input class="input" id="g-io" required maxlength="40" value="${esc(S.profilo.nome || "")}" placeholder="es. Marco R."></div>
        <button class="btn" type="submit">Crea il gruppo</button>
        <span class="small muted">Diventi amministratore: potrai invitare gli altri, nominare chi ti aiuta a invitare e gestire i membri.</span></form></details>`;
  }

  function vistaInvito(codice) {
    setTimeout(async () => {
      const box = document.getElementById("invito-info");
      if (!box) return;
      try {
        const info = await rpc("info_invito", { p_codice: codice });
        if (!info) { box.innerHTML = `<p class="ob-p">Questo invito non è valido o è stato sostituito. Chiedi un link nuovo a chi ti ha invitato.</p>`; return; }
        box.innerHTML = `<span class="eyebrow">Invito</span><h1>${esc(info.admin || "Il gruppo")} ti ha invitato in «${esc(info.nome)}»</h1>
          <p class="ob-p">${info.membri} ${info.membri === 1 ? "runner" : "runner"}. Vedrai chi corre le tue gare e i risultati che gli altri scelgono di condividere.</p>${avatari(info.iniziali || [], 6)}`;
      } catch (e) { box.innerHTML = `<p class="ob-p">Non riesco a leggere l'invito: controlla la connessione.</p>`; }
    }, 0);
    if (S.gruppo && S.gruppo.dentro) return `<section class="card"><span class="title">Sei già in un gruppo</span><span class="small">Per entrare in un altro, prima esci da quello attuale (Gruppo → Gestisci o Io).</span><a class="btn" href="#/gruppo">Vai al gruppo</a></section>`;
    return `<section class="invito"><span class="ob-logo">RaceBuddy</span><div id="invito-info" style="display:flex;flex-direction:column;gap:10px"><p class="ob-p">Leggo l'invito…</p></div>
      <form id="g-entra" data-codice="${esc(codice)}" class="card" style="color:var(--fg)">
        <div class="field"><label for="g-io">Come ti vedono gli altri</label><input class="input" id="g-io" required maxlength="40" value="${esc(S.profilo.nome || "")}" placeholder="es. Luca A."></div>
        <label class="check" style="border:0;padding:4px 0"><input type="checkbox" id="g-mostra" checked><span><span class="t">Mostra al gruppo le gare a cui sono iscritto</span></span></label>
        <label class="check" style="border:0;padding:4px 0"><input type="checkbox" id="g-mostra-pb" checked><span><span class="t">Metti i miei personali nella classifica del gruppo</span></span></label>
        <button class="btn block" type="submit">Entra nel gruppo</button>
        <span class="small muted">Niente email né password: il gruppo ti riconosce da questo telefono. Puoi uscire quando vuoi.</span></form></section>`;
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
    const post = (p) => `<div class="post">${avatar(p.membro, 34)}<div style="flex:1;min-width:0"><span><b>${esc(p.membro)}</b> ${p.tipo === "risultato" ? `ha chiuso ${esc(titoloGara(p.gara_nome || "la gara"))} in <b>${esc(p.tempo)}</b>${p.pb ? ' · <span class="pb">nuovo PB</span>' : ""}` : `si è iscritto a <b>${esc(titoloGara(p.gara_nome))}</b>`}</span>${p.testo ? `<br><span class="small">«${esc(p.testo)}»</span>` : ""}<br><span class="small muted">${esc(fa(String(p.creato).slice(0, 10)))}${p.mio || io.ruolo === "admin" ? ` · <button class="linkbtn" data-act="g-togli" data-id="${p.id}">togli</button>` : ""}</span></div>
      <button class="applauso ${p.applaudito ? "on" : ""}" data-act="g-applaudi" data-id="${p.id}" aria-pressed="${p.applaudito}" aria-label="Applaudi">👏 ${p.applausi || ""}</button></div>`;
    return `${bannerProva()}<header class="head"><div style="min-width:0"><span class="eyebrow">Il gruppo · ${d.membri.length} runner</span><h1>${esc(d.gruppo.nome)}</h1></div>${org ? `<a class="btn ghost small" href="#/gruppo/admin">${io.ruolo === "admin" ? "Gestisci" : "Invita"}</a>` : ""}</header>
      <section aria-label="Gare in comune"><h2 style="margin-bottom:8px">Le gare del gruppo</h2>${comuni.length ? `<div class="lista-c">${comuni.slice(0, 6).map((g) => `<a class="card" href="#/gruppo/gara/${encodeURIComponent(g.gara_id)}" style="text-decoration:none;color:inherit;font-weight:inherit"><div class="between"><span class="title">${esc(titoloGara(g.nome))}</span><span class="small" style="font-weight:700;color:${g.mia ? "var(--accent)" : "var(--muted)"}">${esc(L.fmtGiorno(g.data))}</span></div><div class="row">${avatari(g.chi)}<span class="small">${g.chi.length} del gruppo${g.mia ? ", tu compreso" : ""} ›</span></div></a>`).join("")}</div>` : `<p class="sub">Ancora nessuna gara condivisa.</p>`}</section>
      ${cardClassifica(d)}
      <section class="card" aria-label="Bacheca" style="gap:0"><div class="between" style="margin-bottom:4px"><h2>In bacheca</h2></div>${d.bacheca.length ? d.bacheca.slice(0, 15).map(post).join("") : `<span class="small">Qui compaiono i risultati e le iscrizioni che il gruppo condivide.</span>`}</section>
      <p class="sub">Ognuno sceglie cosa condividere: le tue gare si vedono solo se lo hai scelto (Io → Gruppo).</p>`;
  }

  function cardClassifica(d) {
    const righe = DISTANZE.map((dist) => {
      const l = d.classifica.filter((c) => c.distanza === dist).sort((a, b) => a.secondi - b.secondi);
      if (!l.length) return "";
      const io = l.findIndex((c) => c.mio);
      return `<a class="post" href="#/gruppo/classifica?d=${dist}" style="color:inherit;text-decoration:none;font-weight:inherit"><span style="width:76px;font-weight:700">${esc(L.DIST_LABEL[dist])}</span>${avatar(l[0].membro, 30)}<span style="flex:1;min-width:0"><b>${esc(l[0].membro)}</b> ${esc(l[0].tempo)}<br><span class="small muted">${l.length} in classifica${io >= 0 ? ` · tu ${io + 1}°` : ""}</span></span><span aria-hidden="true">›</span></a>`;
    }).join("");
    return `<section class="card" aria-label="Classifica dei personali" style="gap:0"><div class="between" style="margin-bottom:4px"><h2>Classifica dei personali</h2><a class="small" href="#/pb">I tuoi ›</a></div>
      ${righe || `<span class="small">Ancora nessun personale. <a href="#/pb">Inserisci i tuoi</a>: bastano tempo, gara e data.</span>`}</section>`;
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
    const io = d.io, admin = io.ruolo === "admin";
    const link = d.gruppo.codice ? linkInvito(d.gruppo.codice) : "";
    const attivi = d.membri.filter((m) => m.visto && L.diffDays(L.todayISO(), m.visto) <= 7).length;
    const comuni = gareInComune().length;
    const membro = (m) => `<div class="post"><span style="display:flex;gap:10px;align-items:center;flex:1;min-width:0">${avatar(m.nome, 34)}<span style="min-width:0"><b>${esc(m.nome)}</b>${m.id === io.id ? " (tu)" : ""}<br><span class="small muted">visto ${esc(m.visto ? fa(m.visto) : "—")}</span></span></span>
      ${admin ? `<select class="input" style="width:auto;height:36px" data-act-change="g-ruolo" data-id="${m.id}" aria-label="Ruolo di ${esc(m.nome)}">${Object.entries(RUOLI_G).map(([k, l]) => `<option value="${k}" ${m.ruolo === k ? "selected" : ""}>${l}</option>`).join("")}</select>${m.id !== io.id ? `<button class="btn ghost small" data-act="g-rimuovi" data-id="${m.id}" data-nome="${esc(m.nome)}" aria-label="Rimuovi ${esc(m.nome)}">✕</button>` : ""}` : `<span class="small muted">${RUOLI_G[m.ruolo]}</span>`}</div>`;
    return `${bannerProva()}<header class="head-back">${back("#/gruppo")}<div><span class="eyebrow">${admin ? "Amministrazione" : "Organizzatore"}</span><h1 style="font-size:28px">${esc(d.gruppo.nome)}</h1></div></header>
      <section class="stat3"><div><b>${d.membri.length}</b><span>membri</span></div><div><b>${attivi}</b><span>attivi in settimana</span></div><div><b>${comuni}</b><span>gare in comune</span></div></section>
      <section class="card"><h2>Invita</h2><span class="small">Manda questo link su WhatsApp o dove preferisci: chi lo apre entra nel gruppo.</span>
        <code class="link-invito">${esc(link)}</code>
        <div class="grid2"><button class="btn" data-act="g-condividi" data-link="${esc(link)}">Condividi</button><button class="btn ghost" data-act="g-copia" data-link="${esc(link)}">Copia</button></div>
        ${admin ? `<button class="btn ghost small" data-act="g-nuovocodice" style="align-self:flex-start">Crea un link nuovo (il vecchio smette di funzionare)</button>` : ""}</section>
      ${admin ? `<form id="g-rinomina" class="card"><h2>Nome del gruppo</h2><div class="row"><label class="sr" for="g-nn">Nome</label><input class="input" id="g-nn" value="${esc(d.gruppo.nome)}" maxlength="60"><button class="btn ghost" type="submit">Salva</button></div></form>` : ""}
      <section class="card" style="gap:0"><div class="between" style="margin-bottom:4px"><h2>Membri · ${d.membri.length}</h2>${admin ? `<span class="small muted">ruolo</span>` : ""}</div>${d.membri.map(membro).join("")}
        ${admin ? `<span class="small muted" style="padding-top:8px">Gli <b>organizzatori</b> vedono e condividono il link d'invito. Gli <b>amministratori</b> gestiscono anche i membri.</span>` : ""}</section>
      <div id="g-esci-box"><button class="btn ghost block" data-act="g-esci">Esci dal gruppo</button></div>`;
  }

  // ---------------------------------------------------------------- risultato dopo la gara
  const fmtDiff = (s) => { s = Math.abs(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`; };
  function garaDaRaccontare() {
    const o = oggi();
    return S.gare.filter((g) => g.data < o && L.diffDays(o, g.data) <= 7 && !(S.risultati || {})[g.id]).sort((a, b) => (a.data < b.data ? 1 : -1))[0] || null;
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

  function vistaRisultato(id) {
    const g = S.gare.find((x) => x.id === id);
    if (!g) return `<p class="sub">Gara non trovata.</p>`;
    const r = (S.risultati || {})[id] || {}, pb = (S.pb || {})[g.distanza];
    const inGruppo = S.gruppo && S.gruppo.dentro;
    const altri = inGruppo && GD() ? GD().bacheca.filter((p) => p.tipo === "risultato" && p.gara_nome === g.nome && !p.mio).map((p) => p.membro) : [];
    setTimeout(() => stravaRisultato(id), 0);
    return `${bannerProva()}<header class="head-back">${back("#/oggi")}<div><span class="eyebrow">${esc(titoloGara(g.nome))} · ${esc(L.fmtGiorno(g.data))}</span><h1 style="font-size:30px">Com'è andata?</h1></div></header>
      <form id="risultato" data-id="${esc(id)}" style="display:flex;flex-direction:column;gap:12px">
      <section class="card" style="align-items:center;text-align:center"><span class="eyebrow" id="ris-tempo-l">Il tuo tempo ufficiale</span>
        ${campoTempo("ris-tempo", g.distanza, r.tempo, "ris-tempo-l", true)}
        <div id="ris-strava" style="width:100%"></div>
        <span class="small muted" id="ris-pb">${pb ? `Il tuo personale: ${esc(L.leggiTempo(g.distanza, pb.tempo).tempo || pb.tempo)}` : "Solo numeri: si passa da solo alla casella dopo"}</span></section>
      <div class="field"><label for="ris-testo">Due parole <span class="muted">(facoltativo)</span></label><textarea class="input" id="ris-testo" maxlength="280" placeholder="es. Crisi al 16, poi il traguardo mi ha tirato su.">${esc(r.testo || "")}</textarea></div>
      ${inGruppo ? `<section class="card" style="gap:0"><label class="check"><input type="checkbox" id="ris-bacheca" checked><span><span class="t">Condividi in bacheca con il gruppo</span>${GD() && GD().io && GD().io.mostra_pb !== false ? `<br><span class="d">Se è un nuovo personale, si aggiorna anche in classifica.</span>` : ""}</span></label></section>` : `<p class="sub">Entra in un gruppo per condividere i risultati con la tua società.</p>`}
      <button class="btn block" type="submit">${inGruppo ? "Salva e condividi" : "Salva"}</button>
      ${r.tempo ? `<a class="btn ghost block" href="#/condividi/${encodeURIComponent(id)}">Crea l'immagine da condividere</a>` : ""}
      ${altri.length ? `<div class="row">${avatari(altri)}<span class="small muted">${esc(altri.slice(0, 3).join(", "))} ${altri.length === 1 ? "ha" : "hanno"} già condiviso il loro</span></div>` : ""}</form>`;
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
  function leggiCampoTempo(id, distanza) {
    const t = L.tempoDaParti(...["h", "m", "s"].map((k) => (document.getElementById(`${id}-${k}`) || {}).value || ""));
    return t ? L.leggiTempo(distanza, t) : { errore: "Scrivi il tempo: ore, minuti e secondi" };
  }
  function sezionePB() {
    const pb = S.pb || {}, inG = S.gruppo && S.gruppo.dentro && GD();
    const riga = (d) => {
      const x = pb[d];
      return `<form class="pb-riga" data-form="pb" data-d="${d}">
        <div class="between"><span class="title">${esc(L.DIST_LABEL[d])}${x && x.fonte === "strava" ? ' <span class="small muted" style="font-weight:700">· da Strava</span>' : ""}</span>${x ? `<b class="pb-tempo">${esc(L.leggiTempo(d, x.tempo).tempo || x.tempo)}</b>` : `<span class="small muted">da inserire</span>`}</div>
        ${x && (x.gara || x.data) ? `<span class="small muted">${esc([titoloGara(x.gara), x.data && L.fmtBreve(x.data)].filter(Boolean).join(" · "))}</span>` : ""}
        <details><summary class="small">${x ? "Modifica" : "Inserisci il personale"}</summary><div style="display:flex;flex-direction:column;gap:10px;padding-top:10px">
          <div class="field"><span class="lbl" id="pb-t-${d}-l">Tempo ufficiale</span>${campoTempo(`pb-t-${d}`, d, x && x.tempo, `pb-t-${d}-l`)}</div>
          <div class="grid2"><div class="field"><label for="pb-g-${d}">Gara <span class="muted">(facoltativo)</span></label><input class="input" id="pb-g-${d}" maxlength="120" value="${esc(x ? x.gara || "" : "")}" placeholder="es. Roma-Ostia"></div>
          <div class="field"><label for="pb-d-${d}">Quando</label><input class="input" id="pb-d-${d}" type="date" max="${L.todayISO()}" value="${esc(x ? x.data || "" : "")}"></div></div>
          <div class="row"><button class="btn" type="submit">Salva</button>${x ? `<button class="btn ghost" type="button" data-act="pb-togli" data-d="${d}">Togli</button>` : ""}</div></div></details></form>`;
    };
    return `${DISTANZE.map(riga).join("")}
      ${inG ? `<label class="check" style="border:0;padding:4px 0"><input type="checkbox" id="io-mostra-pb" ${GD().io.mostra_pb !== false ? "checked" : ""}><span><span class="t">Metti i miei personali nella classifica del gruppo</span><br><span class="d">Al gruppo vanno solo tempo, gara e data.</span></span></label><a class="small" href="#/gruppo/classifica">Classifica del gruppo ›</a>` : ""}
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
      }
      S.strava.letto = Date.now(); salva();
      if (/^#\/io/.test(location.hash)) rerender();
    } catch (e) { /* riprova alla prossima apertura */ }
  }
  // Scollegato (o account cancellato): scarpe e personali importati restano e diventano manuali.
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
  // Personali da Strava: le corse segnate come gara, la migliore per distanza, da confermare una per una.
  function caricaPBStrava() {
    STRAVA_PB = "carico";
    funzioneStrava({ azione: "gare" }).then((r) => { STRAVA_PB = { ...L.candidatiPersonali(r.gare), totale: (r.gare || []).length }; }).catch((e) => { STRAVA_PB = { errore: e.message }; })
      .then(() => { if (/^#\/pb/.test(location.hash)) rerender(); });
  }
  function sezioneStravaPB() {
    if (!STRAVA_PB) return "";
    if (STRAVA_PB === "carico") return `<section class="card"><span class="small">Leggo le tue gare su Strava…</span></section>`;
    if (STRAVA_PB.errore) return `<section class="card"><span class="small">${esc(STRAVA_PB.errore)}</span><button class="btn ghost small" data-act="strava-pb" style="align-self:flex-start">Riprova</button></section>`;
    const voce = (d) => {
      const lista = STRAVA_PB[d] || [], c = lista[0], att = (S.pb || {})[d];
      if (!c) return `<section class="card"><div class="between"><span class="title">${esc(L.DIST_LABEL[d])}</span><span class="small muted">nessuna su Strava</span></div><span class="small muted">Nessuna corsa di questa distanza segnata come gara. Puoi inserirla a mano.</span></section>`;
      const meglio = !att || c.secondi < att.secondi, km = (c.metri / 1000).toFixed(1).replace(".", ",");
      const altre = lista.slice(1, 8);
      return `<section class="card ${meglio ? "strava-meglio" : ""}"><div class="between"><span class="title">${esc(L.DIST_LABEL[d])}</span><span class="small muted">${att ? `oggi nell'app: ${esc(L.leggiTempo(d, att.tempo).tempo || att.tempo)}` : "non ancora inserito"}</span></div>
        <div class="between"><span style="min-width:0"><b>${esc(c.nome)}</b><br><span class="small muted">${esc(L.fmtBreve(c.data))} · ${km} km sul GPS</span></span><b class="pb-tempo">${esc(c.tempo)}</b></div>
        ${meglio ? `${att ? `<span class="small" style="color:var(--accent-strong);font-weight:700">Migliore di quello che hai: −${esc(fmtDiff(att.secondi - c.secondi))}</span>` : ""}
          <div class="grid2"><button class="btn" data-act="strava-pb-salva" data-d="${d}" data-id="${esc(c.id)}">Salva come personale</button><button class="btn ghost" data-act="strava-pb-correggi" data-d="${d}" data-id="${esc(c.id)}">Correggi il tempo</button></div>`
          : `<span class="small muted">${c.secondi === att.secondi ? "È già il tuo personale." : `Più lento di quello che hai: resta ${esc(L.leggiTempo(d, att.tempo).tempo || att.tempo)}.`}</span>`}
        ${altre.length ? `<details><summary class="small">Altre ${altre.length} trovate</summary>${altre.map((x) => `<div class="between small" style="padding:6px 0"><span>${esc(x.nome)} · ${esc(L.fmtBreve(x.data))}</span><span class="row"><b>${esc(x.tempo)}</b><button class="linkbtn" data-act="strava-pb-salva" data-d="${d}" data-id="${esc(x.id)}">Usa questa</button></span></div>`).join("")}</details>` : ""}</section>`;
    };
    return `<p class="sub">Abbiamo letto le tue corse segnate come <b>gara</b> su Strava: ${STRAVA_PB.totale}. Conferma il tempo ufficiale, che può differire da quello del GPS.</p>${DISTANZE.map(voce).join("")}
      <p class="sub">I tempi da Strava restano sul telefono. Entrano nella classifica del gruppo solo quelli che salvi, e solo se hai scelto di comparire.</p>`;
  }
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
        <div class="field"><label for="sl-${esc(s.id)}">Da cambiare a</label><select class="input" id="sl-${esc(s.id)}" data-act-change="scarpa-limite" data-id="${esc(s.id)}">${opzioni([400, 500, 600, 700, 800, 900, 1000], s.limite, (v) => `${v} km`)}</select></div></div></article>`;
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
      ${acc("profilo", "Profilo", esc([P.nome, P.citta, P.ora && oraInput(P.ora)].filter(Boolean).join(" · ") || "da completare"), `<form id="profilo" autocomplete="off" style="display:flex;flex-direction:column;gap:10px">
        <div class="field"><label for="p-nome">Come ti chiami</label><input class="input" id="p-nome" data-auto="nome" value="${esc(P.nome)}" autocomplete="given-name"></div>
        <div class="field"><label for="p-citta">Dove corri di solito</label><input class="input" id="p-citta" data-auto="citta" value="${esc(P.citta)}" placeholder="es. Roma">
          <div class="between">${bottoneGps("p-citta")}${P.coord ? `<span class="small muted">dal GPS</span>` : ""}</div></div>
        <div class="field"><label for="p-ora">A che ora esci di solito</label><input class="input" id="p-ora" data-auto="ora" type="time" step="900" value="${esc(oraInput(P.ora))}"></div>
        <span class="small muted">Si salva da solo.</span></form>`)}
      ${acc("documenti", "Tessera e certificato", (() => { const a = statoDoc((S.documenti || {}).tessera), b = statoDoc((S.documenti || {}).certificato); const peggio = [a, b].find((x) => ["scaduto", "urgente", "presto"].includes(x.livello)); return peggio ? pillDoc(peggio) : a.livello === "ok" && b.livello === "ok" ? '<span class="pill ok">in regola</span>' : "da inserire"; })(), sezioneDocumenti())}
      ${acc("notifiche", "Notifiche", on ? '<span class="pill ok">attive</span>' : sp === "ok" ? "da attivare" : sp === "non-pronto" ? "in arrivo" : "non disponibili", cardPush(false, true))}
      ${acc("gruppo", "Gruppo", inG ? `${esc(GD().gruppo.nome)} · ${esc(RUOLI_G[GD().io.ruolo].toLowerCase())}` : "non sei in un gruppo", inG ? `<span class="small">Sei in <b>${esc(GD().gruppo.nome)}</b> come «${esc(GD().io.nome)}».</span>
        <label class="check" style="border:0;padding:4px 0"><input type="checkbox" id="io-mostra" ${GD().io.mostra_gare ? "checked" : ""}><span><span class="t">Mostra al gruppo le mie gare</span><br><span class="d">Nome della gara, ruolo e tempo obiettivo.</span></span></label>
        <a class="btn ghost" href="#/gruppo/admin">${GD().io.ruolo === "membro" ? "Membri ed esci dal gruppo" : "Gestisci il gruppo"}</a>` : `<span class="small">Entra nel gruppo della tua società con il link d'invito, oppure crealo se sei il presidente.</span><a class="btn ghost" href="#/gruppo">Vai al gruppo</a>`)}
      ${acc("personali", "I miei personali", esc(riassuntoPB()) || "da inserire", sezionePB())}
      ${C().strava ? acc("strava", "Strava", STRAVA_STATO && STRAVA_STATO.collegato ? '<span class="pill ok">collegato</span>' : "in prova", sezioneStrava()) : ""}
      ${acc("scarpe", "Le mie scarpe", S.scarpe.length ? `${S.scarpe.length} ${stravaOn ? "da Strava" : S.scarpe.length === 1 ? "paio" : "paia"}${daCambiare ? ` · <b style="color:var(--warn)">${daCambiare} da cambiare</b>` : ""}` : "nessuna", `${scarpe || `<span class="small">Nessuna scarpa ancora.</span>`}
        ${stravaOn ? `<span class="small muted">I km arrivano da Strava${S.strava.letto ? `, aggiornati alle ${esc(new Date(S.strava.letto).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }))}` : ""}. Una scarpa nuova si aggiunge su Strava; quelle ritirate lì spariscono da qui.</span>` : S.strava && S.strava.attivo ? `<span class="small muted">Su Strava non hai scarpe attive, quindi usiamo quelle inserite qui. Se ne aggiungi una su Strava, i km arriveranno da lì e queste andranno in Archivio.</span>` : ""}
        ${archivio.length ? `<details class="card"><summary>Archivio · ${archivio.length} ${archivio.length === 1 ? "scarpa inserita" : "scarpe inserite"} a mano</summary>${archivio.map((x) => `<div class="between" style="padding:6px 0"><span>${esc(x.nome)} <span class="small muted">· ${Math.round(Number(x.km) || 0)} km</span></span><button class="btn ghost small" data-act="arch-del" data-id="${esc(x.id)}">Elimina</button></div>`).join("")}<span class="small muted">${stravaOn ? "Non contano finché Strava è collegato." : "Se sono le stesse scarpe che hai già, eliminale."}</span></details>` : ""}
        ${stravaOn ? "" : `<details class="card"><summary>+ Aggiungi una scarpa</summary><form id="scarpa" style="display:flex;flex-direction:column;gap:10px">
        <div class="field"><label for="s-nome">Modello</label><input class="input" id="s-nome" required placeholder="es. la mia scarpa da lento"></div>
        <div class="grid2"><div class="field"><label for="s-tipo">Uso</label><select class="input" id="s-tipo"><option value="allenamento">Allenamento</option><option value="ritmo">Ritmo e lunghi</option><option value="gara">Gara</option><option value="trail">Trail</option></select></div>
        <div class="field"><label for="s-km">Km attuali</label><input class="input" id="s-km" type="number" min="0" value="0"></div></div>
        <div class="field"><label for="s-lim">Da cambiare a (km)</label><input class="input" id="s-lim" type="number" min="100" value="800"></div>
        <button class="btn" type="submit">Aggiungi scarpa</button></form></details>
        <span class="small muted">I km si aggiornano a mano${C().strava ? "; con Strava arrivano da soli" : ""}.</span>`}`)}
      <details class="card"><summary>Strumenti di prova</summary>
        <form id="prova" style="display:flex;flex-direction:column;gap:10px"><div class="field"><label for="d-prova">Fai finta che oggi sia</label><input class="input" id="d-prova" type="date" value="${esc(S.prova)}"></div>
        <div class="grid2"><button class="btn" type="submit">Applica</button><button class="btn ghost" type="button" data-act="prova-off">Torna a oggi</button></div></form>
        <a class="small" href="#/statistiche" style="align-self:flex-start">Statistiche ›</a>
        <div id="reset-box" style="display:flex;flex-direction:column;gap:8px"><button class="btn ghost" type="button" data-act="reset-ask">Cancella tutti i miei dati</button></div></details>
      <a class="btn ghost" href="#/benvenuto">Rivedi il tutorial</a>
      <p class="sub">Versione ${esc(window.RB_VERSION || "?")} · gare condivise: ${Object.keys(S.segnalate || {}).length} di ${S.gare.length}${S.erroreSegnala ? ` · ultimo errore: ${esc(S.erroreSegnala)}` : ""}</p>
      <p class="sub">Profilo, preparazione e scarpe restano su questo telefono.</p>`;
  }

  // ---------------------------------------------------------------- router
  function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [path, query] = h.split("?");
    const parts = path.split("/").map(decodeURIComponent);
    const param = Object.fromEntries(new URLSearchParams(query || ""));
    const tab = parts[0] || "oggi";
    document.querySelectorAll("nav.tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.tab === ({ prepara: "oggi", aggiungi: "gare", gara: "gare", checklist: "gare", percorso: "gare", meteo: "oggi", pillole: "oggi", invito: "gruppo", risultato: "oggi", pb: "io", statistiche: "io", condividi: "gare" }[tab] || tab) ? "page" : "false"));
    if (D.errore) { $app.innerHTML = `<section class="card"><span class="title">Qualcosa non va</span><span class="small">${esc(D.errore)}</span></section>`; return; }
    let html;
    const benvenuto = !S.benvenuto && !S.gare.length && (tab === "oggi" || tab === "benvenuto");
    document.body.classList.toggle("onboarding", benvenuto);
    if (benvenuto || tab === "benvenuto") { $app.innerHTML = vistaBenvenuto(); document.body.classList.add("onboarding"); avviaBenvenuto(); return; }
    switch (tab) {
      case "gare": html = vistaGare(param); break;
      case "aggiungi": html = vistaAggiungi(parts[1]); break;
      case "percorso": { const fid = parts[1] || (L.gareAttive(S.gare, D.fasi, oggi()).focus || S.gare[0] || {}).id; html = fid ? vistaPreparazione(fid) : vistaVuota(); break; }
      case "checklist": html = vistaBorsa(parts[1]); break;
      case "gruppo":
        html = parts[1] === "gara" ? vistaGaraGruppo(parts[2]) : parts[1] === "classifica" ? vistaClassifica(param) : parts[1] === "admin" ? vistaAdmin() : vistaGruppo();
        break;
      case "invito": html = vistaInvito(parts[1]); break;
      case "pb": html = vistaPB(param); break;
      case "condividi": html = vistaCondividi(parts[1]); break;
      case "statistiche": html = vistaStatistiche(); break;
      case "risultato": html = vistaRisultato(parts[1]); break;
      case "io": if (param.strava) { ritornoStrava(param.strava); history.replaceState(null, "", "#/io"); }
        if (parts[1] === "documenti") S.ioAperto = { ...(S.ioAperto || {}), documenti: true }; html = vistaIo(); break;
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
    document.body.classList.toggle("onboarding", tab === "invito" && !(S.gruppo && S.gruppo.dentro));
    document.body.classList.toggle("funnel-on", tab === "prepara");
    if (tab === "oggi" || !tab) riempiMeteo();
    riempiMeteoGaraBox();
    if (tab === "io") { mostraFotoDoc(); if (parts[1] === "documenti") { const el = document.querySelector('[data-acc="documenti"]'); if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 50); } }
    if (tab === "meteo") riempiMeteoDettaglio();
    if (tab === "gare" && param.focus) { const c = document.getElementById("cerca"); if (c) { c.focus(); c.setSelectionRange(c.value.length, c.value.length); } }
  }
  const rerender = () => { const y = window.scrollY; route(); window.scrollTo(0, y); };

  // ---------------------------------------------------------------- azioni
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "spunta") {
      if (t.tagName === "INPUT") S.spunte[t.dataset.k] = t.checked; else S.spunte[t.dataset.k] = true;
      if (!S.spunte[t.dataset.k]) delete S.spunte[t.dataset.k];
      salva(); if (t.tagName !== "INPUT") toast("Fatto"); rerender();
    } else if (act === "ob-avanti") {
      const tr = document.getElementById("ob-track"); tr.scrollBy({ left: tr.clientWidth, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    } else if (act === "ob-fine") {
      S.benvenuto = true; salva(); document.body.classList.remove("onboarding");
      if (t.dataset.vai) location.hash = t.dataset.vai; else if (location.hash === "#/benvenuto") location.hash = "#/oggi"; else route();
    } else if (act === "g-applaudi") {
      t.classList.toggle("on"); azioneGruppo(() => rpc("applaudi", { p_token: token(), p_post: t.dataset.id }));
    } else if (act === "g-togli") {
      azioneGruppo(() => rpc("togli_post", { p_token: token(), p_post: t.dataset.id }), "Tolto dalla bacheca");
    } else if (act === "g-rimuovi") {
      confirmBox(t, `Tolgo ${t.dataset.nome} dal gruppo?`, () => azioneGruppo(() => rpc("admin_rimuovi", { p_token: token(), p_membro: t.dataset.id }), "Membro rimosso"));
    } else if (act === "g-nuovocodice") {
      confirmBox(t, "Creo un link nuovo? Quello vecchio smette di funzionare.", () => azioneGruppo(() => rpc("admin_gruppo", { p_token: token(), p_nome: null, p_nuovo_codice: true }), "Nuovo link creato"));
    } else if (act === "g-condividi") {
      const testo = `Entra nel gruppo «${GD().gruppo.nome}» su RaceBuddy: vediamo chi corre le stesse gare e ci applaudiamo i risultati.`;
      if (navigator.share) navigator.share({ title: "RaceBuddy", text: testo, url: t.dataset.link }).catch(() => {});
      else copia(t.dataset.link);
    } else if (act === "g-copia") {
      copia(t.dataset.link);
    } else if (act === "g-esci") {
      confirmBox(t, "Esci dal gruppo? Le tue gare e i tuoi post spariscono dal gruppo.", async () => {
        try { await rpc("esci_gruppo", { p_token: token() }); S.gruppo = { token: S.gruppo.token }; salva(); toast("Sei uscito dal gruppo"); location.hash = "#/gruppo"; }
        catch (e) { toast(e.message); rerender(); }
      });
    } else if (act === "perte-tipo") {
      location.hash = `#/perte?t=${t.dataset.t}`;
      return;
    } else if (act === "apri-novita") {
      S.letti = S.letti || {}; S.letti["n:" + t.dataset.id] = oggi(); salva();
      return;
    } else if (act === "apri-contenuto") {
      S.letti = S.letti || {}; S.letti["c:" + t.dataset.id] = oggi(); salva(); // il link si apre comunque
      return;
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
    } else if (act === "doc-togli-foto") {
      fotoTogli(t.dataset.k).catch(() => {}); doc(t.dataset.k).foto = false; salva(); toast("Foto tolta"); rerender();
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
    } else if (act === "filtro") {
      const q = document.getElementById("cerca").value;
      location.hash = `#/gare?q=${encodeURIComponent(q)}&d=${t.dataset.d}`;
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
      if (sc) { if (e.target.dataset.actChange === "scarpa-uso") sc.tipo = e.target.value; else sc.limite = Number(e.target.value); salva(); rerender(); }
    } else if (e.target.dataset && e.target.dataset.actChange === "cnd-flag") {
      CND[e.target.dataset.k] = e.target.checked; disegnaAnteprima();
    } else if (e.target.id === "cnd-foto" && e.target.files && e.target.files[0]) {
      const url = URL.createObjectURL(e.target.files[0]);
      caricaImg(url).then((im) => { CND.foto = im; CND.stile = "foto"; rerender(); }).catch(() => toast("Non riesco ad aprire la foto"));
    } else if (e.target.dataset && e.target.dataset.actChange === "g-ruolo") {
      azioneGruppo(() => rpc("admin_ruolo", { p_token: token(), p_membro: e.target.dataset.id, p_ruolo: e.target.value }), "Ruolo aggiornato");
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
    } else if (el.dataset && el.dataset.scan && el.files && el.files[0]) {
      const k = el.dataset.scan, nelFunnel = !!document.getElementById("prepara-form"), pdf = /pdf/i.test(el.files[0].type) || /\.pdf$/i.test(el.files[0].name || "");
      const stato = (t) => { const x = document.querySelector(`[data-scan-stato="${k}"]`); if (x) x.textContent = t; };
      el.closest("label").classList.add("disabled");
      try {
        const r = await scansiona(k, el.files[0], stato);
        const letti = descriviLetti(r, k);
        if (!letti) { stato("Non sono riuscito a leggere i dati: inseriscili a mano. La foto è salvata."); return; }
        const d = doc(k);
        if (r.tipo) d.tipo = r.tipo;
        if (r.rilascio) d.rilascio = r.rilascio;
        if (r.tesseramento) d.tesseramento = r.tesseramento;
        if (r.certificato) { const c = doc("certificato"); if (r.certificato.tipo) c.tipo = r.certificato.tipo; if (!nelFunnel && r.certificato.scadenza) c.scadenza = r.certificato.scadenza; }
        if (nelFunnel && r.societa) d.societa = r.societa;
        if (nelFunnel && r.codiceSocieta) d.codiceSocieta = r.codiceSocieta;
        if (nelFunnel) { // campi da confermare con "Avanti"
          const metti = (id, val) => { const f = document.getElementById(id); if (f && val) f.value = val; };
          if (k === "tessera") { metti("pf-tipo", r.tipo); metti("pf-numero", r.numero); metti("pf-tess-scadenza", r.scadenza); metti("pf-cert-scadenza", r.certificato && r.certificato.scadenza); }
          else metti("pf-cert-scadenza", r.scadenza);
          salva();
          stato(`Letti ${pdf ? "dal PDF" : "dalla foto"}: ${letti}. Controlla e correggi se serve.${r.calcolata ? (k === "tessera" ? (r.tipo === "FIDAL" ? " La scadenza della tessera è calcolata: la FIDAL vale fino al 31 dicembre dell'anno stampato sul tesserino." : " La scadenza è calcolata: 12 mesi dall'emissione.") : " La scadenza è calcolata: un anno dalla visita.") : ""}`);
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
    const val = e.target.value.trim();
    if ((S.profilo[k] || "") === val) return;
    S.profilo = { ...S.profilo, [k]: val };
    if (k === "citta") delete S.profilo.coord;
    salva(); toast("Salvato");
  });

  // Caselle del tempo: solo cifre, si passa da sole alla casella dopo, il tasto cancella su una casella vuota torna indietro.
  const caselleTempo = (el) => (el && el.closest && el.closest(".tempo3") ? [...el.closest(".tempo3").querySelectorAll("input")] : null);
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
      const d = (location.hash.match(/[?&]d=(\d*)/) || [])[1] || "";
      document.getElementById("risultati").innerHTML = risultati(L.cercaGare(D.gare, e.target.value, d, oggi()));
      history.replaceState(null, "", `#/gare?q=${encodeURIComponent(e.target.value)}&d=${d}`);
    }, 150);
  });

  document.addEventListener("submit", (e) => {
    const f = e.target; e.preventDefault();
    const v = (id) => (document.getElementById(id) || {}).value || "";
    if (f.id === "prepara-form") {
      const passo = f.dataset.passo;
      if (passo === "ora") S.profilo = { ...S.profilo, ora: v("pf-ora") };
      else if (passo === "zona") { const c = v("pf-citta").trim(); if (c !== (S.profilo.citta || "")) { S.profilo = { ...S.profilo, citta: c }; delete S.profilo.coord; } }
      else if (passo === "documenti") {
        const t = doc("tessera"); t.tipo = v("pf-tipo"); t.numero = v("pf-numero").trim().toUpperCase(); t.scadenza = v("pf-tess-scadenza");
        const c = doc("certificato"); c.scadenza = v("pf-cert-scadenza"); c.tipo = c.tipo || "agonistico (atletica leggera)";
      }
      salva(); vaiPasso(passo); return;
    }
    if (f.id === "manuale") {
      const id = "M" + Date.now().toString(36);
      S._bozza = { id, nome: v("m-nome"), data: v("m-data"), distanza: v("m-dist"), luogo: v("m-luogo"), fonte: "manuale" };
      salva(); location.hash = `#/aggiungi/${id}`;
    } else if (f.id === "aggiungi") {
      const id = f.dataset.id;
      const base = D.gare.find((x) => x.id === id) || S._bozza;
      const ruolo = (f.querySelector('input[name="ruolo"]:checked') || {}).value || "obiettivo";
      S.gare = S.gare.filter((g) => g.id !== id);
      S.gare.push({ id, nome: base.nome, data: base.data, luogo: base.luogo || "", distanza: base.distanza, ruolo, tempo: v("a-tempo"), aggiunta: oggi() });
      if (v("a-citta")) S.profilo.citta = v("a-citta");
      if (v("a-ora")) S.profilo.ora = v("a-ora");
      delete S._bozza; salva(); toast("Preparazione creata");
      segnalaGara(S.gare[S.gare.length - 1], base.fonte);
      location.hash = urlGara(id);
    } else if (f.id === "g-codice") {
      const c = (v("g-cod").match(/([A-Z2-9]{8})\s*$/i) || [])[1];
      if (c) location.hash = `#/invito/${c.toUpperCase()}`; else toast("Codice non valido: sono 8 caratteri");
    } else if (f.id === "g-crea" || f.id === "g-entra") {
      const nome = v("g-io").trim(), btn = f.querySelector("button[type=submit]"); btn.disabled = true;
      (async () => {
        try {
          if (f.id === "g-crea") await rpc("crea_gruppo", { p_token: token(), p_gruppo: v("g-nome").trim(), p_nome: nome });
          else await rpc("entra_gruppo", { p_token: token(), p_codice: f.dataset.codice, p_nome: nome, p_mostra: document.getElementById("g-mostra").checked });
          G().dentro = true; if (!S.profilo.nome) S.profilo.nome = nome.split(" ")[0]; salva();
          const pbNo = document.getElementById("g-mostra-pb") && !document.getElementById("g-mostra-pb").checked;
          if (pbNo) await rpc("imposta_mostra_pb", { p_token: token(), p_mostra: false }).catch(() => {});
          await sincronizzaGareGruppo(); if (!pbNo) await sincronizzaPBGruppo(true); await aggiornaGruppo(true);
          document.body.classList.remove("onboarding");
          toast(f.id === "g-crea" ? "Gruppo creato: ora invita gli altri" : "Benvenuto nel gruppo!");
          location.hash = f.id === "g-crea" ? "#/gruppo/admin" : "#/gruppo";
        } catch (e) { btn.disabled = false; toast(e.message || "Non riuscito"); }
      })();
    } else if (f.id === "g-rinomina") {
      azioneGruppo(() => rpc("admin_gruppo", { p_token: token(), p_nome: v("g-nn").trim(), p_nuovo_codice: false }), "Nome aggiornato");
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
      S.risultati[id] = { tempo, secondi: sec, testo: v("ris-testo").trim(), pb, precedente: prec ? { tempo: prec.tempo, secondi: prec.secondi, gara: prec.gara || "", data: prec.data || "" } : null };
      if (pb) S.pb[g.distanza] = { tempo, secondi: sec, gara: g.nome, data: g.data };
      else if (daQuesta && prec) S.pb[g.distanza] = { ...prec }; // corretto al ribasso: torna il personale di prima
      S.spunte[`${id}:P051`] = true; salva();
      const condividi = document.getElementById("ris-bacheca");
      const fine = () => { toast(pb && prec ? `Nuovo personale! −${fmtDiff(prec.secondi - sec)}` : pb ? "Primo tempo registrato" : "Tempo salvato"); location.hash = `#/condividi/${encodeURIComponent(id)}`; };
      if (condividi && condividi.checked) {
        rpc("pubblica_risultato", { p_token: token(), p: { gara_id: id, gara_nome: g.nome, distanza: g.distanza, data_gara: g.data, tempo, pb, testo: v("ris-testo").trim() } })
          .then(() => aggiornaGruppo(true)).then(fine).catch((e) => { toast(e.message || "Salvato sul telefono, non condiviso"); });
      } else fine();
    } else if (f.id === "gara-imp") {
      const g = S.gare.find((x) => x.id === f.dataset.id);
      if (g) { g.ruolo = v("gi-ruolo") || g.ruolo; g.tempo = v("gi-tempo").trim(); salva(); toast("Salvato"); location.hash = urlGara(g.id); }
    } else if (f.id === "scheda") {
      const g = S.gare.find((x) => x.id === f.dataset.id);
      if (g) {
        const uff = (D.schede || {})[g.id] || {};
        g.info = {}; CAMPI.forEach(([k]) => { const val = v("i-" + k).trim(); if (val && val !== uff[k]) g.info[k] = val; });
        salva(); toast("Info gara salvate");
        location.hash = urlGara(g.id, "info");
      }
    } else if (f.id === "personale") {
      const t = v("p-voce").trim(); if (!t) return;
      S.personali.push({ id: "U" + Date.now().toString(36), titolo: t }); salva(); rerender();
    } else if (f.id === "profilo") {
      document.activeElement && document.activeElement.blur();
    } else if (f.id === "scarpa") {
      S.scarpe.push({ id: "S" + Date.now().toString(36), nome: v("s-nome").trim(), tipo: v("s-tipo"), km: Number(v("s-km")) || 0, limite: Number(v("s-lim")) || 800 }); salva(); toast("Scarpa aggiunta"); rerender();
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
      if (s && km > 0) { s.km = Math.round((Number(s.km) + km) * 10) / 10; salva(); toast(`+${km} km`); rerender(); }
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
  carica().then(() => { route(); contaApertura(); if (C().strava) aggiornaScarpeStrava(); S.gare.forEach((g) => segnalaGara(g, g.id.startsWith("M") ? "manuale" : "FIDAL")); if (S.push && S.push.attivo) sincronizzaPush(); if (S.gruppo && S.gruppo.dentro) { aggiornaGruppo(true).then(() => sincronizzaPBGruppo()); sincronizzaGareGruppo(); } });
})();
