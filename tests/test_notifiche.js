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
const base = (over = {}) => ({ ora: 6.5, fasi, percorso, schede: {}, dati: { ora: "07:00", gare: [firenze], spunte: [] }, stato: {}, meteoUscita: { temp: 12, vento: 5, pioggia: 10, codice: 1 }, ...over });

// orari
assert.strictEqual(N.oraMattino("06:30"), 6);
assert.strictEqual(N.oraMattino("07:00"), 6.5);
assert.strictEqual(N.oraMattino("07:15"), 6.5);
assert.strictEqual(N.oraMattino("07:45"), 7);
assert.strictEqual(N.oraMattino("05:00"), 5);
assert.strictEqual(N.oraMattino("12:00"), 11.5);
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

// il giorno della gara alle 12: "Com'è andata?", senza tempi, una volta sola, non se il risultato è già segnato
r = N.pianifica(base({ oggi: "2026-11-29", ora: 12, schede: scheda, stato: r.stato }));
assert.ok(r.invio && r.invio.title === "Com'è andata la ESTRA Firenze Marathon?" && r.invio.url.endsWith("#/risultato/" + encodeURIComponent(firenze.id)) && !/\d:\d\d/.test(r.invio.body), r.invio);
assert.strictEqual(N.pianifica(base({ oggi: "2026-11-29", ora: 12, schede: scheda, stato: r.stato })).invio, null);
assert.strictEqual(N.pianifica(base({ oggi: "2026-11-29", ora: 12, schede: scheda, dati: { ora: "07:00", gare: [firenze], spunte: [`${firenze.id}:P051`] } })).invio, null);
assert.strictEqual(N.pianifica(base({ oggi: "2026-11-29", ora: 12, schede: scheda, dati: { ora: "07:00", gare: [firenze], spunte: [], pref: { gara: false } } })).invio, null);
// il giorno dopo niente più "Registra il risultato" (tappa senza notifica)
assert.ok(!require("../content/percorso.json").find((v) => v.id === "P051").notifica);

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

