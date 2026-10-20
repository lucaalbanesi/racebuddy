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

// ciclo di vita: attiva fino al giorno gara, post-gara per 3 giorni, poi archivio
assert.strictEqual(L.ciclo(roma, "2026-10-17"), "attiva");
assert.strictEqual(L.ciclo(roma, "2026-10-18"), "attiva");
// il giorno della gara si passa al post-gara alle 12 (le gare sono di mattina)
assert.strictEqual(L.ciclo(roma, "2026-10-18", null, "11:59"), "attiva");
assert.strictEqual(L.ciclo(roma, "2026-10-18", null, "12:00"), "postgara");
assert.strictEqual(L.ciclo(roma, "2026-10-18", null, "9:30"), "attiva");
assert.strictEqual(L.ciclo(roma, "2026-10-18", { tempo: "1:45:00", salvato: "2026-10-18" }, "19:00"), "postgara");
assert.strictEqual(L.ciclo(roma, "2026-10-17", null, "19:00"), "attiva");
assert.deepStrictEqual(L.dividiGare([firenze, roma], "2026-10-18", {}, "19:02").postgara.map((g) => g.id), ["RM-21"]);
assert.strictEqual(L.ciclo(roma, "2026-10-19"), "postgara");
assert.strictEqual(L.ciclo(roma, "2026-10-21"), "postgara");
assert.strictEqual(L.ciclo(roma, "2026-10-22"), "archiviata");
// tempo segnato il giorno della gara: in archivio dal giorno dopo; segnato al giorno 2: dal giorno 3
assert.strictEqual(L.ciclo(roma, "2026-10-18", { tempo: "1:45:00", salvato: "2026-10-18" }), "attiva");
assert.strictEqual(L.ciclo(roma, "2026-10-19", { tempo: "1:45:00", salvato: "2026-10-18" }), "archiviata");
assert.strictEqual(L.ciclo(roma, "2026-10-20", { tempo: "1:45:00", salvato: "2026-10-20" }), "postgara");
assert.strictEqual(L.ciclo(roma, "2026-10-21", { tempo: "1:45:00", salvato: "2026-10-20" }), "archiviata");
// risultati salvati prima di questa regola (senza "salvato") valgono come segnati il giorno della gara
assert.strictEqual(L.ciclo(roma, "2026-10-19", { tempo: "1:45:00" }), "archiviata");
// ritirato / non partito: come il tempo; archiviata a mano: subito
assert.strictEqual(L.ciclo({ ...roma, esito: "dnf", esitoData: "2026-10-19" }, "2026-10-19"), "postgara");
assert.strictEqual(L.ciclo({ ...roma, esito: "dnf", esitoData: "2026-10-19" }, "2026-10-20"), "archiviata");
assert.strictEqual(L.ciclo({ ...roma, archiviata: "2026-10-19" }, "2026-10-19"), "archiviata");
// le gare divise: la maratona resta attiva, la mezza passa da appena corsa ad archivio
const dv = L.dividiGare([firenze, roma], "2026-10-19");
assert.deepStrictEqual([dv.attive.map((g) => g.id), dv.postgara.map((g) => g.id), dv.archivio.map((g) => g.id)], [["FI-42"], ["RM-21"], []]);
assert.deepStrictEqual(L.dividiGare([firenze, roma], "2026-10-19", { "RM-21": { tempo: "1:45:00", salvato: "2026-10-18" } }).archivio.map((g) => g.id), ["RM-21"]);
// in Oggi una gara archiviata non c'è più: la mezza col tempo segnato lascia il posto alla maratona
assert.strictEqual(L.gareAttive([firenze, roma], fasi, "2026-10-19").tutte.length, 2);
assert.deepStrictEqual(L.gareAttive([firenze, roma], fasi, "2026-10-19", { "RM-21": { tempo: "1:45:00", salvato: "2026-10-18" } }).tutte.map((g) => g.id), ["FI-42"]);
assert.strictEqual(L.gareAttive([roma], fasi, "2026-10-22").obiettivo, null);
// il bilancio dell'ultima gara torna nella borsa della successiva, solo se c'è qualcosa da ricordare
const ris = { "RM-21": { tempo: "1:45:00", debrief: { rifornimento: "rivedere", scarpe: "ok", fastidi: "no", nota: "Gel al 15 e al 30" } } };
const ud = L.ultimoDebrief([firenze, roma], ris, firenze.data);
assert.strictEqual(ud.gara.id, "RM-21");
assert.deepStrictEqual(ud.voci, ["Rifornimento da rivedere"]);
assert.strictEqual(ud.nota, "Gel al 15 e al 30");
assert.strictEqual(L.ultimoDebrief([firenze, roma], ris, roma.data), null);
assert.strictEqual(L.ultimoDebrief([roma], { "RM-21": { tempo: "1:45:00", debrief: { rifornimento: "ok", scarpe: "ok", fastidi: "no", nota: "" } } }, firenze.data), null);

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
assert.strictEqual(L.prossimaUscita("6:30", new Date(2026, 9, 14, 6, 45)), "2026-10-15T06:00"); // iniziata da poco: già domani
assert.strictEqual(L.prossimaUscita("08:00", new Date(2026, 9, 17, 8, 3)), "2026-10-18T08:00");
assert.strictEqual(L.prossimaUscita("08:00", new Date(2026, 9, 17, 7, 59)), "2026-10-17T08:00");
assert.strictEqual(L.prossimaUscita("18:30", new Date(2026, 9, 17, 8, 3)), "2026-10-17T18:00");

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
  // Rotazione: un contenuto rimasto in cima nei giorni scorsi senza essere aperto scende.
  const visti = L.segnaVisti(L.segnaVisti({}, ["a"], "2026-10-12"), ["a"], "2026-10-13");
  assert.deepStrictEqual(visti.a, { giorni: 2, ultimo: "2026-10-13" });
  assert.strictEqual(L.segnaVisti(visti, ["a"], "2026-10-13").a.giorni, 2); // stesso giorno: non conta due volte
  assert.strictEqual(L.perTe(cont, { fase: "scarico", distanza: "42", oggi: "2026-10-14", visti: { a: { giorni: 3, ultimo: "2026-10-13" } } })[0].id, "c");
  // Oggi stesso non penalizza: la lista non cambia mentre navighi.
  assert.strictEqual(L.perTe(cont, { fase: "scarico", distanza: "42", oggi: "2026-10-14", visti: { a: { giorni: 1, ultimo: "2026-10-14" } } })[0].id, "a");
  // Le voci vecchie si dimenticano.
  assert.ok(!L.segnaVisti({ z: { giorni: 3, ultimo: "2026-01-01" } }, [], "2026-10-14").z);
  // Varietà: una fonte per volta, poi completa.
  const fv = [{ id: 1, fonte: "A" }, { id: 2, fonte: "A" }, { id: 3, fonte: "B" }];
  assert.deepStrictEqual(L.varieta(fv, 2).map((x) => x.id), [1, 3]);
  assert.deepStrictEqual(L.varieta(fv, 3).map((x) => x.id), [1, 3, 2]);
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

