/* RaceBuddy – regole delle notifiche push (funzioni pure, testate in tests/test_notifiche.js).

   Principio: una notifica parte solo se dice qualcosa di nuovo e utile. Niente countdown, niente meteo
   ripetuto, niente avvisi già dati.

   Momenti di invio (ora di Roma):
   - "mattino": mezz'ora prima dell'uscita abituale, alla mezz'ora (uscita 7:00 → 6:30, 7:15 → 6:30; chi esce dopo le 12
     lo riceve alle 7; mai prima delle 5). Al massimo 1 al giorno. Il job gira ogni mezz'ora: "ora" è in ore con 0.5
     per la mezz'ora (6.5 = 6:30); vigilia, mattina di gara e novità urgenti valgono solo all'ora piena.
   - "vigilia": il giorno prima della gara alle 19.
   - "gara":    la mattina della gara, 2 ore prima della partenza (mai prima delle 5).
   - "dopo":    il giorno della gara, "Com'è andata?": apre la pagina per segnare il tempo (classifiche, Strava,
                ENDU). Senza tempi nel testo e solo se il risultato non è già segnato (sul telefono o, per chi è nelle
                classifiche del gruppo, già certificato online). Una sola, anche con più gare. Ora (oraDopo): partenza
                + tempo obiettivo (o un tempo tipico: 1h la 10 km, 2h15 la mezza, 4h30 la maratona, 6 min/km le altre)
                + mezz'ora, all'ora piena dopo; mai prima delle 12 né dopo le 20.
   - "esito":   tempo certificato dal direttivo o deciso dal referente (esitoTempi): ogni ora tra le 8 e le 21, una per
                risultato e stato; non per i tempi che l'atleta si è certificato da solo.
   Fuori da questi momenti non parte nulla: niente notifiche di notte.

   Al mattino si sceglie la cosa più importante tra (in ordine):
   1. scheda gara cambiata (annullata, spostata, nuovo orario) o appena pronta per una gara vicina;
   2. una cosa che l'utente ha rimandato a oggi ("Domani");
   3. una tappa chiave del percorso (voci con "notifica": true), se non già fatta;
   4. il meteo della gara, la prima volta che è disponibile (7 giorni prima) e se poi cambia molto;
   5. il meteo dell'uscita, solo se cambia davvero rispetto a ieri: nuovo avviso importante, ±3°, arriva la pioggia.
      Un avviso già dato ieri (o negli ultimi giorni) non si ripete. Al massimo 2 notifiche di solo meteo a settimana.
   Il cambio di meteo, se c'è, si aggiunge come seconda riga alla notifica principale.
   Una novità ufficiale "del mattino" di una gara seguita (pacer, allenamenti ufficiali, video…) va come riga in più,
   o da sola se non c'è altro. La domenica, se non c'è proprio nulla, un contenuto per la fase (una volta a settimana).

   Novità urgenti delle gare (novitaUrgente, valutata ogni ora tra le 8 e le 21): medaglia, maglia, percorso,
   partenza e orari, pettorale ed Expo, annullamento; dopo la gara risultati e foto. Al massimo una al giorno per
   gara, lo stesso tema di una gara non più di una volta ogni 14 giorni, mai una novità vecchia di oltre 2 giorni.

   Vestizione ogni giorno (preferenza "vestizione", spenta di default, novembre 2026): chi la accende riceve ogni giorno
   cosa mettersi per la corsa (tabella content/vestizione.json, L.vestizioneCorsa) al posto del "meteo che cambia".
   Titolo "👕 Corsa delle HH:MM · T°, percepiti P°" (⚠️ con un avviso serio), testo = un elemento (ghiaccio, pioggia,
   vento…) e i capi; il tocco apre #/meteo?uscita=…. Quando (momentoVestizione):
   - uscita prima delle 7:30 → la sera prima alle 20:30 (non la vigilia di una gara); al mattino solo una correzione,
     come riga o da sola, se la fascia salta di 2 o arriva un avviso nuovo (o se la sera non è partita);
   - uscita tra le 7:30 e le 11:59 → nel messaggio del mattino: da sola, o seconda riga della cosa più importante;
     la domenica il contenuto per la fase diventa una riga in più;
   - uscita dalle 12 → un'ora prima dell'uscita, a parte (il messaggio delle 7 resta senza meteo).
   Mai il giorno di una gara (c'è la notifica di gara con la vestizione da gara).

   Preferenze dell'utente (dati.pref): meteo, percorso, gara, documenti, novita, fase (attive di default), vestizione
   (spenta di default). */
