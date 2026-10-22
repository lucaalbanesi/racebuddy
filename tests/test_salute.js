// Prova delle regole del controllo salute (scripts/salute.js): node tests/test_salute.js
"use strict";
const assert = require("assert");
const S = require("../scripts/salute.js");
const adesso = new Date("2026-10-22T19:30:00Z"); // 21:30 a Roma
const ore = (n) => new Date(adesso - n * 3600e3).toISOString();
const giro = (n, conclusion = "success", status = "completed") => ({ created_at: ore(n), status, conclusion, html_url: "https://github.com/x/runs/1" });
const tuttiOk = Object.fromEntries(S.JOBS.map((j) => [j.id, [giro(0.5)]]));
const datiOk = { "dati-calendario": "2026-10-21T21:08:41Z", "dati-contenuti": "2026-10-22", "dati-seguite": "2026-10-22", "dati-estero": "2026-10-18" };
const servOk = [{ id: "sito", nome: "Sito", stato: "ok", dettaglio: "Online" }];

// tutto ok: niente avviso
let e = S.valuta({ adesso, runs: tuttiOk, aggiornati: datiOk, servizi: servOk });
assert.ok(e.ok); assert.strictEqual(e.avviso, null); assert.deepStrictEqual(e.ko, []);
assert.strictEqual(e.controlli.find((c) => c.id === "push").dettaglio, "Ultimo giro 21:00");

// le push non partono da 3 ore di giorno: KO e avviso
e = S.valuta({ adesso, runs: { ...tuttiOk, push: [giro(3)] }, aggiornati: datiOk, servizi: servOk });
assert.deepStrictEqual(e.ko, ["push"]); assert.ok(e.avviso && /Notifiche push/.test(e.avviso.title)); assert.ok(/Non parte da 3 ore/.test(e.avviso.body));
// di notte 3 ore vanno bene
assert.strictEqual(S.valutaJob(S.JOBS[0], [giro(3)], new Date("2026-10-22T02:30:00Z")).stato, "ok");
// giro fallito: KO; annullato: attenzione (senza avviso)
assert.strictEqual(S.valutaJob(S.JOBS[1], [giro(0.2, "failure")], adesso).stato, "ko");
assert.strictEqual(S.valutaJob(S.JOBS[1], [giro(0.1, null, "in_progress"), giro(1.2, "failure")], adesso).stato, "ko");
e = S.valuta({ adesso, runs: { ...tuttiOk, novita: [giro(0.2, "cancelled")] }, aggiornati: datiOk, servizi: servOk });
assert.ok(e.ok && !e.avviso);
// nessun giro
assert.strictEqual(S.valutaJob(S.JOBS[2], [], adesso).stato, "ko");

// dati fermi
assert.strictEqual(S.valutaDato(S.DATI[0], "2026-10-10T04:00:00Z", adesso).stato, "ko");
assert.strictEqual(S.valutaDato(S.DATI[1], null, adesso).stato, "ko");
assert.strictEqual(S.valutaDato(S.DATI[1], "2026-10-21", adesso).stato, "ok");

// avvisi: una volta, poi solo se si aggiunge un problema o dopo 24 ore
const ko1 = { ...tuttiOk, push: [giro(3)] };
const p1 = S.valuta({ adesso, runs: ko1, aggiornati: datiOk, servizi: servOk });
const prec = { ko: p1.ko, avvisato: p1.avvisato };
const dopo = new Date(adesso.getTime() + 3600e3), ore2 = (n) => new Date(dopo - n * 3600e3).toISOString();
let e2 = S.valuta({ adesso: dopo, runs: { ...tuttiOk, push: [{ created_at: ore2(4), status: "completed", conclusion: "success" }] }, aggiornati: datiOk, servizi: servOk, precedente: prec });
assert.strictEqual(e2.avviso, null, "stesso problema: niente avviso"); assert.strictEqual(e2.avvisato, prec.avvisato);
e2 = S.valuta({ adesso: dopo, runs: { ...tuttiOk, push: [{ created_at: ore2(4), status: "completed", conclusion: "success" }] }, aggiornati: datiOk, servizi: [{ id: "sito", nome: "Sito", stato: "ko", dettaglio: "Risponde 500" }], precedente: prec });
assert.ok(e2.avviso && /2 problemi/.test(e2.avviso.title), "problema nuovo: avviso");
const giorno = new Date(adesso.getTime() + 25 * 3600e3);
e2 = S.valuta({ adesso: giorno, runs: { ...tuttiOk, push: [{ created_at: new Date(giorno - 3 * 3600e3).toISOString(), status: "completed", conclusion: "success" }] }, aggiornati: datiOk, servizi: servOk, precedente: prec });
assert.ok(e2.avviso, "dopo 24 ore si ricorda");
// risolto: si azzera
e2 = S.valuta({ adesso: dopo, runs: tuttiOk, aggiornati: datiOk, servizi: servOk, precedente: prec });
assert.ok(e2.ok && !e2.avviso && e2.avvisato === null);
console.log("salute ok");
