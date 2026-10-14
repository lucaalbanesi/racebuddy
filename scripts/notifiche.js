/* RaceBuddy – regole delle notifiche push (funzioni pure, testate in tests/test_notifiche.js).

   Principio: una notifica parte solo se dice qualcosa di nuovo e utile. Niente countdown, niente meteo
   ripetuto, niente avvisi già dati.

   Momenti di invio (ora di Roma):
   - "mattino": un'ora prima dell'uscita abituale (chi esce dopo le 12 lo riceve alle 7). Al massimo 1 al giorno.
   - "vigilia": il giorno prima della gara alle 19.
   - "gara":    la mattina della gara, 2 ore prima della partenza (mai prima delle 5).
   Fuori da questi momenti non parte nulla: niente notifiche di notte.

   Al mattino si sceglie la cosa più importante tra (in ordine):
   1. scheda gara cambiata (annullata, spostata, nuovo orario) o appena pronta per una gara vicina;
   2. una cosa che l'utente ha rimandato a oggi ("Domani");
   3. una tappa chiave del percorso (voci con "notifica": true), se non già fatta;
   4. il meteo della gara, la prima volta che è disponibile (7 giorni prima) e se poi cambia molto;
   5. il meteo dell'uscita, solo se cambia davvero rispetto a ieri: nuovo avviso importante, ±5°, arriva la pioggia.
      Un avviso già dato ieri (o negli ultimi giorni) non si ripete. Al massimo 2 notifiche di solo meteo a settimana.
   Il cambio di meteo, se c'è, si aggiunge come seconda riga alla notifica principale.

   Preferenze dell'utente (dati.pref): meteo, percorso, gara (tutte attive di default). */
"use strict";
const L = require("../app/logic.js");

const titolo = (n) => String(n || "").replace(/^\s*[IVXLCDM]+\^\s*/, "");
const primaFrase = (t) => { const s = String(t || "").split(/(?<=\.)\s/)[0].replace(/\.$/, ""); return s ? s + "." : ""; };
const minuscola = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const oraNum = (o, def) => { const m = String(o || "").match(/(\d{1,2})(?:[:.](\d{2}))?/); return m ? Number(m[1]) + Number(m[2] || 0) / 60 : def; };
const fmtOra = (o) => { const m = String(o || "").match(/(\d{1,2})[:.](\d{2})/); return m ? `${Number(m[1])}:${m[2]}` : ""; };
const ICONA = { sereno: "☀️", variabile: "⛅", nuvoloso: "☁️", nebbia: "🌫️", pioggia: "🌧️", neve: "❄️", temporale: "⛈️" };
const icona = (m) => (m.notte && L.tipoCielo(m) === "sereno" ? "🌙" : ICONA[L.tipoCielo(m)]);

/** Ora (intera, Roma) del messaggio del mattino. */
function oraMattino(oraUscita) {
  const h = Math.floor(oraNum(oraUscita, 7));
  return h <= 12 ? Math.max(5, h - 1) : 7;
}
/** Ora del messaggio della mattina di gara: 2 ore prima della partenza indicata nella scheda (default 8:30). */
function oraGara(scheda) {
  return Math.max(5, Math.floor(oraNum(fmtOra(scheda && scheda.partenza), 8.5) - 2));
}
/** Fascia di vestizione (0 = caldo … 5 = gelo), per capire se il "cosa mettere" è cambiato. */
function fascia(m) {
  const t = m.temp - (m.vento >= 20 ? 2 : 0);
  return t >= 22 ? 0 : t >= 16 ? 1 : t >= 11 ? 2 : t >= 6 ? 3 : t >= 1 ? 4 : 5;
}
const firmaScheda = (s) => (s ? JSON.stringify([s.partenza || "", s.luogoPartenza || "", (s.note || "").match(/^(ANNULLATA|SPOSTATA[^.]*)/) ? s.note.slice(0, 40) : ""]) : "");

/** Cambiamento del meteo rispetto all'ultima osservazione. Ritorna una riga di testo o null. */
function cambioMeteo(m, prec, avvisiRecenti) {
  const avv = L.avvisiMeteo(m);
  const nuovo = avv.find((a) => a.livello === "attenzione" && !avvisiRecenti.includes(a.tipo));
  if (nuovo) return `${icona(m)} ${nuovo.titolo}: ${minuscola(primaFrase(nuovo.testo))}`;
  if (!prec) return null;
  const vest = primaFrase(L.vestizione(m));
  if (m.temp - prec.temp <= -5) return `${icona(m)} Molto più freddo di ieri: ${Math.round(m.temp)}°. ${vest}`;
  if (m.temp - prec.temp >= 5) return `${icona(m)} Più caldo di ieri: ${Math.round(m.temp)}°. ${vest}`;
  if (m.pioggia >= 60 && prec.pioggia < 30) return `🌧️ Oggi pioggia probabile (${Math.round(m.pioggia)}%) all'ora della tua uscita.`;
  if (Math.abs(fascia(m) - prec.fascia) >= 2) return `${icona(m)} ${Math.round(m.temp)}°: cambia la vestizione. ${vest}`;
  return null;
}

