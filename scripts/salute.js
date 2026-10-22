/* RaceBuddy – controllo salute. Gira ogni ora (workflow "Controllo salute", cron di GitHub: non dipende dall'innesco di
   Supabase che controlla). Verifica:
   - job programmati: partiti quando dovevano e finiti bene (API di GitHub Actions);
   - dati: data di aggiornamento dei file del calendario, dei contenuti, delle gare seguite e delle gare estere;
   - servizi: sito, database, invii push di oggi, funzione buddy e (una volta al giorno) la ricerca tempi su FIDAL e GPL.
   Scrive l'esito in Supabase (salute_controlli, letto dalla pagina #/salute del superamministratore) e manda una push ai
   telefoni in salute_avvisi solo se qualcosa è KO: alla prima volta, quando si aggiunge un problema nuovo, e poi al
   massimo una volta al giorno finché resta. Stati: ok, attenzione (solo nella pagina), ko (pagina e push).
   Variabili: GITHUB_TOKEN, GITHUB_REPOSITORY, SUPABASE_SECRET_KEY, VAPID_PRIVATE_KEY. Nessun dato degli utenti. */
"use strict";
const fs = require("fs");
const path = require("path");

const ORA_MS = 3600 * 1000;
// Job e massimo di ore tra un giro e l'altro (ora di Roma: di notte molti job non girano)
const JOBS = [
  { id: "push", wf: "push.yml", nome: "Notifiche push", max: (h) => (h >= 6 && h <= 23 ? 1.5 : 9) },
  { id: "novita", wf: "novita.yml", nome: "Novità delle gare", max: (h) => (h >= 7 && h <= 22 ? 2.5 : 11) },
  { id: "contenuti", wf: "contenuti.yml", nome: "Contenuti", max: () => 14 },
  { id: "seguite", wf: "seguite.yml", nome: "Gare seguite", max: () => 26 },
  { id: "schede", wf: "schede.yml", nome: "Schede gara", max: () => 26 },
  { id: "calendario", wf: "calendario.yml", nome: "Calendario gare", max: () => 8 * 24 },
  { id: "estero", wf: "estero.yml", nome: "Gare estere", max: () => 32 * 24 },
];
// File di dati e giorni massimi dall'ultimo aggiornamento (campo "aggiornato")
const DATI = [
  { id: "dati-calendario", file: "data/gare.json", nome: "Calendario delle gare", giorni: 9 },
  { id: "dati-contenuti", file: "data/contenuti.json", nome: "Articoli e video", giorni: 2 },
  { id: "dati-seguite", file: "data/gare_seguite.json", nome: "Gare seguite", giorni: 2 },
  { id: "dati-estero", file: "content/estero.json", nome: "Gare estere", giorni: 35 },
];
const FALLITO = new Set(["failure", "timed_out", "startup_failure"]);

const romaParti = (d) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((p) => [p.type, p.value]));
const oraRoma = (d) => Number(romaParti(d).hour);
const giornoRoma = (d) => { const p = romaParti(d); return `${p.year}-${p.month}-${p.day}`; };
/** "22:37" se oggi, "ieri 22:37", altrimenti "21/10 22:37" (ora di Roma) */
function quando(iso, adesso) {
  const d = new Date(iso), p = romaParti(d), hm = `${p.hour}:${p.minute}`;
  const g = giornoRoma(d), oggi = giornoRoma(adesso), ieri = giornoRoma(new Date(adesso - 24 * ORA_MS));
  return g === oggi ? hm : g === ieri ? `ieri ${hm}` : `${p.day}/${p.month} ${hm}`;
}
const durata = (ore) => (ore < 48 ? `${Math.round(ore)} ${Math.round(ore) === 1 ? "ora" : "ore"}` : `${Math.round(ore / 24)} giorni`);