"use strict";
const L = require("../app/logic.js");

const titolo = (n) => String(n || "").replace(/^\s*[IVXLCDM]+\^\s*/, "");
const primaFrase = (t) => { const s = String(t || "").split(/(?<=\.)\s/)[0].replace(/\.$/, ""); return s ? s + "." : ""; };
const minuscola = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const oraNum = (o, def) => { const m = String(o || "").match(/(\d{1,2})(?:[:.](\d{2}))?/); return m ? Number(m[1]) + Number(m[2] || 0) / 60 : def; };
const fmtOra = (o) => { const m = String(o || "").match(/(\d{1,2})[:.](\d{2})/); return m ? `${Number(m[1])}:${m[2]}` : ""; };
const ICONA = { sereno: "☀️", variabile: "⛅", nuvoloso: "☁️", nebbia: "🌫️", pioggia: "🌧️", neve: "❄️", temporale: "⛈️" };
const icona = (m) => (m.notte && L.tipoCielo(m) === "sereno" ? "🌙" : ICONA[L.tipoCielo(m)]);

/** Ora (Roma, a mezz'ore: 6.5 = 6:30) del messaggio del mattino: mezz'ora prima dell'uscita. */
function oraMattino(oraUscita) {
  const u = oraNum(oraUscita, 7);
  return u <= 12 ? Math.max(5, Math.floor((u - 0.5) * 2) / 2) : 7;
}
/** Ora del messaggio della mattina di gara: 2 ore prima della partenza indicata nella scheda (default 8:30). */
function oraGara(scheda) {
  return Math.max(5, Math.floor(oraNum(fmtOra(scheda && scheda.partenza), 8.5) - 2));
}
/** Ora del "Com'è andata?" del giorno della gara: quando la gara è davvero finita, con mezz'ora di margine. */
const DURATA_TIPICA = { "10": 1, "21": 2.25, "42": 4.5 };
function oraDopo(g, scheda) {
  const via = oraNum(fmtOra(scheda && scheda.partenza), 8.5);
  const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String((g && g.tempo) || "")), obiettivo = t ? Number(t[1]) + Number(t[2]) / 60 + Number(t[3]) / 3600 : null;
  const durata = obiettivo || (g && g.km ? g.km * 0.1 : DURATA_TIPICA[g && g.distanza] || 1);
  return Math.min(20, Math.max(12, Math.ceil(via + durata + 0.5)));
}
/** Vestizione ogni giorno: quando parte. "sera" = la sera prima alle 20:30 (uscita prima delle 7:30), "prima" = un'ora
    prima dell'uscita (dalle 12), "mattino" = col messaggio del mattino. Ore a mezz'ore come oraMattino. */
function momentoVestizione(oraUscita) {
  const u = oraNum(oraUscita, 7);
  if (u < 7.5) return { tipo: "sera", ora: 20.5 };
  if (u >= 12) return { tipo: "prima", ora: Math.floor((u - 1) * 2) / 2 };
  return { tipo: "mattino", ora: oraMattino(oraUscita) };
}
const gradi = (v) => `${v.temp}°, percepiti ${v.percepita}°`;
const iconaVest = (v) => (v.avviso ? "⚠️" : "👕");
const urlMeteo = (giorno, ora) => `./#/meteo?uscita=${giorno}T${String(Math.floor(oraNum(ora, 7))).padStart(2, "0")}:${String(Math.round((oraNum(ora, 7) % 1) * 60)).padStart(2, "0")}`;

