// Test della funzione "tempi": node tests/test_tempi.mjs
// Le pagine in tests/fixtures/tempi sono vere (ottobre 2026) ma ridotte e anonime: nomi e link cambiati.
import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as T from "../supabase/functions/tempi/cerca.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/tempi");
const f = (n) => fs.readFileSync(path.join(dir, n), "utf8");

// tempi nei due formati
assert.strictEqual(T.secondi("02:23:18"), 8598);
assert.strictEqual(T.secondi("1h51:29"), 6689);
assert.strictEqual(T.secondi("        1h51:29"), 6689);
assert.strictEqual(T.secondi("59:01"), 3541);
assert.strictEqual(T.secondi("27:57.4"), 1677);
assert.strictEqual(T.secondi("10,000"), null);
assert.strictEqual(T.hms(6689), "1:51:29");
assert.strictEqual(T.distanzaDaKm(21.097), "21");
assert.strictEqual(T.distanzaDaKm(9.9), null);
// fuori misura: vicino alla distanza (9,8-10,2; mezza e maratona ±400 m), entra con km_reali
assert.strictEqual(T.distanzaCirca(9.9), "10");
assert.strictEqual(T.distanzaCirca(10.2), "10");
assert.strictEqual(T.distanzaCirca(10.05), null, "esatta: non è fuori misura");
assert.strictEqual(T.distanzaDaKm(10.05), "10", "10,050 km è esatta (±50 m)");
assert.strictEqual(T.distanzaCirca(9.7), null);
assert.strictEqual(T.distanzaCirca(21.4), "21");
assert.strictEqual(T.distanzaCirca(19), null);
assert.strictEqual(T.distanzaFidal("MARATONINA A"), "21");
assert.strictEqual(T.distanzaFidal("MARATONA A"), "42");
assert.strictEqual(T.distanzaFidal("Corsa strada Km 10"), "10");
assert.strictEqual(T.distanzaFidal("corsa km 5 strada"), null);
assert.strictEqual(T.distanzaFidal("10000 metri"), null);

// Gare Podistiche Lazio: le gare dell'anno, con società e categoria per ogni gara
const g = T.leggiGpl(f("gpl_atleta.html"));
assert.strictEqual(g.length, 8);
assert.deepStrictEqual(g[0], { data: "2026-10-18", gara: "Rome Half Marathon", luogo: "Roma", km: 21.097, tempo: "2:23:18", secondi: 8598, societa: "Podistica Esempio", categoria: "SM60" });
assert.strictEqual(g[1].gara, "Walk of Life Fondazione Telethon"); // senza il simbolo delle non competitive
assert.strictEqual(T.leggiGpl(f("gpl_vuoto.html")).length, 0);
// una persona: solo 10/21/42 esatti e plausibili (la "6 Ore" registrata come 10 km in 21 minuti è fuori)
const [p] = T.personeGpl([...g, ...T.leggiGpl(f("gpl_anno.html"))], "Luigi Verdi");
assert.strictEqual(p.fonte, "gpl");
assert.strictEqual(p.societa, "Podistica Esempio");
assert.ok(p.risultati.every((r) => ["10", "21", "42"].includes(r.distanza)));
assert.ok(!p.risultati.some((r) => r.gara === "6 Ore di Roma"));
const miguel = p.risultati.find((r) => r.gara === "La Corsa di Miguel"); // 9,9 km: fuori misura
assert.ok(miguel && miguel.distanza === "10" && miguel.km_reali === 9.9, "la Corsa di Miguel entra come 10 km fuori misura");
assert.deepStrictEqual(p.risultati.filter((r) => r.km_reali).map((r) => r.km_reali).sort(), [10.1, 42.4, 9.9], "solo le fuori misura hanno km_reali");
assert.ok(p.risultati.some((r) => r.gara === "Run Rome The Marathon" && r.tempo === "5:29:26" && r.distanza === "42"));
assert.ok(p.risultati.some((r) => r.data.startsWith("2025")));
assert.ok(p.risultati[0].data >= p.risultati[p.risultati.length - 1].data, "dalla più recente");
// omonimi nella stessa pagina: una persona per società
const om = T.personeGpl(T.leggiGpl(f("gpl_omonimi.html")), "Mario Rossi");
assert.deepStrictEqual(om.map((x) => x.societa), ["Societa Uno", "Societa Due", "Societa Tre"]);
assert.deepStrictEqual(om[0].risultati.map((r) => `${r.distanza} ${r.tempo}${r.km_reali ? ` (${r.km_reali} km)` : ""}`), ["21 1:43:29", "10 1:01:53 (9.9 km)"]);