/** Esito di un job dai suoi ultimi giri (dal più recente). */
function valutaJob(j, runs, adesso) {
  const base = { id: j.id, gruppo: "job", nome: j.nome };
  const ultimo = (runs || [])[0];
  if (!ultimo) return { ...base, stato: "ko", dettaglio: "Nessun giro trovato" };
  const ore = (adesso - new Date(ultimo.created_at)) / ORA_MS, max = j.max(oraRoma(adesso));
  const link = ultimo.html_url || "";
  if (ore > max) return { ...base, stato: "ko", dettaglio: `Non parte da ${durata(ore)} (ultimo giro ${quando(ultimo.created_at, adesso)})`, link };
  const finito = runs.find((r) => r.status === "completed");
  if (finito && FALLITO.has(finito.conclusion)) return { ...base, stato: "ko", dettaglio: `Ultimo giro fallito (${quando(finito.created_at, adesso)})`, link: finito.html_url || link };
  if (finito && finito.conclusion === "cancelled") return { ...base, stato: "attenzione", dettaglio: `Ultimo giro annullato (${quando(finito.created_at, adesso)})`, link: finito.html_url || link };
  return { ...base, stato: "ok", dettaglio: ultimo.status === "completed" ? `Ultimo giro ${quando(ultimo.created_at, adesso)}` : `In corso dalle ${quando(ultimo.created_at, adesso)}`, link };
}
/** Esito di un file di dati dal suo campo "aggiornato" (data o data e ora). */
function valutaDato(d, aggiornato, adesso) {
  const base = { id: d.id, gruppo: "dati", nome: d.nome };
  const t = aggiornato ? new Date(/T/.test(aggiornato) ? aggiornato : `${aggiornato}T12:00:00Z`) : null;
  if (!t || isNaN(t)) return { ...base, stato: "ko", dettaglio: "Data di aggiornamento mancante" };
  const giorni = (adesso - t) / (24 * ORA_MS), testo = /T/.test(aggiornato) ? quando(aggiornato, adesso) : aggiornato.split("-").reverse().slice(0, 2).join("/");
  return giorni > d.giorni ? { ...base, stato: "ko", dettaglio: `Fermo da ${durata(giorni * 24)} (aggiornato ${testo})` } : { ...base, stato: "ok", dettaglio: `Aggiornato ${testo}` };
}

/** Il controllo completo. servizi: [{id, nome, stato, dettaglio}] già valutati. precedente: dati del controllo prima.
 *  Ritorna { ok, controlli, ko, avvisato, avviso } — avviso = la push da mandare, o null. */
function valuta({ adesso, runs = {}, aggiornati = {}, servizi = [], precedente = null }) {
  const controlli = [
    ...JOBS.map((j) => valutaJob(j, runs[j.id], adesso)),
    ...DATI.map((d) => valutaDato(d, aggiornati[d.id], adesso)),
    ...servizi.map((s) => ({ gruppo: "servizi", ...s })),
  ];
  const ko = controlli.filter((c) => c.stato === "ko").map((c) => c.id);
  const prima = (precedente && precedente.ko) || [], nuovi = ko.filter((k) => !prima.includes(k));
  const avvisatoPrima = precedente && precedente.avvisato ? new Date(precedente.avvisato) : null;
  let avviso = null, avvisato = ko.length && avvisatoPrima ? precedente.avvisato : null;
  if (ko.length && (nuovi.length || !avvisatoPrima || adesso - avvisatoPrima >= 24 * ORA_MS)) {
    const nomi = controlli.filter((c) => c.stato === "ko").map((c) => c.nome);
    avviso = { title: ko.length === 1 ? `RaceBuddy · ${nomi[0]} KO` : `RaceBuddy · ${ko.length} problemi`,
      body: ko.length === 1 ? controlli.find((c) => c.stato === "ko").dettaglio : nomi.join(", "), url: "./#/salute", tag: "salute" };
    avvisato = adesso.toISOString();
  }
  return { ok: ko.length === 0, controlli, ko, avvisato, avviso };
}

module.exports = { JOBS, DATI, valuta, valutaJob, valutaDato, quando };