// Strava: candidate a personale e corsa del giorno della gara
{
  const gare = [
    { id: "1", nome: "Roma-Ostia", data: "2026-03-01", metri: 21300, secondi: 6178 },
    { id: "2", nome: "Mezza di Napoli", data: "2025-02-23", metri: 21150, secondi: 6400 },
    { id: "3", nome: "Corsa di Miguel", data: "2026-01-18", metri: 10100, secondi: 2885 },
    { id: "4", nome: "Trail 15 km", data: "2026-05-01", metri: 15000, secondi: 5400 },
    { id: "5", nome: "Mezza con GPS impazzito", data: "2026-04-01", metri: 21200, secondi: 1800 },  // 30 minuti: impossibile
  ];
  // novità delle gare: scheda di Oggi e ordine di Per te
  const nv = [
    { id: "expo", gara: "G", data: "2026-10-14", urgenza: "subito" },
    { id: "elite", gara: "G", data: "2026-10-16", urgenza: "mattino" },
    { id: "tv", gara: "G", data: "2026-10-16", urgenza: "mattino" },
    { id: "promo", gara: "G", data: "2026-10-17", urgenza: "app" },
    { id: "altra", gara: "X", data: "2026-10-17", urgenza: "subito" },
  ];
  assert.deepStrictEqual(L.ordinaNovita(nv.filter((n) => n.gara === "G")).map((n) => n.id), ["promo", "elite", "tv", "expo"]);
  let ev = (o, esposte = {}, letti = {}) => (L.novitaInEvidenza(nv, { gare: ["G"], letti, esposte, oggi: o }) || {}).id;
  assert.strictEqual(ev("2026-10-15"), "expo", "importante e fresca: davanti");
  assert.strictEqual(ev("2026-10-17"), "elite", "dopo 2 giorni conta la data");
  assert.strictEqual(ev("2026-10-17", { elite: { giorni: 2, ultimo: "2026-10-16" } }), "tv", "vista in 2 giorni senza aprirla: lascia il posto");
  assert.strictEqual(ev("2026-10-17", { elite: { giorni: 2, ultimo: "2026-10-17" } }), "elite", "il secondo giorno resta per tutta la giornata");
  assert.strictEqual(ev("2026-10-17", {}, { "n:elite": "2026-10-16", "n:tv": "2026-10-16" }), "expo");
  assert.strictEqual(ev("2026-10-25"), undefined, "oltre 7 giorni no");
  const c = L.candidatiPersonali(gare);
  assert.deepStrictEqual(c["21"].map((x) => x.id), ["1", "2"]);
  assert.strictEqual(c["21"][0].tempo, "1:42:58");
  assert.deepStrictEqual(c["10"].map((x) => x.tempo), ["0:48:05"]);
  assert.deepStrictEqual(c["42"], []);
  // maratona non segnata come gara, GPS a 42,65 km (Roma) e a 43,5 km: si trovano
  const mar = L.candidatiPersonali([{ id: "r", nome: "Morning Run", data: "2026-03-22", metri: 42653, secondi: 13529 }, { id: "m", data: "2026-04-12", metri: 43500, secondi: 15559 }]);
  assert.deepStrictEqual(mar["42"].map((x) => [x.id, x.tempo]), [["r", "3:45:29"], ["m", "4:19:19"]]);
  const giorno = [{ id: "a", metri: 2000, secondi: 700 }, { id: "b", metri: 42400, secondi: 13325, gara: true }, { id: "c", metri: 42300, secondi: 13400 }];
  let g = L.corsaDellaGara(giorno, "42");
  assert.strictEqual(g.scelta.id, "b"); assert.strictEqual(g.scelta.tempo, "3:42:05"); assert.deepStrictEqual(g.altre.map((x) => x.id), ["a", "c"]);
  g = L.corsaDellaGara([{ id: "x", metri: 42900, secondi: 13500 }, { id: "y", metri: 42250, secondi: 13600 }], "42");
  assert.strictEqual(g.scelta.id, "y", "senza la gara segnata: la distanza più vicina a 42,195");
  assert.strictEqual(L.corsaDellaGara([{ id: "z", metri: 5000, secondi: 1500 }], "21").scelta, null);
}

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
// swipe tra le sezioni della gara
assert.strictEqual(L.sezioneSwipe("", -120, 10, 300), "preparazione");
assert.strictEqual(L.sezioneSwipe("preparazione", -120, 10, 300), "info");
assert.strictEqual(L.sezioneSwipe("info", -120, 10, 300), "borsa");
assert.strictEqual(L.sezioneSwipe("borsa", -120, 10, 300), null); // ultima
assert.strictEqual(L.sezioneSwipe("info", 120, 10, 300), "preparazione");
assert.strictEqual(L.sezioneSwipe("preparazione", 120, 0, 300), "");
assert.strictEqual(L.sezioneSwipe("", 120, 0, 300), null); // prima
assert.strictEqual(L.sezioneSwipe("", -40, 0, 300), null); // troppo corto
assert.strictEqual(L.sezioneSwipe("", -100, 80, 300), null); // in diagonale: è uno scroll
assert.strictEqual(L.sezioneSwipe("", -100, 0, 1200), null); // troppo lento
assert.strictEqual(L.sezioneSwipe("novita", -120, 0, 300), null); // fuori dalla barra
// passi di "Prepara RaceBuddy"
{
  const vuoto = L.passiPrepara({}, "2026-10-15");
  assert.deepStrictEqual([vuoto.fatti, vuoto.totale, vuoto.completo], [0, 3, false]);
  const p = L.passiPrepara({ profilo: { ora: "07:00", citta: "Roma" }, documenti: { tessera: { tipo: "FIDAL", numero: "AB123456", scadenza: "2027-03-12" }, certificato: { scadenza: "" } }, gare: [] }, "2026-10-15");
  assert.deepStrictEqual([p.fatti, p.completo], [2, false]); // documenti incompleti: manca il certificato
  assert.strictEqual(L.passiPrepara({ documenti: { tessera: { scadenza: "2027-03-12" }, certificato: { scadenza: "2027-05-01" } } }, "2026-10-15").passi.find((x) => x.k === "documenti").fatto, false); // senza numero non basta
  const gps = L.passiPrepara({ profilo: { ora: "6:30", coord: { lat: 41.9, lon: 12.5 } }, documenti: { tessera: { numero: "RC00123", scadenza: "2027-01-01" }, certificato: { scadenza: "2027-05-01" } } }, "2026-10-15");
  assert.deepStrictEqual([gps.fatti, gps.completo], [3, true]);
  assert.strictEqual(gps.passi.find((x) => x.k === "gara").fatto, false); // facoltativa, non conta
  const nt = L.passiPrepara({ profilo: { ora: "07:00", citta: "Roma" }, nonTesserato: true }, "2026-10-15");
  assert.deepStrictEqual([nt.fatti, nt.totale, nt.completo, nt.passi.some((x) => x.k === "documenti")], [2, 2, true, false]);
  assert.strictEqual(L.passiPrepara({ gare: [{ data: "2026-10-18" }] }, "2026-10-15").passi.find((x) => x.k === "gara").fatto, true);
  assert.strictEqual(L.passiPrepara({ gare: [{ data: "2026-10-01" }] }, "2026-10-15").passi.find((x) => x.k === "gara").fatto, false); // gara passata
}
// lettura delle foto dei documenti (testo OCR)
{
  const O = "2026-10-15";
  const fidal = "FEDERAZIONE ITALIANA DI ATLETICA LEGGERA\nFIDAL\nTessera n. RM 123456\nROSSI MARIO\nSocietà: A.S.D. Podistica Roma\nValida fino al 31/12/2026";
  assert.deepStrictEqual(L.leggiDocumento(fidal, "tessera", O), { tipo: "FIDAL", numero: "RM123456", societa: "A.S.D. Podistica Roma", scadenza: "2026-12-31" });
  const runcard = "RUNCARD\nCard n° RC-0045821\nScadenza 03.05.2027\nNato il 22/08/1988";
  assert.deepStrictEqual(L.leggiDocumento(runcard, "tessera", O), { tipo: "Runcard", numero: "RC0045821", scadenza: "2027-05-03" });
  const fidalVera = "FIDAL\nFederazione Italiana di Atletica Leggera\nTessera n. RM123456\nData tesseramento: 14/01/2026\nNato il 22/08/1988";
  assert.deepStrictEqual(L.leggiDocumento(fidalVera, "tessera", O), { tipo: "FIDAL", numero: "RM123456", tesseramento: "2026-01-14", scadenza: "2026-12-31", calcolata: true });
  const runcardEmessa = "RUNCARD\nCard n° RC-0045821\nData emissione 10/05/2026";
  assert.deepStrictEqual(L.leggiDocumento(runcardEmessa, "tessera", O), { tipo: "Runcard", numero: "RC0045821", tesseramento: "2026-05-10", scadenza: "2027-05-09", calcolata: true });
  // tessera FIDAL con la scadenza del certificato medico stampata sopra: non va confusa con quella della tessera
  const fidalCert = "FIDAL\nTessera n. RM123456\nData tesseramento 14/01/2026\nScadenza certificato medico 12/03/2027\nAGONISTICO";
  assert.deepStrictEqual(L.leggiDocumento(fidalCert, "tessera", O), { tipo: "FIDAL", numero: "RM123456", certificato: { scadenza: "2027-03-12", tipo: "agonistico (atletica leggera)" }, tesseramento: "2026-01-14", scadenza: "2026-12-31", calcolata: true });
  const fidalCert2 = "FIDAL\nTessera n. RM123456\nCert. medico valido fino al 30/06/2027\nTesserato dal 02/02/2026";
  const r2 = L.leggiDocumento(fidalCert2, "tessera", O);
  assert.strictEqual(r2.certificato.scadenza, "2027-06-30"); assert.strictEqual(r2.scadenza, "2026-12-31");
  // squadra: codice FIDAL e nome, sulla stessa riga o separati
  const conCodice = "FIDAL\nTessera n. 7654321\nSocietà: RM123 - A.S.D. Podistica Roma\nData tesseramento 14/01/2026";
  const rc = L.leggiDocumento(conCodice, "tessera", O);
  assert.deepStrictEqual([rc.codiceSocieta, rc.societa, rc.numero], ["RM123", "A.S.D. Podistica Roma", "7654321"]);
  const separati = "FIDAL\nCodice società: LZ045\nSocietà A.S.D. Atletica Ostia\n14/01/2026";
  const rs = L.leggiDocumento(separati, "tessera", O);
  assert.deepStrictEqual([rs.codiceSocieta, rs.societa, rs.numero], ["LZ045", "A.S.D. Atletica Ostia", undefined]); // il codice non diventa il numero
  // tesserino FIDAL reale (dati inventati, stessa struttura): anno di validità stampato, tesseramento a dicembre dell'anno
  // prima, unica "Scadenza" = certificato, numero senza etichetta, squadra "RM000 - NOME" senza la parola società
  const tesserino = "FEDERAZIONE ITALIANA\nDI ATLETICA LEGGERA\natletica italiana\nATLETA\nRossi Mario\n01/01/1980 SM45 Italiano\nData Tesseramento: 09/12/2025\nScadenza Certificato Medico: 11/02/2027\n2026 XY012345\nRM999 - A.S.D. CORRERE INSIEME";
  assert.deepStrictEqual(L.leggiDocumento(tesserino, "tessera", O), { tipo: "FIDAL", numero: "XY012345", codiceSocieta: "RM999", societa: "A.S.D. CORRERE INSIEME", certificato: { scadenza: "2027-02-11" }, tesseramento: "2025-12-09", scadenza: "2026-12-31", calcolata: true });
  // lo stesso letto male dall'OCR di una foto
  const tesserinoOcr = "4. | atletica\na ze | Itallana\n© ATLETA\nRossi\nLi r\n2 i Data : 09/12/2025\nA è | Scadenza ledico: 11/02/2027\n2026 XY012345\nRM999 - A.S.D. CORRERE INSIEME";
  const ro = L.leggiDocumento(tesserinoOcr, "tessera", O);
  assert.deepStrictEqual([ro.tipo, ro.numero, ro.codiceSocieta, ro.scadenza, ro.certificato.scadenza, ro.tesseramento], ["FIDAL", "XY012345", "RM999", "2026-12-31", "2027-02-11", "2025-12-09"]);
  assert.strictEqual(L.leggiDocumento("ATLETA\n2026 XY012345\nRM999 — A.S.D. CORRERE INSIEME", "tessera", O).codiceSocieta, "RM999"); // trattino letto male
  assert.strictEqual(L.leggiDocumento("ATLETA\n2026 XY012345\nRM999 A.S.D. CORRERE INSIEME", "tessera", O).societa, "A.S.D. CORRERE INSIEME"); // trattino perso
  assert.strictEqual(L.leggiDocumento("ATLETA\n2026 XY012345\nRM8999 - A.S.D. CORRERE INSIEME", "tessera", O).codiceSocieta, "RM8999"); // cifra in più letta dall'OCR: si tiene, l'utente corregge
  // foto vera letta con soglia adattiva: righe spezzate, cifre separate, "FIDAL" mai letto, solo l'anno in basso
  const fotoA = "atletica.\n“4 ATLETA.\nData Tesseramento:\n09/12/2025 «.\nscadenza Certificato\nMedico 11/02/2027\nXY012345\n2026\nRM999 - - A.S.D. CORRERE INSIEME";
  const fa = L.leggiDocumento(fotoA, "tessera", O);
  assert.deepStrictEqual([fa.tipo, fa.numero, fa.scadenza, fa.certificato && fa.certificato.scadenza, fa.codiceSocieta], ["FIDAL", "XY012345", "2026-12-31", "2027-02-11", "RM999"]);
  const fotoB = "Scadenza ( Certificato Medico: 1 1/02/2027 ©\nXY012345\n2026";
  const fb = L.leggiDocumento(fotoB, "tessera", O);
  assert.deepStrictEqual([fb.tipo, fb.scadenza, fb.certificato.scadenza], ["FIDAL", "2026-12-31", "2027-02-11"]);
  const fotoC = "‘Scadenza Certificato Medico: 11/02/2027.\nXY012345"; // né anno né FIDAL letti: la scadenza resta al certificato
  const fc = L.leggiDocumento(fotoC, "tessera", O);
  assert.deepStrictEqual([fc.scadenza, fc.certificato.scadenza], [undefined, "2027-02-11"]);
  // senza anno stampato: tesseramento di dicembre vale per l'anno dopo
  assert.strictEqual(L.leggiDocumento("FIDAL\nData Tesseramento: 15/11/2025\nTessera n. AB12345", "tessera", O).scadenza, "2026-12-31");
  const eps = "RUNCARD EPS\nENTE DI PROMOZIONE SPORTIVA\nAB12C345\n2027-02-01";
  assert.strictEqual(L.leggiDocumento(eps, "tessera", O).tipo, "Runcard EPS");
  assert.strictEqual(L.leggiDocumento(eps, "tessera", O).numero, "AB12C345");
  const cert = "CERTIFICATO DI IDONEITÀ ALLA PRATICA\nDI ATTIVITÀ SPORTIVA AGONISTICA\nSport: ATLETICA LEGGERA\nData della visita: 12/03/2026\nIl presente certificato ha validità annuale\nScadenza: 12/03/2027";
  assert.deepStrictEqual(L.leggiDocumento(cert, "certificato", O), { tipo: "agonistico (atletica leggera)", scadenza: "2027-03-12" });
  const soloVisita = "Certificato medico agonistico\nRoma, 05/11/2025\nIl medico";
  assert.deepStrictEqual(L.leggiDocumento(soloVisita, "certificato", O), { tipo: "agonistico (atletica leggera)", scadenza: "2026-11-04", calcolata: true });
  const certLungo = "Si certifica che il Sig. Luca, nato a Roma il 22/08/1988, sottoposto a visita medica,\nè risultato idoneo\nATLETICA LEGGERA\nData della visita: 12/03/2026\nScadenza: 12/03/2027";
  assert.deepStrictEqual(L.leggiDocumento(certLungo, "certificato", O), { scadenza: "2027-03-12" }); // nessuna data della visita conservata
  assert.deepStrictEqual(L.leggiDocumento("testo illeggibile ~~", "certificato", O), {});
  assert.deepStrictEqual(L.leggiDocumento("NON AGONISTICA\nvalido sino al 31-01-27", "certificato", O), { tipo: "non agonistico", scadenza: "2027-01-31" });
  assert.strictEqual(L.leggiDocumento("Valida fino al 31/02/2027", "tessera", O).scadenza, undefined); // data impossibile
}
// tempi dalle classifiche: chi proporre tra gli omonimi, doppioni tra le fonti, tempo della gara
const PER = [
  { id: "gpl:a", fonte: "gpl", societa: "Podistica Solidarieta'", risultati: [{ id: "g1", data: "2026-10-18", distanza: "21", secondi: 6209, tempo: "1:43:29", fonte: "gpl", gara: "Rome Half Marathon", luogo: "Roma" }] },
  { id: "gpl:b", fonte: "gpl", societa: "Asd Frosinone Sport", risultati: [] },
  { id: "fidal:x", fonte: "fidal", codice: "RM123", societa: "PODISTICA SOLIDARIETA", risultati: [{ id: "f1", data: "2026-10-18", distanza: "21", secondi: 6209, tempo: "1:43:29", fonte: "fidal", gara: "", luogo: "ROMA" }, { id: "f2", data: "2025-03-16", distanza: "42", secondi: 14000, tempo: "3:53:20", fonte: "fidal", gara: "", luogo: "REGGIO EMILIA" }] },
  { id: "fidal:y", fonte: "fidal", codice: "MI1", societa: "ALTRA", risultati: [] },
];
assert.deepStrictEqual(L.personeProposte(PER, { codiceSocieta: "rm123", societa: "A.S.D. Podistica Solidarietà" }), ["gpl:a", "fidal:x"]);
assert.deepStrictEqual(L.personeProposte(PER, {}), []);
assert.deepStrictEqual(L.personeProposte(PER.filter((p) => p.id !== "gpl:b"), {}), ["gpl:a"]); // unica persona di una fonte
const un = L.tempiUniti(PER, ["gpl:a", "fidal:x"]);
assert.deepStrictEqual(un.map((r) => r.id), ["g1", "f2"]); // la mezza su entrambe: vince Gare Podistiche Lazio
assert.strictEqual(L.nomeRisultato(un[1]), "Gara a Reggio Emilia");
assert.deepStrictEqual(L.tempiPerDistanza(un)["42"].map((r) => r.id), ["f2"]);
assert.deepStrictEqual(L.tempiDellaGara(un, roma).map((r) => r.id), ["g1"]);

