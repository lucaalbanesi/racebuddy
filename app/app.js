/* RaceBuddy – web app (fetta 1: tutto sul telefono, senza account).
   Stato salvato nel browser; contenuti e calendario letti dai file pubblicati. */
(function () {
  "use strict";
  const L = window.RBLogic;
  const KEY = "racebuddy.v1";
  const $app = document.getElementById("app");

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
      [D.schede, D.contenuti, D.sorrisi] = await Promise.all([opz("content/schede.json", {}), opz("data/contenuti.json", { contenuti: [] }).then((x) => x.contenuti || []), opz("content/sorrisi.json", [])]);
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
      v: 1, ora: S.profilo.ora || "07:00", pref: { meteo: true, percorso: true, gara: true, documenti: true, ...(S.prefPush || {}) },
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
  async function disattivaPush() {
    try {
      const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
      if (sub) { await rpc("cancella_iscrizione", { p_endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    } catch (e) { /* va bene lo stesso */ }
    S.push = null; salva(); toast("Notifiche disattivate"); rerender();
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
    const pr = { meteo: true, percorso: true, gara: true, documenti: true, ...(S.prefPush || {}) };
    const sw = (k, t, d) => `<label class="check" style="cursor:pointer"><input type="checkbox" data-act="push-pref" data-k="${k}" ${pr[k] ? "checked" : ""}><span><span class="t">${t}</span><br><span class="d">${d}</span></span></label>`;
    if (on) corpo = `<span class="small">Ti scrivo solo quando c'è qualcosa di nuovo, al massimo una volta al giorno, un'ora prima della tua uscita delle <b>${ora}</b>. Mai di notte.</span>
      <div>${sw("meteo", "Meteo che cambia", "Solo se cambia davvero rispetto a ieri: gelo, caldo, vento forte, pioggia, ±5°. Mai lo stesso avviso due volte.")}${sw("percorso", "Tappe del percorso", "Le cose importanti da fare e quelle che hai rimandato a oggi.")}${sw("gara", "La tua gara", "Scheda pronta o cambiata, prime previsioni, la vigilia alle 19 e la mattina della gara.")}${sw("documenti", "Scadenze", "Tessera e certificato medico: 30, 15 e 2 giorni prima.")}</div>
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
  function sezioneDocumenti() {
    const t = doc("tessera"), c = doc("certificato");
    const campo = (k, f, l, v, extra = "") => `<div class="field"><label for="doc-${k}-${f}">${l}</label><input class="input" id="doc-${k}-${f}" data-docf="${k}:${f}" value="${esc(v || "")}" ${extra}></div>`;
    const foto = (k) => `<div class="doc-foto"><img data-doc-thumb="${k}" alt="Foto ${DOCS[k].toLowerCase()}" hidden data-act="doc-apri">
      <label class="btn ghost small" style="cursor:pointer">📷 ${doc(k).foto ? "Cambia foto" : "Aggiungi foto"}<input type="file" accept="image/*" data-docfoto="${k}" hidden></label>
      ${doc(k).foto ? `<button class="btn ghost small" type="button" data-act="doc-togli-foto" data-k="${k}">Togli foto</button>` : ""}</div>`;
    return `<section class="card doc"><div class="between"><span class="title">Tessera</span>${pillDoc(statoDoc(t))}</div>
        <div class="field"><label for="doc-tessera-tipo">Tipo</label><select class="input" id="doc-tessera-tipo" data-docf="tessera:tipo">${["", "FIDAL", "Runcard", "Runcard EPS"].map((x) => `<option value="${x}" ${t.tipo === x ? "selected" : ""}>${x || "Scegli…"}</option>`).join("")}</select></div>
        <div class="field"><label for="doc-tessera-numero">Numero di tessera</label><div class="row"><input class="input" id="doc-tessera-numero" data-docf="tessera:numero" value="${esc(t.numero || "")}" inputmode="text" autocomplete="off"><button class="btn ghost" type="button" data-act="doc-copia" ${t.numero ? "" : "disabled"}>Copia</button></div></div>
        ${t.tipo === "FIDAL" ? campo("tessera", "societa", "Società", t.societa) : ""}
        ${campo("tessera", "scadenza", "Scadenza", t.scadenza, 'type="date"')}
        ${foto("tessera")}</section>
      <section class="card doc"><div class="between"><span class="title">Certificato medico</span>${pillDoc(statoDoc(c))}</div>
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
    const barra = `<div class="bar" style="height:10px">${fasiDemo.map(([, n, c]) => `<div style="flex:${n}">${c === "done" ? '<div class="done" style="width:100%"></div>' : c === "fill" ? '<div class="fill" style="width:55%"></div>' : ""}</div>`).join("")}</div><div class="bar-labels">${fasiDemo.map(([t, n, c]) => `<span style="flex:${n}" class="${c === "fill" ? "cur" : ""}">${t}</span>`).join("")}</div>`;
    const voce = (t, d, quando, fatto) => `<label class="check ${fatto ? "done" : ""}"><input type="checkbox" ${fatto ? "checked" : ""} tabindex="-1"><span><span class="t">${t}</span><br><span class="d">${d}</span></span><span class="ob-quando ${quando === "oggi" ? "hot" : ""}">${quando}</span></label>`;
    const riga = (l, t) => `<div class="line"><span class="when" style="width:84px">${l}</span><span class="small">${t}</span></div>`;
    const mappaDemo = `<svg class="ob-mappa" viewBox="0 0 300 96" aria-hidden="true"><rect width="300" height="96" rx="10" fill="var(--line2)"/><path d="M0 70 C60 60 90 80 150 64 S240 40 300 52" stroke="var(--cloud)" stroke-width="10" fill="none"/><path d="M30 30 C70 10 110 70 150 50 S220 20 270 62" stroke="var(--accent)" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-dasharray="1 0"/><circle cx="30" cy="30" r="6" fill="var(--ok)"/><circle cx="270" cy="62" r="6" fill="var(--navy)"/><text x="40" y="26" font-size="11" font-weight="700" fill="var(--fg2)">Partenza</text><text x="226" y="84" font-size="11" font-weight="700" fill="var(--fg2)">Arrivo</text></svg>`;
    const slides = [
      { k: "Ciao!", t: "Il tuo buddy per la gara", d: "Ti accompagno dal giorno dell'iscrizione fino al traguardo. 10 km, mezza o maratona.",
        ill: `<div class="ob-countdown"><span class="big">46</span><span>giorni alla tua gara</span></div>` },
      { k: "1 · La preparazione", t: "Ogni giorno sai cosa fare", d: "Scegli la gara e la preparazione si costruisce sulle date vere: cosa provare nei lunghi, cosa preparare e quando. Spunti e vai avanti.",
        ill: `<div class="card ob-mini">${barra}
          ${voce("Certificato medico e tessera", "Validi fino al giorno della gara", "fatto", true)}
          ${voce("Prima prova di rifornimento", "Nel lungo prova il gel che userai in gara", "oggi", false)}
          ${voce("Prova il completo da gara", "Maglia, calze e scarpe insieme, in un lungo", "sab", false)}
          ${voce("Ritiro pettorale: orari e regole", "Documenti, delega, giorni dell'Expo", "tra 5 sett.", false)}</div>` },
      { k: "2 · Il meteo", t: "Come vestirti, ogni mattina", d: "Il meteo all'ora della tua uscita, cosa mettere e un avviso quando serve: gelo, caldo, vento forte, temporale.",
        ill: `<div class="card ob-mini">${bloccoMeteo(m, false)}</div>` },
      { k: "3 · La gara", t: "La tua gara, in una scheda", d: "Orari, ritiro pettorale, griglie, deposito e percorso, presi dal sito ufficiale e ricontrollati fino al via. Con la partenza su Maps.",
        ill: `<div class="card ob-mini"><div class="between"><b>Domenica · ore 8:30</b><span class="pill ok">dal sito ufficiale</span></div>${mappaDemo}<div class="list" style="display:flex;flex-direction:column">${riga("Pettorale", "Expo, ven 10-19 · sab 9-19")}${riga("Griglia", "Per tempo, ingresso 7:00-8:00")}${riga("Deposito", "In piazza dalle 7:00")}</div><span class="small" style="color:var(--accent);font-weight:700">Partenza in Maps ↗ · Percorso ↗</span></div>` },
    ];
    return `<section class="ob" aria-roledescription="tutorial" aria-label="Benvenuto in RaceBuddy">
      <div class="ob-top"><span class="ob-logo">RaceBuddy</span><button class="ob-salta" data-act="ob-fine">Salta</button></div>
      <div class="ob-track" id="ob-track">${slides.map((x, i) => `<article class="ob-slide" aria-label="${i + 1} di ${slides.length + 1}"><div class="ob-ill">${x.ill}</div><span class="eyebrow">${x.k}</span><h1>${x.t}</h1><p>${x.d}</p></article>`).join("")}
        <article class="ob-slide" aria-label="${slides.length + 1} di ${slides.length + 1}"><div class="ob-ill"><div class="ob-countdown"><span class="big">Via!</span></div></div><span class="eyebrow">Partiamo</span><h1>Qual è la tua prossima gara?</h1><p>Ci vuole un minuto. I tuoi dati restano su questo telefono.</p>
          <button class="btn block" data-act="ob-fine" data-vai="#/gare">Scegli la tua gara</button>
          <button class="ob-salta" data-act="ob-fine" data-vai="#/pb" style="align-self:center">Hai già dei personali? Inseriscili</button>
          <p class="ob-nota">Indicazioni generali per runner amatoriali in salute: non sostituiscono medico, nutrizionista o allenatore.</p></article></div>
      <div class="ob-bottom"><div class="ob-dots" aria-hidden="true">${[...slides, 0].map((_, i) => `<span class="${i ? "" : "on"}"></span>`).join("")}</div><button class="btn" id="ob-avanti" data-act="ob-avanti">Avanti</button></div></section>`;
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
    const daRaccontare = garaDaRaccontare();
    if (daRaccontare) blocco = `<a class="card dark" href="#/risultato/${encodeURIComponent(daRaccontare.id)}" style="text-decoration:none;font-weight:inherit"><span class="eyebrow">Dopo la gara</span><span style="font:700 24px/1.1 var(--display)">Com'è andata la ${esc(titoloGara(daRaccontare.nome))}?</span><span class="sub">Segna il tuo tempo${S.gruppo && S.gruppo.dentro ? " e condividilo con il gruppo" : ""} ›</span></a>` + blocco;
    if (recuperi) blocco += `<a class="card soft" href="${urlGara(obiettivo.id, "preparazione")}" style="text-decoration:none;color:inherit"><span class="between"><span class="title">Hai ${recuperi} ${recuperi === 1 ? "cosa" : "cose"} da recuperare</span><span aria-hidden="true">›</span></span><span class="small">Ti sei iscritto a preparazione iniziata.</span></a>`;
    if (focus.mancano >= 0 && focus.mancano <= 2) blocco += `<a class="btn block" href="${urlGara(focus.id, "borsa")}">Apri la checklist della borsa</a>`;
    blocco += cardInvitoPB();

    const fp = L.fase(D.fasi, focus.distanza, focus.data, o);
    const pil = L.pillola(D.pillole, fp.id, focus.distanza, o, Number(o.slice(5, 7)));
    const pill = pil ? `<section class="card soft" aria-label="Pillola del giorno"><span class="eyebrow" style="color:var(--accent-strong)">Pillola · ${esc(fp.nome)}</span><span class="title">${esc(pil.titolo)}</span><span class="small">${esc(pil.testo)}</span>${(() => { const n = L.pillolePool(D.pillole, fp.id, focus.distanza, Number(o.slice(5, 7))).length - 1; return n > 0 ? `<a class="small" href="#/pillole/${encodeURIComponent(focus.id)}">Vedi le altre ${n} di questa fase ›</a>` : ""; })()}</section>` : "";

    const meteo = cardMeteo();

    return `${bannerProva()}<header class="head"><div><span class="eyebrow">${esc(L.fmtGiorno(o))}</span><h1>Buongiorno${S.profilo.nome ? ", " + esc(S.profilo.nome) : ""}</h1></div></header>${hero}${avvisoDocumenti()}${meteo}${blocco}${cardPush(true)}${pill}${(() => {
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
    const ck = L.checklist(D.percorso, g, S.personali), tot = ck.borsa.length + ck.mattina.length;
    const fatte = [...ck.borsa, ...ck.mattina].filter((v) => S.spunte[v.chiave]).length;
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
    const tutte = [...ck.borsa, ...ck.mattina];
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
        ${ck.mattina.map((v) => voceCheck(v)).join("")}</section>`;
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
    const tipo = param.t || "", letti = Object.fromEntries(Object.keys(S.letti || {}).filter((k) => k.startsWith("c:")).map((k) => [k.slice(2), true]));
    const chip = (v, l) => `<button class="chip" data-act="perte-tipo" data-t="${v}" aria-pressed="${tipo === v}">${l}</button>`;
    const testa = `${bannerProva()}<header class="head"><div><span class="eyebrow">${esc(nomeFase)}</span><h1>Per te</h1></div></header>
      <div class="chips" role="group" aria-label="Tipo di contenuto">${chip("", "Tutto")}${chip("articolo", "Articoli")}${chip("video", "Video")}${chip("podcast", "Podcast")}${chip("sorrisi", "Sorrisi")}</div>`;
    if (tipo === "sorrisi") {
      const lista = [...(D.sorrisi || [])].sort((a, b) => (a.fase === fase ? -1 : 0) - (b.fase === fase ? -1 : 0));
      return `${testa}${lista.map((x) => `<section class="card sorriso"><p>${esc(x.testo)}</p></section>`).join("")}<p class="sub">Battute originali di RaceBuddy.</p>`;
    }
    const lista = L.perTe(D.contenuti || [], { fase, distanza, oggi: o, letti, tipo });
    if (!lista.length) return `${testa}<p class="sub">Nessun contenuto per ora: le fonti si aggiornano due volte al giorno.</p>`;
    const perFase = fase ? lista.filter((c) => c.perLaFase && !letti[c.id]).slice(0, 6) : [];
    const usati = new Set(perFase.map((c) => c.id));
    const novita = lista.filter((c) => !usati.has(c.id)).sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
    const n = Number(param.n || 20);
    return `${testa}
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
  function vistaRisultato(id) {
    const g = S.gare.find((x) => x.id === id);
    if (!g) return `<p class="sub">Gara non trovata.</p>`;
    const r = (S.risultati || {})[id] || {}, pb = (S.pb || {})[g.distanza];
    const inGruppo = S.gruppo && S.gruppo.dentro;
    const altri = inGruppo && GD() ? GD().bacheca.filter((p) => p.tipo === "risultato" && p.gara_nome === g.nome && !p.mio).map((p) => p.membro) : [];
    return `${bannerProva()}<header class="head-back">${back("#/oggi")}<div><span class="eyebrow">${esc(titoloGara(g.nome))} · ${esc(L.fmtGiorno(g.data))}</span><h1 style="font-size:30px">Com'è andata?</h1></div></header>
      <form id="risultato" data-id="${esc(id)}" style="display:flex;flex-direction:column;gap:12px">
      <section class="card" style="align-items:center;text-align:center"><label for="ris-tempo" class="eyebrow">Il tuo tempo ufficiale</label>
        <input class="input tempo-grande" id="ris-tempo" required inputmode="decimal" pattern="\\d{1,2}[:.,]\\d{2}([:.,]\\d{2})?" placeholder="${g.distanza === "10" ? "0:47:30" : g.distanza === "21" ? "1:45:00" : "3:45:00"}" value="${esc(r.tempo || "")}">
        <span class="small muted" id="ris-pb">${pb ? `Il tuo personale: ${esc(pb.tempo)}` : "Ore:minuti:secondi"}</span></section>
      <div class="field"><label for="ris-testo">Due parole <span class="muted">(facoltativo)</span></label><textarea class="input" id="ris-testo" maxlength="280" placeholder="es. Crisi al 16, poi il traguardo mi ha tirato su.">${esc(r.testo || "")}</textarea></div>
      ${inGruppo ? `<section class="card" style="gap:0"><label class="check"><input type="checkbox" id="ris-bacheca" checked><span><span class="t">Condividi in bacheca con il gruppo</span>${GD() && GD().io && GD().io.mostra_pb !== false ? `<br><span class="d">Se è un nuovo personale, si aggiorna anche in classifica.</span>` : ""}</span></label></section>` : `<p class="sub">Entra in un gruppo per condividere i risultati con la tua società.</p>`}
      <button class="btn block" type="submit">${inGruppo ? "Salva e condividi" : "Salva"}</button>
      ${altri.length ? `<div class="row">${avatari(altri)}<span class="small muted">${esc(altri.slice(0, 3).join(", "))} ${altri.length === 1 ? "ha" : "hanno"} già condiviso il loro</span></div>` : ""}</form>`;
  }

  // ---------------------------------------------------------------- personali
  function sezionePB() {
    const pb = S.pb || {}, inG = S.gruppo && S.gruppo.dentro && GD();
    const riga = (d) => {
      const x = pb[d], ph = { "10": "0:47:30", "21": "1:45:00", "42": "3:45:00" }[d];
      return `<form class="pb-riga" data-form="pb" data-d="${d}">
        <div class="between"><span class="title">${esc(L.DIST_LABEL[d])}</span>${x ? `<b class="pb-tempo">${esc(L.leggiTempo(d, x.tempo).tempo || x.tempo)}</b>` : `<span class="small muted">da inserire</span>`}</div>
        ${x && (x.gara || x.data) ? `<span class="small muted">${esc([titoloGara(x.gara), x.data && L.fmtBreve(x.data)].filter(Boolean).join(" · "))}</span>` : ""}
        <details><summary class="small">${x ? "Modifica" : "Inserisci il personale"}</summary><div style="display:flex;flex-direction:column;gap:10px;padding-top:10px">
          <div class="field"><label for="pb-t-${d}">Tempo ufficiale</label><input class="input" id="pb-t-${d}" required inputmode="decimal" pattern="\\d{1,2}[:.,]\\d{2}([:.,]\\d{2})?" placeholder="${ph}" value="${esc(x ? L.leggiTempo(d, x.tempo).tempo || x.tempo : "")}"></div>
          <div class="grid2"><div class="field"><label for="pb-g-${d}">Gara <span class="muted">(facoltativo)</span></label><input class="input" id="pb-g-${d}" maxlength="120" value="${esc(x ? x.gara || "" : "")}" placeholder="es. Roma-Ostia"></div>
          <div class="field"><label for="pb-d-${d}">Quando</label><input class="input" id="pb-d-${d}" type="date" max="${L.todayISO()}" value="${esc(x ? x.data || "" : "")}"></div></div>
          <div class="row"><button class="btn" type="submit">Salva</button>${x ? `<button class="btn ghost" type="button" data-act="pb-togli" data-d="${d}">Togli</button>` : ""}</div></div></details></form>`;
    };
    return `${DISTANZE.map(riga).join("")}
      ${inG ? `<label class="check" style="border:0;padding:4px 0"><input type="checkbox" id="io-mostra-pb" ${GD().io.mostra_pb !== false ? "checked" : ""}><span><span class="t">Metti i miei personali nella classifica del gruppo</span><br><span class="d">Al gruppo vanno solo tempo, gara e data.</span></span></label><a class="small" href="#/gruppo/classifica">Classifica del gruppo ›</a>` : ""}
      <span class="small muted">Restano su questo telefono. Dopo ogni gara, se fai meglio, il personale si aggiorna da solo.</span>`;
  }
  const riassuntoPB = () => DISTANZE.filter((d) => (S.pb || {})[d]).map((d) => `${L.DIST_LABEL[d]} ${L.leggiTempo(d, S.pb[d].tempo).tempo || S.pb[d].tempo}`).join(" · ");
  function vistaPB() {
    return `${bannerProva()}<header class="head-back">${back("#/io")}<div><span class="eyebrow">Io</span><h1 style="font-size:28px">I tuoi personali</h1></div></header>
      <p class="sub">Il tuo miglior tempo su 10 km, mezza e maratona, anche di gare corse prima di RaceBuddy.</p>
      <section class="card" style="gap:14px">${sezionePB()}</section>`;
  }
  const cardInvitoPB = () => (DISTANZE.some((d) => (S.pb || {})[d]) || (S.letti || {})["pb-invito"] ? ""
    : `<section class="card soft"><span class="title">Hai già dei personali?</span><span class="small">Inseriscili una volta: dopo ogni gara ti dico se hai fatto meglio${S.gruppo && S.gruppo.dentro ? " e, se vuoi, entrano nella classifica del gruppo" : ""}.</span>
      <div class="grid2"><a class="btn" href="#/pb">Inseriscili</a><button class="btn ghost" data-act="letto" data-k="pb-invito">Non ora</button></div></section>`);

  function vistaIo() {
    const P = S.profilo;
    const scarpe = S.scarpe.map((s) => {
      const st = L.statoScarpa(s);
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
    return `${bannerProva()}<header class="head"><h1>Io</h1></header>
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
      ${acc("scarpe", "Le mie scarpe", S.scarpe.length ? `${S.scarpe.length} ${S.scarpe.length === 1 ? "paio" : "paia"}${daCambiare ? ` · <b style="color:var(--warn)">${daCambiare} da cambiare</b>` : ""}` : "nessuna", `${scarpe || `<span class="small">Nessuna scarpa ancora.</span>`}
        <details class="card"><summary>+ Aggiungi una scarpa</summary><form id="scarpa" style="display:flex;flex-direction:column;gap:10px">
        <div class="field"><label for="s-nome">Modello</label><input class="input" id="s-nome" required placeholder="es. la mia scarpa da lento"></div>
        <div class="grid2"><div class="field"><label for="s-tipo">Uso</label><select class="input" id="s-tipo"><option value="allenamento">Allenamento</option><option value="ritmo">Ritmo e lunghi</option><option value="gara">Gara</option><option value="trail">Trail</option></select></div>
        <div class="field"><label for="s-km">Km attuali</label><input class="input" id="s-km" type="number" min="0" value="0"></div></div>
        <div class="field"><label for="s-lim">Da cambiare a (km)</label><input class="input" id="s-lim" type="number" min="100" value="800"></div>
        <button class="btn" type="submit">Aggiungi scarpa</button></form></details>
        <span class="small muted">I km si aggiornano a mano; con Strava arriveranno da soli.</span>`)}
      <details class="card"><summary>Strumenti di prova</summary>
        <form id="prova" style="display:flex;flex-direction:column;gap:10px"><div class="field"><label for="d-prova">Fai finta che oggi sia</label><input class="input" id="d-prova" type="date" value="${esc(S.prova)}"></div>
        <div class="grid2"><button class="btn" type="submit">Applica</button><button class="btn ghost" type="button" data-act="prova-off">Torna a oggi</button></div></form>
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
    document.querySelectorAll("nav.tabs a").forEach((a) => a.setAttribute("aria-current", a.dataset.tab === ({ aggiungi: "gare", gara: "gare", checklist: "gare", percorso: "gare", meteo: "oggi", pillole: "oggi", invito: "gruppo", risultato: "oggi", pb: "io" }[tab] || tab) ? "page" : "false"));
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
      case "pb": html = vistaPB(); break;
      case "risultato": html = vistaRisultato(parts[1]); break;
      case "io": if (parts[1] === "documenti") S.ioAperto = { ...(S.ioAperto || {}), documenti: true }; html = vistaIo(); break;
      case "gara": html = parts[2] === "preparazione" ? vistaPreparazione(parts[1]) : parts[2] === "info" ? vistaInfoGara(parts[1], param) : parts[2] === "borsa" ? vistaBorsa(parts[1]) : vistaGaraHome(parts[1], param); break;
      case "meteo": html = vistaMeteo(); break;
      case "pillole": html = vistaPillole(parts[1]); break;
      case "perte": html = vistaPerTe(param); break;
      default: html = vistaOggi();
    }
    $app.innerHTML = html;
    document.body.classList.toggle("onboarding", tab === "invito" && !(S.gruppo && S.gruppo.dentro));
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
    } else if (act === "apri-contenuto") {
      S.letti = S.letti || {}; S.letti["c:" + t.dataset.id] = oggi(); salva(); // il link si apre comunque
      return;
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
      confirmBox(t, "Cancello gare, spunte, scarpe e documenti da questo telefono?", () => { fotoTogli("tessera").catch(() => {}); fotoTogli("certificato").catch(() => {}); S = vuoto(); salva(); location.hash = "#/oggi"; route(); });
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
    if (e.target.dataset && e.target.dataset.actChange === "g-ruolo") {
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
      const [k, f] = el.dataset.docf.split(":"); doc(k)[f] = el.value.trim(); salva(); toast("Salvato");
      if (f === "tipo" || f === "scadenza" || f === "numero") rerender();
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
      const lt = g ? L.leggiTempo(g.distanza, v("ris-tempo")) : { errore: "Gara non trovata" };
      if (lt.errore) { toast(lt.errore); return; }
      const tempo = lt.tempo, sec = lt.secondi;
      S.pb = S.pb || {}; S.risultati = S.risultati || {};
      const prec = S.pb[g.distanza], pb = !prec || sec < prec.secondi;
      S.risultati[id] = { tempo, testo: v("ris-testo").trim(), pb };
      if (pb) S.pb[g.distanza] = { tempo, secondi: sec, gara: g.nome, data: g.data };
      S.spunte[`${id}:P051`] = true; salva();
      const condividi = document.getElementById("ris-bacheca");
      const fine = () => { toast(pb && prec ? `Nuovo personale! −${fmtDiff(prec.secondi - sec)}` : pb ? "Primo tempo registrato" : "Tempo salvato"); location.hash = condividi && condividi.checked ? "#/gruppo" : "#/oggi"; };
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
    } else if (f.dataset.form === "pb") {
      const d = f.dataset.d, lt = L.leggiTempo(d, v(`pb-t-${d}`));
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  carica().then(() => { route(); S.gare.forEach((g) => segnalaGara(g, g.id.startsWith("M") ? "manuale" : "FIDAL")); if (S.push && S.push.attivo) sincronizzaPush(); if (S.gruppo && S.gruppo.dentro) { aggiornaGruppo(true).then(() => sincronizzaPBGruppo()); sincronizzaGareGruppo(); } });
})();
