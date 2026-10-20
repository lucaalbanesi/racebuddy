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

  /** Ciclo di vita di una gara seguita: "attiva" fino alle 12 del giorno della gara (le gare sono di mattina), poi
      "postgara" (recap e "Com'è andata?") fino a POST_GARA giorni dopo, poi "archiviata". `ora` = "HH:MM" adesso
      (senza ora, il giorno della gara resta attivo). Si archivia prima quando l'esito è segnato (tempo,
      ritirato, non partito, annullata): dal giorno dopo averlo segnato, mai il giorno della gara. "Archivia" a mano
      (g.archiviata = data) archivia subito. `risultato` = S.risultati[g.id] (con `salvato`, il giorno in cui è stato
      segnato; i risultati di prima di questa regola valgono come segnati il giorno della gara). */
  const POST_GARA = 3, FINE_GARA = "12:00";
  function ciclo(g, oggi, risultato, ora) {
    if (g.archiviata) return "archiviata";
    const n = diffDays(oggi, g.data);
    if (n < 0 || (n === 0 && !(ora && ora.padStart(5, "0") >= FINE_GARA))) return "attiva";
    const segnato = risultato && risultato.tempo ? (risultato.salvato || g.data) : g.esito ? (g.esitoData || g.data) : null;
    if (segnato && oggi > segnato) return "archiviata";
    return n <= POST_GARA ? "postgara" : "archiviata";
  }

  /** Le gare seguite divise per la vista Gare: attive (dalla più vicina), appena corse e archivio (dalla più recente). */
  function dividiGare(gare, oggi, risultati = {}, ora) {
    const out = { attive: [], postgara: [], archivio: [] };
    for (const g of gare) { const c = ciclo(g, oggi, risultati[g.id], ora); out[c === "attiva" ? "attive" : c === "postgara" ? "postgara" : "archivio"].push(g); }
    out.attive.sort((a, b) => a.data.localeCompare(b.data));
    out.postgara.sort((a, b) => b.data.localeCompare(a.data));
    out.archivio.sort((a, b) => b.data.localeCompare(a.data));
    return out;
  }

  /** Il bilancio dell'ultima gara corsa prima di `prima` (data), da ricordare nella borsa: le voci "da rivedere" e la
      nota. null se non c'è niente da ricordare. */
  const DEBRIEF = { rifornimento: "Rifornimento da rivedere", scarpe: "Scarpe da rivedere", fastidi: "Hai avuto fastidi" };
  function ultimoDebrief(gare, risultati = {}, prima) {
    const g = gare.filter((x) => x.data < prima && risultati[x.id] && risultati[x.id].debrief).sort((a, b) => b.data.localeCompare(a.data))[0];
    if (!g) return null;
    const d = risultati[g.id].debrief, voci = Object.keys(DEBRIEF).filter((k) => d[k] === "rivedere" || (k === "fastidi" && d[k] === "si")).map((k) => DEBRIEF[k]);
    return voci.length || d.nota ? { gara: g, voci, nota: d.nota || "" } : null;
  }

  /** Tempi dalle classifiche (funzione "tempi"): quali persone proporre come "sei tu" tra gli omonimi.
      FIDAL: quella con il codice società della tessera; Gare Podistiche Lazio: quella con la società della tessera
      (nome simile); se una fonte ha una sola persona, quella. `tessera` = { codiceSocieta, societa }. */
  const chiaveNome = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(a\.?s\.?d\.?|s\.?s\.?d\.?|asd|ssd|ass|associazione|sportiva|dilettantistica|atletica|atl|polisportiva|pol|g\.?s\.?|podistica|team|club)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  function personeProposte(persone, tessera = {}) {
    const cod = String(tessera.codiceSocieta || "").toUpperCase(), soc = chiaveNome(tessera.societa);
    const out = new Set();
    for (const fonte of ["gpl", "fidal"]) {
      const qui = persone.filter((p) => p.fonte === fonte);
      const mia = qui.filter((p) => (fonte === "fidal" && cod && p.codice === cod) || (soc && chiaveNome(p.societa) && (chiaveNome(p.societa).includes(soc) || soc.includes(chiaveNome(p.societa)))));
      (mia.length ? mia : qui.length === 1 ? qui : []).forEach((p) => out.add(p.id));
    }
    return [...out];
  }
  /** I risultati delle persone scelte, senza doppioni (la stessa gara su entrambe le fonti: vince Gare Podistiche Lazio,
      che ha il nome della gara), dalla più recente. */
  function tempiUniti(persone, scelti) {
    const tutti = persone.filter((p) => scelti.includes(p.id)).flatMap((p) => p.risultati)
      .sort((a, b) => (a.fonte === b.fonte ? 0 : a.fonte === "gpl" ? -1 : 1));
    const visti = new Set(), out = [];
    for (const r of tutti) { const k = `${r.data}:${r.distanza}`; if (visti.has(k)) continue; visti.add(k); out.push(r); }
    return out.sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  }
  /** Per distanza, dal più veloce. */
  function tempiPerDistanza(risultati) {
    const out = { "10": [], "21": [], "42": [] };
    for (const r of risultati) if (out[r.distanza]) out[r.distanza].push(r);
    for (const d of Object.keys(out)) out[d].sort((a, b) => a.secondi - b.secondi);
    return out;
  }
  /** Il tempo di una gara seguita: stesso giorno e stessa distanza. */
  const tempiDellaGara = (risultati, gara) => risultati.filter((r) => r.data === gara.data && r.distanza === gara.distanza);
  /** Nome della gara da mostrare: FIDAL non lo dà, solo la città. */
  const nomeRisultato = (r) => r.gara || (r.luogo ? `Gara a ${r.luogo.toLowerCase().replace(/(^|[\s/'-])(\p{L})/gu, (m, a, c) => a + c.toUpperCase())}` : "Gara");

  /** Scarpe: quanti km al giorno macinano, dalla storia dei km (S.scarpe[i].storia = [{d, km}]) degli ultimi 28 giorni,
      se copre almeno 7 giorni. null se non si sa. */
  function kmAlGiorno(storia, oggi) {
    const st = (storia || []).filter((x) => x && x.d <= oggi && diffDays(oggi, x.d) <= 28).sort((a, b) => (a.d < b.d ? -1 : 1));
    if (st.length < 2) return null;
    const giorni = diffDays(st[st.length - 1].d, st[0].d);
    return giorni >= 7 ? Math.max(0, (st[st.length - 1].km - st[0].km) / giorni) : null;
  }
  // Senza storia: i km a settimana del profilo divisi come in una settimana tipo di preparazione (media di mezza
  // 10 base/10 qualità/10 base/15-18 lungo e maratona 10/10 qualità/10/10/25-30 lungo): base 44%, qualità 18%, lungo 38%.
  // Le scarpe da allenamento fanno la base, quelle "ritmo e lunghi" qualità e lungo (56%); se manca uno dei due tipi
  // l'altro fa tutto. Le scarpe dello stesso tipo si dividono i km. Le scarpe da gara contano solo le gare in calendario.
  // Senza km a settimana: uso tipico per chi prepara quella distanza.
  const QUOTE = { base: 0.44, qualita: 0.18, lungo: 0.38 };
  const USO_TIPICO = { "10": 30, "21": 40, "42": 55 }, KM_GARA = { "10": 10, "21": 21.0975, "42": 42.195 };
  const gruppoScarpa = (s) => (s.tipo === "ritmo" ? "ritmo" : "base");
  /** Con quanti km la scarpa arriva al via: { km, limite, come: "gare"|"storia"|"settimana"|"tipico", gare, ok }.
      ctx: { kmSettimana, scarpe (attive), gare (seguite) }. */
  function scarpaAlVia(s, gara, oggi, ctx = {}) {
    const giorni = Math.max(0, diffDays(gara.data, oggi)), lim = Math.max(300, Number(s.limite) || 800);
    let extra, come, nGare = 0;
    if (s.tipo === "gara") {
      const prima = (ctx.gare || []).filter((g) => g.id !== gara.id && g.data >= oggi && g.data < gara.data && !g.archiviata);
      nGare = prima.length; extra = prima.reduce((t, g) => t + (KM_GARA[g.distanza] || 0), 0); come = "gare";
    } else {
      const r = kmAlGiorno(s.storia, oggi), sett = Number(ctx.kmSettimana) || 0;
      if (r != null) { extra = r * giorni; come = "storia"; }
      else if (sett > 0) {
        const altre = (ctx.scarpe || []).filter((x) => !x.ritirata && x.tipo !== "gara" && x.tipo !== "trail" && x.id !== s.id);
        const mio = gruppoScarpa(s), stessi = altre.filter((x) => gruppoScarpa(x) === mio).length + 1, altro = altre.some((x) => gruppoScarpa(x) !== mio);
        const quota = !altro ? 1 : mio === "ritmo" ? QUOTE.qualita + QUOTE.lungo : QUOTE.base;
        extra = (sett * quota / stessi / 7) * giorni; come = "settimana";
      } else { extra = (USO_TIPICO[gara.distanza] / 7) * giorni; come = "tipico"; }
    }
    const km = Math.round((Number(s.km) || 0) + extra);
    return { km, limite: lim, come, gare: nGare, stimata: come !== "storia", ok: km <= lim };
  }

  /** La preparazione adattata a chi corre (regole delle voci, "regola" in percorso.json). ctx: { oggi, documenti, nonTesserato,
      scarpe, citta, kmSettimana, gare (tutte quelle seguite, anche passate), risultati, pb }. Ritorna:
      - percorso: le voci che valgono per questa gara (via quelle che non servono: viaggio e logistica per le gare in casa,
        bere in corsa e vestizione se non è la prima gara, completo se non è la prima dell'anno);
      - fatte: { chiave: true } delle voci già soddisfatte (documenti validi alla data della gara, tempo obiettivo, scarpa scelta,
        scarpa che arriva al via);
      - info: { chiave: { msg, azione } } con il messaggio su misura e l'azione da proporre (documenti, tempo, aggiungi-scarpe,
        scegli-scarpa). */
  const chiaveCitta = (c) => String(c || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  // Gara "in casa": il luogo della gara (anche composto, es. "OSTIA - ROMA") è la città in cui corri di solito.
  function inCasa(luogoGara, citta) {
    const c = chiaveCitta(citta);
    return !!c && String(luogoGara || "").split(/\s*[-/,]\s*/).map(chiaveCitta).includes(c);
  }
  function adatta(percorso, gara, ctx = {}) {
    const oggi = ctx.oggi || todayISO(), altre = (ctx.gare || []).filter((g) => g.id !== gara.id && g.data < gara.data);
    const primaGara = !altre.length && !Object.keys(ctx.pb || {}).length && !Object.keys(ctx.risultati || {}).length;
    const anno = gara.data.slice(0, 4), primaAnno = !altre.some((g) => g.data.startsWith(anno)) && !Object.values(ctx.pb || {}).some((p) => String(p.data || "").startsWith(anno) && p.data < gara.data);
    const casa = inCasa(gara.luogo, ctx.citta);
    const nascondi = { fuori_citta: casa, prima_gara: !primaGara, prima_anno: !primaAnno };
    const fatte = {}, info = {};
    const scarpe = (ctx.scarpe || []).filter((s) => !s.ritirata), scelta = scarpe.find((s) => s.id === gara.scarpa);
    for (const v of percorso) {
      const k = `${gara.id}:${v.id}`;
      if (v.regola === "documenti") {
        const d = ctx.documenti || {}, t = d.tessera || {}, c = d.certificato || {}, p = [];
        if (!t.scadenza) p.push("manca la tessera"); else if (t.scadenza < gara.data) p.push(`la tessera scade il ${fmtBreve(t.scadenza)}, prima della gara`);
        if (!c.scadenza) p.push("manca il certificato medico"); else if (c.scadenza < gara.data) p.push(`il certificato scade il ${fmtBreve(c.scadenza)}, prima della gara`);
        if (!p.length) { fatte[k] = true; info[k] = { msg: "Tessera e certificato sono validi fino al giorno della gara." }; }
        else info[k] = { msg: !t.scadenza && !c.scadenza ? "Non hai ancora inserito tessera e certificato: caricali, ti avviso io prima che scadano." : p.join(" e ").replace(/^./, (x) => x.toUpperCase()) + ".", azione: "documenti" };
      } else if (v.regola === "tempo") {
        if (gara.tempo) { fatte[k] = true; info[k] = { msg: `Il tuo obiettivo: ${gara.tempo}.` }; } else info[k] = { msg: v.messaggio, azione: "tempo" };
      } else if (v.regola === "scarpa") {
        if (scelta) { fatte[k] = true; info[k] = { msg: `In gara userai le ${scelta.nome}.`, azione: "scegli-scarpa" }; }
        else info[k] = scarpe.length ? { msg: "Con quali scarpe correrai la gara?", azione: "scegli-scarpa" } : { msg: "Non hai ancora inserito le tue scarpe: aggiungile e ti dico se arrivano alla gara.", azione: "aggiungi-scarpe" };
      } else if (v.regola === "scarpa_dura") {
        if (!scelta) { info[k] = scarpe.length ? { msg: "Scegli prima con quali scarpe correrai: poi ti dico se arrivano al via.", azione: "scegli-scarpa" } : { msg: "Aggiungi le tue scarpe: ti dico se arrivano al via.", azione: "aggiungi-scarpe" }; continue; }
        const a = scarpaAlVia(scelta, gara, oggi, { kmSettimana: ctx.kmSettimana, scarpe, gare: ctx.gare });
        const stima = { storia: "", settimana: ` (stima con i tuoi ${Number(ctx.kmSettimana)} km a settimana)`, tipico: " (stima con un uso tipico: dimmi quanti km corri a settimana)",
          gare: a.gare ? ` (contando le ${a.gare === 1 ? "altra gara" : a.gare + " gare"} in calendario prima di questa)` : " (nessun'altra gara in calendario prima di questa)" }[a.come];
        const azione = a.come === "tipico" ? "km-settimana" : "scegli-scarpa";
        if (a.ok) { fatte[k] = true; info[k] = { msg: `Le ${scelta.nome} arrivano al via con circa ${a.km} km su ${a.limite}${stima}.`, azione, ok: true }; }
        else info[k] = { msg: `Le ${scelta.nome} arriverebbero al via con circa ${a.km} km, oltre i ${a.limite}${stima}: valuta adesso una scarpa nuova, così hai il tempo di rodarla.`, azione, ok: false };
      }
    }
    return { percorso: percorso.filter((v) => !(v.regola && nascondi[v.regola])), fatte, info, casa, primaGara, primaAnno };
  }

  /** Gara "principale" per la vista Oggi: la più vicina tra quelle non concluse e non archiviate, con priorità
      all'obiettivo se le altre sono lontane. Restituisce anche le altre gare in arrivo. */
  function gareAttive(gare, fasi, oggi, risultati = {}) {
    const vive = gare
      .filter((g) => ciclo(g, oggi, risultati[g.id]) !== "archiviata")
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

  /** Gare estere (content/estero.json): future, non annullate, per circuito e distanza, dalla più vicina. */
  function cercaEstero(gare, circuito, distanza, oggi) {
    return (gare || [])
      .filter((g) => g.data >= oggi && !g.annullata)
      .filter((g) => !circuito || (g.circuiti || []).includes(circuito))
      .filter((g) => !distanza || g.distanza === distanza)
      .sort((a, b) => a.data.localeCompare(b.data) || a.nome.localeCompare(b.nome));
  }
  /** I circuiti di una gara: quelli dell'elenco estero, oppure, per le italiane, quelli in cui compare il nome
      (estero.italiane = { circuito: [nomi] }, es. Roma negli European Marathon Classics). */
  const nomeSemplice = (n) => String(n || "").replace(/\b[IVXLCDM]+\^\s*/g, "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  function circuitiDi(gara, estero = {}) {
    const e = (estero.gare || []).find((x) => x.id === gara.id);
    if (e) return e.circuiti || [];
    const n = nomeSemplice(gara.nome);
    return Object.entries(estero.italiane || {}).filter(([, nomi]) => nomi.some((x) => n.includes(nomeSemplice(x)))).map(([c]) => c);
  }
  /** Benvenuto per le gare del top: Major e SuperHalfs. null per le altre. */
  function benvenutoTop(circuiti, distanza) {
    if ((circuiti || []).includes("major")) return { titolo: "Benvenuto nel top del top", testo: "È una delle Abbott World Marathon Majors, le maratone più grandi e ambite del mondo. Ogni Major che finisci è una stella in più verso la medaglia di chi le ha corse tutte." };
    if ((circuiti || []).includes("superhalfs")) return { titolo: "Benvenuto nel top delle mezze", testo: "È una delle SuperHalfs, il circuito delle grandi mezze maratone europee: finiscile tutte e sei e diventi SuperRunner." };
    return null;
  }

  /** Presentazione di una gara estera: il circuito principale (Major prima di tutto), gli altri, le città del circuito e
      quale è quella della gara (per illuminarla nell'animazione). */
  const PRI_CIRCUITI = ["major", "superhalfs", "classics", "grandi"];
  function introEstera(gara, estero = {}) {
    const cs = circuitiDi(gara, estero).slice().sort((a, b) => PRI_CIRCUITI.indexOf(a) - PRI_CIRCUITI.indexOf(b));
    const c = cs[0] || null, info = ((estero.circuiti || {})[c]) || {}, citta = info.citta || [];
    const k = nomeSemplice(gara.luogo);
    return { circuito: c, altri: cs.slice(1), info, citta, indice: citta.findIndex((x) => nomeSemplice(x) === k) };
  }
  /** Le gare "nel mirino" ancora da correre, dalla più vicina. */
  const nelMirino = (lista, oggi) => (lista || []).filter((g) => g.data >= oggi).sort((a, b) => a.data.localeCompare(b.data));

  /** Stato di una scarpa. */
  function statoScarpa(s) {
    const lim = Math.max(300, Number(s.limite) || 800); // sotto i 300 km non ha senso: anche i limiti vecchi più bassi valgono 300
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

  /** Funnel "Entra nel gruppo" (dal link d'invito, o per chi è già nel gruppo quando si accendono le classifiche).
   *  Sei passi in ordine; quelli già fatti si saltano. Obbligatori: tessera e certificato (salvo non tesserati), quando e dove
   *  corri. Le classifiche ci sono solo se il gruppo le ha accese, i tempi solo se la ricerca nelle classifiche è attiva.
   *  x = { classifiche, partecipa, documenti, nonTesserato, tempi, tempiFatti, ora, zona, garaFutura, notifiche, saltati } */
  const PASSI_ENTRA = [
    { k: "classifiche", titolo: "Le classifiche della stagione", obbligatorio: false },
    { k: "documenti", titolo: "Tessera e certificato", obbligatorio: true },
    { k: "tempi", titolo: "I tuoi tempi dalle classifiche", obbligatorio: false },
    { k: "uscita", titolo: "Quando e dove corri", obbligatorio: true },
    { k: "gara", titolo: "La tua prossima gara", obbligatorio: false },
    { k: "notifiche", titolo: "Le notifiche", obbligatorio: false },
  ];
  function passiEntra(x = {}) {
    const sal = x.saltati || {};
    const fatto = {
      classifiche: !!x.partecipa || !!sal.classifiche,
      documenti: !!x.documenti || !!x.nonTesserato || !!sal.documenti,
      tempi: !!x.tempiFatti || !!sal.tempi,
      uscita: !!x.ora && !!x.zona,
      gara: !!x.garaFutura || !!sal.gara,
      notifiche: !!x.notifiche || !!sal.notifiche,
    };
    const passi = PASSI_ENTRA.filter((p) => (p.k !== "classifiche" || x.classifiche) && (p.k !== "tempi" || x.tempi))
      .map((p) => ({ ...p, obbligatorio: p.obbligatorio && !(p.k === "documenti" && x.nonTesserato), fatto: fatto[p.k] }));
    const fatti = passi.filter((p) => p.fatto).length;
    return { passi, fatti, totale: passi.length, completo: passi.every((p) => p.fatto), obbligatoriFatti: passi.every((p) => !p.obbligatorio || p.fatto) };
  }
  /** Il passo dopo "dopo" (o il primo): prima quelli che seguono, poi gli obbligatori rimasti indietro; null = finito. */
  function prossimoEntra(stato, dopo) {
    const ks = stato.passi.map((p) => p.k), i = dopo ? ks.indexOf(dopo) + 1 : 0;
    const giro = [...stato.passi.slice(i), ...stato.passi.slice(0, Math.max(0, i - 1)).filter((p) => p.obbligatorio)];
    const p = giro.find((x) => !x.fatto && x.k !== dopo);
    return p ? p.k : null;
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

  // Buddy (chat AI): il contesto del runner per il modello, in poche righe. Solo il minimo: gare, obiettivo, personali,
  // scarpe inserite a mano e km a settimana. Mai nomi, documenti, posizione, né dati arrivati da Strava (scarpe con
  // `strava`, personali con fonte "strava"): i dati di Strava restano all'utente e non vanno alle funzioni AI.
  const KM_DIST = { "10": 10, "21": 21.0975, "42": 42.195 };
  const TIPO_SCARPA = { allenamento: "allenamento", ritmo: "ritmo e lunghi", gara: "gara", trail: "trail" };
  function fmtPasso(sec) { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`; }
  function secondiTempo(t) { const p = String(t || "").split(":").map(Number); if (p.length < 2 || p.some((x) => !Number.isFinite(x))) return 0; return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; }
  function contestoBuddy({ oggi, gare = [], fasi, risultati = {}, pb = {}, scarpe = [], kmSettimana = 0 }) {
    const righe = [`Oggi: ${oggi}.`];
    const { tutte, obiettivo } = fasi ? gareAttive(gare, fasi, oggi, risultati) : { tutte: [], obiettivo: null };
    const descr = (g) => {
      const sec = secondiTempo(g.tempo), km = KM_DIST[g.distanza];
      return `${g.nome} (${DIST_LABEL[g.distanza] || g.distanza}), ${g.data}, tra ${g.mancano} giorni${g.fase && g.fase.nome ? `, fase: ${g.fase.nome}` : ""}${sec && km ? `, tempo obiettivo ${g.tempo} (passo ${fmtPasso(sec / km)})` : ", tempo obiettivo non indicato"}`;
    };
    if (obiettivo) righe.push(`Gara obiettivo: ${descr(obiettivo)}.`);
    // ritmi di riferimento dal passo obiettivo (stime prudenti, per tenere coerenti i numeri del piano)
    const secO = obiettivo ? secondiTempo(obiettivo.tempo) : 0, kmO = obiettivo ? KM_DIST[obiettivo.distanza] : 0;
    if (secO && kmO) {
      const p = secO / kmO, pm = obiettivo.distanza === "42" ? p : obiettivo.distanza === "21" ? p * 1.05 : p * 1.12;
      righe.push(`Ritmi di riferimento (dal tempo obiettivo): lento ${fmtPasso(pm + 60)}-${fmtPasso(pm + 80)}, medio ${fmtPasso(pm + 20)}, passo maratona ${fmtPasso(pm)}, soglia ${fmtPasso(pm - 15)}, ripetute ${fmtPasso(pm - 30)}.`);
    }
    else righe.push("Nessuna gara in programma.");
    const altre = tutte.filter((g) => !obiettivo || g.id !== obiettivo.id).slice(0, 3);
    if (altre.length) righe.push(`Altre gare: ${altre.map(descr).join("; ")}.`);
    const per = ["10", "21", "42"].filter((d) => pb[d] && pb[d].tempo && pb[d].fonte !== "strava").map((d) => `${DIST_LABEL[d]} ${pb[d].tempo}`);
    righe.push(per.length ? `Personali: ${per.join(", ")}.` : "Personali: non indicati.");
    const sc = scarpe.filter((x) => x && !x.strava).slice(0, 6).map((x) => { const st = statoScarpa(x); return `${x.nome} (${TIPO_SCARPA[x.tipo] || x.tipo}): ${Math.round(st.km)} km su ${st.limite} (${Math.round(st.quota * 100)}%, ${st.etichetta})`; });
    righe.push(sc.length ? `Scarpe: ${sc.join("; ")}.` : "Scarpe: non indicate.");
    if (Number(kmSettimana) > 0) righe.push(`Km a settimana: circa ${Math.round(Number(kmSettimana))}.`);
    return righe.join("\n");
  }

  // ---------------------------------------------------------------- classifiche del gruppo (fase 1)
  // I risultati arrivano dal database: solo quelli certificati, con il tempo, di chi partecipa
  // ({ membro_id, membro, mio, data, distanza, secondi, gara_nome, categoria }). Qui si fanno le classifiche.
  /** Sesso dalla categoria FIDAL o di Gare Podistiche Lazio ("SM45", "SF", "PM", "AF"): seconda lettera. */
  function sessoCategoria(cat) { const m = /^[A-Z]([MF])/.exec(String(cat || "").toUpperCase()); return m ? m[1] : ""; }
  /** Posizioni con il pari merito: stessa chiave, stessa posizione (1, 2, 2, 4). */
  function conPosizioni(lista, chiaveFn) {
    let prec = null, pos = 0;
    return lista.map((x, i) => { const k = chiaveFn(x); if (k !== prec) { pos = i + 1; prec = k; } return { ...x, pos }; });
  }
  const perMembro = (risultati) => {
    const m = new Map();
    for (const r of risultati || []) { if (!m.has(r.membro_id)) m.set(r.membro_id, { membro_id: r.membro_id, membro: r.membro, mio: !!r.mio, lista: [] }); m.get(r.membro_id).lista.push(r); }
    return [...m.values()];
  };
  const ordineNome = (a, b) => String(a.membro).localeCompare(String(b.membro), "it");
  /** Gare corse: quante gare concluse nella stagione (anno) o nel mese ("AAAA-MM"). Chi non ne ha non compare. */
  function classificaGareCorse(risultati, { anno, mese } = {}) {
    const dentro = (r) => (mese ? r.data.slice(0, 7) === mese : r.data.slice(0, 4) === String(anno));
    const l = perMembro(risultati).map((m) => ({ membro_id: m.membro_id, membro: m.membro, mio: m.mio, n: m.lista.filter(dentro).length })).filter((x) => x.n > 0);
    return conPosizioni(l.sort((a, b) => b.n - a.n || ordineNome(a, b)), (x) => x.n);
  }
  /** PB della stagione: quante volte nell'anno un atleta migliora il suo miglior tempo certificato precedente sulla stessa
   *  distanza (anche di anni prima). La prima gara su una distanza fissa il riferimento e non conta. A parità vince chi è
   *  migliorato di più in percentuale (somma dei miglioramenti). */
  function classificaPBStagione(risultati, anno) {
    const l = perMembro(risultati).map((m) => {
      let n = 0, perc = 0;
      for (const d of ["10", "21", "42"]) {
        const gare = m.lista.filter((r) => r.distanza === d).sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
        let meglio = null;
        for (const r of gare) {
          if (meglio !== null && r.secondi < meglio && r.data.slice(0, 4) === String(anno)) { n++; perc += ((meglio - r.secondi) / meglio) * 100; }
          if (meglio === null || r.secondi < meglio) meglio = r.secondi;
        }
      }
      return { membro_id: m.membro_id, membro: m.membro, mio: m.mio, n, perc: Math.round(perc * 10) / 10 };
    }).filter((x) => x.n > 0);
    return conPosizioni(l.sort((a, b) => b.n - a.n || b.perc - a.perc || ordineNome(a, b)), (x) => `${x.n}|${x.perc}`);
  }
  /** Albo d'oro: il miglior tempo di sempre di ogni atleta su una distanza, dal più veloce. sesso "M"/"F" filtra con la
   *  categoria della gara (chi non ha categoria compare solo in "tutti"). */
  function alboDoro(risultati, distanza, sesso = "") {
    const l = perMembro((risultati || []).filter((r) => r.distanza === distanza && (!sesso || sessoCategoria(r.categoria) === sesso)))
      .map((m) => { const b = m.lista.reduce((x, y) => (y.secondi < x.secondi || (y.secondi === x.secondi && y.data < x.data) ? y : x)); return { membro_id: m.membro_id, membro: m.membro, mio: m.mio, secondi: b.secondi, data: b.data, gara_nome: b.gara_nome || "", categoria: b.categoria || "" }; });
    return conPosizioni(l.sort((a, b) => a.secondi - b.secondi || (a.data < b.data ? -1 : 1)), (x) => x.secondi);
  }
  /** Record del gruppo per categoria su una distanza: il tempo più veloce di ogni categoria, in ordine di categoria. */
  function recordCategorie(risultati, distanza) {
    const m = new Map();
    for (const r of (risultati || []).filter((x) => x.distanza === distanza && x.categoria)) {
      const c = String(r.categoria).toUpperCase(), b = m.get(c);
      if (!b || r.secondi < b.secondi || (r.secondi === b.secondi && r.data < b.data)) m.set(c, { categoria: c, membro: r.membro, mio: !!r.mio, secondi: r.secondi, data: r.data, gara_nome: r.gara_nome || "" });
    }
    return [...m.values()].sort((a, b) => a.categoria.localeCompare(b.categoria, "it", { numeric: true }));
  }
  /** Le prime n righe e, se sta più giù, la riga dell'atleta (per le schede in Gruppo). */
  function primiETu(lista, n = 3) {
    const io = lista.findIndex((x) => x.mio);
    return { primi: lista.slice(0, n), tu: io >= n ? lista[io] : null };
  }
  /** Recupero della stagione aperto: entro i 30 giorni dall'adesione (recupero_fino dal database). */
  const recuperoAperto = (io, adesso = new Date()) => !!(io && io.partecipa && io.recupero_fino && new Date(io.recupero_fino) >= adesso);
  /** Risultati trovati nelle classifiche che si possono ancora recuperare: tutti nel recupero, poi solo quelli da una
   *  settimana prima dell'adesione. Esclusi quelli già certificati con lo stesso tempo. */
  function daRecuperare(trovati, io, miei = [], adesso = new Date()) {
    const dal = io && io.dal ? addDays(String(io.dal).slice(0, 10), -7) : null;
    const gia = new Set((miei || []).filter((m) => m.stato === "certificato").map((m) => `${m.data}:${m.distanza}:${m.secondi}`));
    return (trovati || []).filter((r) => !gia.has(`${r.data}:${r.distanza}:${r.secondi}`) && (recuperoAperto(io, adesso) || (dal && r.data >= dal)));
  }

  const api = { diffDays, addDays, todayISO, fmtBreve, fmtGiorno, DIST_LABEL, RUOLO_LABEL, fase, vociGara, stato, checklist, adatta, inCasa, kmAlGiorno, scarpaAlVia, personeProposte, tempiUniti, tempiPerDistanza, tempiDellaGara, nomeRisultato, POST_GARA, FINE_GARA, ciclo, dividiGare, ultimoDebrief, gareAttive, pillola, pillolePool, vestizione, descriviMeteo, tipoCielo, avvisiMeteo, perTe, varieta, segnaVisti, ordinaNovita, novitaInEvidenza, sorriso, prossimaUscita, cercaGare, cercaEstero, circuitiDi, benvenutoTop, introEstera, nelMirino, statoScarpa, leggiTempo, tempoDaParti, candidatiPersonali, corsaDellaGara, SEZIONI_GARA, sezioneSwipe, PASSI_PREPARA, passiPrepara, leggiDocumento, contestoBuddy, sessoCategoria, conPosizioni, classificaGareCorse, classificaPBStagione, alboDoro, recordCategorie, primiETu, recuperoAperto, daRecuperare, PASSI_ENTRA, passiEntra, prossimoEntra };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RBLogic = api;
})(typeof self !== "undefined" ? self : this);
