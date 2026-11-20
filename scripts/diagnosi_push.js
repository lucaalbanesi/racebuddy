/* RaceBuddy – diagnosi delle iscrizioni push (sola lettura, si lancia a mano dal workflow "Diagnosi notifiche").
   Per ogni iscrizione: tipo di telefono (dal servizio push), codice anonimo (6 caratteri dell'impronta dell'endpoint),
   ora di uscita, vestizione accesa/spenta, quando parte, ultimo aggiornamento delle preferenze, ultimo invio,
   ultima vestizione della sera. Nessun dato personale (niente luogo, gare, documenti, endpoint). Non scrive nulla. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const N = require("./notifiche.js");

const cfg = fs.readFileSync(path.join(__dirname, "..", "app/config.js"), "utf8");
const URL_SB = cfg.match(/https:\/\/[a-z0-9]+\.supabase\.co/)[0];
const KEY = process.env.SUPABASE_SECRET_KEY;

const tipo = (e) => (/fcm\.googleapis|android\.googleapis/.test(e) ? "Android/Chrome" : /push\.apple\.com/.test(e) ? "iPhone" : /mozilla/.test(e) ? "Firefox" : /notify\.windows/.test(e) ? "Windows" : "altro");
const breve = (t) => (t ? String(t).replace("T", " ").slice(0, 16) : "—");

async function main() {
  if (!KEY) { console.error("Manca SUPABASE_SECRET_KEY"); process.exit(1); }
  const r = await fetch(`${URL_SB}/rest/v1/push_iscrizioni?select=*`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) { console.error("Lettura fallita", r.status, (await r.text()).slice(0, 300)); process.exit(1); }
  const righe = (await r.json()).map((it) => {
    const d = it.dati || {}, p = d.pref || {}, st = it.stato || {}, m = N.momentoVestizione(d.ora);
    return {
      codice: crypto.createHash("sha256").update(it.endpoint).digest("hex").slice(0, 6),
      telefono: tipo(it.endpoint),
      uscita: d.ora || "—",
      vestizione: p.vestizione ? "accesa" : "spenta",
      quando: p.vestizione ? (m.tipo === "sera" ? "sera prima 20:30" : m.tipo === "prima" ? "un'ora prima" : "col mattino") : "—",
      citta: d.luogo ? "sì" : "no",
      aggiornato: breve(it.aggiornato),
      ultimo_invio: it.ultimo_invio || "—",
      sera_per: st.vestSera ? st.vestSera.data : "—",
    };
  }).sort((a, b) => a.telefono.localeCompare(b.telefono) || a.uscita.localeCompare(b.uscita));
  const col = Object.keys(righe[0] || { codice: 1 });
  const md = [`| ${col.join(" | ")} |`, `|${col.map(() => "---").join("|")}|`, ...righe.map((x) => `| ${col.map((c) => x[c]).join(" | ")} |`)].join("\n");
  console.log(md);
  const sera = righe.filter((x) => x.quando === "sera prima 20:30");
  const sintesi = `Iscrizioni ${righe.length}; vestizione la sera: ${sera.length} (${sera.map((x) => x.telefono).join(", ") || "nessuna"})`;
  console.log(sintesi);
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=Diagnosi notifiche::${sintesi}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Diagnosi notifiche\n${sintesi}\n\n${md}\n`);
  }
}
main();