// ------------------------------------------------------------------ dal vivo
async function main() {
  const radice = path.join(__dirname, "..");
  const cfg = fs.readFileSync(path.join(radice, "app/config.js"), "utf8");
  const URL_SB = cfg.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0];
  const PUB = (cfg.match(/sb_publishable_[A-Za-z0-9_-]+/) || [])[0];
  const VAPID_PUB = (cfg.match(/vapidPublic:\s*"([^"]+)"/) || [])[1];
  const KEY = process.env.SUPABASE_SECRET_KEY, GH = process.env.GITHUB_TOKEN, REPO = process.env.GITHUB_REPOSITORY || "lucaalbanesi/racebuddy";
  if (!KEY) { console.log("Manca SUPABASE_SECRET_KEY: niente da fare."); return; }
  const sb = (q, opt = {}) => fetch(`${URL_SB}/rest/v1/${q}`, { ...opt, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(opt.headers || {}) } });
  const conTempo = (p, ms) => Promise.race([p, new Promise((_, ko) => setTimeout(() => ko(new Error("nessuna risposta")), ms))]);
  const adesso = new Date();

  // il controllo precedente
  let precedente = null;
  try { const r = await sb("salute_controlli?select=dati&order=creato.desc,id.desc&limit=1"); if (r.ok) precedente = ((await r.json())[0] || {}).dati || null; } catch (e) { /* primo giro */ }

  // job
  const runs = {};
  for (const j of JOBS) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${j.wf}/runs?per_page=5&exclude_pull_requests=true`, { headers: { Authorization: `Bearer ${GH}`, Accept: "application/vnd.github+json" } });
      runs[j.id] = r.ok ? (await r.json()).workflow_runs || [] : [];
    } catch (e) { runs[j.id] = []; }
  }
  // dati
  const aggiornati = {};
  for (const d of DATI) { try { aggiornati[d.id] = JSON.parse(fs.readFileSync(path.join(radice, d.file), "utf8")).aggiornato || null; } catch (e) { aggiornati[d.id] = null; } }

  // servizi
  const servizi = [];
  const servizio = async (id, nome, fn) => { try { servizi.push({ id, nome, ...(await conTempo(fn(), 60000)) }); } catch (e) { servizi.push({ id, nome, stato: "ko", dettaglio: String(e.message || e).slice(0, 140) }); } };
  await servizio("sito", "Sito dell'app", async () => {
    const r = await fetch("https://lucaalbanesi.github.io/racebuddy/"); const t = await r.text();
    return r.ok && /RaceBuddy/.test(t) ? { stato: "ok", dettaglio: "Online" } : { stato: "ko", dettaglio: `Risponde ${r.status}` };
  });
  let iscritti = null;
  await servizio("database", "Database", async () => {
    const r = await sb("push_iscrizioni?select=endpoint", { headers: { Prefer: "count=exact", Range: "0-0" } });
    if (!r.ok) return { stato: "ko", dettaglio: `Risponde ${r.status}` };
    iscritti = Number(String(r.headers.get("content-range") || "").split("/")[1]) || 0;
    return { stato: "ok", dettaglio: `Raggiungibile · ${iscritti} ${iscritti === 1 ? "telefono iscritto" : "telefoni iscritti"} alle notifiche` };
  });
  await servizio("invii", "Invii push di oggi", async () => {
    const r = await sb(`invii?select=tipo,n&giorno=eq.${giornoRoma(adesso)}`);
    if (!r.ok) return { stato: "attenzione", dettaglio: "Conteggi non leggibili" };
    const l = await r.json(), falliti = l.filter((x) => x.tipo === "falliti").reduce((t, x) => t + x.n, 0), inviati = l.filter((x) => !["falliti", "scadute"].includes(x.tipo)).reduce((t, x) => t + x.n, 0);
    return falliti ? { stato: "attenzione", dettaglio: `${falliti} ${falliti === 1 ? "invio fallito" : "invii falliti"}, ${inviati} ${inviati === 1 ? "inviata" : "inviate"}` } : { stato: "ok", dettaglio: `${inviati} ${inviati === 1 ? "inviata" : "inviate"}, nessun errore` };
  });
  await servizio("buddy", "Chat Buddy", async () => {
    const t = require("crypto").randomBytes(32).toString("hex");
    const r = await fetch(`${URL_SB}/functions/v1/buddy`, { method: "POST", headers: { apikey: PUB, "x-racebuddy-token": t, "Content-Type": "application/json" }, body: JSON.stringify({ azione: "quota" }) });
    const j = await r.json().catch(() => ({}));
    return j.quota != null ? { stato: "ok", dettaglio: `Risponde · ${j.restano} domande su ${j.quota} oggi` } : { stato: "ko", dettaglio: `Risponde ${r.status}` };
  });
  // la ricerca tempi interroga FIDAL e Gare Podistiche Lazio: una volta al giorno, alle 8, o se l'ultima volta era KO
  const tempiPrima = precedente && (precedente.controlli || []).find((c) => c.id === "tempi");
  if (oraRoma(adesso) === 8 || !tempiPrima || tempiPrima.stato !== "ok" || process.env.TUTTO === "1") {
    await servizio("tempi", "Ricerca tempi (FIDAL e GPL)", async () => {
      const r = await fetch(`${URL_SB}/functions/v1/tempi`, { method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" }, body: JSON.stringify({ nome: "Yemaneberhan", cognome: "Crippa" }) });
      const j = await r.json().catch(() => ({})), f = j.fonti || {}, n = (j.persone || []).reduce((t, p) => t + (p.risultati || []).length, 0);
      const giu = ["gpl", "fidal"].filter((k) => f[k] !== "ok").map((k) => (k === "gpl" ? "Gare Podistiche Lazio" : "FIDAL"));
      return giu.length ? { stato: "ko", dettaglio: `Non risponde: ${giu.join(" e ")}` } : { stato: "ok", dettaglio: `FIDAL e GPL rispondono · ${n} risultati di prova`, provato: adesso.toISOString() };
    });
  } else servizi.push({ ...tempiPrima, dettaglio: tempiPrima.dettaglio.replace(/ · provato .*$/, "") + ` · provato ${quando(tempiPrima.provato || adesso.toISOString(), adesso)}` });

  const esito = valuta({ adesso, runs, aggiornati, servizi, precedente });
  const dati = { controlli: esito.controlli, ko: esito.ko, avvisato: esito.avvisato };
  const w = await sb("salute_controlli", { method: "POST", body: JSON.stringify({ ok: esito.ok, dati }) });
  if (!w.ok) console.error("Esito non salvato", w.status, (await w.text()).slice(0, 200));
  await sb(`salute_controlli?creato=lt.${new Date(adesso - 30 * 24 * ORA_MS).toISOString()}`, { method: "DELETE" }).catch(() => null);

  // avviso push ai telefoni del superamministratore
  let mandati = 0;
  if (esito.avviso && process.env.VAPID_PRIVATE_KEY && VAPID_PUB) {
    const webpush = require("web-push");
    webpush.setVapidDetails("https://github.com/lucaalbanesi/racebuddy", VAPID_PUB, process.env.VAPID_PRIVATE_KEY);
    const a = await sb("salute_avvisi?select=endpoint"), eps = a.ok ? (await a.json()).map((x) => x.endpoint) : [];
    if (eps.length) {
      const r = await sb(`push_iscrizioni?select=endpoint,p256dh,auth&endpoint=in.(${eps.map((e) => `"${e.replace(/"/g, "")}"`).join(",")})`);
      for (const it of r.ok ? await r.json() : []) {
        try { await webpush.sendNotification({ endpoint: it.endpoint, keys: { p256dh: it.p256dh, auth: it.auth } }, JSON.stringify(esito.avviso), { TTL: 6 * 3600, urgency: "high" }); mandati++; }
        catch (e) { console.error("Avviso non inviato", e.statusCode || "", String(e.body || e.message || e).slice(0, 160)); }
      }
    }
  }
  const righe = esito.controlli.map((c) => `${c.stato === "ok" ? "✓" : c.stato === "ko" ? "✗" : "!"} ${c.nome}: ${c.dettaglio}`);
  console.log(righe.join("\n"));
  const sintesi = esito.ok ? "Tutto ok" : `KO: ${esito.controlli.filter((c) => c.stato === "ko").map((c) => c.nome).join(", ")}`;
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::${esito.ok ? "notice" : "warning"} title=Controllo salute::${sintesi}${esito.avviso ? ` · avviso a ${mandati} ${mandati === 1 ? "telefono" : "telefoni"}` : ""}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Controllo salute\n${righe.map((r) => `- ${r}`).join("\n")}\n`);
  }
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