/**
 * Decide cosa inviare a un iscritto in questo momento.
 * ctx: { oggi, ora, dati, stato, fasi, percorso, schede, meteoUscita, meteoGara(gara, ora) -> meteo|null }
 * Ritorna { invio: {title, body, url, tag} | null, stato }.
 * meteoUscita e meteoGara sono già calcolati da chi chiama (qui niente rete).
 */
function pianifica(ctx) {
  const { oggi, ora, dati = {}, fasi, percorso, schede = {} } = ctx;
  const pref = { meteo: true, percorso: true, gara: true, ...(dati.pref || {}) };
  const stato = JSON.parse(JSON.stringify(ctx.stato || {}));
  stato.inviati = stato.inviati || {}; stato.schede = stato.schede || {}; stato.meteoGara = stato.meteoGara || {};
  const gia = (k) => !!stato.inviati[k];
  const segna = (k) => { stato.inviati[k] = oggi; };
  // pulizia: dimentica gli invii più vecchi di 60 giorni
  for (const [k, d] of Object.entries(stato.inviati)) if (L.diffDays(oggi, d) > 60) delete stato.inviati[k];

  const gare = (dati.gare || []).filter((g) => g && g.data && g.distanza && g.data >= L.addDays(oggi, -3));
  const spunte = Object.fromEntries((dati.spunte || []).map((k) => [k, true]));
  const url = "./#/oggi";

  // --- giorno di gara e vigilia (solo se l'utente vuole le notifiche gara)
  const garaOggi = gare.find((g) => g.data === oggi && g.ruolo !== "divertimento") || gare.find((g) => g.data === oggi);
  const garaDomani = gare.find((g) => L.diffDays(g.data, oggi) === 1);
  if (pref.gara && garaOggi && ora === oraGara(schede[garaOggi.id]) && !gia(`gara:${garaOggi.id}`)) {
    const s = schede[garaOggi.id] || {}, m = ctx.meteoGara && ctx.meteoGara(garaOggi, s.partenza);
    const righe = [];
    if (s.partenza) righe.push(`Partenza ${fmtOra(s.partenza) || s.partenza}${s.griglia ? ` · ${primaFrase(s.griglia).replace(/\.$/, "")}` : ""}.`);
    if (s.deposito) righe.push(`Deposito: ${minuscola(primaFrase(s.deposito))}`);
    if (m) righe.push(`${icona(m)} ${Math.round(m.temp)}° al via. ${primaFrase(L.vestizione(m, true))}`);
    righe.push("Buona gara! 🏁");
    segna(`gara:${garaOggi.id}`); stato.ultimo = oggi;
    return { invio: { title: `Oggi è il giorno: ${titolo(garaOggi.nome)}`, body: righe.join("\n"), url: `./#/gara/${encodeURIComponent(garaOggi.id)}`, tag: `gara-${garaOggi.id}` }, stato };
  }
  if (pref.gara && garaDomani && ora === 19 && !gia(`vigilia:${garaDomani.id}`)) {
    const s = schede[garaDomani.id] || {}, m = ctx.meteoGara && ctx.meteoGara(garaDomani, s.partenza);
    const righe = ["Prepara la borsa stasera: la checklist è pronta nell'app."];
    if (s.partenza) righe.push(`Partenza alle ${fmtOra(s.partenza) || s.partenza}${s.luogoPartenza ? `, ${minuscola(primaFrase(s.luogoPartenza).replace(/^Partenza (da|in)\s*/i, "").replace(/\.$/, ""))}` : ""}.`);
    if (m) righe.push(`${icona(m)} ${Math.round(m.temp)}° previsti al via. ${primaFrase(L.vestizione(m, true))}`);
    segna(`vigilia:${garaDomani.id}`);
    return { invio: { title: `Domani: ${titolo(garaDomani.nome)}`, body: righe.join("\n"), url: `./#/checklist/${encodeURIComponent(garaDomani.id)}`, tag: `vigilia-${garaDomani.id}` }, stato };
  }

  // --- mattino
  if (ora !== oraMattino(dati.ora) || stato.ultimo === oggi || garaOggi) return { invio: null, stato };
  const candidati = []; // { pri, title, body, url, chiave }

  // 1. schede gara
  for (const g of gare) {
    const s = schede[g.id], firma = firmaScheda(s), n = L.diffDays(g.data, oggi);
    if (!s || n < 0) continue;
    const prima = stato.schede[g.id];
    stato.schede[g.id] = firma;
    if (!pref.gara) continue;
    if (prima === undefined) {
      if (n <= 30) candidati.push({ pri: 1, title: `Scheda pronta: ${titolo(g.nome)}`, body: `Orari, ritiro pettorale e logistica dal sito ufficiale.${s.partenza ? ` Partenza alle ${fmtOra(s.partenza) || s.partenza}.` : ""}`, url: `./#/gara/${encodeURIComponent(g.id)}` });
    } else if (prima !== firma) {
      const ann = (s.note || "").match(/^(ANNULLATA|SPOSTATA[^.]*)/);
      candidati.push({ pri: 0, title: ann ? `${titolo(g.nome)}: ${ann[1].toLowerCase()}` : `Cambiato qualcosa: ${titolo(g.nome)}`, body: ann ? "Controlla la scheda gara e il sito ufficiale." : `Aggiornate le informazioni della gara.${s.partenza ? ` Partenza: ${s.partenza}.` : ""}`, url: `./#/gara/${encodeURIComponent(g.id)}` });
    }
  }
  // 2 e 3. cose rimandate e tappe chiave del percorso
  const { focus } = L.gareAttive(gare, fasi, oggi);
  for (const g of gare) {
    if (!pref.percorso) break;
    const st = L.stato(percorso, g, oggi, spunte, dati.rinvii || {});
    for (const [k, d] of Object.entries(dati.rinvii || {})) {
      if (d !== oggi || !k.startsWith(g.id + ":") || spunte[k] || gia(`rinvio:${k}:${d}`)) continue;
      const v = st.voci.find((x) => x.chiave === k);
      if (v) candidati.push({ pri: 2, title: `Te lo ricordo: ${v.titolo}`, body: primaFrase(v.messaggio), chiave: `rinvio:${k}:${d}` });
    }
    for (const v of st.voci.filter((x) => x.notifica && x.data === oggi && !spunte[x.chiave] && !gia(`voce:${x.chiave}`))) {
      let body = primaFrase(v.messaggio);
      if (v.id === "P031" && schede[g.id] && schede[g.id].pettorale) body = `Ultimo giorno utile: ${minuscola(primaFrase(schede[g.id].pettorale))}`;
      candidati.push({ pri: v.tipo === "momento" ? 3.5 : 3, title: g.id === (focus && focus.id) ? v.titolo : `${v.titolo} · ${titolo(g.nome)}`, body, chiave: `voce:${v.chiave}` });
    }
  }
  // 4. meteo della gara (da 7 giorni prima)
  for (const g of gare) {
    const n = L.diffDays(g.data, oggi);
    if (!pref.gara || n < 2 || n > 7 || !ctx.meteoGara) continue;
    const s = schede[g.id] || {}, m = ctx.meteoGara(g, s.partenza);
    if (!m) continue;
    const prec = stato.meteoGara[g.id];
    const cambio = prec && (Math.abs(m.temp - prec.temp) >= 4 || (m.pioggia >= 60) !== (prec.pioggia >= 60) || L.avvisiMeteo(m, true).some((a) => a.livello === "attenzione" && !(prec.avvisi || []).includes(a.tipo)));
    if (!prec || (cambio && !prec.aggiornato)) {
      candidati.push({ pri: 4, title: `${prec ? "Cambia il meteo" : "Prime previsioni"} per ${titolo(g.nome)}`, body: `${icona(m)} ${Math.round(m.temp)}° al via, pioggia ${Math.round(m.pioggia)}%, vento ${Math.round(m.vento)} km/h. ${primaFrase(L.vestizione(m, true))}`, url: `./#/gara/${encodeURIComponent(g.id)}`, poi: () => { stato.meteoGara[g.id] = { temp: m.temp, pioggia: m.pioggia, avvisi: L.avvisiMeteo(m, true).map((a) => a.tipo), aggiornato: !!prec }; } });
    }
  }
  // 5. meteo dell'uscita: si confronta sempre, si avvisa solo se cambia
  let rigaMeteo = null;
  const m = ctx.meteoUscita;
  if (m) {
    const recenti = Object.entries(stato.avvisi || {}).filter(([, d]) => L.diffDays(oggi, d) <= 5).map(([t]) => t);
    rigaMeteo = pref.meteo ? cambioMeteo(m, stato.meteo, recenti) : null;
    stato.avvisi = stato.avvisi || {};
    for (const a of L.avvisiMeteo(m)) stato.avvisi[a.tipo] = oggi;
    stato.meteo = { data: oggi, temp: m.temp, pioggia: m.pioggia, fascia: fascia(m) };
  }

  candidati.sort((a, b) => a.pri - b.pri);
  const top = candidati[0];
  if (!top && !rigaMeteo) return { invio: null, stato };
  if (!top) {
    const settimana = Object.entries(stato.inviati).filter(([k, d]) => k.startsWith("meteo:") && L.diffDays(oggi, d) < 7).length;
    if (settimana >= 2) return { invio: null, stato };
    segna(`meteo:${oggi}`); stato.ultimo = oggi;
    return { invio: { title: "Il meteo cambia", body: rigaMeteo, url: "./#/meteo", tag: `meteo-${oggi}` }, stato };
  }
  if (top.chiave) segna(top.chiave);
  if (top.poi) top.poi();
  stato.ultimo = oggi;
  return { invio: { title: top.title, body: [top.body, rigaMeteo].filter(Boolean).join("\n"), url: top.url || url, tag: `mattino-${oggi}` }, stato };
}