// gare estere: elenco curato, circuiti, benvenuto
const ESTERO = JSON.parse(fs.readFileSync(path.join(root, "content/estero.json"), "utf8"));
assert.ok(ESTERO.gare.every((g) => /^E-[a-z0-9-]+-(21|42)-\d{4}$/.test(g.id) && g.id.endsWith(g.data.slice(0, 4)) && ["21", "42"].includes(g.distanza) && g.circuiti.length && g.circuiti.every((c) => ESTERO.circuiti[c])), "formato di content/estero.json");
assert.strictEqual(new Set(ESTERO.gare.map((g) => g.id)).size, ESTERO.gare.length, "id unici");
const major = L.cercaEstero(ESTERO.gare, "major", "", "2026-10-18");
assert.ok(major.length >= 7 && major.every((g) => g.distanza === "42"));
assert.ok(major.every((g, i) => i === 0 || major[i - 1].data <= g.data), "dalla più vicina");
assert.ok(L.cercaEstero(ESTERO.gare, "superhalfs", "", "2026-10-18").every((g) => g.distanza === "21"));
assert.strictEqual(L.cercaEstero(ESTERO.gare, "", "", "2099-01-01").length, 0);
assert.deepStrictEqual(L.circuitiDi({ id: "E-londra-42-2027" }, ESTERO), ["major", "classics"]);
assert.deepStrictEqual(L.circuitiDi({ id: "COD1-42", nome: "XXXII^ Acea Run Rome The Marathon" }, ESTERO), ["classics"]);
assert.deepStrictEqual(L.circuitiDi({ id: "COD2-42", nome: "Maratona di Firenze" }, ESTERO), []);
assert.match(L.benvenutoTop(["major", "classics"]).titolo, /top del top/);
assert.match(L.benvenutoTop(["superhalfs"]).titolo, /mezze/);
assert.strictEqual(L.benvenutoTop(["classics"]), null);