/** Fascia di vestizione (0 = caldo … 5 = gelo), per capire se il "cosa mettere" è cambiato. */
function fascia(m) {
  const t = m.temp - (m.vento >= 20 ? 2 : 0);
  return t >= 22 ? 0 : t >= 16 ? 1 : t >= 11 ? 2 : t >= 6 ? 3 : t >= 1 ? 4 : 5;
}
const PREF = { meteo: true, percorso: true, gara: true, documenti: true, novita: true, fase: true, vestizione: false };
// Una novità è "fresca" se è uscita da poco e l'abbiamo vista da poco: le vecchie non si notificano mai.
const fresca = (n, oggi, giorni) => n.data >= L.addDays(oggi, -giorni) && String(n.trovato || "").slice(0, 10) >= L.addDays(oggi, -giorni);
const PRI_TEMA = ["annullata", "medaglia", "percorso", "partenza", "pettorale", "maglia", "risultati"];
const TITOLO_TEMA = { annullata: "avviso importante", medaglia: "ecco la medaglia", maglia: "ecco la maglia ufficiale", percorso: "il percorso ufficiale",
  partenza: "partenza e orari", pettorale: "ritiro del pettorale", risultati: "risultati e foto" };
const urlNovita = (n) => `./#/gara/${encodeURIComponent(n.gara)}/novita?n=${encodeURIComponent(n.id)}`;
const corpoNovita = (n) => `${n.titolo}${n.ufficiale ? "" : ` (${n.fonte})`}${n.tipo === "video" ? " Tocca per vederlo." : ""}`;

/**
 * Novità urgente di una gara seguita, valutata ogni ora tra le 8 e le 21 (in aggiunta al messaggio del mattino).
 * ctx: { oggi, ora, dati, stato, novita: [{id, gara, tema, urgenza, titolo, data, trovato, fonte, ufficiale, tipo}] }
 */
function novitaUrgente(ctx) {
  const { oggi, ora, dati = {}, novita = [] } = ctx;
  const pref = { ...PREF, ...(dati.pref || {}) };
  const stato = JSON.parse(JSON.stringify(ctx.stato || {}));
  stato.inviati = stato.inviati || {};
  if (!pref.novita || !Number.isInteger(ora) || ora < 8 || ora > 21) return { invio: null, stato };
  const gare = Object.fromEntries((dati.gare || []).filter((g) => g && g.data >= L.addDays(oggi, -14)).map((g) => [g.id, g]));
  const recente = (k, giorni) => stato.inviati[k] && L.diffDays(oggi, stato.inviati[k]) < giorni;
  const n = novita
    .filter((x) => x.urgenza === "subito" && gare[x.gara] && fresca(x, oggi, 2) && !stato.inviati[`novita:${x.id}`]
      && !recente(`novita-giorno:${x.gara}`, 1) && !recente(`novita-tema:${x.gara}:${x.tema}`, 14))
    .sort((a, b) => PRI_TEMA.indexOf(a.tema) - PRI_TEMA.indexOf(b.tema) || (a.data < b.data ? 1 : -1))[0];
  if (!n) return { invio: null, stato };
  for (const k of [`novita:${n.id}`, `novita-giorno:${n.gara}`, `novita-tema:${n.gara}:${n.tema}`]) stato.inviati[k] = oggi;
  return { invio: { title: `${titolo(gare[n.gara].nome)}: ${TITOLO_TEMA[n.tema] || "novità"}`, body: corpoNovita(n), url: urlNovita(n), tag: `novita-${n.id}` }, stato };
}

const firmaScheda = (s) => (s ? JSON.stringify([s.partenza || "", s.luogoPartenza || "", (s.note || "").match(/^(ANNULLATA|SPOSTATA[^.]*)/) ? s.note.slice(0, 40) : ""]) : "");

/** Cambiamento del meteo rispetto all'ultima osservazione. Ritorna una riga di testo o null. */
function cambioMeteo(m, prec, avvisiRecenti) {
  const avv = L.avvisiMeteo(m);
  const nuovo = avv.find((a) => a.livello === "attenzione" && !avvisiRecenti.includes(a.tipo));
  if (nuovo) return `${icona(m)} ${nuovo.titolo}: ${minuscola(primaFrase(nuovo.testo))}`;
  if (!prec) return null;
  const vest = primaFrase(L.vestizione(m));
  if (m.temp - prec.temp <= -3) return `${icona(m)} Più freddo di ieri: ${Math.round(m.temp)}°. ${vest}`;
  if (m.temp - prec.temp >= 3) return `${icona(m)} Più caldo di ieri: ${Math.round(m.temp)}°. ${vest}`;
  if (m.pioggia >= 60 && prec.pioggia < 30) return `🌧️ Oggi pioggia probabile (${Math.round(m.pioggia)}%) all'ora della tua uscita.`;
  if (Math.abs(fascia(m) - prec.fascia) >= 2) return `${icona(m)} ${Math.round(m.temp)}°: cambia la vestizione. ${vest}`;
  return null;
}

