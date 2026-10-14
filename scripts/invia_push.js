/* RaceBuddy – messaggio del mattino via notifiche push.
   Gira ogni ora in GitHub Actions. Per ogni iscritto la cui uscita è tra circa un'ora (ora di Roma) e che oggi
   non ha ancora ricevuto il messaggio: meteo all'ora dell'uscita, come vestirsi, avviso principale, cosa fare oggi.
   Variabili: SUPABASE_SECRET_KEY, VAPID_PRIVATE_KEY (GitHub Secrets). Con PROVA=1 invia subito a tutti. */
"use strict";
const fs = require("fs");
const path = require("path");
const webpush = require.main === module ? require("web-push") : null;
const L = require("../app/logic.js");

const radice = path.join(__dirname, "..");
const cfg = fs.readFileSync(path.join(radice, "app/config.js"), "utf8");
const URL_SB = cfg.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0];
const VAPID_PUB = (cfg.match(/vapidPublic:\s*"([^"]+)"/) || [])[1];
const KEY = process.env.SUPABASE_SECRET_KEY, PRIV = process.env.VAPID_PRIVATE_KEY, PROVA = process.env.PROVA === "1";

const leggi = (f) => JSON.parse(fs.readFileSync(path.join(radice, f), "utf8"));
const fasi = leggi("content/fasi.json"), percorso = leggi("content/percorso.json");
const sb = (q, opt = {}) => fetch(`${URL_SB}/rest/v1/${q}`, { ...opt, headers: { apikey: KEY, "Content-Type": "application/json", ...(opt.headers || {}) } });

// Ora e data di Roma
const parti = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const OGGI = `${parti.year}-${parti.month}-${parti.day}`, ORA = Number(parti.hour);

const ICONA = { sereno: "☀️", variabile: "⛅", nuvoloso: "☁️", nebbia: "🌫️", pioggia: "🌧️", neve: "❄️", temporale: "⛈️" };
const cacheMeteo = {};
async function meteo(luogo, ora) {
  let lat, lon;
  if (luogo && luogo.lat != null) ({ lat, lon } = luogo);
  else if (luogo && luogo.citta) {
    const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(luogo.citta)}&count=1&language=it&countryCode=IT`).then((r) => r.json());
    if (!g.results || !g.results[0]) return null;
    ({ latitude: lat, longitude: lon } = g.results[0]);
  } else return null;
  const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (!cacheMeteo[k]) cacheMeteo[k] = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code,is_day&timezone=Europe%2FRome&forecast_days=2`).then((r) => r.json());
  const h = cacheMeteo[k].hourly, i = h.time.indexOf(`${OGGI}T${String(ora).padStart(2, "0")}:00`);
  return i < 0 ? null : { temp: h.temperature_2m[i], pioggia: h.precipitation_probability[i] ?? 0, vento: h.wind_speed_10m[i] ?? 0, codice: h.weather_code[i], notte: h.is_day[i] === 0 };
}

const titolo = (n) => String(n || "").replace(/^\s*[IVXLCDM]+\^\s*/, "");
async function messaggio(d) {
  const [hh, mm = "00"] = String(d.ora || "07:00").split(/[:.]/);
  const oraUscita = Number(hh), righe = [];
  const m = await meteo(d.luogo, oraUscita);
  let titoloMsg = `Buongiorno! Uscita delle ${oraUscita}:${mm}`;
  if (m) {
    const cielo = L.tipoCielo(m);
    titoloMsg = `${m.notte && cielo === "sereno" ? "🌙" : ICONA[cielo]} ${Math.round(m.temp)}° alle ${oraUscita}:${mm} · buongiorno!`;
    righe.push(L.vestizione(m).split(". ")[0].replace(/\.$/, "") + ".");
    const avv = L.avvisiMeteo(m).find((a) => a.livello === "attenzione") || L.avvisiMeteo(m)[0];
    if (avv) { const t = avv.testo.split(". ")[0].replace(/\.$/, ""); righe.push(`⚠️ ${avv.titolo}: ${t.charAt(0).toLowerCase() + t.slice(1)}.`); }
  }
  const gare = (d.gare || []).filter((g) => g && g.data && g.distanza);
  if (gare.length) {
    const { focus, obiettivo } = L.gareAttive(gare, fasi, OGGI);
    if (focus) {
      const spunte = Object.fromEntries((d.spunte || []).map((k) => [k, true]));
      const st = L.stato(percorso, focus, OGGI, spunte, d.rinvii || {});
      const azione = st.oggi.find((v) => v.tipo === "cosa da fare" && !spunte[v.chiave]);
      const momento = st.oggi.find((v) => v.tipo === "momento");
      if (azione) righe.push(`Oggi: ${azione.titolo}.`);
      else if (momento) righe.push(`${momento.titolo}`);
      const g = focus, n = L.diffDays(g.data, OGGI);
      righe.push(n === 0 ? `Oggi è il giorno: ${titolo(g.nome)}! 🏁` : n === 1 ? `Domani: ${titolo(g.nome)}. Borsa pronta?` : `${titolo(g.nome)} tra ${n} giorni.`);
    }
  }
  if (!m && !righe.length) return null;
  return { title: titoloMsg, body: righe.join("\n"), url: "./#/oggi", tag: `mattino-${OGGI}` };
}

// Chi esce entro le 12 riceve il messaggio un'ora prima; chi esce di pomeriggio o sera lo riceve alle 7.
const oraInvioPer = (ora) => { const h = Number(String(ora || "07:00").split(/[:.]/)[0]); return h <= 12 ? Math.max(5, h - 1) : 7; };

async function main() {
  if (!KEY || !PRIV || !VAPID_PUB) { console.log("Notifiche non ancora configurate (secret o chiave pubblica mancanti): niente da fare."); return; }
  webpush.setVapidDetails("https://github.com/lucaalbanesi/racebuddy", VAPID_PUB, PRIV);
  const r = await sb("push_iscrizioni?select=endpoint,p256dh,auth,dati,ultimo_invio");
  if (!r.ok) { console.error("Lettura iscrizioni fallita", r.status, await r.text()); process.exit(1); }
  const iscritti = await r.json();
  let inviati = 0, scaduti = 0, saltati = 0;
  for (const it of iscritti) {
    const d = it.dati || {};
    const oraInvio = oraInvioPer(d.ora);
    if (!PROVA && (it.ultimo_invio === OGGI || ORA !== oraInvio)) { saltati++; continue; }
    try {
      const msg = await messaggio(d);
      if (!msg) { saltati++; continue; }
      await webpush.sendNotification({ endpoint: it.endpoint, keys: { p256dh: it.p256dh, auth: it.auth } }, JSON.stringify(msg), { TTL: 3 * 3600, urgency: "normal" });
      inviati++;
      if (!PROVA) await sb(`push_iscrizioni?endpoint=eq.${encodeURIComponent(it.endpoint)}`, { method: "PATCH", body: JSON.stringify({ ultimo_invio: OGGI }) });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { scaduti++; await sb(`push_iscrizioni?endpoint=eq.${encodeURIComponent(it.endpoint)}`, { method: "DELETE" }); }
      else console.error("Invio fallito", e.statusCode || "", String(e.body || e.message || e).slice(0, 200));
    }
  }
  console.log(`${OGGI} ore ${ORA}: iscritti ${iscritti.length}, inviati ${inviati}, saltati ${saltati}, iscrizioni scadute rimosse ${scaduti}`);
}

if (require.main === module) main();
else module.exports = { messaggio, oraInvioPer, OGGI };