// presentazione delle estere e gare nel mirino
const il = L.introEstera({ id: "E-londra-42-2027", luogo: "Londra" }, ESTERO);
assert.deepStrictEqual([il.circuito, il.altri, il.indice], ["major", ["classics"], 2]);
assert.ok(il.info.racconto && il.info.traguardo && il.citta.length === 8);
assert.strictEqual(L.introEstera({ id: "E-citta-del-capo-42-2027", luogo: "Città del Capo" }, ESTERO).indice, 3);
assert.strictEqual(L.introEstera({ id: "E-siviglia-42-2027", luogo: "Siviglia" }, ESTERO).circuito, "grandi");
assert.deepStrictEqual(L.nelMirino([{ id: "b", data: "2027-04-25" }, { id: "a", data: "2026-01-01" }, { id: "c", data: "2027-03-07" }], "2026-10-19").map((g) => g.id), ["c", "b"]);

// scarpe: il limite minimo è 300 km
assert.strictEqual(L.statoScarpa({ km: 150, limite: 100 }).limite, 300);
assert.strictEqual(L.statoScarpa({ km: 150, limite: 300 }).quota, 0.5);
assert.strictEqual(L.statoScarpa({ km: 150 }).limite, 800);
// preparazione su misura (L.adatta)
{
  const roma21 = { id: "R", nome: "Roma Half", data: "2027-03-01", luogo: "ROMA", distanza: "21", ruolo: "obiettivo", aggiunta: "2026-12-01" };
  const voci = (a) => a.percorso.map((v) => v.id);
  const base = { oggi: "2026-12-10", citta: "Roma", gare: [roma21] };
  // via le voci tolte
  assert.ok(!percorso.some((v) => ["P007", "P021", "P023", "P054", "P055", "P056"].includes(v.id)));
  // gara in casa: niente viaggio né logistica; fuori città sì; senza città nel profilo restano
  let a = L.adatta(percorso, roma21, base);
  assert.ok(a.casa && !voci(a).includes("P006") && !voci(a).includes("P022"));
  assert.ok(voci(L.adatta(percorso, { ...roma21, luogo: "FIRENZE" }, base)).includes("P006"));
  assert.ok(voci(L.adatta(percorso, roma21, { ...base, citta: "" })).includes("P022"));
  // prima gara in assoluto: bere in corsa e vestizione; prima dell'anno: completo
  assert.ok(a.primaGara && voci(a).includes("P012") && voci(a).includes("P030") && voci(a).includes("P017"));
  const esperto = L.adatta(percorso, roma21, { ...base, pb: { "10": { tempo: "0:45:00", data: "2026-05-01" } } });
  assert.ok(!voci(esperto).includes("P012") && !voci(esperto).includes("P030") && voci(esperto).includes("P017"));
  const secondaAnno = L.adatta(percorso, roma21, { ...base, gare: [roma21, { id: "X", data: "2027-01-15", luogo: "ROMA", distanza: "10" }] });
  assert.ok(!voci(secondaAnno).includes("P017") && !voci(secondaAnno).includes("P012"));
  // documenti: niente → carica; uno scaduto prima della gara → messaggio; validi → fatta
  assert.strictEqual(a.info["R:P002"].azione, "documenti");
  assert.ok(!a.fatte["R:P002"]);
  const doc = (t, c) => L.adatta(percorso, roma21, { ...base, documenti: { tessera: t && { scadenza: t }, certificato: c && { scadenza: c } } });
  assert.match(doc("2027-12-31", "2027-02-01").info["R:P002"].msg, /certificato scade il 1 feb, prima della gara/);
  assert.match(doc("2027-12-31", null).info["R:P002"].msg, /^Manca il certificato/);
  assert.ok(doc("2027-12-31", "2027-06-01").fatte["R:P002"]);
  // tempo obiettivo
  assert.strictEqual(a.info["R:P003"].azione, "tempo");
  assert.ok(L.adatta(percorso, { ...roma21, tempo: "1:45:00" }, base).fatte["R:P003"]);
  // scarpe: nessuna → aggiungi; ci sono → scegli; scelta → fatta, e dice se arriva al via
  assert.strictEqual(a.info["R:P004"].azione, "aggiungi-scarpe");
  const scarpe = [{ id: "s1", nome: "Pegasus", km: 600, limite: 700 }, { id: "s2", nome: "Vaporfly", km: 50, limite: 400, storia: [{ d: "2026-11-20", km: 30 }, { d: "2026-12-10", km: 50 }] }];
  assert.strictEqual(L.adatta(percorso, roma21, { ...base, scarpe }).info["R:P004"].azione, "scegli-scarpa");
  const conV = L.adatta(percorso, { ...roma21, scarpa: "s2" }, { ...base, scarpe });
  assert.ok(conV.fatte["R:P004"] && conV.fatte["R:P013"], conV.info["R:P013"]);
  assert.match(conV.info["R:P013"].msg, /Vaporfly arrivano al via con circa 131 km su 400\.$/); // 1 km/giorno per 81 giorni, dalla storia
  const conP = L.adatta(percorso, { ...roma21, scarpa: "s1" }, { ...base, scarpe });
  assert.ok(!conP.fatte["R:P013"] && /oltre i 700.*stima/.test(conP.info["R:P013"].msg), conP.info["R:P013"].msg);
  // scarpa da gara: contano solo le gare in calendario prima di questa (a partire da oggi), mai la storia
  const gara3 = L.scarpaAlVia({ km: 50, limite: 400, tipo: "gara" }, roma21, "2026-12-10");
  assert.deepStrictEqual([gara3.km, gara3.come, gara3.ok], [50, "gare", true]);
  const calendario = [roma21, { id: "A", data: "2026-12-20", distanza: "10" }, { id: "B", data: "2027-01-18", distanza: "21" }, { id: "C", data: "2026-11-01", distanza: "42" }, { id: "D", data: "2027-06-01", distanza: "42" }];
  const gara4 = L.scarpaAlVia({ km: 50, limite: 400, tipo: "gara", storia: [{ d: "2026-11-20", km: 0 }, { d: "2026-12-10", km: 50 }] }, roma21, "2026-12-10", { gare: calendario });
  assert.deepStrictEqual([gara4.km, gara4.gare], [81, 2]); // 50 + 10 + 21,1 (non quella passata né quella dopo)
  const conG = L.adatta(percorso, { ...roma21, scarpa: "g1" }, { ...base, gare: calendario, scarpe: [{ id: "g1", nome: "Alphafly", km: 50, limite: 400, tipo: "gara" }] });
  assert.match(conG.info["R:P013"].msg, /circa 81 km su 400 \(contando le 2 gare in calendario prima di questa\)\.$/);
  // km a settimana del profilo: base 44% alle scarpe da allenamento, qualità + lungo 56% a quelle "ritmo e lunghi"
  const parco = [{ id: "a1", nome: "Pegasus", km: 100, tipo: "allenamento" }, { id: "r1", nome: "Endorphin", km: 100, tipo: "ritmo" }, { id: "g1", nome: "Alphafly", km: 0, tipo: "gara" }, { id: "t1", nome: "Speedgoat", km: 0, tipo: "trail" }];
  const conKm = (id, sc = parco) => L.scarpaAlVia(sc.find((x) => x.id === id), roma21, "2026-12-10", { kmSettimana: 70, scarpe: sc });
  assert.deepStrictEqual([conKm("a1").km, conKm("a1").come], [100 + Math.round(70 * 0.44 / 7 * 81) , "settimana"]); // 456
  assert.strictEqual(conKm("r1").km, 100 + Math.round(70 * 0.56 / 7 * 81)); // 554
  assert.strictEqual(conKm("a1", parco.filter((x) => x.id !== "r1")).km, 100 + 810, "senza scarpe da ritmo fa tutto lei");
  assert.strictEqual(conKm("a1", [...parco, { id: "a2", nome: "Clifton", km: 0, tipo: "allenamento" }]).km, 100 + Math.round(70 * 0.44 / 2 / 7 * 81), "due da allenamento si dividono la base");
  assert.strictEqual(conKm("a1", [...parco, { id: "a3", km: 0, tipo: "allenamento", ritirata: true }]).km, conKm("a1").km, "le ritirate non contano");
  // senza km a settimana: uso tipico e invito a dirli; con: il messaggio lo dice
  assert.strictEqual(conP.info["R:P013"].azione, "km-settimana");
  assert.strictEqual(conP.info["R:P013"].ok, false);
  const conPkm = L.adatta(percorso, { ...roma21, scarpa: "a1" }, { ...base, kmSettimana: 70, scarpe: parco });
  assert.match(conPkm.info["R:P013"].msg, /Pegasus arrivano al via con circa 456 km su 800 \(stima con i tuoi 70 km a settimana\)\.$/);
  assert.strictEqual(conPkm.info["R:P013"].azione, "scegli-scarpa");
}
assert.strictEqual(L.kmAlGiorno([{ d: "2026-12-05", km: 10 }, { d: "2026-12-10", km: 20 }], "2026-12-10"), null); // meno di 7 giorni
assert.strictEqual(L.kmAlGiorno([{ d: "2026-11-26", km: 10 }, { d: "2026-12-10", km: 38 }], "2026-12-10"), 2);

