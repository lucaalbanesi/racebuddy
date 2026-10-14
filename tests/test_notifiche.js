/* Regole delle notifiche: node tests/test_notifiche.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const N = require("../scripts/notifiche.js");
const leggi = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
const fasi = leggi("content/fasi.json"), percorso = leggi("content/percorso.json");

const firenze = { id: "F-42", nome: "XLII^ ESTRA Firenze Marathon", data: "2026-11-29", distanza: "42", ruolo: "obiettivo", aggiunta: "2026-09-01" };
const scheda = { "F-42": { partenza: "8:30", luogoPartenza: "Partenza da Piazza Duomo", griglia: "Griglie per PB, ingresso 7:00-8:00.", deposito: "Piazza Santa Maria Novella dalle 7:00.", pettorale: "Expo Leopolda ven 10-19:30, sab 9-19:30." } };
const freddo = { temp: 3, vento: 5, pioggia: 10, codice: 0 };
const base = (over = {}) => ({ ora: 6, fasi, percorso, schede: {}, dati: { ora: "07:00", gare: [firenze], spunte: [] }, stato: {}, meteoUscita: { temp: 12, vento: 5, pioggia: 10, codice: 1 }, ...over });

// orari
assert.strictEqual(N.oraMattino("06:30"), 5);
assert.strictEqual(N.oraMattino("07:00"), 6);
assert.strictEqual(N.oraMattino("18:30"), 7);
assert.strictEqual(N.oraGara({ partenza: "8:30" }), 6);
assert.strictEqual(N.oraGara({ partenza: "9:30 da confermare" }), 7);

// giorno qualunque senza novità: nessuna notifica (niente countdown), ma il meteo diventa il riferimento
let r = N.pianifica(base({ oggi: "2026-10-20" }));
assert.strictEqual(r.invio, null);
assert.strictEqual(r.stato.meteo.temp, 12);

// fuori dall'ora giusta: niente
assert.strictEqual(N.pianifica(base({ oggi: "2026-10-20", ora: 9 })).invio, null);

// meteo: crollo di 9 gradi rispetto a ieri -> notifica di solo meteo
r = N.pianifica(base({ oggi: "2026-10-21", stato: r.stato, meteoUscita: freddo }));
assert.ok(r.invio && /freddo/i.test(r.invio.body), r.invio);
// il giorno dopo fa ancora freddo uguale: silenzio
r = N.pianifica(base({ oggi: "2026-10-22", stato: r.stato, meteoUscita: freddo }));
assert.strictEqual(r.invio, null);
// gelo: avviso importante nuovo -> si dice; il giorno dopo stesso gelo -> silenzio
r = N.pianifica(base({ oggi: "2026-10-23", stato: r.stato, meteoUscita: { temp: -1, vento: 5, pioggia: 0, codice: 0 } }));
assert.ok(r.invio && /ghiaccio/i.test(r.invio.body), r.invio);
r = N.pianifica(base({ oggi: "2026-10-24", stato: r.stato, meteoUscita: { temp: -1, vento: 5, pioggia: 0, codice: 0 } }));
assert.strictEqual(r.invio, null);

// tappa chiave del percorso: "Ritiro pettorale: orari e regole" (P023, -16) non è tra quelle notificate; "Ricontrolla la logistica" (P022, -20) sì
r = N.pianifica(base({ oggi: "2026-11-09" }));
assert.ok(r.invio && r.invio.title === "Ricontrolla la logistica", r.invio);
// già spuntata: niente
r = N.pianifica(base({ oggi: "2026-11-09", dati: { ora: "07:00", gare: [firenze], spunte: ["F-42:P022"] } }));
assert.strictEqual(r.invio, null);

// cosa rimandata a oggi
r = N.pianifica(base({ oggi: "2026-10-20", dati: { ora: "07:00", gare: [firenze], spunte: [], rinvii: { "F-42:P016": "2026-10-20" } } }));
assert.ok(r.invio && r.invio.title.startsWith("Te lo ricordo"), r.invio);

// scheda pronta per gara entro 30 giorni, poi cambio orario
r = N.pianifica(base({ oggi: "2026-11-01", schede: scheda }));
assert.ok(r.invio && r.invio.title.startsWith("Scheda pronta"), r.invio);
const s2 = { "F-42": { ...scheda["F-42"], partenza: "9:00" } };
r = N.pianifica(base({ oggi: "2026-11-02", schede: s2, stato: r.stato }));
assert.ok(r.invio && r.invio.title.startsWith("Cambiato qualcosa"), r.invio);

// meteo gara: prima volta a 7 giorni; poi solo se cambia molto
const mg = (t, p) => () => ({ temp: t, vento: 5, pioggia: p, codice: 1 });
r = N.pianifica(base({ oggi: "2026-11-22", meteoGara: mg(9, 10), stato: { schede: {} } }));
assert.ok(r.invio && r.invio.title.startsWith("Prime previsioni"), r.invio);
r = N.pianifica(base({ oggi: "2026-11-23", meteoGara: mg(10, 15), stato: r.stato }));
assert.ok(!r.invio || !/previsioni|meteo/i.test(r.invio.title), r.invio);
r = N.pianifica(base({ oggi: "2026-11-25", meteoGara: mg(9, 80), stato: r.stato }));
assert.ok(r.invio && r.invio.title.startsWith("Cambia il meteo"), r.invio);

// vigilia alle 19 e mattina di gara 2 ore prima della partenza
r = N.pianifica(base({ oggi: "2026-11-28", ora: 19, schede: scheda, meteoGara: mg(8, 10) }));
assert.ok(r.invio && r.invio.title === "Domani: ESTRA Firenze Marathon" && /borsa/i.test(r.invio.body), r.invio);
r = N.pianifica(base({ oggi: "2026-11-29", ora: 6, schede: scheda, meteoGara: mg(8, 10), stato: r.stato }));
assert.ok(r.invio && r.invio.title.startsWith("Oggi è il giorno") && /8:30/.test(r.invio.body), r.invio);
// ripetuto alla stessa ora: niente doppioni
assert.strictEqual(N.pianifica(base({ oggi: "2026-11-29", ora: 6, schede: scheda, stato: r.stato })).invio, null);

// preferenze: meteo spento
r = N.pianifica(base({ oggi: "2026-10-21", stato: { meteo: { temp: 15, pioggia: 0, fascia: 2 } }, meteoUscita: freddo, dati: { ora: "07:00", gare: [], pref: { meteo: false } } }));
assert.strictEqual(r.invio, null);

// scadenze documenti: 30, 15, 2 giorni prima
{
  const dati = (sc) => ({ ora: "07:00", gare: [firenze], spunte: [], documenti: { certificato: { scadenza: sc }, tessera: { tipo: "FIDAL", scadenza: "2026-12-31" } } });
  let r = N.pianifica(base({ oggi: "2026-10-16", dati: dati("2026-11-15") }));
  assert.ok(r.invio && r.invio.title === "Certificato medico: scade tra 30 giorni" && /Firenze/.test(r.invio.body), r.invio);
  r = N.pianifica(base({ oggi: "2026-10-17", dati: dati("2026-11-15"), stato: r.stato }));
  assert.strictEqual(r.invio, null);
  r = N.pianifica(base({ oggi: "2026-10-31", dati: dati("2026-11-15"), stato: r.stato }));
  assert.ok(r.invio && /15 giorni/.test(r.invio.title), r.invio);
  // salta un giorno: a 1 giorno recupera la soglia dei 2
  r = N.pianifica(base({ oggi: "2026-11-14", dati: dati("2026-11-15"), stato: r.stato }));
  assert.ok(r.invio && /domani/.test(r.invio.title), r.invio);
  // aggiunto tardi (a 10 giorni): arriva una volta sola, non anche quella dei 30
  r = N.pianifica(base({ oggi: "2026-11-05", dati: dati("2026-11-15") }));
  assert.ok(r.invio && /10 giorni/.test(r.invio.title), r.invio);
  r = N.pianifica(base({ oggi: "2026-11-06", dati: dati("2026-11-15"), stato: r.stato }));
  assert.strictEqual(r.invio, null);
  // preferenza spenta
  assert.strictEqual(N.pianifica(base({ oggi: "2026-10-16", dati: { ...dati("2026-11-15"), pref: { documenti: false } } })).invio, null);
}

// gruppo: ritrovi
{
  const rit = (o = {}) => ({ id: "r1", titolo: "Lungo della domenica", giorno: "2026-10-25", etichetta: "dom 25 ott alle 8:00", luogo: "Piazza", gara_id: null, autore_id: "m1", annullato: false, promemoria: true, si: ["m1"], ...o });
  let g = N.gruppo({ oggi: "2026-10-20", ora: 12, membro: "m2", ritrovi: [rit()] });
  assert.ok(g.invio && g.invio.title.startsWith("Nuovo ritrovo"), g.invio);
  assert.strictEqual(N.gruppo({ oggi: "2026-10-20", ora: 13, membro: "m2", ritrovi: [rit()], stato: g.stato }).invio, null);   // una volta sola
  assert.strictEqual(N.gruppo({ oggi: "2026-10-20", ora: 12, membro: "m1", ritrovi: [rit()] }).invio, null);                  // non all'autore
  assert.strictEqual(N.gruppo({ oggi: "2026-10-20", ora: 23, membro: "m2", ritrovi: [rit()] }).invio, null);                  // non di notte
  assert.strictEqual(N.gruppo({ oggi: "2026-10-20", ora: 12, membro: "m2", ritrovi: [rit({ gara_id: "F-42" })] }).invio, null); // non corre quella gara
  assert.ok(N.gruppo({ oggi: "2026-10-20", ora: 12, membro: "m2", corre: ["F-42"], ritrovi: [rit({ gara_id: "F-42" })] }).invio);
  // promemoria la sera prima solo a chi ha detto sì
  g = N.gruppo({ oggi: "2026-10-24", ora: 19, membro: "m2", ritrovi: [rit({ si: ["m1", "m2"] })], stato: g.stato });
  assert.ok(g.invio && g.invio.title.startsWith("Domani"), g.invio);
  assert.strictEqual(N.gruppo({ oggi: "2026-10-24", ora: 20, membro: "m2", ritrovi: [rit({ si: ["m1", "m2"] })], stato: g.stato }).invio, null);
  assert.strictEqual(N.gruppo({ oggi: "2026-10-24", ora: 19, membro: "m3", ritrovi: [rit()], stato: { ritrovi: { r1: "nuovo" } } }).invio, null);
  // annullato: solo a chi aveva detto sì
  g = N.gruppo({ oggi: "2026-10-22", ora: 10, membro: "m2", ritrovi: [rit({ annullato: true, si: ["m1", "m2"] })], stato: { ritrovi: { r1: "nuovo" } } });
  assert.ok(g.invio && g.invio.title.startsWith("Annullato"), g.invio);
  assert.strictEqual(N.gruppo({ oggi: "2026-10-22", ora: 10, membro: "m3", ritrovi: [rit({ annullato: true })], stato: { ritrovi: { r1: "nuovo" } } }).invio, null);
  // preferenza spenta
  assert.strictEqual(N.gruppo({ oggi: "2026-10-20", ora: 12, membro: "m2", ritrovi: [rit()], pref: { gruppo: false } }).invio, null);
}

console.log("ok");
