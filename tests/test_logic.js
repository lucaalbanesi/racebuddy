// Test del motore del percorso: node tests/test_logic.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const L = require("../app/logic.js");
const root = path.join(__dirname, "..");
const fasi = JSON.parse(fs.readFileSync(path.join(root, "content/fasi.json"), "utf8"));
const percorso = JSON.parse(fs.readFileSync(path.join(root, "content/percorso.json"), "utf8"));
const pillole = JSON.parse(fs.readFileSync(path.join(root, "content/pillole.json"), "utf8"));

const firenze = { id: "FI-42", nome: "Firenze Marathon", data: "2026-11-29", distanza: "42", ruolo: "obiettivo", aggiunta: "2026-10-14" };
const roma = { id: "RM-21", nome: "Rome Half Marathon", data: "2026-10-18", distanza: "21", ruolo: "tappa", aggiunta: "2026-10-14" };

// date
assert.strictEqual(L.diffDays("2026-11-29", "2026-10-14"), 46);
assert.strictEqual(L.addDays("2026-11-29", -46), "2026-10-14");
assert.strictEqual(L.fmtGiorno("2026-11-29"), "dom 29 nov");

// fasi: a -46 giorni da una maratona si è in costruzione (-63..-36)
assert.strictEqual(L.fase(fasi, "42", "2026-11-29", "2026-10-14").id, "costruzione");
assert.strictEqual(L.fase(fasi, "42", "2026-11-29", "2026-11-29").id, "gara");
assert.strictEqual(L.fase(fasi, "42", "2026-11-29", "2026-11-20").id, "scarico");
assert.strictEqual(L.fase(fasi, "42", "2026-11-29", "2026-08-01").id, "prima");
assert.strictEqual(L.fase(fasi, "42", "2026-11-29", "2027-01-30").id, "conclusa");

// iscritto tardi: le cose da fare recuperabili già passate finiscono in "da recuperare"
const s = L.stato(percorso, firenze, "2026-10-14");
const rec = s.daRecuperare.map((v) => v.titolo);
assert.ok(rec.includes("Certificato medico e tessera"), rec);
assert.ok(rec.includes("Prenota viaggio e alloggio"), rec);
assert.ok(!s.daRecuperare.some((v) => v.tipo !== "cosa da fare"));
assert.ok(s.momenti.every((v) => v.data > "2026-10-14"));
assert.ok(s.momenti.length > 0);

// spuntare toglie la voce dai recuperi
const k = s.daRecuperare[0].chiave;
assert.ok(!L.stato(percorso, firenze, "2026-10-14", { [k]: true }).daRecuperare.some((v) => v.chiave === k));
// rinviare a domani: sparisce oggi, torna domani
const r = L.stato(percorso, firenze, "2026-10-14", {}, { [k]: "2026-10-15" });
assert.ok(!r.daRecuperare.some((v) => v.chiave === k));
assert.ok(L.stato(percorso, firenze, "2026-10-15", {}, { [k]: "2026-10-15" }).daRecuperare.some((v) => v.chiave === k));

// tappa: solo voci marcate per le tappe e non oltre 14 giorni prima
const vt = L.vociGara(percorso, roma);
assert.ok(vt.length > 0 && vt.every((v) => v.tappa));
assert.ok(vt.every((v) => v.giorno >= -14 || v.riferimento === "attivazione"));
// le voci senza mezza (null) non compaiono nel 10 km
const dieci = L.vociGara(percorso, { ...firenze, distanza: "10" });
assert.ok(!dieci.some((v) => v.titolo === "Gel del piano"));

// checklist con voce personale
const ck = L.checklist(percorso, roma, [{ id: "X1", titolo: "Cerotti" }]);
assert.ok(ck.borsa.some((v) => v.titolo === "Cerotti" && v.personale));
assert.ok(ck.mattina.length > 0);

// gara focus: la tappa entro 7 giorni passa davanti all'obiettivo
const ga = L.gareAttive([firenze, roma], fasi, "2026-10-15");
assert.strictEqual(ga.obiettivo.id, "FI-42");
assert.strictEqual(ga.focus.id, "RM-21");
assert.strictEqual(L.gareAttive([firenze, roma], fasi, "2026-10-25").focus.id, "FI-42");

// pillola: stabile nel giorno, coerente con fase e distanza
const p1 = L.pillola(pillole, "costruzione", "42", "2026-10-14", 10);
assert.strictEqual(p1.id, L.pillola(pillole, "costruzione", "42", "2026-10-14", 10).id);
assert.ok(p1.fase === "costruzione" && p1.distanze.includes("42"));
assert.strictEqual(L.pillola(pillole, "prima", "42", "2026-10-14", 1).fase, "senza_gara");

// vestizione a regole
assert.match(L.vestizione({ temp: 9, vento: 5 }), /Maniche lunghe sottili/);
assert.match(L.vestizione({ temp: 9, vento: 5, pioggia: 70 }), /pioggia/);
assert.match(L.vestizione({ temp: 8 }, true), /strato da buttare/);
assert.strictEqual(L.descriviMeteo({ temp: 9.4, vento: 6 }), "9°C, vento leggero");

// prossima uscita
assert.strictEqual(L.prossimaUscita("6:30", new Date(2026, 9, 14, 5, 0)), "2026-10-14T06:00");
assert.strictEqual(L.prossimaUscita("6:30", new Date(2026, 9, 14, 9, 0)), "2026-10-15T06:00");