// FIDAL: ricerca → omonimi con società e codice
const c = T.leggiFidalCerca(f("fidal_cerca.html"));
assert.strictEqual(c.length, 6);
assert.deepStrictEqual(c[3], { nome: "Luigi Verdi", link: c[3].link, societa: "MONZA MARATHON TEAM - A.S.D.", codice: "MI704", categoria: "SM45" });
assert.ok(/^https:\/\/www\.fidal\.it\/atleta\//.test(c[3].link));
assert.strictEqual(T.leggiFidalCerca(f("fidal_vuoto.html")).length, 0);
// scheda: risultati su strada di 10 km, mezza e maratona
assert.deepStrictEqual(T.leggiFidalAtleta(f("fidal_atleta.html")), [{ data: "2018-03-25", gara: "", luogo: "Milano", distanza: "21", tempo: "1:51:29", secondi: 6689, categoria: "SM45" }]);
const s = T.leggiFidalAtleta(f("fidal_strada.html"));
assert.ok(s.some((r) => r.distanza === "42" && r.tempo === "2:05:18" && r.data === "2026-04-12" && r.luogo === "Parigi"));
assert.ok(s.some((r) => r.distanza === "10" && r.tempo === "0:27:57"));
assert.ok(s.some((r) => r.distanza === "21" && r.tempo === "0:59:01"));
assert.ok(!s.some((r) => r.secondi < 900), "niente 5 km né pista");

// la funzione intera, con la rete finta
const chiamate = [];
const finta = async (url) => {
  chiamate.push(url);
  const pag = url.includes("garepodistichelazio") ? (url.includes("anno=2026") ? f("gpl_atleta.html") : url.includes("anno=2025") ? f("gpl_anno.html") : f("gpl_vuoto.html"))
    : url.includes("result.php") ? f("fidal_cerca.html") : url.includes("/atleta/") ? f("fidal_atleta.html") : "";
  return new Response(pag, { status: 200 });
};
const h = T.crea({}, finta, () => new Date("2026-10-18T19:00:00"));
const post = (corpo) => h(new Request("https://x/functions/v1/tempi", { method: "POST", body: JSON.stringify(corpo) }));

let r = await post({ nome: "Luigi", cognome: "Verdi", codice: "MI704" });
let j = await r.json();
assert.strictEqual(r.status, 200);
assert.deepStrictEqual(j.fonti, { gpl: "ok", fidal: "ok" });
assert.ok(chiamate.some((u) => u.includes("na=VERDI%20LUIGI") && u.includes("anno=2019")), "tutti gli anni dal 2019");
assert.strictEqual(chiamate.filter((u) => u.includes("garepodistichelazio")).length, 8);
assert.strictEqual(chiamate.filter((u) => u.includes("/atleta/")).length, 4, "al massimo 4 schede FIDAL");
const fid = j.persone.filter((x) => x.fonte === "fidal");
assert.strictEqual(fid[0].codice, "MI704", "la società della tessera davanti");
assert.ok(j.persone.some((x) => x.fonte === "gpl" && x.risultati.length >= 3));
assert.ok(j.persone.every((x) => x.risultati.every((y) => y.id && y.fonte === x.fonte && !("km" in y) && !("societa" in y))));

// un anno solo (tempo di una gara appena corsa)
chiamate.length = 0;
j = await (await post({ nome: "Luigi", cognome: "Verdi", anno: 2026 })).json();
assert.strictEqual(chiamate.filter((u) => u.includes("garepodistichelazio")).length, 1);
assert.ok(j.persone.find((x) => x.fonte === "gpl").risultati.some((y) => y.data === "2026-10-18" && y.distanza === "21"));

// una fonte che non risponde non ferma l'altra
const mezza = T.crea({}, async (u) => (u.includes("fidal") ? new Response("", { status: 503 }) : finta(u)), () => new Date("2026-10-18T19:00:00"));
j = await (await mezza(new Request("https://x", { method: "POST", body: JSON.stringify({ nome: "Luigi", cognome: "Verdi" }) }))).json();
assert.deepStrictEqual(j.fonti, { gpl: "ok", fidal: "errore" });
assert.ok(j.persone.length > 0);

// input non valido
assert.strictEqual((await post({ nome: "<script>", cognome: "Verdi" })).status, 400);
assert.strictEqual((await post({ nome: "Luigi" })).status, 400);
assert.strictEqual((await post({ nome: "x".repeat(60), cognome: "Verdi" })).status, 400);
assert.strictEqual((await h(new Request("https://x", { method: "GET" }))).status, 405);
assert.ok((await post({ nome: "Maria Grazia", cognome: "D'Angelo" })).status === 200, "nomi composti e apostrofi");

// certificazione (classifiche del gruppo): rifà la ricerca, tiene solo i risultati scelti e li scrive con la chiave segreta
const scritte = [];
const conDb = async (url, opt = {}) => {
  if (String(url).includes("/rest/v1/rpc/_registra_certificati")) {
    scritte.push({ url, opt, corpo: JSON.parse(opt.body) });
    return new Response(JSON.stringify({ certificati: JSON.parse(opt.body).p_righe.length, in_approvazione: 0, saltati: 0 }), { status: 200 });
  }
  return finta(url);
};
const env = { SUPABASE_URL: "https://db.esempio", SUPABASE_SERVICE_ROLE_KEY: "segreta" };
const hc = T.crea(env, conDb, () => new Date("2026-10-18T19:00:00"));
const tok = "a".repeat(64);
const certifica = (corpo, token = tok) => hc(new Request("https://x/functions/v1/tempi", { method: "POST", headers: token ? { "x-racebuddy-token": token } : {}, body: JSON.stringify({ azione: "certifica", ...corpo }) }));
j = await (await post({ nome: "Luigi", cognome: "Verdi" })).json();
const pg = j.persone.find((x) => x.fonte === "gpl"), scelto = pg.risultati.find((x) => x.distanza === "42");
r = await certifica({ nome: "Luigi", cognome: "Verdi", persone: [pg.id], risultati: [scelto.id, "gpl:2026-01-01:10:9999", pg.risultati[0].id, pg.risultati[0].id] });
j = await r.json();
assert.strictEqual(r.status, 200, JSON.stringify(j));
assert.strictEqual(scritte.length, 1);
const w = scritte[0];
assert.strictEqual(w.opt.headers.apikey, "segreta", "scrive con la chiave segreta");
assert.strictEqual(w.corpo.p_nome, "Luigi Verdi");
assert.strictEqual(w.corpo.p_hash, crypto.createHash("sha256").update(tok).digest("hex"), "nel database solo l'impronta");
assert.ok(!JSON.stringify(w.corpo).includes(tok), "mai il codice");
assert.strictEqual(w.corpo.p_righe.length, 2, "solo i risultati veri e scelti, senza doppioni");
assert.deepStrictEqual(w.corpo.p_righe.find((x) => x.distanza === "42"), { data: scelto.data, distanza: "42", secondi: scelto.secondi, gara_nome: scelto.gara, fonte: "gpl", categoria: scelto.categoria, societa: "Podistica Esempio" });
assert.strictEqual(j.righe, 2);
// FIDAL: il nome della gara è la città
j = await (await post({ nome: "Luigi", cognome: "Verdi" })).json();
const pf = j.persone.find((x) => x.fonte === "fidal" && x.risultati.length), rf = pf.risultati[0];
scritte.length = 0;
r = await certifica({ nome: "Luigi", cognome: "Verdi", persone: [pf.id], risultati: [rf.id] });
assert.strictEqual(r.status, 200);
assert.strictEqual(scritte[0].corpo.p_righe[0].gara_nome, rf.luogo);
assert.strictEqual(scritte[0].corpo.p_righe[0].fonte, "fidal");
// senza codice del telefono, senza scelte, senza database
assert.strictEqual((await certifica({ nome: "Luigi", cognome: "Verdi", persone: [pg.id], risultati: [scelto.id] }, "")).status, 401);
assert.strictEqual((await certifica({ nome: "Luigi", cognome: "Verdi", persone: [], risultati: [scelto.id] })).status, 400);
assert.strictEqual((await T.crea({}, conDb)(new Request("https://x", { method: "POST", headers: { "x-racebuddy-token": tok }, body: JSON.stringify({ azione: "certifica", nome: "Luigi", cognome: "Verdi", persone: [pg.id], risultati: [scelto.id] }) }))).status, 503);
// il database rifiuta (per esempio: non partecipi): l'errore arriva al telefono
const rifiuta = T.crea(env, async (url, opt) => (String(url).includes("rpc/") ? new Response(JSON.stringify({ message: "non partecipi alle classifiche" }), { status: 400 }) : finta(url)), () => new Date("2026-10-18T19:00:00"));
r = await rifiuta(new Request("https://x", { method: "POST", headers: { "x-racebuddy-token": tok }, body: JSON.stringify({ azione: "certifica", nome: "Luigi", cognome: "Verdi", persone: [pg.id], risultati: [scelto.id] }) }));
assert.strictEqual(r.status, 400);
assert.strictEqual((await r.json()).errore, "non partecipi alle classifiche");

console.log("ok");