// Buddy: contesto per il modello, senza dati di Strava e senza nomi
{
  const ctx = L.contestoBuddy({ oggi: "2026-10-14", gare: [firenze, { ...roma, data: "2026-11-08", tempo: "1:40:00" }], fasi,
    pb: { "21": { tempo: "1:38:00" }, "10": { tempo: "44:00", fonte: "strava" } },
    scarpe: [{ nome: "Adizero", tipo: "gara", km: 250, limite: 600 }, { nome: "DaStrava", tipo: "allenamento", km: 3, strava: true }], kmSettimana: 45 });
  assert.ok(ctx.includes("Gara obiettivo: Firenze Marathon (Maratona), 2026-11-29, tra 46 giorni"), ctx);
  assert.ok(ctx.includes("tempo obiettivo 1:40:00 (passo 4:44/km)"), ctx);
  assert.ok(ctx.includes("Personali: Mezza 1:38:00."), ctx);
  assert.ok(!ctx.includes("44:00") && !ctx.includes("DaStrava"), "niente dati di Strava");
  assert.ok(ctx.includes("Adizero (gara): 250 km su 600 (42%, in forma)"), ctx);
  assert.ok(ctx.includes("Km a settimana: circa 45."), ctx);
  const ctx2 = L.contestoBuddy({ oggi: "2026-10-14", gare: [{ ...firenze, tempo: "3:25:00" }], fasi });
  assert.ok(ctx2.includes("passo maratona 4:52/km, soglia 4:37/km, ripetute 4:22/km"), ctx2);
  assert.ok(L.contestoBuddy({ oggi: "2026-10-14", fasi }).includes("Nessuna gara in programma."));
}

