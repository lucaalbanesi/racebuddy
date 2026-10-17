/* RaceBuddy – motore del percorso (funzioni pure, nessun accesso al DOM).
   Le date sono stringhe ISO "YYYY-MM-DD". I giorni sono contati rispetto alla gara:
   0 = giorno gara, -7 = una settimana prima, +3 = tre giorni dopo. */
(function (root) {
  "use strict";

  const DAY = 86400000;
  const toUTC = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / DAY); // a - b
  const addDays = (iso, n) => new Date(toUTC(iso) + n * DAY).toISOString().slice(0, 10);
  const todayISO = (now = new Date()) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  };

  const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  const GIORNI = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
  const fmtBreve = (iso) => { const d = new Date(toUTC(iso)); return `${d.getUTCDate()} ${MESI[d.getUTCMonth()]}`; };
  const fmtGiorno = (iso) => { const d = new Date(toUTC(iso)); return `${GIORNI[d.getUTCDay()]} ${d.getUTCDate()} ${MESI[d.getUTCMonth()]}`; };
  const DIST_LABEL = { "10": "10 km", "21": "Mezza", "42": "Maratona" };
  const RUOLO_LABEL = { obiettivo: "Obiettivo", tappa: "Tappa", divertimento: "Per divertimento" };

  /** Fase in cui si trova una gara a una certa data. */
  function fase(fasi, distanza, dataGara, oggi) {
    const off = diffDays(oggi, dataGara);
    const ord = [...fasi].sort((a, b) => a.ordine - b.ordine);
    for (const f of ord) {
      const g = f.giorni[distanza];
      if (g && off >= g.inizio && off <= g.fine) return { id: f.id, nome: f.nome, offset: off, inizio: g.inizio, fine: g.fine };
    }
    const primo = ord[0].giorni[distanza];
    if (off < primo.inizio) return { id: "prima", nome: "Prima della preparazione", offset: off, inizio: null, fine: null };
    return { id: "conclusa", nome: "Conclusa", offset: off, inizio: null, fine: null };
  }

  /** Voci del percorso valide per una gara, in base a distanza e ruolo, con la loro data. */
  function vociGara(percorso, gara) {
    const out = [];
    for (const v of percorso) {
      const g = v.giorni[gara.distanza];
      if (g === null || g === undefined) continue;
      if (gara.ruolo === "tappa" && !(v.tappa && (g >= -14 || v.riferimento === "attivazione"))) continue;
      if (gara.ruolo === "divertimento" && !(v.divertimento && (g >= -7 || v.riferimento === "attivazione"))) continue;
      const data = v.riferimento === "attivazione" ? (gara.aggiunta || gara.data) : addDays(gara.data, g);
      out.push({ ...v, giorno: g, data, chiave: `${gara.id}:${v.id}`, gara });
    }
    return out.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.id < b.id ? -1 : 1));
  }

  /** Divide le voci di una gara in gruppi utili alla vista, alla data `oggi`. */
  function stato(percorso, gara, oggi, spunte = {}, rinvii = {}) {
    const voci = vociGara(percorso, gara).filter((v) => v.tipo !== "checklist");
    const fatto = (v) => !!spunte[v.chiave];
    const quando = (v) => (rinvii[v.chiave] && rinvii[v.chiave] > v.data ? rinvii[v.chiave] : v.data);
    const daRecuperare = voci.filter((v) => v.tipo === "cosa da fare" && v.recuperabile && v.data < oggi && v.data < (gara.aggiunta || oggi) && !fatto(v) && !(rinvii[v.chiave] > oggi));
    const oggiVoci = voci.filter((v) => quando(v) === oggi && !(v.recuperabile && v.data < (gara.aggiunta || oggi)));
    const settimana = voci.filter((v) => v.tipo === "cosa da fare" && quando(v) > oggi && quando(v) <= addDays(oggi, 7));
    const momenti = voci.filter((v) => v.tipo === "momento" && v.data > oggi).slice(0, 6);
    return { voci, daRecuperare, oggi: oggiVoci, settimana, momenti, fatto };
  }

  /** Voci di checklist (borsa e mattina) di una gara, più quelle personali. */
  function checklist(percorso, gara, personali = []) {
    const base = vociGara(percorso, gara).filter((v) => v.tipo === "checklist");
    const extra = personali.map((p) => ({ id: p.id, titolo: p.titolo, messaggio: "Voce tua, salvata per le prossime gare", categoria: "borsa", giorno: -1, chiave: `${gara.id}:${p.id}`, personale: true }));
    return { borsa: [...base.filter((v) => v.giorno < 0), ...extra], mattina: base.filter((v) => v.giorno === 0) };
  }

  /** Gara "principale" per la vista Oggi: la più vicina tra quelle non concluse, con priorità all'obiettivo
      se le altre sono lontane. Restituisce anche le altre gare in arrivo. */
  function gareAttive(gare, fasi, oggi) {
    const vive = gare
      .map((g) => ({ ...g, fase: fase(fasi, g.distanza, g.data, oggi), mancano: diffDays(g.data, oggi) }))
      .filter((g) => g.fase.id !== "conclusa")
      .sort((a, b) => a.data.localeCompare(b.data));
    const obiettivo = vive.find((g) => g.ruolo === "obiettivo") || vive[0] || null;
    const vicina = vive.find((g) => g.mancano >= 0 && g.mancano <= 7) || null;
    return { tutte: vive, obiettivo, focus: vicina || obiettivo };
  }

  function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

  /** Pillola del giorno: stessa per tutto il giorno, diversa ogni giorno, legata a fase e distanza. */
  /** Pillole coerenti con il momento: fase e distanza della gara, oppure quelle "senza gara" di stagione. */
  function pillolePool(pillole, faseId, distanza, mese) {
    let pool = pillole.filter((p) => p.fase === faseId && p.distanze.includes(distanza));
    if (!pool.length) {
      const stagione = { 12: "Inverno", 1: "Inverno", 2: "Inverno", 3: "Primavera", 4: "Primavera", 5: "Primavera", 6: "Estate", 7: "Estate", 8: "Estate", 9: "Autunno", 10: "Autunno", 11: "Autunno" }[mese];
      pool = pillole.filter((p) => p.fase === "senza_gara" && (p.categoria !== "stagione" || p.titolo === stagione));
    }
    return pool;
  }
  function pillola(pillole, faseId, distanza, oggi, mese) {
    const pool = pillolePool(pillole, faseId, distanza, mese);
    return pool.length ? pool[hash(oggi + faseId + distanza) % pool.length] : null;
  }

  /** Consiglio di vestizione a regole (nessuna AI). `gara` = true aggiunge 3°C percepiti (in gara ci si scalda di più). */
  function vestizione({ temp, vento = 0, pioggia = 0 }, gara = false) {
    let t = temp - (vento >= 20 ? 2 : 0) + (gara ? 3 : 0);
    let capi;
    if (t >= 22) capi = "Canottiera, pantaloncini e cappellino. Bevi di più e rallenta il passo.";
    else if (t >= 16) capi = "Maglietta e pantaloncini.";
    else if (t >= 11) capi = "Maglietta e pantaloncini. Manicotti se parti fresco.";
    else if (t >= 6) capi = "Maniche lunghe sottili, pantaloncini. Guanti facoltativi.";
    else if (t >= 1) capi = "Maniche lunghe e gilet antivento, pantacollant, guanti e fascia per le orecchie.";
    else capi = "Strato termico e antivento, pantacollant, guanti e berretto.";
    const extra = [];
    if (pioggia >= 50) extra.push("Probabile pioggia: giacca leggera o visiera.");
    if (gara && temp < 12) extra.push("Porta uno strato da buttare per l'attesa in griglia.");
    return [capi, ...extra].join(" ");
  }

  /** Descrive il meteo in breve. */
  function descriviMeteo({ temp, vento = 0, pioggia = 0 }) {
    const v = vento >= 30 ? "vento forte" : vento >= 15 ? "vento moderato" : "vento leggero";
    const p = pioggia >= 60 ? ", pioggia probabile" : pioggia >= 30 ? ", possibile pioggia" : "";
    return `${Math.round(temp)}°C, ${v}${p}`;
  }

  /** Contenuti "per te": punteggio in base a fase e distanza della gara, freschezza, già letti e già visti.
      Tutto calcolato sul telefono: online non va nulla di personale.
      Rotazione: un contenuto mostrato in cima nei giorni scorsi e non aperto scende (VISTO_PENALITA per giorno),
      un piccolo rimescolamento quotidiano (stabile nella giornata) varia i quasi pari merito,
      e la freschezza dimezza ogni settimana, così le novità salgono davvero. */
  const ARG_FASE = { si_parte: ["scarpe", "forza", "allenamento"], costruzione: ["allenamento", "rifornimento", "forza", "scarpe"],
    picco: ["allenamento", "rifornimento", "scarpe"], scarico: ["gara", "rifornimento", "mente", "alimentazione", "abbigliamento"],
    gara: ["gara", "mente", "abbigliamento"], dopo: ["recupero", "racconti"] };
  const VISTO_PENALITA = 2.5, VISTI_GIORNI = 60, ROTAZIONE = 1.2;
  function giorniVisto(v, oggi) {
    // Giorni (prima di oggi) in cui il contenuto è stato mostrato in cima: oggi non conta, così la lista non cambia mentre navighi.
    if (!v) return 0;
    return Math.max(0, (v.giorni || 0) - (v.ultimo === oggi ? 1 : 0));
  }
  function punteggio(c, fase, distanza, oggi, letti = {}, visti = {}) {
    const giorni = Math.max(0, diffDays(oggi, c.data));
    let p = 4 * Math.pow(0.5, giorni / 7);
    if (fase && (c.fasi || []).includes(fase)) p += 3;
    if (distanza && (c.distanze || []).includes(distanza)) p += 2;
    else if (distanza && (c.distanze || []).length) p -= 1.5;
    p += (c.argomenti || []).filter((a) => (ARG_FASE[fase] || []).includes(a)).length * 0.7;
    if (letti[c.id]) p -= 6;
    p -= giorniVisto(visti[c.id], oggi) * VISTO_PENALITA;
    p += (hash(String(c.id) + oggi) % 100) / 100 * ROTAZIONE;
    return p;
  }
  function perTe(contenuti, { fase, distanza, oggi, letti = {}, visti = {}, tipo = "" }) {
    return contenuti
      .filter((c) => !tipo || c.tipo === tipo)
      .map((c) => ({ c, p: punteggio(c, fase, distanza, oggi, letti, visti) }))
      .sort((a, b) => b.p - a.p || (a.c.data < b.c.data ? 1 : -1))
      .map((x) => ({ ...x.c, punteggio: Math.round(x.p * 10) / 10, perLaFase: !!fase && (x.c.fasi || []).includes(fase) }));
  }
  /** I primi n di una lista ordinata, al massimo maxPerFonte per fonte (se non bastano, completa con gli altri). */
  function varieta(lista, n, maxPerFonte = 1) {
    const out = [], conta = {};
    for (const c of lista) {
      if (out.length >= n) break;
      const f = c.fonteId || c.fonte || "";
      if ((conta[f] || 0) >= maxPerFonte) continue;
      out.push(c); conta[f] = (conta[f] || 0) + 1;
    }
    for (const c of lista) { if (out.length >= n) break; if (!out.includes(c)) out.push(c); }
    return out;
  }
  /** Registra i contenuti mostrati in cima oggi: { id: { giorni, ultimo } }. Ritorna una mappa nuova, senza voci vecchie. */
  function segnaVisti(visti = {}, ids = [], oggi) {
    const out = {};
    for (const [id, v] of Object.entries(visti || {})) if (v && v.ultimo && diffDays(oggi, v.ultimo) <= VISTI_GIORNI) out[id] = v;
    for (const id of ids) {
      const v = out[id];
      if (!v) out[id] = { giorni: 1, ultimo: oggi };
      else if (v.ultimo !== oggi) out[id] = { giorni: (v.giorni || 0) + 1, ultimo: oggi };
    }
    return out;
  }
  /** Novità delle gare.
   *  ordinaNovita: dalla più recente (a parità di giorno prima le più urgenti) – per il blocco e il filtro di Per te.
   *  novitaInEvidenza (scheda di Oggi): non aperte, non "app", al massimo di 7 giorni; le importanti (urgenza subito)
   *  passano davanti solo nei primi 2 giorni, poi conta la data; una notizia già mostrata in cima in 2 giorni diversi
   *  (prima di oggi) senza essere aperta lascia il posto. esposte = mappa di segnaVisti. */
  const PRI_URG = { subito: 0, mattino: 1, app: 2 };
  const ordinaNovita = (lista) => [...lista].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : (PRI_URG[a.urgenza] ?? 3) - (PRI_URG[b.urgenza] ?? 3)));
  function novitaInEvidenza(novita, { gare = [], letti = {}, esposte = {}, oggi }) {
    const fresca = (n) => n.urgenza === "subito" && diffDays(oggi, n.data) <= 2;
    const parcheggiata = (n) => { const v = esposte[n.id]; return !!(v && v.giorni >= 2 && v.ultimo !== oggi); };
    return (novita || []).filter((n) => gare.includes(n.gara) && n.urgenza !== "app" && !letti["n:" + n.id] && diffDays(oggi, n.data) <= 7 && !parcheggiata(n))
      .sort((a, b) => (fresca(a) ? 0 : 1) - (fresca(b) ? 0 : 1) || (a.data < b.data ? 1 : a.data > b.data ? -1 : 0) || (PRI_URG[a.urgenza] ?? 3) - (PRI_URG[b.urgenza] ?? 3))[0] || null;
  }
  /** Sorriso del giorno: stesso per tutto il giorno, coerente con la fase. */
  function sorriso(sorrisi, fase, oggi) {
    const pool = sorrisi.filter((s) => s.fase === fase);
    const lista = pool.length ? pool : sorrisi.filter((s) => s.fase === "senza_gara");
    return lista.length ? lista[hash("s" + oggi + fase) % lista.length] : null;
  }

  /** Tipo di cielo dal codice meteo WMO di Open-Meteo (se manca, si deduce dalla probabilità di pioggia). */
  function tipoCielo({ codice, pioggia = 0, temp = 10 } = {}) {
    const c = Number(codice);
    if (codice == null || Number.isNaN(c)) return pioggia >= 60 ? (temp <= 1 ? "neve" : "pioggia") : pioggia >= 30 ? "nuvoloso" : "sereno";
    if (c >= 95) return "temporale";
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "neve";
    if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return "pioggia";
    if (c === 45 || c === 48) return "nebbia";
    if (c === 3) return "nuvoloso";
    if (c === 2) return "variabile";
    return "sereno";
  }

  /** Avvisi pratici per l'uscita o la gara: freddo, gelo, caldo, vento, pioggia, temporale, neve, nebbia.
      Solo indicazioni generali di buon senso, nessuna prescrizione. livello: "attenzione" | "info". */
  function avvisiMeteo(m = {}, gara = false) {
    const { temp = 10, vento = 0, pioggia = 0 } = m;
    const cielo = tipoCielo(m), out = [];
    const add = (tipo, livello, titolo, testo) => out.push({ tipo, livello, titolo, testo });
    if (cielo === "temporale") add("temporale", "attenzione", "Temporale previsto", gara ? "Segui le comunicazioni dell'organizzazione sul sito e sui social della gara." : "Valuta di spostare l'uscita o di correre al chiuso.");
    if (cielo === "neve") add("neve", "attenzione", "Neve", "Fondo scivoloso: scarpe con buona aderenza e passo corto.");
    if (temp <= 0) add("gelo", "attenzione", "Rischio ghiaccio", "Attenzione a ponti, tombini e marciapiedi in ombra. Meglio percorsi conosciuti e illuminati.");
    else if (temp <= 4) add("freddo", "info", "Fa freddo", "Copri mani e orecchie e scaldati qualche minuto al chiuso prima di uscire.");
    if (temp >= 27) add("caldo", "attenzione", "Caldo intenso", gara ? "Sfrutta tutti i ristori e cerca l'ombra nell'attesa in griglia." : "Esci nelle ore più fresche, porta da bere e scegli percorsi all'ombra.");
    else if (temp >= 23) add("caldo", "info", "Fa caldo", "Porta da bere e preferisci le ore più fresche.");
    if (vento >= 40) add("vento", "attenzione", "Vento forte", "Attenzione a rami e cantieri. Meglio un percorso riparato.");
    else if (vento >= 25) add("vento", "info", "Ventoso", "Parti controvento e torna col vento a favore.");
    if (cielo === "nebbia") add("nebbia", "info", "Nebbia", "Indossa qualcosa di chiaro o riflettente e attenzione agli incroci.");
    if (pioggia >= 70 && cielo !== "temporale" && cielo !== "neve") add("pioggia", "info", "Pioggia quasi certa", "Calze asciutte e un cambio per dopo; un po' di crema sui punti di sfregamento.");
    return out;
  }

  /** Prossima uscita: oggi all'ora indicata se non è passata, altrimenti domani. Ritorna "YYYY-MM-DDTHH:00". */
  /** Prossima uscita: oggi se l'ora non è ancora arrivata (minuti compresi), altrimenti domani.
   *  Restituisce l'ora piena delle previsioni orarie (7:30 → 07:00). */
  function prossimaUscita(oraUscita, adesso) {
    const m = String(oraUscita || "7:00").match(/(\d{1,2})(?:[:.](\d{2}))?/);
    const h = Math.min(23, Number(m ? m[1] : 7)), mi = Number(m && m[2] ? m[2] : 0);
    const oggi = todayISO(adesso);
    const passata = adesso.getHours() * 60 + adesso.getMinutes() >= h * 60 + mi;
    return `${passata ? addDays(oggi, 1) : oggi}T${String(h).padStart(2, "0")}:00`;
  }

  /** Ricerca nel calendario: gare future, per testo e distanza. */
  function cercaGare(gare, testo, distanza, oggi, limite = 40) {
    const q = (testo || "").trim().toLowerCase();
    return gare
      .filter((g) => g.data >= oggi && !g.annullata)
      .filter((g) => !distanza || g.distanza === distanza)
      .filter((g) => !q || `${g.nome} ${g.luogo}`.toLowerCase().includes(q))
      .slice(0, limite);
  }

  /** Stato di una scarpa. */
  function statoScarpa(s) {
    const lim = Number(s.limite) || 800;
    const km = Number(s.km) || 0;
    const quota = Math.min(km / lim, 1);
    const etichetta = quota >= 1 ? "da sostituire" : quota >= 0.85 ? "quasi a fine vita" : s.tipo === "gara" && km < 60 ? "da rodare" : "in forma";
    const livello = quota >= 0.85 ? "attenzione" : s.tipo === "gara" && km < 60 ? "info" : "ok";
    return { km, limite: lim, quota, etichetta, livello };
  }

  /** Tempo di gara scritto a mano → { tempo: "h:mm:ss", secondi } oppure { errore }.
   *  Accetta h:mm:ss, mm:ss o h:mm (due parti: si sceglie la lettura plausibile per la distanza), anche con i punti. */
  const LIMITI_TEMPO = { "10": [25 * 60, 2.5 * 3600], "21": [55 * 60, 4.5 * 3600], "42": [118 * 60, 8 * 3600] };
  function leggiTempo(distanza, testo) {
    const lim = LIMITI_TEMPO[distanza];
    const t = String(testo || "").trim().replace(/[.,]/g, ":");
    if (!lim || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return { errore: "Scrivi il tempo come ore:minuti:secondi, es. 1:45:00" };
    const p = t.split(":").map(Number);
    if (p.slice(1).some((x) => x > 59)) return { errore: "Minuti e secondi vanno da 00 a 59" };
    const ok = (s) => s >= lim[0] && s <= lim[1];
    const candidati = p.length === 3 ? [p[0] * 3600 + p[1] * 60 + p[2]] : [p[0] * 60 + p[1], p[0] * 3600 + p[1] * 60];
    const secondi = candidati.find(ok);
    if (secondi == null) return { errore: `Il tempo non sembra giusto per ${{ "10": "un 10 km", "21": "una mezza", "42": "una maratona" }[distanza]}: ricontrollalo` };
    const h = Math.floor(secondi / 3600), m = Math.floor((secondi % 3600) / 60), s = secondi % 60;
    return { tempo: `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`, secondi };
  }

  /** Tre caselle ore · minuti · secondi → "h:mm:ss" da passare a leggiTempo; "" se vuote o non numeriche. Vuoto vale 0. */
  function tempoDaParti(ore, minuti, secondi) {
    const p = [ore, minuti, secondi].map((x) => String(x ?? "").trim());
    if (p.every((x) => x === "") || p.some((x) => x !== "" && !/^\d{1,2}$/.test(x))) return "";
    const [h, m, s] = p.map((x) => Number(x || 0));
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  /** Strava: in che distanza cade una corsa (il GPS sbaglia di qualche centinaio di metri). */
  const FINESTRE_KM = { "10": [9.8, 10.6], "21": [20.9, 21.8], "42": [41.9, 43.6] }; // le maratone in città sul GPS arrivano spesso a 43 km e oltre
  const distanzaDi = (metri) => Object.keys(FINESTRE_KM).find((d) => metri / 1000 >= FINESTRE_KM[d][0] && metri / 1000 <= FINESTRE_KM[d][1]) || null;
  /** Corse di Strava (segnate come gara o no) → per ogni distanza le candidate a personale, dalla più veloce.
   *  A parità di tempo prima quella segnata come gara. */
  const hms = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  function candidatiPersonali(gare) {
    const out = { "10": [], "21": [], "42": [] };
    for (const a of gare || []) {
      const d = distanzaDi(a.metri || 0), t = d && a.secondi > 0 ? leggiTempo(d, hms(a.secondi)) : null; // leggiTempo scarta i tempi impossibili
      if (t && t.tempo) out[d].push({ ...a, tempo: t.tempo, secondi: t.secondi });
    }
    for (const d of Object.keys(out)) out[d].sort((x, y) => x.secondi - y.secondi || (y.gara ? 1 : 0) - (x.gara ? 1 : 0) || (x.data < y.data ? 1 : -1));
    return out;
  }
  /** Le corse di Strava del giorno della gara → quella che è la gara (segnata come gara, o con la distanza più giusta), più le altre. */
  function corsaDellaGara(corse, distanza) {
    const ufficiale = { "10": 10000, "21": 21097, "42": 42195 }[distanza];
    const giuste = (corse || []).filter((a) => distanzaDi(a.metri || 0) === distanza && a.secondi > 0 && leggiTempo(distanza, hms(a.secondi)).tempo);
    const scelta = giuste.find((a) => a.gara) || [...giuste].sort((x, y) => Math.abs(x.metri - ufficiale) - Math.abs(y.metri - ufficiale))[0] || null;
    return { scelta: scelta ? { ...scelta, tempo: leggiTempo(distanza, hms(scelta.secondi)).tempo } : null, altre: (corse || []).filter((a) => a !== scelta && a.secondi > 0) };
  }

  /** Swipe tra le sezioni della gara. SEZIONI_GARA è l'ordine della barra a segmenti ("" = Panoramica).
   *  sezioneSwipe(sez, dx, dy, ms): sezione di arrivo, o null se il gesto non è uno swipe orizzontale deciso
   *  (almeno 60px, nettamente più orizzontale che verticale, entro 700ms) o se si è già alla prima/ultima. */
  const SEZIONI_GARA = ["", "preparazione", "info", "borsa"];
  function sezioneSwipe(sez, dx, dy, ms) {
    if (!(Math.abs(dx) >= 60 && Math.abs(dx) > 1.8 * Math.abs(dy) && ms <= 700)) return null;
    const i = SEZIONI_GARA.indexOf(sez || "");
    if (i < 0) return null;
    const j = i + (dx < 0 ? 1 : -1); // dito verso sinistra = sezione successiva
    return j >= 0 && j < SEZIONI_GARA.length ? SEZIONI_GARA[j] : null;
  }

  /** Passi di "Prepara RaceBuddy" (scheda in Oggi + funnel #/prepara). Obbligatori: ora di uscita, zona, tessera (numero e
   *  scadenza) e certificato in un solo passo (servono alle notifiche anche senza gare). Facoltativo: seguire una gara futura.
   *  Le notifiche sono il traguardo del funnel, non un passo contato. */
  const PASSI_PREPARA = [
    { k: "ora", titolo: "Quando esci a correre", obbligatorio: true },
    { k: "zona", titolo: "Dove corri di solito", obbligatorio: true },
    { k: "documenti", titolo: "Tessera e certificato medico", obbligatorio: true },
    { k: "gara", titolo: "La tua prossima gara", obbligatorio: false },
  ];
  function passiPrepara({ profilo = {}, documenti = {}, gare = [], nonTesserato = false } = {}, oggi) {
    const data = (d) => !!(d && /^\d{4}-\d{2}-\d{2}$/.test(d.scadenza || ""));
    const fatto = {
      ora: /^\d{1,2}[:.]\d{2}$/.test(String(profilo.ora || "")),
      zona: !!(profilo.coord || String(profilo.citta || "").trim()),
      documenti: data(documenti.tessera) && String((documenti.tessera || {}).numero || "").trim().length >= 3 && data(documenti.certificato),
      gara: (gare || []).some((g) => g && g.data >= (oggi || todayISO())),
    };
    // chi non è tesserato esce dal passo dei documenti: non conta e non blocca
    const passi = PASSI_PREPARA.filter((p) => !(nonTesserato && p.k === "documenti")).map((p) => ({ ...p, fatto: fatto[p.k] }));
    const obb = passi.filter((p) => p.obbligatorio);
    return { passi, fatti: obb.filter((p) => p.fatto).length, totale: obb.length, completo: obb.every((p) => p.fatto) };
  }

  /** Legge il testo di una foto di tessera o certificato (OCR fatto sul telefono) e propone i campi.
   *  k = "tessera" | "certificato". Restituisce solo ciò che trova: { tipo, numero, codiceSocieta, societa, scadenza, certificato, calcolata }.
   *  I valori sono proposte: l'utente li controlla prima di salvare. */
  function leggiDocumento(testo, k, oggi) {
    // l'OCR spezza a volte le cifre di una data ("1 1/02/2027"): si ricompongono prima di tutto
    const t = String(testo || "").replace(/\r/g, "").replace(/(\d)\s+(?=\d\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2,4})/g, "$1");
    const T = t.toUpperCase();
    const out = {};
    const iso = (g, m, a) => {
      let y = Number(a); if (a.length === 2) y += 2000;
      const d = Number(g), mo = Number(m);
      if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100)) return null;
      const s = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      return addDays(s, 0) === s ? s : null; // scarta date impossibili (31/02)
    };
    const righe = t.split("\n").map((r) => r.trim()).filter(Boolean);
    const RE_DATA = /(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{4}|\d{2})(?!\d)/g;
    const date = []; // { data, riga, testoRiga }
    righe.forEach((r, i) => { for (const m of r.matchAll(RE_DATA)) { const d = iso(m[1], m[2], m[3]); if (d) date.push({ data: d, i }); } });
    const vicino = (re, escludi) => { // data sulla stessa riga di una parola chiave o sulla successiva (prima riga che ne ha una)
      for (let i = 0; i < righe.length; i++) {
        if (!re.test(righe[i]) || (escludi && escludi.test(righe[i]))) continue;
        const d = date.find((x) => x.i === i) || (escludi && escludi.test(righe[i + 1] || "") ? null : date.find((x) => x.i === i + 1));
        if (d) return d.data;
      }
      return null;
    };
    const rif = oggi || todayISO();
    if (k === "tessera") {
      if (/RUNCARD/.test(T)) out.tipo = /\bEPS\b|ENTE DI PROMOZIONE/.test(T) ? "Runcard EPS" : "Runcard";
      // anno di validità stampato da solo (es. "2026" in basso a sinistra sul tesserino FIDAL), in una riga senza date
      var annoTess = (righe.map((r) => (/\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2,4}/.test(r) ? null : r.match(/(?:^|[^\d\/.\-])(20[2-4]\d)(?![\d\/.\-])/))).find(Boolean) || [])[1];
      if (!out.tipo && (/FIDAL|FEDERAZIONE|ATLETICA\s*IT|TESSERAMENT|^\s*\W*ATLETA\b/m.test(T) || annoTess)) out.tipo = "FIDAL";
      const etichetta = t.match(/(?:\b(?:tessera|card|numero|matricola|codice)\b(?:\s*(?:n[°º.]|numero))?|\bn[°º.])[ \t]*[:#]?[ \t]*([A-Z0-9][A-Z0-9 \-]{3,14}[A-Z0-9])/i);
      const pulisci = (x) => x.replace(/[\s\-]/g, "").toUpperCase();
      const valido = (x) => x && /\d/.test(x) && x.length >= 5 && x.length <= 12 && !/^(19|20)\d\d$/.test(x);
      let num = etichetta && pulisci(etichetta[1]);
      if (!valido(num)) {
        const cand = (T.replace(RE_DATA, " ").match(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z]?)[A-Z0-9]{5,12}\b/g) || []).filter((x) => valido(x) && !/^\d{1,4}$/.test(x));
        const cod5 = new Set((T.match(/\b[A-Z]{2}\s?\d{3}\b/g) || []).map((x) => x.replace(/\s/g, "")));
        num = cand.filter((x) => !cod5.has(x)).sort((a, b) => b.length - a.length)[0];
      }
      const codici = new Set((T.match(/\b[A-Z]{2}\s?\d{3}\b/g) || []).map((x) => x.replace(/\s/g, "")));
      if (valido(num) && !codici.has(num)) out.numero = num;
      // Squadra (società): codice FIDAL (sigla della provincia + 3 cifre, es. RM123) e nome, sulla stessa riga o separati.
      const RE_COD = /\b([A-Z]{2}\s?\d{3})\b/;
      const rigaCod = righe.find((r) => /cod(?:ice)?\.?\s*(?:societ|squadr|soc\b)/i.test(r) && RE_COD.test(r.toUpperCase()));
      const STRIP = /^.*?(?:societ[aà]|squadra)\s*[:\-]?\s*/i;
      let cod = rigaCod ? rigaCod.toUpperCase().match(RE_COD)[1] : "", nome = "";
      for (const r of righe.filter((x) => /societ[aà]|squadra/i.test(x))) {
        const resto = r.replace(STRIP, "").trim();
        const m = resto.match(/^([A-Z]{2}\s?\d{3})\s*[-–:]?\s*(.*)$/i);
        if (m) { cod = cod || m[1].toUpperCase(); if (m[2].trim().length >= 3) { nome = m[2].trim(); break; } }
        else if (resto.length >= 3 && r !== rigaCod) { nome = resto; break; }
      }
      if (!nome) { // sul tesserino FIDAL la squadra è una riga "RM368 - A.S.D. NOME", senza etichetta
        const r = righe.map((x) => x.match(/^\W*([A-Z]{2}\s?\d{3,4})\s*[-–—~:.,]?\s+(.{3,})$/)).find((m) => m && /[A-Z]{3}/i.test(m[2])); // 4 cifre: l'OCR a volte ne aggiunge una
        if (r) { cod = cod || r[1].toUpperCase(); nome = r[2].trim(); }
      }
      if (cod) out.codiceSocieta = cod.replace(/\s/g, "");
      if (nome) out.societa = nome.replace(/\s{2,}/g, " ").slice(0, 70);
      // Sulla tessera FIDAL c'è la data di tesseramento, non la scadenza: vale per l'anno solare (31/12).
      // La Runcard vale 12 mesi dall'emissione. Una scadenza scritta, se c'è, vince sempre.
      // Tesserino FIDAL: l'anno stampato da solo (es. "2026  LE060029") è l'anno di validità, quindi scade il 31/12.
      // La data di tesseramento può essere dell'anno prima (rinnovo a dicembre). L'unica "Scadenza" stampata è quella del
      // certificato medico: sulla FIDAL ogni riga con "scad" va al certificato, anche se l'OCR storpia "Certificato Medico".
      // Runcard: 12 mesi dall'emissione. Una scadenza esplicita della tessera (non FIDAL) vince sempre.
      const FIDAL = out.tipo === "FIDAL";
      const MED = FIDAL ? /cert|medi|edico|idone|visit|scad/i : /cert|medi|edico|idone|visit/i;
      const scCert = vicino(MED);
      if (scCert) out.certificato = { scadenza: scCert, ...(/AGONISTIC/.test(T) && !/NON\s*AGONISTIC/.test(T) ? { tipo: "agonistico (atletica leggera)" } : {}) };
      const sc = FIDAL ? vicino(/valid|fino al/i, MED) : vicino(/scad|valid|fino al|expir/i, MED);
      const tess = vicino(/tesserament|tesserat|rilasci|emission|emess|iscrizion|attivazion|dal\b|\bdata\b\s*:?/i, MED);
      if (tess) out.tesseramento = tess;
      const anno = annoTess;
      const daAnno = (y) => { out.scadenza = `${y}-12-31`; out.calcolata = true; };
      if (sc) out.scadenza = sc;
      else if (FIDAL && anno) daAnno(anno);
      else if (FIDAL && tess) daAnno(Number(tess.slice(5, 7)) >= 11 ? Number(tess.slice(0, 4)) + 1 : tess.slice(0, 4));
      else if (tess && out.tipo) { const [y, m, d] = tess.split("-").map(Number); out.scadenza = addDays(`${y + 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, -1); out.calcolata = true; }
      else if (!FIDAL) { const future = date.map((x) => x.data).filter((d) => d >= rif && d !== scCert).sort(); if (future.length) out.scadenza = future[future.length - 1]; }
    } else {
      const sc = vicino(/scad|valid[oa]?\s*(fino|sino)|fino al|sino al/i);
      const ril = vicino(/rilasci|visita|data\s*:|emess|in data/i);
      if (/AGONISTIC/.test(T) && !/NON\s*AGONISTIC/.test(T)) out.tipo = "agonistico (atletica leggera)";
      else if (/NON\s*AGONISTIC/.test(T)) out.tipo = "non agonistico";
      if (sc) out.scadenza = sc;
      else {
        const future = date.map((x) => x.data).filter((d) => d >= rif).sort();
        if (future.length) out.scadenza = future[future.length - 1];
        else {
          const base = ril || date.map((x) => x.data).filter((d) => d <= rif).sort().pop();
          if (base) { // certificato agonistico: vale un anno dalla visita
            const [y, m, d] = base.split("-").map(Number);
            out.scadenza = addDays(`${y + 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, -1);
            out.calcolata = true; // la data della visita serve solo a calcolare, non si conserva
          }
        }
      }
    }
    return out;
  }

  const api = { diffDays, addDays, todayISO, fmtBreve, fmtGiorno, DIST_LABEL, RUOLO_LABEL, fase, vociGara, stato, checklist, gareAttive, pillola, pillolePool, vestizione, descriviMeteo, tipoCielo, avvisiMeteo, perTe, varieta, segnaVisti, ordinaNovita, novitaInEvidenza, sorriso, prossimaUscita, cercaGare, statoScarpa, leggiTempo, tempoDaParti, candidatiPersonali, corsaDellaGara, SEZIONI_GARA, sezioneSwipe, PASSI_PREPARA, passiPrepara, leggiDocumento };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RBLogic = api;
})(typeof self !== "undefined" ? self : this);