// scarpe
assert.strictEqual(L.statoScarpa({ km: 720, limite: 800 }).etichetta, "quasi a fine vita");
assert.strictEqual(L.statoScarpa({ km: 40, limite: 400, tipo: "gara" }).etichetta, "da rodare");

{
  const A = L.avvisiMeteo;
  assert.deepStrictEqual(A({ temp: -2, vento: 5, pioggia: 0, codice: 0 }).map((a) => a.tipo), ["gelo"]);
  assert.deepStrictEqual(A({ temp: 3, vento: 45, pioggia: 80, codice: 63 }).map((a) => a.tipo), ["freddo", "vento", "pioggia"]);
  assert.deepStrictEqual(A({ temp: 30, vento: 0, pioggia: 10, codice: 1 }).map((a) => a.livello), ["attenzione"]);
  assert.deepStrictEqual(A({ temp: 15, vento: 10, pioggia: 90, codice: 96 }).map((a) => a.tipo), ["temporale"]);
  assert.strictEqual(A({ temp: 15, vento: 10, pioggia: 10, codice: 2 }).length, 0);
  assert.strictEqual(L.tipoCielo({ pioggia: 70, temp: 0 }), "neve");
  assert.strictEqual(L.tipoCielo({ codice: 45 }), "nebbia");
}
{
  const cont = [
    { id: "a", data: "2026-10-13", fasi: ["scarico"], distanze: ["42"], argomenti: ["gara"], tipo: "articolo" },
    { id: "b", data: "2026-10-14", fasi: [], distanze: [], argomenti: [], tipo: "video" },
    { id: "c", data: "2026-10-12", fasi: ["scarico"], distanze: ["21"], argomenti: ["gara"], tipo: "articolo" },
  ];
  const r = L.perTe(cont, { fase: "scarico", distanza: "42", oggi: "2026-10-14" });
  assert.deepStrictEqual(r.map((x) => x.id), ["a", "c", "b"]);
  assert.ok(r[0].perLaFase && !r[2].perLaFase);
  assert.strictEqual(L.perTe(cont, { fase: "scarico", distanza: "42", oggi: "2026-10-14", letti: { a: true } })[0].id, "c");
  assert.deepStrictEqual(L.perTe(cont, { fase: "scarico", oggi: "2026-10-14", tipo: "video" }).map((x) => x.id), ["b"]);
  const sr = [{ id: "1", fase: "scarico", testo: "x" }, { id: "2", fase: "senza_gara", testo: "y" }];
  assert.strictEqual(L.sorriso(sr, "scarico", "2026-10-14").id, "1");
  assert.strictEqual(L.sorriso(sr, "picco", "2026-10-14").id, "2");
}

// tempi dei personali
assert.deepStrictEqual(L.leggiTempo("21", "1:45:00"), { tempo: "1:45:00", secondi: 6300 });
assert.deepStrictEqual(L.leggiTempo("21", "1:45"), { tempo: "1:45:00", secondi: 6300 });    // h:mm per la mezza
assert.deepStrictEqual(L.leggiTempo("10", "47:30"), { tempo: "0:47:30", secondi: 2850 });   // mm:ss per il 10 km
assert.deepStrictEqual(L.leggiTempo("42", "3.29.59"), { tempo: "3:29:59", secondi: 12599 });
assert.deepStrictEqual(L.leggiTempo("21", "1,45,00"), { tempo: "1:45:00", secondi: 6300 });  // tastiera italiana
assert.ok(L.leggiTempo("42", "0:47:30").errore);   // troppo veloce per una maratona
assert.ok(L.leggiTempo("10", "5:00:00").errore);   // troppo lento
assert.ok(L.leggiTempo("21", "1:75:00").errore);
assert.ok(L.leggiTempo("21", "abc").errore);
assert.ok(L.leggiTempo("5", "20:00").errore);
// tre caselle ore · min · sec
assert.strictEqual(L.tempoDaParti("1", "44", "10"), "1:44:10");
assert.strictEqual(L.tempoDaParti("", "47", "30"), "0:47:30");
assert.strictEqual(L.tempoDaParti("3", "5", ""), "3:05:00");
assert.strictEqual(L.tempoDaParti("", "", ""), "");
assert.strictEqual(L.tempoDaParti("1", "4a", "0"), "");
assert.ok(L.leggiTempo("21", L.tempoDaParti("1", "75", "00")).errore);

// immagine del risultato: andata a capo e taglio con i puntini (larghezza finta: 10 px a carattere)
{
  const I = require("../app/immagine.js");
  const ctx = { measureText: (t) => ({ width: String(t).length * 10 }) };
  assert.deepStrictEqual(I.aCapo(ctx, "ESTRA Firenze Marathon", 140, 2), ["ESTRA Firenze", "Marathon"]);
  const r = I.aCapo(ctx, "Maratona Internazionale di Reggio Emilia Città del Tricolore", 160, 2);
  assert.strictEqual(r.length, 2); assert.ok(r[1].endsWith("…") && r.every((x) => x.length * 10 <= 160), r);
  assert.deepStrictEqual(I.aCapo(ctx, "", 100, 2), []);
  assert.deepStrictEqual(I.FORMATI.storia, [1080, 1920]);
}
console.log("ok");