// classifiche del gruppo (fase 1)
{
  const R = (membro, data, distanza, secondi, categoria = "", mio = false) => ({ membro_id: membro, membro, mio, data, distanza, secondi, categoria, gara_nome: `Gara ${data}` });
  const ris = [
    R("Giulia", "2026-03-15", "21", 6400, "SF35"), R("Giulia", "2026-10-18", "21", 6350, "SF35"), R("Giulia", "2025-11-30", "42", 14500, "SF35"),
    R("Giulia", "2026-10-04", "10", 2900, "SF35"),
    R("Luca", "2025-10-19", "21", 6000, "SM45", true), R("Luca", "2026-03-22", "21", 5950, "SM45", true), R("Luca", "2026-10-18", "21", 5900, "SM45", true),
    R("Marco", "2026-10-11", "10", 2500, "SM40"), R("Marco", "2026-10-18", "10", 2400, "SM40"), R("Marco", "2026-09-06", "21", 5600, "SM40"),
    R("Sara", "2024-05-05", "10", 3000, ""),
  ];
  assert.strictEqual(L.sessoCategoria("SM45"), "M");
  assert.strictEqual(L.sessoCategoria("sf"), "F");
  assert.strictEqual(L.sessoCategoria("AF"), "F");
  assert.strictEqual(L.sessoCategoria(""), "");
  // gare corse nella stagione: Giulia 3, Marco 3, Luca 2; Sara (solo 2024) non compare
  const gc = L.classificaGareCorse(ris, { anno: 2026 });
  assert.deepStrictEqual(gc.map((x) => `${x.pos} ${x.membro} ${x.n}`), ["1 Giulia 3", "1 Marco 3", "3 Luca 2"]);
  assert.deepStrictEqual(L.classificaGareCorse(ris, { mese: "2026-10" }).map((x) => `${x.pos} ${x.membro} ${x.n}`), ["1 Giulia 2", "1 Marco 2", "3 Luca 1"]);
  // PB della stagione: Luca migliora due volte la mezza (riferimento del 2025), Giulia una (la prima mezza fissa il
  // riferimento), Marco una sui 10 km; a parità vince chi è migliorato di più
  const pb = L.classificaPBStagione(ris, 2026);
  assert.deepStrictEqual(pb.map((x) => `${x.pos} ${x.membro} ${x.n}`), ["1 Luca 2", "2 Marco 1", "3 Giulia 1"]);
  assert.ok(pb[1].perc > pb[2].perc, "Marco migliora di più in percentuale");
  assert.strictEqual(L.classificaPBStagione(ris, 2025).length, 0, "nel 2025 nessuno migliora");
  // albo d'oro: miglior tempo di sempre per atleta; filtro per sesso dalla categoria
  assert.deepStrictEqual(L.alboDoro(ris, "21").map((x) => `${x.pos} ${x.membro} ${x.secondi}`), ["1 Marco 5600", "2 Luca 5900", "3 Giulia 6350"]);
  assert.deepStrictEqual(L.alboDoro(ris, "21", "F").map((x) => x.membro), ["Giulia"]);
  assert.deepStrictEqual(L.alboDoro(ris, "10").map((x) => x.membro), ["Marco", "Giulia", "Sara"]);
  assert.deepStrictEqual(L.alboDoro(ris, "10", "M").map((x) => x.membro), ["Marco"], "senza categoria solo in tutti");
  assert.deepStrictEqual(L.recordCategorie(ris, "21").map((x) => `${x.categoria} ${x.membro}`), ["SF35 Giulia", "SM40 Marco", "SM45 Luca"]);
  // pari merito
  assert.deepStrictEqual(L.conPosizioni([{ v: 5 }, { v: 5 }, { v: 3 }], (x) => x.v).map((x) => x.pos), [1, 1, 3]);
  // le prime 3 e la tua riga
  const lungo = ["A", "B", "C", "D", "E"].map((m, i) => ({ membro: m, mio: m === "E", pos: i + 1 }));
  assert.deepStrictEqual(L.primiETu(lungo), { primi: lungo.slice(0, 3), tu: lungo[4] });
  assert.strictEqual(L.primiETu(lungo.slice(0, 3).map((x, i) => ({ ...x, mio: i === 1 }))).tu, null);
  // recupero: aperto nei 30 giorni; dopo solo le gare da una settimana prima dell'adesione
  const io = { partecipa: true, dal: "2026-10-20T08:00:00Z", recupero_fino: "2026-11-19T08:00:00Z" };
  const trovati = [{ data: "2024-04-07", distanza: "21", secondi: 6500 }, { data: "2026-10-18", distanza: "21", secondi: 6350 }, { data: "2026-11-30", distanza: "42", secondi: 14000 }];
  assert.strictEqual(L.daRecuperare(trovati, io, [], new Date("2026-10-21")).length, 3);
  assert.deepStrictEqual(L.daRecuperare(trovati, io, [], new Date("2026-12-10")).map((x) => x.data), ["2026-10-18", "2026-11-30"]);
  assert.strictEqual(L.daRecuperare(trovati, io, [{ data: "2026-10-18", distanza: "21", secondi: 6350, stato: "certificato" }], new Date("2026-10-21")).length, 2, "già certificati esclusi");
  assert.strictEqual(L.recuperoAperto({ partecipa: false, recupero_fino: "2099-01-01" }), false);
}

console.log("ok");