/**
 * Decide cosa inviare a un iscritto in questo momento.
 * ctx: { oggi, ora, dati, stato, fasi, percorso, schede, meteoUscita, meteoGara(gara, ora) -> meteo|null,
 *        vestiario (content/vestizione.json), corsaOggi, corsaDomani (L.meteoCorsa dell'uscita di oggi e di domani) }
 * Ritorna { invio: {title, body, url, tag} | null, stato }.
 * meteoUscita, meteoGara e le corse sono già calcolati da chi chiama (qui niente rete).
 */
function pianifica(ctx) {
  const { oggi, ora, dati = {}, fasi, percorso, schede = {} } = ctx;
  const pref = { ...PREF, ...(dati.pref || {}) };
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
    if (m) righe.push(`${icona(m)} ${Math.round(m.temp)}° al via. ${primaFrase(L.vestizione(m, true, ctx.vestiario))}`);
    righe.push("Buona gara! 🏁");
    segna(`gara:${garaOggi.id}`); stato.ultimo = oggi;
    return { invio: { title: `Oggi è il giorno: ${titolo(garaOggi.nome)}`, body: righe.join("\n"), url: `./#/gara/${encodeURIComponent(garaOggi.id)}`, tag: `gara-${garaOggi.id}` }, stato };
  }
  // tempo già certificato online (dall'atleta su un altro telefono, dal direttivo o dal referente): niente domanda
  const certificata = (g) => (ctx.esiti || []).some((e) => e.data === g.data && e.distanza === g.distanza && e.stato === "certificato");
  const corsaOggi = gare.find((g) => g.data === oggi && !spunte[`${g.id}:P051`] && !gia(`dopo:${g.id}`) && !certificata(g));
  if (pref.gara && corsaOggi && ora === oraDopo(corsaOggi, schede[corsaOggi.id])) {
    segna(`dopo:${corsaOggi.id}`);
    return { invio: { title: `Com'è andata la ${titolo(corsaOggi.nome)}?`, body: "Verifica il tuo risultato: lo cerchiamo nelle classifiche, su Strava o su ENDU, e lo segni con un tocco.", url: `./#/risultato/${encodeURIComponent(corsaOggi.id)}`, tag: `dopo-${corsaOggi.id}` }, stato };
  }
  if (pref.gara && garaDomani && ora === 19 && !gia(`vigilia:${garaDomani.id}`)) {
    const s = schede[garaDomani.id] || {}, m = ctx.meteoGara && ctx.meteoGara(garaDomani, s.partenza);
    const righe = ["Prepara la borsa stasera: la checklist è pronta nell'app."];
    if (s.partenza) righe.push(`Partenza alle ${fmtOra(s.partenza) || s.partenza}${s.luogoPartenza ? `, ${minuscola(primaFrase(s.luogoPartenza).replace(/^Partenza (da|in)\s*/i, "").replace(/\.$/, ""))}` : ""}.`);
    if (m) righe.push(`${icona(m)} ${Math.round(m.temp)}° previsti al via. ${primaFrase(L.vestizione(m, true, ctx.vestiario))}`);
    segna(`vigilia:${garaDomani.id}`);
    return { invio: { title: `Domani: ${titolo(garaDomani.nome)}`, body: righe.join("\n"), url: `./#/gara/${encodeURIComponent(garaDomani.id)}/borsa`, tag: `vigilia-${garaDomani.id}` }, stato };
  }

  // --- vestizione ogni giorno: la sera prima (uscita prima delle 7:30) o un'ora prima (uscita dalle 12)
  const vestOn = !!(pref.vestizione && ctx.vestiario);
  const momento = momentoVestizione(dati.ora), oraU = fmtOra(dati.ora) || "7:00";
  const vestDi = (m) => (m ? L.vestizioneCorsa(m, ctx.vestiario) : null);
  if (vestOn && momento.tipo === "sera" && ora === momento.ora) {
    const domani = L.addDays(oggi, 1), v = vestDi(ctx.corsaDomani);
    // la vigilia di una gara non parte: domattina si corre la gara (e la vigilia alle 19 ha già il meteo al via)
    if (!v || gare.some((g) => g.data === domani) || (stato.vestSera && stato.vestSera.data === domani)) return { invio: null, stato };
    stato.vestSera = { data: domani, fascia: v.fascia.indice, avvisi: v.correttivi.filter((c) => c.avviso).map((c) => c.id) };
    return { invio: { title: `${iconaVest(v)} Domattina alle ${oraU} · ${gradi(v)}`, body: v.push, url: urlMeteo(domani, dati.ora), tag: `vestizione-${domani}` }, stato };
  }
  if (vestOn && momento.tipo === "prima" && ora === momento.ora) {
    const v = vestDi(ctx.corsaOggi);
    if (!v || garaOggi || stato.vestizione === oggi) return { invio: null, stato };
    stato.vestizione = oggi;
    return { invio: { title: `${iconaVest(v)} Corsa delle ${oraU} · ${gradi(v)}`, body: v.push, url: urlMeteo(oggi, dati.ora), tag: `vestizione-${oggi}` }, stato };
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
      // la stessa cosa è appena arrivata come novità urgente della gara: niente doppione
      const dNov = stato.inviati[`novita-giorno:${g.id}`];
      if (!ann && dNov && L.diffDays(oggi, dNov) <= 2) continue;
      candidati.push({ pri: 0, title: ann ? `${titolo(g.nome)}: ${ann[1].toLowerCase()}` : `Cambiato qualcosa: ${titolo(g.nome)}`, body: ann ? "Controlla la scheda gara e il sito ufficiale." : `Aggiornate le informazioni della gara.${s.partenza ? ` Partenza: ${s.partenza}.` : ""}`, url: `./#/gara/${encodeURIComponent(g.id)}` });
    }
  }
  // 0. scadenze di tessera e certificato medico: 30, 15 e 2 giorni prima (se un giorno salta, recupera la soglia giusta)
  if (pref.documenti) {
    const DOC = { tessera: (d) => `Tessera ${d.tipo || ""}`.trim(), certificato: () => "Certificato medico" };
    for (const [k, nome] of Object.entries(DOC)) {
      const d = (dati.documenti || {})[k];
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.scadenza || "")) continue;
      const n = L.diffDays(d.scadenza, oggi);
      const soglia = [2, 15, 30].find((x) => n >= 0 && n <= x);
      if (soglia == null || gia(`doc:${k}:${d.scadenza}:${soglia}`)) continue;
      const gara = gare.filter((g) => g.data >= oggi && g.data > d.scadenza).sort((a, b) => (a.data < b.data ? -1 : 1))[0];
      candidati.push({ pri: 0.5, title: `${nome(d)}: ${n === 0 ? "scade oggi" : n === 1 ? "scade domani" : `scade tra ${n} giorni`}`,
        body: `Scadenza ${d.scadenza.split("-").reverse().join("/")}.${gara ? ` Ti serve valido per ${titolo(gara.nome)}.` : ""} ${k === "certificato" ? "Prenota per tempo la visita." : "Rinnovala con la tua società o online."}`,
        url: "./#/io/documenti", chiave: `doc:${k}:${d.scadenza}:${soglia}` });
      // segna anche le soglie più larghe, così non arrivano dopo
      for (const x of [2, 15, 30]) if (x > soglia) stato.inviati[`doc:${k}:${d.scadenza}:${x}`] = stato.inviati[`doc:${k}:${d.scadenza}:${x}`] || oggi;
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
      candidati.push({ pri: 4, title: `${prec ? "Cambia il meteo" : "Prime previsioni"} per ${titolo(g.nome)}`, body: `${icona(m)} ${Math.round(m.temp)}° al via, pioggia ${Math.round(m.pioggia)}%, vento ${Math.round(m.vento)} km/h. ${primaFrase(L.vestizione(m, true, ctx.vestiario))}`, url: `./#/gara/${encodeURIComponent(g.id)}`, poi: () => { stato.meteoGara[g.id] = { temp: m.temp, pioggia: m.pioggia, avvisi: L.avvisiMeteo(m, true).map((a) => a.tipo), aggiornato: !!prec }; } });
    }
  }
  // 5. meteo dell'uscita: si confronta sempre, si avvisa solo se cambia
  let rigaMeteo = null;
  const m = ctx.meteoUscita;
  if (m) {
    const recenti = Object.entries(stato.avvisi || {}).filter(([, d]) => L.diffDays(oggi, d) <= 5).map(([t]) => t);
    rigaMeteo = pref.meteo && !vestOn ? cambioMeteo(m, stato.meteo, recenti) : null; // con la vestizione ogni giorno il "cambio" non serve
    stato.avvisi = stato.avvisi || {};
    for (const a of L.avvisiMeteo(m)) stato.avvisi[a.tipo] = oggi;
    stato.meteo = { data: oggi, temp: m.temp, pioggia: m.pioggia, fascia: fascia(m) };
  }

  // 6. novità ufficiale "del mattino" di una gara seguita (o urgente non ancora data): una riga in più
  const perGara = Object.fromEntries(gare.map((g) => [g.id, g]));
  const nov = pref.novita ? (ctx.novita || []).filter((x) => x.urgenza !== "app" && perGara[x.gara] && fresca(x, oggi, 3) && !gia(`novita:${x.id}`))
    .sort((a, b) => (a.urgenza === "subito" ? 0 : 1) - (b.urgenza === "subito" ? 0 : 1) || (a.data < b.data ? 1 : -1))[0] : null;
  const rigaNovita = nov ? `Dalla ${titolo(perGara[nov.gara].nome)}: ${minuscola(nov.titolo).replace(/[.!\s]*$/, ".")}` : null;
  const segnaNovita = () => { if (nov) segna(`novita:${nov.id}`); };
  // contenuto per la fase della domenica (una volta a settimana): { c, f } o null
  function contenutoFase() {
    if (new Date(`${oggi}T12:00:00Z`).getUTCDay() !== 0 || !focus) return null;
    const f = L.fase(fasi, focus.distanza, focus.data, oggi);
    const settimana = Object.entries(stato.inviati).some(([k, d]) => k.startsWith("contenuto:") && L.diffDays(oggi, d) < 7);
    const c = !settimana && f.id !== "prima" && L.perTe(ctx.contenuti || [], { fase: f.id, distanza: focus.distanza, oggi })
      .find((x) => x.perLaFase && !gia(`contenuto:${x.id}`) && L.diffDays(oggi, x.data) <= 21);
    return c ? { c, f } : null;
  }

  // vestizione ogni giorno al mattino: per chi esce tra le 7:30 e le 12; per chi esce prima solo la correzione
  // rispetto alla sera (fascia che salta di 2 o avviso nuovo), o tutta se la sera non è partita
  let vest = null;
  if (vestOn && momento.tipo !== "prima" && stato.vestizione !== oggi) {
    const v = vestDi(ctx.corsaOggi);
    const sera = stato.vestSera && stato.vestSera.data === oggi ? stato.vestSera : null;
    if (v && momento.tipo === "mattino") vest = { v };
    else if (v && !sera) vest = { v };
    else if (v && (Math.abs(v.fascia.indice - sera.fascia) >= 2 || v.correttivi.some((c) => c.avviso && !sera.avvisi.includes(c.id)))) vest = { v, cambio: true };
  }
  const titoloVest = (x) => `${iconaVest(x.v)} ${x.cambio ? "Cambia rispetto a ieri sera" : `Corsa delle ${oraU}`} · ${gradi(x.v)}`;
  const rigaVest = vest ? `👕 ${vest.cambio ? "Cambia rispetto a ieri sera" : `Alle ${oraU}`} · ${gradi(vest.v)}. ${vest.v.push}` : null;
  const segnaVest = () => { if (vest) stato.vestizione = oggi; };

  candidati.sort((a, b) => a.pri - b.pri);
  const top = candidati[0];
  if (vest && !top) {
    // la domenica il contenuto per la fase diventa una riga in più
    const cf = pref.fase ? contenutoFase() : null;
    if (cf) segna(`contenuto:${cf.c.id}`);
    segnaVest(); segnaNovita(); stato.ultimo = oggi;
    return { invio: { title: titoloVest(vest), body: [vest.v.push, rigaNovita, cf ? `📖 Per la tua fase: ${cf.c.titolo}` : null].filter(Boolean).join("\n"), url: urlMeteo(oggi, dati.ora), tag: `vestizione-${oggi}` }, stato };
  }
  if (!top && !rigaMeteo && nov) {
    segnaNovita(); stato.ultimo = oggi;
    return { invio: { title: `Novità: ${titolo(perGara[nov.gara].nome)}`, body: corpoNovita(nov), url: urlNovita(nov), tag: `mattino-${oggi}` }, stato };
  }
  // 7. la domenica, se non c'è proprio nulla: un contenuto per la fase, una volta a settimana
  if (!top && !rigaMeteo && pref.fase) {
    const cf = contenutoFase(), c = cf && cf.c, f = cf && cf.f;
    if (c) {
      segna(`contenuto:${c.id}`); stato.ultimo = oggi;
      return { invio: { title: `Per la tua fase: ${f.nome}`, body: `${c.titolo} · ${c.fonte}`, url: "./#/perte", tag: `fase-${oggi}` }, stato };
    }
  }
  if (!top && !rigaMeteo) return { invio: null, stato };
  if (!top) {
    const settimana = Object.entries(stato.inviati).filter(([k, d]) => k.startsWith("meteo:") && L.diffDays(oggi, d) < 7).length;
    if (settimana >= 2) return { invio: null, stato };
    segna(`meteo:${oggi}`); stato.ultimo = oggi; segnaNovita();
    return { invio: { title: "Il meteo cambia", body: [rigaMeteo, rigaNovita].filter(Boolean).join("\n"), url: "./#/meteo", tag: `meteo-${oggi}` }, stato };
  }
  if (top.chiave) segna(top.chiave);
  if (top.poi) top.poi();
  stato.ultimo = oggi; segnaNovita(); segnaVest();
  return { invio: { title: top.title, body: [top.body, rigaVest, rigaNovita, rigaMeteo].filter(Boolean).join("\n"), url: top.url || url, tag: `mattino-${oggi}` }, stato };
}