// novità urgenti delle gare: subito (8-21), una al giorno per gara, mai vecchie, mai lo stesso tema due volte
{
  const nv = (o = {}) => ({ id: "n1", gara: "F-42", tema: "medaglia", urgenza: "subito", titolo: "Ecco la medaglia della 42ª edizione", data: "2026-10-21", trovato: "2026-10-21T08:50Z", fonte: "YouTube della gara", ufficiale: true, tipo: "video", ...o });
  const dati = { ora: "07:00", gare: [firenze], spunte: [] };
  let u = N.novitaUrgente({ oggi: "2026-10-21", ora: 10, dati, novita: [nv()] });
  assert.ok(u.invio && u.invio.title === "ESTRA Firenze Marathon: ecco la medaglia" && /Tocca per vederlo/.test(u.invio.body), u.invio);
  assert.strictEqual(u.invio.url, "./#/gara/F-42/novita?n=n1");
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-21", ora: 11, dati, novita: [nv()], stato: u.stato }).invio, null);               // una volta sola
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-21", ora: 11, dati, novita: [nv({ id: "n2", tema: "percorso" })], stato: u.stato }).invio, null); // una al giorno per gara
  assert.ok(N.novitaUrgente({ oggi: "2026-10-22", ora: 9, dati, novita: [nv({ id: "n2", tema: "percorso", data: "2026-10-21" })], stato: u.stato }).invio); // il giorno dopo sì
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-23", ora: 9, dati, novita: [nv({ id: "n3", data: "2026-10-23", trovato: "2026-10-23T06:50Z", ufficiale: false, fonte: "Podisti.net" })], stato: u.stato }).invio, null); // stessa medaglia da una rivista: no
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-21", ora: 7, dati, novita: [nv()] }).invio, null);   // non prima delle 8
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-21", ora: 22, dati, novita: [nv()] }).invio, null);  // non di sera tardi
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-25", ora: 10, dati, novita: [nv()] }).invio, null);  // troppo vecchia
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-21", ora: 10, dati, novita: [nv({ data: "2026-09-15", trovato: "2026-10-21T08:50Z" })] }).invio, null); // primo import di una notizia vecchia
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-21", ora: 10, dati, novita: [nv({ gara: "X-21" })] }).invio, null); // gara non seguita
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-21", ora: 10, dati, novita: [nv({ urgenza: "mattino" })] }).invio, null);
  assert.strictEqual(N.novitaUrgente({ oggi: "2026-10-21", ora: 10, dati: { ...dati, pref: { novita: false } }, novita: [nv()] }).invio, null);
  // due urgenti insieme: prima la più importante
  u = N.novitaUrgente({ oggi: "2026-10-21", ora: 10, dati, novita: [nv({ id: "a", tema: "maglia" }), nv({ id: "b", tema: "annullata", titolo: "Gara rinviata" })] });
  assert.ok(/avviso importante/.test(u.invio.title), u.invio);

  // al mattino: la novità "del mattino" diventa una riga in più della notifica principale…
  const pacer = nv({ id: "p1", tema: "pacer", urgenza: "mattino", titolo: "Diventa pacer della Firenze Marathon", tipo: "articolo", data: "2026-10-19", trovato: "2026-10-19T05:50Z" });
  let r = N.pianifica(base({ oggi: "2026-10-20", novita: [pacer], dati: { ...dati, rinvii: { "F-42:P016": "2026-10-20" } } }));
  assert.ok(r.invio && r.invio.title.startsWith("Te lo ricordo") && /Dalla ESTRA Firenze Marathon: diventa pacer/.test(r.invio.body), r.invio);
  assert.strictEqual(N.pianifica(base({ oggi: "2026-10-21", novita: [pacer], stato: r.stato })).invio, null); // già detta
  // …o da sola se non c'è altro
  r = N.pianifica(base({ oggi: "2026-10-20", novita: [pacer] }));
  assert.ok(r.invio && r.invio.title === "Novità: ESTRA Firenze Marathon" && r.invio.url.includes("/novita?n=p1"), r.invio);
  // solo app: mai
  assert.strictEqual(N.pianifica(base({ oggi: "2026-10-20", novita: [{ ...pacer, urgenza: "app" }] })).invio, null);
  // scheda cambiata subito dopo una novità urgente sullo stesso argomento: niente doppione
  const s1 = N.pianifica(base({ oggi: "2026-11-01", schede: scheda })).stato;
  s1.inviati["novita-giorno:F-42"] = "2026-11-01";
  const s2 = { "F-42": { ...scheda["F-42"], partenza: "9:00" } };
  r = N.pianifica(base({ oggi: "2026-11-02", schede: s2, stato: s1 }));
  assert.ok(!r.invio || !r.invio.title.startsWith("Cambiato qualcosa"), r.invio);
}

// la domenica, se non c'è nulla: un contenuto per la fase, una volta a settimana
{
  const L = require("../app/logic.js");
  const fase = L.fase(fasi, "42", "2026-11-29", "2026-11-01").id;   // domenica senza tappe del percorso
  const cont = [{ id: "c1", tipo: "video", fonte: "Canale", titolo: "Il lungo a ritmo gara", data: "2026-10-28", fasi: [fase], distanze: ["42"], argomenti: [] }];
  let r = N.pianifica(base({ oggi: "2026-11-01", contenuti: cont }));
  assert.ok(r.invio && r.invio.title.startsWith("Per la tua fase") && /Il lungo a ritmo gara · Canale/.test(r.invio.body), r.invio);
  assert.strictEqual(N.pianifica(base({ oggi: "2026-11-02", contenuti: cont })).invio, null);                        // solo la domenica
  assert.strictEqual(N.pianifica(base({ oggi: "2026-11-08", contenuti: cont, stato: r.stato })).invio, null);        // mai lo stesso
  assert.strictEqual(N.pianifica(base({ oggi: "2026-11-01", contenuti: cont, dati: { ora: "07:00", gare: [firenze], spunte: [], pref: { fase: false } } })).invio, null);
}

console.log("ok");
