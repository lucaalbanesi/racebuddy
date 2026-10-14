/* RaceBuddy – invio delle notifiche push. Gira ogni ora (mattino e sera) in GitHub Actions.
   Le regole su cosa e quando inviare sono in scripts/notifiche.js: qui solo dati, meteo e invio.
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

const cacheMeteo = {};
async function meteo(luogo, ora, giorno = OGGI) {
  let lat, lon;
  if (luogo && luogo.lat != null) ({ lat, lon } = luogo);
  else if (luogo && luogo.citta) {
    const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(luogo.citta)}&count=1&language=it&countryCode=IT`).then((r) => r.json());
    if (!g.results || !g.results[0]) return null;
    ({ latitude: lat, longitude: lon } = g.results[0]);
  } else return null;
  const k = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (!cacheMeteo[k]) cacheMeteo[k] = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code,is_day&timezone=Europe%2FRome&forecast_days=9`).then((r) => r.json());
  const h = cacheMeteo[k].hourly, i = h.time.indexOf(`${giorno}T${String(ora).padStart(2, "0")}:00`);
  return i < 0 ? null : { temp: h.temperature_2m[i], pioggia: h.precipitation_probability[i] ?? 0, vento: h.wind_speed_10m[i] ?? 0, codice: h.weather_code[i], notte: h.is_day[i] === 0 };
}

const N = require("./notifiche.js");
const schede = fs.existsSync(path.join(radice, "content/schede.json")) ? leggi("content/schede.json") : {};
const nomeLuogo = (l) => String(l || "").toLowerCase().replace(/(^|[\s'-])\S/g, (x) => x.toUpperCase());

// Ritrovi dei gruppi (se le tabelle del gruppo esistono): etichette in ora di Roma.
async function datiGruppi() {
  const vuoto = { ritroviPer: {}, gruppoDi: {}, corre: {} };
  const da = new Date(Date.now() - 864e5).toISOString();
  const [rr, mm, gg] = await Promise.all([
    sb(`ritrovi?select=id,gruppo_id,titolo,quando,luogo,gara_id,autore_id,annullato,promemoria,risposte(membro_id,risposta)&quando=gte.${encodeURIComponent(da)}`),
    sb("membri?select=id,gruppo_id"), sb("gare_membri?select=membro_id,gara_id")]);
  if (!rr.ok || !mm.ok || !gg.ok) return vuoto; // gruppo non ancora configurato
  const giorno = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
  const etichetta = (q) => { const x = new Date(q); return `${x.toLocaleDateString("it-IT", { timeZone: "Europe/Rome", weekday: "short", day: "numeric", month: "short" })} alle ${x.toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "numeric", minute: "2-digit" })}`; };
  const out = { ritroviPer: {}, gruppoDi: {}, corre: {} };
  for (const m of await mm.json()) out.gruppoDi[m.id] = m.gruppo_id;
  for (const g of await gg.json()) (out.corre[g.membro_id] = out.corre[g.membro_id] || []).push(g.gara_id);
  for (const r of await rr.json()) {
    (out.ritroviPer[r.gruppo_id] = out.ritroviPer[r.gruppo_id] || []).push({ id: r.id, titolo: r.titolo, giorno: giorno.format(new Date(r.quando)), etichetta: etichetta(r.quando),
      luogo: r.luogo, gara_id: r.gara_id, autore_id: r.autore_id, annullato: r.annullato, promemoria: r.promemoria, si: (r.risposte || []).filter((x) => x.risposta === "si").map((x) => x.membro_id) });
  }
  return out;
}

async function main() {
  if (!KEY || !PRIV || !VAPID_PUB) { console.log("Notifiche non ancora configurate (secret o chiave pubblica mancanti): niente da fare."); return; }
  webpush.setVapidDetails("https://github.com/lucaalbanesi/racebuddy", VAPID_PUB, PRIV);
  const r = await sb("push_iscrizioni?select=endpoint,p256dh,auth,dati,stato");
  if (!r.ok) { console.error("Lettura iscrizioni fallita", r.status, await r.text()); process.exit(1); }
  const iscritti = await r.json();
  const { ritroviPer, gruppoDi, corre } = await datiGruppi();
  let inviati = 0, scaduti = 0, valutati = 0;
  for (const it of iscritti) {
    const d = it.dati || {};
    const gareVicine = (d.gare || []).filter((g) => { const n = L.diffDays(g.data, OGGI); return n >= 0 && n <= 7; });
    const personale = PROVA || ORA === N.oraMattino(d.ora) || ORA === 19 || gareVicine.some((g) => g.data === OGGI && ORA === N.oraGara(schede[g.id]));
    const delGruppo = !!(d.membro && gruppoDi[d.membro]);
    if (!personale && !delGruppo) continue;
    valutati++;
    const sub = { endpoint: it.endpoint, keys: { p256dh: it.p256dh, auth: it.auth } };
    let stato = it.stato || {}, inviato = false, scaduta = false;
    const invia = async (msg) => {
      try { await webpush.sendNotification(sub, JSON.stringify(msg), { TTL: 3 * 3600, urgency: "normal" }); inviati++; inviato = true; }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { scaduta = true; scaduti++; await sb(`push_iscrizioni?endpoint=eq.${encodeURIComponent(it.endpoint)}`, { method: "DELETE" }); }
        else console.error("Invio fallito", e.statusCode || "", String(e.body || e.message || e).slice(0, 200));
      }
    };
    try {
      if (personale) {
        const oraUscita = Math.floor(Number(String(d.ora || "07:00").split(/[:.]/)[0]));
        const meteoUscita = await meteo(d.luogo, oraUscita).catch(() => null);
        const meteoGare = {};
        for (const g of gareVicine) {
          const ora = Math.floor(Number((String((schede[g.id] || {}).partenza || "9").match(/\d{1,2}/) || ["9"])[0]));
          meteoGare[g.id] = await meteo({ citta: nomeLuogo(g.luogo) || (d.luogo && d.luogo.citta) }, ora, g.data).catch(() => null);
        }
        let esito = N.pianifica({ oggi: OGGI, ora: ORA, dati: d, stato, fasi, percorso, schede, meteoUscita, meteoGara: (g) => meteoGare[g.id] || null });
        if (PROVA && !esito.invio) esito = { invio: { title: "RaceBuddy · prova", body: "Le notifiche funzionano. Ti scrivo solo quando c'è qualcosa di nuovo: cambi di meteo, tappe del percorso, la tua gara.", url: "./#/oggi", tag: "prova" }, stato };
        stato = esito.stato;
        if (esito.invio) await invia(esito.invio);
      }
      if (delGruppo && !scaduta && !PROVA) {
        const g = N.gruppo({ oggi: OGGI, ora: ORA, membro: d.membro, corre: corre[d.membro] || [], ritrovi: ritroviPer[gruppoDi[d.membro]] || [], stato, pref: d.pref });
        stato = g.stato;
        if (g.invio) await invia(g.invio);
      }
      if (!PROVA && !scaduta) await sb(`push_iscrizioni?endpoint=eq.${encodeURIComponent(it.endpoint)}`, { method: "PATCH", body: JSON.stringify({ stato, ...(inviato ? { ultimo_invio: OGGI } : {}) }) });
    } catch (e) { console.error("Errore", String(e.message || e).slice(0, 200)); }
  }
  console.log(`${OGGI} ore ${ORA}: iscritti ${iscritti.length}, valutati ${valutati}, inviati ${inviati}, iscrizioni scadute rimosse ${scaduti}`);
}

if (require.main === module) main();