/**
 * Notifiche del gruppo (ritrovi), separate da quelle personali: al massimo una per volta, solo tra le 7 e le 21.
 * - nuovo ritrovo: a chi lo riceve (tutto il gruppo, o chi corre quella gara), non all'autore;
 * - promemoria: la sera prima alle 19, solo a chi ha detto «ci sono»;
 * - annullato: solo a chi aveva detto «ci sono».
 * ctx: { oggi, ora, membro, corre: [gara_id], ritrovi: [{id, titolo, giorno, etichetta, luogo, gara_id, autore_id, annullato, promemoria, si: [membro_id]}], stato, pref }
 */
function gruppo(ctx) {
  const { oggi, ora, membro, ritrovi = [], corre = [] } = ctx;
  const pref = { gruppo: true, ...(ctx.pref || {}) };
  const stato = JSON.parse(JSON.stringify(ctx.stato || {}));
  stato.ritrovi = stato.ritrovi || {};
  if (!membro || !pref.gruppo || ora < 7 || ora > 21) return { invio: null, stato };
  const visto = (id, k) => (stato.ritrovi[id] || "").split(",").includes(k);
  const segna = (id, k) => { stato.ritrovi[id] = [...new Set([...(stato.ritrovi[id] || "").split(",").filter(Boolean), k])].join(","); };
  for (const id of Object.keys(stato.ritrovi)) if (!ritrovi.some((r) => r.id === id)) delete stato.ritrovi[id];
  const url = (r) => `./#/gruppo/ritrovo/${r.id}`;
  for (const r of [...ritrovi].sort((a, b) => (a.giorno < b.giorno ? -1 : 1))) {
    const perMe = !r.gara_id || corre.includes(r.gara_id) || r.autore_id === membro;
    if (!perMe || r.giorno < oggi) continue;
    const ci = (r.si || []).includes(membro);
    if (r.annullato) {
      if (ci && !visto(r.id, "annullato") && r.autore_id !== membro) { segna(r.id, "annullato"); return { invio: { title: `Annullato: ${r.titolo}`, body: `Il ritrovo di ${r.etichetta} non si fa più.`, url: "./#/gruppo", tag: `ritrovo-${r.id}` }, stato }; }
      continue;
    }
    if (!visto(r.id, "nuovo")) {
      segna(r.id, "nuovo");
      if (r.autore_id !== membro && !ci && r.promemoria !== false)
        return { invio: { title: `Nuovo ritrovo: ${r.titolo}`, body: `${r.etichetta}${r.luogo ? ` · ${r.luogo}` : ""}. Ci sei? Rispondi con un tocco.`, url: url(r), tag: `ritrovo-${r.id}` }, stato };
    }
    if (ci && r.promemoria !== false && L.diffDays(r.giorno, oggi) === 1 && ora >= 19 && !visto(r.id, "promemoria")) {
      segna(r.id, "promemoria");
      return { invio: { title: `Domani: ${r.titolo}`, body: `${r.etichetta}${r.luogo ? ` · ${r.luogo}` : ""}. Ci vediamo lì!`, url: url(r), tag: `ritrovo-${r.id}` }, stato };
    }
  }
  return { invio: null, stato };
}

module.exports = { pianifica, gruppo, oraMattino, oraGara, fascia, cambioMeteo };