/**
 * Tempo certificato dal direttivo o deciso dal referente (approvato o no): un avviso per risultato e stato.
 * ctx: { oggi, ora, dati, stato, esiti: [{ id, data, distanza, secondi, stato, da_altri }] } (da _esiti_push).
 */
function esitoTempi(ctx) {
  const { oggi, ora, dati = {}, esiti = [] } = ctx;
  const pref = { ...PREF, ...(dati.pref || {}) };
  const stato = JSON.parse(JSON.stringify(ctx.stato || {}));
  stato.inviati = stato.inviati || {};
  if (!pref.gara || !Number.isInteger(ora) || ora < 8 || ora > 21) return { invio: null, stato };
  const e = esiti.find((x) => x.da_altri && (x.stato === "certificato" || x.stato === "rifiutato") && x.data >= L.addDays(oggi, -3) && !stato.inviati[`esito:${x.id}:${x.stato}`]);
  if (!e) return { invio: null, stato };
  stato.inviati[`esito:${e.id}:${e.stato}`] = oggi;
  const g = (dati.gare || []).find((x) => x.data === e.data && x.distanza === e.distanza);
  const nome = g ? `la ${titolo(g.nome)}` : `la gara del ${e.data.slice(8, 10)}/${e.data.slice(5, 7)}`;
  const sec = Math.round(e.secondi || 0), tempo = sec ? `${Math.floor(sec / 3600) ? `${Math.floor(sec / 3600)}:` : ""}${String(Math.floor((sec % 3600) / 60)).padStart(Math.floor(sec / 3600) ? 2 : 1, "0")}:${String(sec % 60).padStart(2, "0")}` : "";
  return e.stato === "certificato"
    ? { invio: { title: "Il tuo tempo è nelle classifiche", body: `${nome.charAt(0).toUpperCase() + nome.slice(1)}${tempo ? `: ${tempo}` : ""}. È certificato: conta per le classifiche del gruppo.`, url: "./#/gruppo/mie", tag: `esito-${e.id}` }, stato }
    : { invio: { title: "Tempo non approvato", body: `Il referente non ha approvato il tempo che hai mandato per ${nome}. Puoi cercarlo nelle classifiche o rimandarlo.`, url: "./#/gruppo/mie", tag: `esito-${e.id}` }, stato };
}

module.exports = { pianifica, novitaUrgente, esitoTempi, oraMattino, oraGara, oraDopo, momentoVestizione, fascia, cambioMeteo };
