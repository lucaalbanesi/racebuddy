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
  /** Altre distanze (ottobre 2026): una gara di 5-50 km che non è una classica ha "km" (calendario, mie gare, gare
   *  della società) o "km_reali" (risultati) e come "distanza" la classica più vicina, che serve a preparazione e avvisi. */
  const kmAltra = (x) => (x && (x.km || x.km_reali)) || null;
  const fmtKm = (km) => String(Math.round(km * 100) / 100).replace(".", ",");
  /** Etichetta della distanza: "10 km", "Mezza", "Maratona" o, per le altre distanze, i km reali ("19 km", "9,9 km"). */
  const etichettaDist = (x) => (kmAltra(x) ? `${fmtKm(kmAltra(x))} km` : DIST_LABEL[x && x.distanza] || "");
  /** La classica più vicina a quei km, come calendario e funzione tempi (fino a 15,5 km la 10, fino a 31,6 la mezza). */
  const baseKm = (km) => (km < 15.5 ? "10" : km < 31.6 ? "21" : "42");
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
  /** Il giorno della gara, prima delle 12: si può già segnare il tempo quando la gara può essere finita, cioè dalla
   *  partenza più il tempo minimo plausibile (10 km 30 min, mezza 1h05, maratona 2h05, altra distanza 3 min al km).
   *  Senza orario di partenza si conta dalle 7:30. Le 12 restano l'ora del controllo automatico (push "Com'è andata?"). */
  function finitaPrima(g, oggi, ora, partenza) {
    if (!g || g.data !== oggi || !ora) return false;
    const min = (t) => { const m = String(t || "").match(/^(\d{1,2})[:.](\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const via = min(partenza) ?? 7 * 60 + 30, km = kmAltra(g);
    const durata = km ? Math.round(km * 3) : { "10": 30, "21": 65, "42": 125 }[g.distanza] ?? 30;
    return min(ora) >= via + durata;
  }
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
      (nome simile); se una fonte ha una sola persona, quella. MarathonView: l'unica italiana, o l'unica. `tessera` = { codiceSocieta, societa }. */
  const chiaveNome = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\b(a\.?s\.?d\.?|s\.?s\.?d\.?|asd|ssd|ass|associazione|sportiva|dilettantistica|atletica|atl|polisportiva|pol|g\.?s\.?|podistica|team|club)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  function personeProposte(persone, tessera = {}) {
    const cod = String(tessera.codiceSocieta || "").toUpperCase(), soc = chiaveNome(tessera.societa);
    const out = new Set();
    for (const fonte of ["gpl", "fidal"]) {
      const qui = persone.filter((p) => p.fonte === fonte);
      const mia = qui.filter((p) => (fonte === "fidal" && cod && p.codice === cod) || (soc && chiaveNome(p.societa) && (chiaveNome(p.societa).includes(soc) || soc.includes(chiaveNome(p.societa)))));
      (mia.length ? mia : qui.length === 1 ? qui : []).forEach((p) => out.add(p.id));
    }
    // MarathonView (maratone all'estero, senza società): la sola persona di nazionalità italiana, o la sola persona
    const mv = persone.filter((p) => p.fonte === "mview"), ita = mv.filter((p) => p.paese === "ita");
    (ita.length === 1 ? ita : mv.length === 1 ? mv : []).forEach((p) => out.add(p.id));
    return [...out];
  }
  /** I risultati delle persone scelte, senza doppioni (la stessa gara su più fonti: vince Gare Podistiche Lazio, che ha
      il nome della gara, poi FIDAL, poi MarathonView), dalla più recente. */
  const ORDINE_FONTI = ["gpl", "fidal", "mview"];
  function tempiUniti(persone, scelti) {
    const ord = (f) => { const i = ORDINE_FONTI.indexOf(f); return i < 0 ? 9 : i; };
    const tutti = persone.filter((p) => scelti.includes(p.id)).flatMap((p) => p.risultati).sort((a, b) => ord(a.fonte) - ord(b.fonte));
    const visti = new Set(), out = [];
    for (const r of tutti) { const k = `${r.data}:${r.distanza}`; if (visti.has(k)) continue; visti.add(k); out.push(r); }
    return out.sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  }
  /** Fuori misura: percorso vicino alla distanza ma non esatto (km_reali, es. la Corsa di Miguel a 9,9 km). Vale per Gare
   *  corse, punti di arrivo, obiettivo e Borsa Impegno e badge di presenza e Cecchino; mai per personali, PB, Albo d'oro, età. */
  const fuoriMisura = (r) => !!(r && r.km_reali != null);
  const esatte = (l) => (l || []).filter((r) => !fuoriMisura(r));
  /** Per distanza, dal più veloce (solo le esatte: sono i personali). */
  function tempiPerDistanza(risultati) {
    const out = { "10": [], "21": [], "42": [] };
    for (const r of esatte(risultati)) if (out[r.distanza]) out[r.distanza].push(r);
    for (const d of Object.keys(out)) out[d].sort((a, b) => a.secondi - b.secondi);
    return out;
  }
  /** Il tempo di una gara seguita: stesso giorno e stessa distanza. */
  /** Il tempo di una gara seguita: stesso giorno e stessa distanza. Per una classica solo i tempi esatti (un fuori misura
   *  non diventa un personale); per una gara di altra distanza (km) solo quelli di altra distanza con quei km (±1 km). */
  const tempiDellaGara = (risultati, gara) => (gara.km ? (risultati || []).filter((r) => r.km_reali && Math.abs(r.km_reali - gara.km) <= 1) : esatte(risultati))
    .filter((r) => r.data === gara.data && r.distanza === gara.distanza);
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
  const gruppoScarpa = (s) => (s.tipo === "ritmo" || s.tipo === "tempo" ? "ritmo" : "base");
  /** Con quanti km la scarpa arriva al via: { km, limite, come: "gare"|"storia"|"settimana"|"tipico", gare, ok }.
      ctx: { kmSettimana, scarpe (attive), gare (seguite) }. */
  function scarpaAlVia(s, gara, oggi, ctx = {}) {
    const giorni = Math.max(0, diffDays(gara.data, oggi)), lim = Math.max(300, Number(s.limite) || 800);
    let extra, come, nGare = 0;
    if (s.tipo === "gara") {
      const prima = (ctx.gare || []).filter((g) => g.id !== gara.id && g.data >= oggi && g.data < gara.data && !g.archiviata);
      nGare = prima.length; extra = prima.reduce((t, g) => t + (g.km || KM_GARA[g.distanza] || 0), 0); come = "gare";
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
      // "altra" = le gare di altra distanza; le classiche non comprendono quelle con i km (un 16 km non è una mezza)
      .filter((g) => !distanza || (distanza === "altra" ? !!g.km : g.distanza === distanza && !g.km))
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
    // con una gara (oggetto) di altra distanza i limiti vengono dai km reali: passo tra 2:30 e 15:00 al km
    const km = typeof distanza === "object" && distanza ? kmAltra(distanza) : null;
    if (typeof distanza === "object" && distanza) distanza = distanza.distanza;
    const lim = km ? [Math.round(150 * km), Math.round(900 * km)] : LIMITI_TEMPO[distanza];
    const t = String(testo || "").trim().replace(/[.,]/g, ":");
    if (!lim || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return { errore: "Scrivi il tempo come ore:minuti:secondi, es. 1:45:00" };
    const p = t.split(":").map(Number);
    if (p.slice(1).some((x) => x > 59)) return { errore: "Minuti e secondi vanno da 00 a 59" };
    const ok = (s) => s >= lim[0] && s <= lim[1];
    const candidati = p.length === 3 ? [p[0] * 3600 + p[1] * 60 + p[2]] : [p[0] * 60 + p[1], p[0] * 3600 + p[1] * 60];
    const secondi = candidati.find(ok);
    if (secondi == null) return { errore: `Il tempo non sembra giusto per ${km ? `una gara di ${fmtKm(km)} km` : { "10": "un 10 km", "21": "una mezza", "42": "una maratona" }[distanza]}: ricontrollalo` };
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
    // con una gara (oggetto) di altra distanza: le corse entro il 7% dei suoi km
    const km = typeof distanza === "object" && distanza ? kmAltra(distanza) : null, gara = distanza;
    if (typeof distanza === "object" && distanza) distanza = distanza.distanza;
    const ufficiale = km ? km * 1000 : { "10": 10000, "21": 21097, "42": 42195 }[distanza];
    const giusta = (a) => (km ? Math.abs((a.metri || 0) - ufficiale) <= ufficiale * 0.07 : distanzaDi(a.metri || 0) === distanza);
    const giuste = (corse || []).filter((a) => giusta(a) && a.secondi > 0 && leggiTempo(gara, hms(a.secondi)).tempo);
    const scelta = giuste.find((a) => a.gara) || [...giuste].sort((x, y) => Math.abs(x.metri - ufficiale) - Math.abs(y.metri - ufficiale))[0] || null;
    return { scelta: scelta ? { ...scelta, tempo: leggiTempo(gara, hms(scelta.secondi)).tempo } : null, altre: (corse || []).filter((a) => a !== scelta && a.secondi > 0) };
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
   *  Prima quello che si riceve, poi quello che si dà: classifiche, i tuoi tempi (gare fatte), la prossima gara (gare da
   *  correre), le notifiche come scelta dei temi (gara, scadenze, meteo), poi solo i dati che servono ai temi scelti:
   *  scadenze → tessera e certificato, meteo → quando e dove corri. Chi non li vuole li salta e li ritrova in Oggi
   *  (scheda Prepara). Le classifiche ci sono solo se il gruppo le ha accese, i tempi solo se la ricerca è attiva.
   *  x = { classifiche, partecipa, documenti, nonTesserato, tempi, tempiFatti, ora, zona, garaFutura, notifiche, temi, saltati }
   *  temi = { gara, documenti, meteo } dopo la scelta (undefined = non ancora scelto: i passi dei dati restano in lista). */
  const PASSI_ENTRA = [
    { k: "classifiche", titolo: "Le classifiche della stagione", obbligatorio: false },
    { k: "tempi", titolo: "I tuoi tempi dalle classifiche", obbligatorio: false },
    { k: "gara", titolo: "La tua prossima gara", obbligatorio: false },
    { k: "notifiche", titolo: "Cosa vuoi ricevere", obbligatorio: false },
    { k: "documenti", titolo: "Tessera e certificato", obbligatorio: true },
    { k: "uscita", titolo: "Quando e dove corri", obbligatorio: true },
  ];
  function passiEntra(x = {}) {
    const sal = x.saltati || {}, temi = x.temi || null;
    const fatto = {
      classifiche: !!x.partecipa || !!sal.classifiche,
      tempi: !!x.tempiFatti || !!sal.tempi,
      gara: !!x.garaFutura || !!sal.gara,
      notifiche: !!temi || !!x.notifiche || !!sal.notifiche,
      documenti: !!x.documenti || !!x.nonTesserato || !!sal.documenti,
      uscita: (!!x.ora && !!x.zona) || !!sal.uscita,
    };
    // i dati si chiedono solo per i temi scelti (se mancano)
    const serve = { documenti: !temi || !!temi.documenti || fatto.documenti, uscita: !temi || !!temi.meteo || fatto.uscita };
    const passi = PASSI_ENTRA.filter((p) => (p.k !== "classifiche" || x.classifiche) && (p.k !== "tempi" || x.tempi) && serve[p.k] !== false)
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
  const TIPO_SCARPA = { allenamento: "allenamento", ritmo: "ritmo e lunghi", tempo: "tempo", gara: "gara", trail: "trail" };
  function fmtPasso(sec) { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`; }
  function secondiTempo(t) { const p = String(t || "").split(":").map(Number); if (p.length < 2 || p.some((x) => !Number.isFinite(x))) return 0; return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; }
  function contestoBuddy({ oggi, gare = [], fasi, risultati = {}, pb = {}, scarpe = [], kmSettimana = 0 }) {
    const righe = [`Oggi: ${oggi}.`];
    const { tutte, obiettivo } = fasi ? gareAttive(gare, fasi, oggi, risultati) : { tutte: [], obiettivo: null };
    const descr = (g) => {
      const sec = secondiTempo(g.tempo), km = g.km || KM_DIST[g.distanza];
      return `${g.nome} (${etichettaDist(g) || g.distanza}), ${g.data}, tra ${g.mancano} giorni${g.fase && g.fase.nome ? `, fase: ${g.fase.nome}` : ""}${sec && km ? `, tempo obiettivo ${g.tempo} (passo ${fmtPasso(sec / km)})` : ", tempo obiettivo non indicato"}`;
    };
    if (obiettivo) righe.push(`Gara obiettivo: ${descr(obiettivo)}.`);
    // ritmi di riferimento dal passo obiettivo (stime prudenti, per tenere coerenti i numeri del piano)
    const secO = obiettivo ? secondiTempo(obiettivo.tempo) : 0, kmO = obiettivo ? obiettivo.km || KM_DIST[obiettivo.distanza] : 0;
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
  /** I PB della stagione di ogni atleta, uno per evento: su ogni distanza (10, mezza, maratona esatte) ogni gara dell'anno
   *  che batte il suo miglior tempo certificato precedente (anche di anni prima). La prima gara su una distanza fissa il
   *  riferimento e non conta. Ritorna Map membro_id → [{ distanza, data, gara_nome, secondi, prima: {secondi, data,
   *  gara_nome}, perc }], dalla più recente. */
  function pbEventi(risultati, anno) {
    const out = new Map();
    for (const m of perMembro(esatte(risultati))) {
      const ev = [];
      for (const d of ["10", "21", "42"]) {
        const gare = m.lista.filter((r) => r.distanza === d).sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
        let meglio = null;
        for (const r of gare) {
          if (meglio !== null && r.secondi < meglio.secondi && r.data.slice(0, 4) === String(anno))
            ev.push({ distanza: d, data: r.data, gara_nome: r.gara_nome || "", secondi: r.secondi, prima: { secondi: meglio.secondi, data: meglio.data, gara_nome: meglio.gara_nome || "" },
              perc: Math.round(((meglio.secondi - r.secondi) / meglio.secondi) * 1000) / 10 });
          if (meglio === null || r.secondi < meglio.secondi) meglio = r;
        }
      }
      out.set(m.membro_id, ev.sort((a, b) => (a.data < b.data ? 1 : -1)));
    }
    return out;
  }
  /** PB della stagione: quanti PB (pbEventi) nell'anno; a parità vince chi è migliorato di più (somma delle percentuali). */
  function classificaPBStagione(risultati, anno) {
    const ev = pbEventi(risultati, anno);
    const l = perMembro(esatte(risultati)).map((m) => {
      const e = ev.get(m.membro_id) || [], perc = e.reduce((t, x) => t + ((x.prima.secondi - x.secondi) / x.prima.secondi) * 100, 0);
      return { membro_id: m.membro_id, membro: m.membro, mio: m.mio, n: e.length, perc: Math.round(perc * 10) / 10, eventi: e };
    }).filter((x) => x.n > 0);
    return conPosizioni(l.sort((a, b) => b.n - a.n || b.perc - a.perc || ordineNome(a, b)), (x) => `${x.n}|${x.perc}`);
  }
  /** Albo d'oro: il miglior tempo di sempre di ogni atleta su una distanza, dal più veloce. sesso "M"/"F" filtra con la
   *  categoria della gara (chi non ha categoria compare solo in "tutti"). */
  function alboDoro(risultati, distanza, sesso = "") {
    const l = perMembro(esatte(risultati).filter((r) => r.distanza === distanza && (!sesso || sessoCategoria(r.categoria) === sesso)))
      .map((m) => { const b = m.lista.reduce((x, y) => (y.secondi < x.secondi || (y.secondi === x.secondi && y.data < x.data) ? y : x)); return { membro_id: m.membro_id, membro: m.membro, mio: m.mio, secondi: b.secondi, data: b.data, gara_nome: b.gara_nome || "", categoria: b.categoria || "" }; });
    return conPosizioni(l.sort((a, b) => a.secondi - b.secondi || (a.data < b.data ? -1 : 1)), (x) => x.secondi);
  }
  /** Record del gruppo per categoria su una distanza: il tempo più veloce di ogni categoria, in ordine di categoria. */
  function recordCategorie(risultati, distanza) {
    const m = new Map();
    for (const r of esatte(risultati).filter((x) => x.distanza === distanza && x.categoria)) {
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
  /** Dove mostrare "Recupera le gare già corse" in Gruppo: "cima" finché non l'ha fatto, "ultimi" negli ultimi 3 giorni
   *  se non l'ha mai fatto, "discreto" (una riga in Altre classifiche) dopo averlo fatto, null a recupero chiuso.
   *  Fatto = segnato sul telefono, oppure ha già online gare di prima della sua adesione (fatto su un altro telefono). */
  function recuperoInEvidenza(io, miei = [], fattoQui = false, adesso = new Date()) {
    if (!recuperoAperto(io, adesso)) return null;
    const dal = io.dal ? addDays(String(io.dal).slice(0, 10), -7) : null;
    const fatto = fattoQui || (!!dal && (miei || []).some((m) => m.data < dal));
    if (fatto) return "discreto";
    return new Date(io.recupero_fino) - adesso <= 3 * 864e5 ? "ultimi" : "cima";
  }
  function daRecuperare(trovati, io, miei = [], adesso = new Date()) {
    const dal = io && io.dal ? addDays(String(io.dal).slice(0, 10), -7) : null;
    const gia = new Set((miei || []).filter((m) => m.stato === "certificato").map((m) => `${m.data}:${m.distanza}:${m.secondi}`));
    return (trovati || []).filter((r) => !gia.has(`${r.data}:${r.distanza}:${r.secondi}`) && (recuperoAperto(io, adesso) || (dal && r.data >= dal) || fonteAperta(io, r.fonte, adesso)));
  }
  /** Fonti nuove dei tempi (stato_classifiche → io.fonti_nuove: { fonte, nome, cosa, dal, fino }) con il recupero ancora
   *  aperto: per 30 giorni da quando sono accese si recuperano da lì anche le gare degli anni scorsi (come _puo_registrare_fonte). */
  const fontiNuove = (io, adesso = new Date()) => (io && io.partecipa ? (io.fonti_nuove || []).filter((f) => f && f.fonte && f.fino && new Date(f.fino) >= adesso) : []);
  const fonteAperta = (io, fonte, adesso = new Date()) => !!fonte && fontiNuove(io, adesso).some((f) => f.fonte === fonte);
  /** Scheda "Nuove fonti per le gare" in Gruppo: le fonti nuove aperte che il runner non ha ancora usato per il recupero
   *  (viste = { fonte: giorno }, sul telefono), anche durante il suo recupero personale. null se non c'è niente da dire;
   *  ultimi = mancano 3 giorni o meno alla prima che chiude. */
  function nuoveFontiInEvidenza(io, viste = {}, adesso = new Date()) {
    const fonti = fontiNuove(io, adesso).filter((f) => !(viste || {})[f.fonte]);
    if (!fonti.length) return null;
    const fino = fonti.map((f) => f.fino).sort()[0];
    return { fonti, fino, ultimi: new Date(fino) - adesso <= 3 * 864e5 };
  }

  // ---------------------------------------------------------------- stagione (fase 2): Impegno, Obiettivo, età, badge
  // Dati da stato_stagione: gare della società, obiettivi e borse (degli altri solo a gara iniziata), inviti, età.
  const PUNTI = { arrivo: 50, pb: 40, obiettivo: 30, borsa: 20, socio: 30 };
  const CENTRATO = 1; // scarto massimo in % per dire "obiettivo centrato"
  const chiaveGara = (m, d, dist) => `${m}|${d}|${dist}`;
  /** Scarto dall'obiettivo in %, in più o in meno. */
  const scartoObiettivo = (secondi, obiettivo) => (obiettivo > 0 && secondi > 0 ? (Math.abs(secondi - obiettivo) / obiettivo) * 100 : null);
  /** La gara della società di quella data e distanza, se c'è. */
  const garaDellaSocieta = (gareSoc, data, distanza) => (gareSoc || []).find((s) => s.data === data && s.distanza === distanza) || null;
  /** Bollino in Gare: la gara della società che corrisponde a questa gara del calendario o delle mie. Se il direttivo
   *  l'ha scelta dal calendario (gara_id) vale solo quella; aggiunta a mano (senza gara_id) servono stessa data, distanza
   *  e una parola del nome in comune (almeno 4 lettere), così non si accendono le altre gare d'Italia di quel giorno.
   *  Una mia gara inserita a mano (id "M…") vale per stessa data e distanza. */
  const paroleNome = (n) => new Set(String(n || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z]+/).filter((w) => w.length >= 4));
  const garaSocDi = (gareSoc, g) => (g && (gareSoc || []).find((s) => {
    if (s.data !== g.data || s.distanza !== g.distanza) return false;
    if (s.gara_id === g.id || String(g.id || "").startsWith("M")) return true;
    if (s.gara_id || !s.km !== !g.km) return false; // a mano: una mezza non è la gara di 19 km dello stesso giorno
    const a = paroleNome(s.nome); return [...paroleNome(g.nome)].some((w) => a.has(w));
  })) || null;
  /** L'obiettivo è ancora modificabile online: fino alla mezzanotte del giorno della gara (ora del telefono). */
  const obiettivoAperto = (data, adesso = new Date()) => todayISO(adesso) < data;
  /** Tutti gli eventi che fanno punti Impegno, per membro: solo nelle gare della società (arrivo, nuovo personale, obiettivo
   *  centrato, Borsa pronta) più i nuovi soci (alla data del loro primo risultato certificato). Il personale è "nuovo" se
   *  batte il miglior tempo certificato precedente sulla stessa distanza, in qualunque gara; la prima volta non conta.
   *  La Borsa conta solo se poi si arriva. */
  function eventiPunti({ risultati, gareSoc, obiettivi, borse, inviti } = {}) {
    const ob = new Map((obiettivi || []).map((o) => [chiaveGara(o.membro_id, o.data, o.distanza), o.secondi]));
    const bo = new Set((borse || []).map((b) => chiaveGara(b.membro_id, b.data, b.distanza)));
    const ord = [...(risultati || [])].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
    const meglio = new Map(), primo = new Map(), out = [];
    for (const r of ord) {
      if (!primo.has(r.membro_id)) primo.set(r.membro_id, r.data);
      const km = `${r.membro_id}|${r.distanza}`, prima = meglio.get(km), s = garaDellaSocieta(gareSoc, r.data, r.distanza);
      if (s) {
        const ev = (tipo) => out.push({ membro_id: r.membro_id, data: r.data, distanza: r.distanza, tipo, punti: PUNTI[tipo], gara: s.nome, risultato_id: r.id });
        ev("arrivo");
        const fm = fuoriMisura(r); // fuori misura: arrivo, obiettivo e Borsa (non il personale)
        if (!fm && prima != null && r.secondi < prima) ev("pb");
        const o = ob.get(chiaveGara(r.membro_id, r.data, r.distanza));
        if (o && scartoObiettivo(r.secondi, o) <= CENTRATO) ev("obiettivo");
        if (bo.has(chiaveGara(r.membro_id, r.data, r.distanza))) ev("borsa");
      }
      if (!fuoriMisura(r) && (prima == null || r.secondi < prima)) meglio.set(km, r.secondi);
    }
    for (const i of inviti || []) {
      const d = primo.get(i.invitato_id);
      if (d && i.invitante_id) out.push({ membro_id: i.invitante_id, data: d, tipo: "socio", punti: PUNTI.socio, invitato_id: i.invitato_id });
    }
    return out;
  }
  const nelPeriodo = (data, { anno, mese } = {}) => (mese ? data.slice(0, 7) === mese : anno ? data.slice(0, 4) === String(anno) : true);
  /** Classifica Impegno: somma dei punti nel periodo (anno o mese "AAAA-MM"). nomi = { id: nome }, io = il mio id.
   *  Ogni riga: punti, gare (arrivi in gare della società) e il dettaglio per tipo. Chi ha zero punti non compare. */
  function classificaImpegno(eventi, { anno, mese, nomi = {}, io } = {}) {
    const m = new Map();
    for (const e of eventi || []) {
      if (!nelPeriodo(e.data, { anno, mese }) || !(e.membro_id in nomi)) continue;
      if (!m.has(e.membro_id)) m.set(e.membro_id, { membro_id: e.membro_id, membro: nomi[e.membro_id], mio: e.membro_id === io, punti: 0, gare: 0,
        dettaglio: { arrivo: 0, pb: 0, obiettivo: 0, borsa: 0, socio: 0 } });
      const x = m.get(e.membro_id);
      x.punti += e.punti; x.dettaglio[e.tipo]++; if (e.tipo === "arrivo") x.gare++;
    }
    const l = [...m.values()].sort((a, b) => b.punti - a.punti || String(a.membro).localeCompare(String(b.membro), "it"));
    return conPosizioni(l, (x) => x.punti);
  }
  /** Punti di carriera: tutti gli eventi di un membro, di ogni stagione. */
  const puntiCarriera = (eventi, id) => (eventi || []).filter((e) => e.membro_id === id).reduce((s, e) => s + e.punti, 0);
  const LIVELLI = [["Esordiente", 0], ["Promessa", 300], ["Titolare", 1000], ["Veterano", 2500], ["Leggenda", 5000]];
  /** Livello atleta dai punti di carriera: nome, prossimo livello e quota della strada (0-1). */
  function livello(punti) {
    let i = 0;
    while (i + 1 < LIVELLI.length && punti >= LIVELLI[i + 1][1]) i++;
    const [nome, soglia] = LIVELLI[i], prox = LIVELLI[i + 1];
    return { nome, soglia, prossimo: prox ? prox[0] : null, prossimaSoglia: prox ? prox[1] : null, quota: prox ? (punti - soglia) / (prox[1] - soglia) : 1 };
  }
  /** Obiettivo centrato: per ogni gara certificata con un obiettivo, lo scarto. lista = chi ha almeno 3 gare, dallo scarto
   *  medio più basso (a parità, più gare); quasi = chi ne ha 1 o 2, con quante mancano. */
  function classificaObiettivo({ risultati, obiettivi } = {}, { anno, nomi = {}, io } = {}) {
    const ob = new Map((obiettivi || []).map((o) => [chiaveGara(o.membro_id, o.data, o.distanza), o.secondi]));
    const m = new Map();
    for (const r of risultati || []) { // anche le gare di altra distanza: lo scarto è sul tempo, con l'obiettivo fissato su quella gara
      const o = ob.get(chiaveGara(r.membro_id, r.data, r.distanza));
      if (!o || !nelPeriodo(r.data, { anno }) || !(r.membro_id in nomi)) continue;
      if (!m.has(r.membro_id)) m.set(r.membro_id, { membro_id: r.membro_id, membro: nomi[r.membro_id], mio: r.membro_id === io, scarti: [] });
      m.get(r.membro_id).scarti.push(scartoObiettivo(r.secondi, o));
    }
    const tutti = [...m.values()].map((x) => ({ ...x, n: x.scarti.length, centrate: x.scarti.filter((s) => s <= CENTRATO).length,
      media: Math.round((x.scarti.reduce((a, b) => a + b, 0) / x.scarti.length) * 10) / 10 }));
    const lista = tutti.filter((x) => x.n >= 3).sort((a, b) => a.media - b.media || b.n - a.n || String(a.membro).localeCompare(String(b.membro), "it"));
    const quasi = tutti.filter((x) => x.n < 3).map((x) => ({ ...x, mancano: 3 - x.n })).sort((a, b) => a.mancano - b.mancano || String(a.membro).localeCompare(String(b.membro), "it"));
    return { lista: conPosizioni(lista, (x) => `${x.media}|${x.n}`), quasi };
  }
  /** Albo d'oro per età: la percentuale migliore di ognuno su una distanza ("tutte" = la migliore su qualunque distanza).
   *  sesso "M"/"F" filtra col sesso usato per le tabelle. */
  function alboEta(risultati, distanza, sesso = "") {
    const l = new Map();
    for (const r of esatte(risultati)) {
      if (r.ag == null || (distanza !== "tutte" && r.distanza !== distanza) || (sesso && r.sesso_ag !== sesso)) continue;
      const b = l.get(r.membro_id);
      if (!b || r.ag > b.ag || (r.ag === b.ag && r.data < b.data)) l.set(r.membro_id, r);
    }
    const lista = [...l.values()].map((r) => ({ membro_id: r.membro_id, membro: r.membro, mio: !!r.mio, ag: r.ag, circa: !!r.circa, secondi: r.secondi,
      data: r.data, distanza: r.distanza, gara_nome: r.gara_nome || "", categoria: r.categoria || "" }));
    return conPosizioni(lista.sort((a, b) => b.ag - a.ag || (a.data < b.data ? -1 : 1)), (x) => x.ag);
  }
  /** Miglioramento sul miglior tempo dei 12 mesi prima, stessa distanza (positivo = più veloce); null se non c'è. */
  function miglioramento12(miei, r) {
    if (fuoriMisura(r)) return null;
    const dal = addDays(r.data, -365);
    const prima = esatte(miei).filter((x) => x.distanza === r.distanza && x.data < r.data && x.data >= dal && x.secondi > 0);
    if (!prima.length) return null;
    const best = Math.min(...prima.map((x) => x.secondi));
    return Math.round(((best - r.secondi) / best) * 1000) / 10;
  }
  const NOMI_DIST = { "10": "la 10 km", "21": "la mezza", "42": "la maratona" };
  /** I 13 badge di un atleta. miei = i suoi risultati certificati (con ag se c'è), obiettivi e borse = i suoi,
   *  soci = nuovi soci portati, record = primo in un Albo d'oro. Ognuno: k, nome, cosa, preso, progresso. */
  function badgeAtleta({ miei = [], gareSoc = [], obiettivi = [], borse = [], soci = 0, record = false, oggi } = {}) {
    oggi = oggi || todayISO();
    const ord = [...miei].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0)), es = esatte(ord);
    // le distanze (prima 10 km, mezza, maratona, tris) vogliono la misura esatta; presenze, obiettivi e borse no
    const ha = (d) => es.some((r) => r.distanza === d);
    const anni = [...new Set(es.map((r) => r.data.slice(0, 4)))];
    const tris = anni.some((a) => ["10", "21", "42"].every((d) => es.some((r) => r.distanza === d && r.data.startsWith(a))));
    const mancaQuest = ["10", "21", "42"].filter((d) => !es.some((r) => r.distanza === d && r.data.startsWith(oggi.slice(0, 4))));
    const ob = new Map(obiettivi.map((o) => [`${o.data}|${o.distanza}`, o.secondi]));
    let fila = 0, maxFila = 0;
    for (const r of ord) { const o = ob.get(`${r.data}|${r.distanza}`); if (!o) continue; fila = scartoObiettivo(r.secondi, o) <= CENTRATO ? fila + 1 : 0; maxFila = Math.max(maxFila, fila); }
    const bs = new Set(borse.map((b) => `${b.data}|${b.distanza}`));
    const nBorse = ord.filter((r) => bs.has(`${r.data}|${r.distanza}`)).length;
    const mesi = [...new Set(ord.map((r) => r.data.slice(0, 7)))].sort();
    let mf = 0, mMax = 0, prec = null;
    for (const m of mesi) { const succ = prec && addDays(`${prec}-15`, 31).slice(0, 7) === m; mf = succ ? mf + 1 : 1; mMax = Math.max(mMax, mf); prec = m; }
    const socAnno = (a) => gareSoc.filter((s) => s.data.startsWith(a));
    const corseSoc = (a) => socAnno(a).filter((s) => ord.some((r) => r.data === s.data && r.distanza === s.distanza)).length;
    const fedele = anni.some((a) => socAnno(a).length >= 3 && corseSoc(a) === socAnno(a).length);
    const annoOra = oggi.slice(0, 4), agMax = Math.max(0, ...es.map((r) => r.ag || 0));
    const b = (k, nome, cosa, preso, progresso = "") => ({ k, nome, cosa, preso: !!preso, progresso: preso ? "" : progresso });
    return [
      b("prima10", "Prima 10 km", "Una 10 km certificata", ha("10")),
      b("prima21", "Prima mezza", "Una mezza certificata", ha("21")),
      b("prima42", "Prima maratona", "Una maratona certificata", ha("42")),
      b("tris", "Tris", "10 km, mezza e maratona nello stesso anno", tris,
        mancaQuest.length === 1 ? `manca ${NOMI_DIST[mancaQuest[0]]} nel ${annoOra}` : `ne mancano ${mancaQuest.length} nel ${annoOra}`),
      b("cecchino", "Cecchino", "3 obiettivi centrati di fila", maxFila >= 3, `${fila} di 3 di fila`),
      b("borsa5", "Borsa di bronzo", "Borsa pronta alla vigilia in 5 gare", nBorse >= 5, `${nBorse} di 5`),
      b("borsa10", "Borsa d'argento", "Borsa pronta alla vigilia in 10 gare", nBorse >= 10, `${nBorse} di 10`),
      b("borsa20", "Borsa d'oro", "Borsa pronta alla vigilia in 20 gare", nBorse >= 20, `${nBorse} di 20`),
      b("mesi6", "Sempre in gara", "Almeno una gara al mese per 6 mesi di fila", mMax >= 6, `${mf} ${mf === 1 ? "mese" : "mesi"} di fila`),
      b("fedele", "Fedelissimo", "Tutte le gare della società di una stagione", fedele, `${corseSoc(annoOra)} di ${socAnno(annoOra).length} gare della società`),
      b("chioccia", "Chioccia", "3 nuovi soci portati nel gruppo", soci >= 3, `${soci} di 3 nuovi soci`),
      b("record", "Record di società", "Primo nell'Albo d'oro, assoluto o per età", record, "primo nell'Albo d'oro"),
      b("oltre70", "Oltre il 70%", "Una gara al 70% per età", agMax >= 70, agMax ? `meglio finora ${String(agMax).replace(".", ",")}%` : "serve un tempo certificato"),
    ];
  }

  /** Si può ancora mandare un tempo per una gara di questa data (come _puo_registrare nel database): mai oltre domani;
   *  nei 30 giorni del recupero qualsiasi gara passata, poi solo da 7 giorni prima dell'adesione in avanti. */
  function registrabile(io, data, oggiISO, adesso = new Date()) {
    if (!io || !io.partecipa || !io.dal || !data || data > addDays(oggiISO, 1)) return false;
    return recuperoAperto(io, adesso) || data >= addDays(String(io.dal).slice(0, 10), -7);
  }
  const ESITO_LABEL = { ritirato: "Ritirato", non_partito: "Non partito", annullata: "Annullata" };
  /** Le mie gare per le classifiche: quelle online (miei, da stato_classifiche) e quelle corse nell'app ma non ancora
   *  online (10 km, mezza e maratona fino a oggi), dalla più recente. stato:
   *  conta (certificata nella stagione) · storico (certificata negli anni prima: Albo d'oro e PB) · attesa (dal referente) ·
   *  rifiutato · esito (ritirato, non partito, annullata) · locale (nell'app, non certificata) · vecchia (nell'app, ma
   *  prima dell'adesione: non si può più mandare). gid = id della gara nell'app, se c'è. */
  function mieGareClassifica(miei, gare, risultati, { oggi, io, adesso = new Date() } = {}) {
    const anno = String(oggi || todayISO()).slice(0, 4), chiave = (d, dist) => `${d}:${dist}`;
    const locali = new Map();
    for (const g of gare || []) if (g && ["10", "21", "42"].includes(g.distanza) && g.data && g.data <= oggi) locali.set(chiave(g.data, g.distanza), g);
    const online = new Set(), out = [];
    for (const m of miei || []) {
      const k = chiave(m.data, m.distanza), g = locali.get(k);
      online.add(k);
      const stato = statoOnline(m, anno);
      out.push({ chiave: k, id: m.id, gid: g ? g.id : null, data: m.data, distanza: m.distanza, nome: m.gara_nome || (g && g.nome) || "",
        secondi: m.secondi || null, fonte: m.fonte, nota: m.nota || "", esito: m.esito, stato, luogo: (g && g.luogo) || "", km_reali: m.km_reali ?? null });
    }
    for (const [k, g] of locali) {
      if (online.has(k)) continue;
      const r = (risultati || {})[g.id] || {};
      const stato = g.esito ? "esito" : registrabile(io, g.data, oggi, adesso) ? "locale" : "vecchia";
      out.push({ chiave: k, id: null, gid: g.id, data: g.data, distanza: g.distanza, nome: g.nome || "", secondi: g.esito ? null : r.secondi || null,
        fonte: null, nota: "", esito: g.esito || "arrivato", stato, luogo: g.luogo || "" });
    }
    return out.sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  }
  /** Stato di un risultato online per l'elenco: conta (certificato nella stagione) · storico · attesa · rifiutato · esito. */
  const statoOnline = (m, anno) => m.stato === "certificato" ? (m.data.slice(0, 4) === anno ? "conta" : "storico")
    : m.stato === "in_approvazione" ? "attesa" : m.stato === "rifiutato" ? "rifiutato" : "esito";
  /** Le gare di tutti (per l'amministratore, da gare_membri): ogni risultato online di ogni membro, in ogni stato,
   *  con lo stesso formato di mieGareClassifica più membro, membro_id, link e chi ha deciso. Dalla più recente. */
  function gareMembri(risultati, { oggi } = {}) {
    const anno = String(oggi || todayISO()).slice(0, 4);
    return (risultati || []).map((m) => ({ chiave: `${m.membro_id}:${m.data}:${m.distanza}`, id: m.id, gid: null, data: m.data, distanza: m.distanza,
      nome: m.gara_nome || "", secondi: m.secondi || null, fonte: m.fonte, nota: m.nota || "", esito: m.esito || "arrivato", stato: statoOnline(m, anno),
      luogo: "", membro: m.membro || "", membro_id: m.membro_id, mio: !!m.mio, link: m.link || "", deciso_da: m.deciso_da || "", categoria: m.categoria || "", km_reali: m.km_reali ?? null }))
      .sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  }
  /** Un riepilogo per membro (tutti i membri del gruppo, anche chi non partecipa): quante gare per stato nella stagione
   *  e quante in tutto. Prima chi ha qualcosa da decidere, poi per nome. */
  function riepilogoMembri(membri, righe, { oggi } = {}) {
    const anno = String(oggi || todayISO()).slice(0, 4);
    return (membri || []).map((m) => {
      const sue = (righe || []).filter((x) => x.membro_id === m.id);
      return { id: m.id, nome: m.nome, partecipa: !!m.partecipa, mio: !!m.mio, tutte: sue.length,
        n: riepilogoMie(sue.filter((x) => x.data.slice(0, 4) === anno || x.stato === "attesa")) };
    }).sort((a, b) => (b.n.attesa > 0) - (a.n.attesa > 0) || b.partecipa - a.partecipa || String(a.nome).localeCompare(String(b.nome), "it"));
  }
  const STATO_MIE = { conta: "conta", storico: "albo e pb", attesa: "in approvazione", rifiutato: "non approvata", esito: "senza tempo", locale: "non certificata", vecchia: "fuori tempo" };
  const MESI_LUNGHI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  const senzaAccenti = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  /** Ricerca tra le mie gare: periodo "stagione" (anno di oggi) o "tutte"; ogni parola deve trovarsi nel nome, nella
   *  distanza ("mezza", "10 km"), nella data ("18 ott", "ottobre", "2025") o nello stato ("conta", "in approvazione"). */
  function cercaMieGare(lista, q, { periodo = "stagione", oggi } = {}) {
    const anno = String(oggi || todayISO()).slice(0, 4), parole = senzaAccenti(q).split(/\s+/).filter(Boolean);
    return (lista || []).filter((x) => {
      if (periodo !== "tutte" && x.data.slice(0, 4) !== anno) return false;
      if (!parole.length) return true;
      const testo = senzaAccenti([x.nome, x.luogo, x.membro || "", etichettaDist(x), x.distanza === "42" ? "42 km" : x.distanza === "21" ? "21 km" : "", fmtBreve(x.data), MESI_LUNGHI[Number(x.data.slice(5, 7)) - 1], x.data.slice(0, 4),
        STATO_MIE[x.stato], ESITO_LABEL[x.esito] || ""].join(" "));
      return parole.every((p) => testo.includes(p));
    });
  }
  /** Quante gare per stato, per il riepilogo in cima. */
  function riepilogoMie(lista) {
    const n = { conta: 0, storico: 0, attesa: 0, rifiutato: 0, esito: 0, locale: 0, vecchia: 0 };
    for (const x of lista || []) n[x.stato]++;
    return n;
  }


  // ------------------------------------------------------------------ Scarpiera (rotazione e piano d'acquisto delle scarpe)
  // Specifica in docs/scarpiera.md. Tutto sul telefono: ctx = { oggi, peso, scarpe: [{ id, nome, t, km, max }],
  // wk: { F, V } (km a settimana di facile e veloce), mix: { LF|R|G: { n, km } } (weekend del mese, n che sommano 4),
  // gare: [{ id, nome, data, km }] (gare obiettivo future) }. Tipi: DA daily, ST super-trainer, TE tempo, GA gara.
  const SC_TIPI = { DA: "Daily", ST: "Super-trainer", TE: "Tempo", GA: "Gara" };
  const SC_TK = ["DA", "ST", "TE", "GA"];
  const SC_DA_APP = { allenamento: "DA", ritmo: "ST", tempo: "TE", gara: "GA" }; // trail: fuori dalla rotazione
  const SC_A_APP = { DA: "allenamento", ST: "ritmo", TE: "tempo", GA: "gara" };
  const SC_BASE = { DA: 800, ST: 750, TE: 575, GA: 340 };
  const SC_PREZZO = { DA: 110, ST: 150, TE: 100, GA: 150 }; // prezzi tipici in sconto (Runnea, ottobre 2026)
  const SC_RUOLI = { F: "Facile", LF: "Lungo facile", V: "Veloce / qualità", R: "Lunghissimo / ritmo gara", G: "Gara" };
  const SC_RK = ["F", "LF", "V", "R", "G"];
  // priorità tipo × uscita: p = ordine di scelta, ok = ideale (0 = ripiego); assente = mai
  const SC_MX = {
    F: { DA: { p: 1, ok: 1 }, ST: { p: 2, ok: 0 } },
    LF: { DA: { p: 1, ok: 1 }, ST: { p: 2, ok: 1 }, TE: { p: 3, ok: 0 } },
    V: { TE: { p: 1, ok: 1 }, ST: { p: 2, ok: 1 }, GA: { p: 3, ok: 0 }, DA: { p: 4, ok: 0 } },
    R: { ST: { p: 1, ok: 1 }, TE: { p: 2, ok: 1 }, GA: { p: 3, ok: 1 }, DA: { p: 4, ok: 0 } },
    G: { GA: { p: 1, ok: 1 }, TE: { p: 2, ok: 1 }, ST: { p: 3, ok: 0 }, DA: { p: 4, ok: 0 } },
  };
  const SC_MXM = { GA: { p: 1, ok: 1 }, ST: { p: 2, ok: 1 }, TE: { p: 3, ok: 0 } }; // gare da 30 km in su
  const SC_SOGLIA = { F: 1, LF: 0.9, V: 0.8, R: 0.8, G: 0.8 };
  const scSoglia = (r, t) => (t === "GA" ? 1 : SC_SOGLIA[r]);
  const RODAGGIO = 40;
  const RODAGGIO_GARA = 20; // km minimi prima di correrci una gara

  /** Durata stimata in km per tipo e peso: -0,87% per ogni kg sopra i 70 (al massimo -25%), arrotondata a 10. */
  const scDurata = (t, peso) => { const f = !peso || peso <= 70 ? 1 : Math.max(0.75, 1 - (peso - 70) * 0.0087); return Math.round((SC_BASE[t] || 700) * f / 10) * 10; };
  /** Primo lunedì da oggi (oggi stesso se è lunedì): la settimana 0 del piano. */
  const scInizio = (oggi) => { const dow = new Date(toUTC(oggi)).getUTCDay(); return addDays(oggi, (8 - dow) % 7); };
  const scSettimana = (ctx, data) => Math.floor(diffDays(data, scInizio(ctx.oggi)) / 7);
  const scData = (ctx, w) => addDays(scInizio(ctx.oggi), w * 7);
  /** Settimane del piano: fino a 6 dopo l'ultima gara obiettivo, minimo 20, massimo 52. */
  const scOrizzonte = (ctx) => { const ws = (ctx.gare || []).map((g) => scSettimana(ctx, g.data)).filter((w) => w >= 0); return Math.min(52, Math.max(20, (ws.length ? Math.max(...ws) : 0) + 6)); };
  /** Ciclo dei 4 weekend del mese: lunghissimi alternati a lunghi facili e gare. */
  function scWeekend(mix) {
    const o = [];
    for (let i = 0; i < (mix.LF.n || 0); i++) o.push("LF");
    for (let i = 0; i < (mix.G.n || 0); i++) o.push("G");
    let x = mix.R.n || 0; const a = [];
    for (let i = 0; i < 4; i++) { if (x > 0 && (i % 2 === 0 || !o.length)) { a.push("R"); x--; } else if (o.length) a.push(o.shift()); else { a.push(x > 0 ? "R" : "LF"); x--; } }
    return a;
  }
  /** Uscite di una settimana: [[ruolo, km, gara?]]. Settimana di gara lunga: scarico prima, recupero dopo. */
  function scUscite(ctx, w, ciclo) {
    const F = Number(ctx.wk.F) || 0, V = Number(ctx.wk.V) || 0, gare = ctx.gare || [], lunghe = gare.filter((g) => g.km >= 21);
    const gara = gare.find((g) => scSettimana(ctx, g.data) === w);
    if (gara && gara.km >= 21) return { tipo: "gara", u: [["F", Math.round(F * 0.6)], ["V", Math.round(V * 0.5)], ["G", Number(gara.km), gara]] };
    if (lunghe.some((g) => scSettimana(ctx, g.data) === w + 1)) return { tipo: "scarico", u: [["F", Math.round(F * 0.8)], ["V", Math.round(V * 0.7)], ["LF", Math.min(14, ctx.mix.LF.km || 14)]] };
    if (lunghe.some((g) => scSettimana(ctx, g.data) === w - 1)) return { tipo: "recupero", u: [["F", Math.round(F * 0.7)]] };
    const u = [["F", F], ["V", V]];
    if (gara) u.push(["G", Number(gara.km), gara]); else { const k = ciclo[w % 4]; if (ctx.mix[k] && ctx.mix[k].km) u.push([k, Number(ctx.mix[k].km)]); }
    return { tipo: "normale", u: u.filter((x) => x[1] > 0) };
  }
  /** Simula settimana per settimana chi fa cosa. piano = acquisti [{ t, w }]. */
  function scSimula(ctx, piano = [], H0) {
    const S = (ctx.scarpe || []).filter((s) => SC_TIPI[s.t]).map((s) => ({ id: s.id, nome: s.nome, t: s.t, km: Number(s.km) || 0, km0: Number(s.km) || 0, max: Number(s.max) || scDurata(s.t, ctx.peso), da: 0, nuova: false, ruoli: new Set(), soglie: {}, ultimo: -1, ultIdeale: -1, ultQ: -1, ultF: -1, fine: null }));
    piano.forEach((p, i) => S.push({ id: "n" + i, nome: SC_TIPI[p.t] + " nuova", t: p.t, km: 0, km0: 0, max: scDurata(p.t, ctx.peso), da: p.w, nuova: true, ruoli: new Set(), soglie: {}, ultimo: -1, ultIdeale: -1, ultQ: -1, ultF: -1, fine: null }));
    const ciclo = scWeekend(ctx.mix), H = H0 || scOrizzonte(ctx), griglia = [], ripieghi = [], scoperte = [], eventi = [], gare = [];
    for (let w = 0; w < H; w++) {
      const cella = {};
      for (const [r, k, gara] of scUscite(ctx, w, ciclo).u) {
        const mar = r === "G" && gara && gara.km >= 30, mx = mar ? SC_MXM : SC_MX[r];
        const c = S.filter((s) => s.da <= w && s.fine == null && mx[s.t] && s.km / s.max < scSoglia(r, s.t) && !(r === "G" && s.km < RODAGGIO_GARA) && !((r === "V" || r === "R") && s.t === "GA" && s.km / s.max >= 0.3));
        // fine corsa: il super-trainer uscito dalla qualità finisce la vita sui facili
        const fineCorsa = (s) => r === "F" && s.t === "ST" && s.km / s.max >= SC_SOGLIA.V;
        const rimasti = (s) => SC_RK.filter((rr) => SC_MX[rr][s.t] && SC_MX[rr][s.t].ok && s.km / s.max < scSoglia(rr, s.t)).length + (s.t === "ST" && s.km / s.max >= SC_SOGLIA.V ? 1 : 0);
        // in allenamento una scarpa ferma da 2 settimane passa davanti: la rotazione non parcheggia nessuno
        const ultima = (s) => Math.max(s.ultimo, s.da - 1), ferme = (l) => l.filter((s) => ultima(s) < w - 2).sort((a, b) => ultima(a) - ultima(b));
        const scegli = (l) => {
          if (r === "F" || r === "LF") { const rod = l.filter((s) => s.km < RODAGGIO); if (rod.length) return rod[0]; if (ferme(l).length) return ferme(l)[0]; return l.slice().sort((a, b) => rimasti(a) - rimasti(b) || b.km / b.max - a.km / a.max)[0]; }
          const rod = l.filter((s) => s.nuova && s.km < RODAGGIO && (s.t === "GA" || s.t === "TE")); if (rod.length && (r === "V" || r === "R")) return rod[0];
          if (r !== "G" && ferme(l).length) return ferme(l)[0];
          const fresca = r === "G"; // in gara la più fresca, in allenamento si finisce prima la più usata
          return l.slice().sort((a, b) => mx[a.t].p - mx[b.t].p || (fresca ? a.km / a.max - b.km / b.max : b.km / b.max - a.km / a.max))[0];
        };
        const ok = c.filter((s) => mx[s.t].ok || fineCorsa(s)), rip = c.filter((s) => !mx[s.t].ok && !fineCorsa(s));
        let s;
        if (ok.length) { s = scegli(ok); s.ultIdeale = w; if (r === "F" || r === "LF") s.ultF = w; else s.ultQ = w; }
        else if (rip.length) { s = scegli(rip); ripieghi.push({ w, r, mar, scarpa: s.nome, km: k }); }
        else { scoperte.push({ w, r, mar, km: k }); continue; }
        const prima = s.km / s.max;
        if (gara) gare.push({ gara, w, scarpa: s.nome, id: s.id, km: Math.round(s.km), ok: !!mx[s.t].ok });
        s.km += k; s.ultimo = w; s.ruoli.add(r); cella[s.id] = cella[s.id] || {}; cella[s.id][r] = (cella[s.id][r] || 0) + k;
        for (const rr of s.ruoli) if (scSoglia(rr, s.t) < 1 && prima < scSoglia(rr, s.t) && s.km / s.max >= scSoglia(rr, s.t) && !s.soglie[rr]) { s.soglie[rr] = 1; eventi.push({ w, tipo: "lascia", scarpa: s.nome, r: rr, km: Math.round(s.km) }); }
        if (s.km >= s.max && s.fine == null) { s.fine = w; eventi.push({ w, tipo: "fine", scarpa: s.nome, km: s.max }); }
      }
      griglia.push(cella);
    }
    return { S, griglia, ripieghi, scoperte, eventi, gare, H };
  }
  function scTipoPer(t, set) {
    const mx = t.mar ? SC_MXM : SC_MX[t.r], ordine = Object.keys(mx).sort((a, b) => mx[a].p - mx[b].p);
    let tipo = ordine.find((k) => mx[k].ok && set.includes(k)); if (tipo) return { tipo };
    if (!t.urgente) return null;
    tipo = ordine.find((k) => set.includes(k)); return tipo ? { tipo } : { tipo: ordine.find((k) => mx[k].ok), fuoriSet: true };
  }
  // un tipo del set che manca (o una seconda scarpa voluta): quando serve davvero
  function scMancanti(sim, piano, set, qty) {
    const out = [];
    for (const t of set) {
      const q = qty[t] || 1, primo = piano.filter((p) => p.t === t).reduce((m, p) => Math.min(m, p.w), 999), mia = sim.S.some((s) => s.t === t && !s.nuova);
      if (!mia && primo === 999) {
        const ideali = SC_RK.filter((r) => SC_MX[r][t] && SC_MX[r][t].ok); let meglio = null;
        [...sim.scoperte, ...sim.ripieghi].filter((f) => !piano.some((p) => { const mx = f.mar ? SC_MXM : SC_MX[f.r]; return mx[p.t] && mx[p.t].ok && p.w <= f.w && p.w >= f.w - 6; }))
          .forEach((f) => { if ((ideali.includes(f.r) || (f.mar && SC_MXM[t] && SC_MXM[t].ok)) && (!meglio || f.w < meglio.w)) meglio = { w: f.w, r: f.r, mar: f.mar }; });
        if (meglio) out.push({ ...meglio, qt: t, urgente: false, presenza: true });
        continue;
      }
      for (let w = mia ? 0 : primo; w < sim.H; w++) {
        const n = sim.S.filter((s) => s.t === t && s.da <= w && (s.fine == null || s.fine > w)).length;
        if (n < q) { out.push(q === 1 ? { w, qt: t, urgente: false, presenza: true, r: SC_RK.find((r) => SC_MX[r][t] && SC_MX[r][t].p === 1) } : { w, qt: t, urgente: false }); break; }
      }
    }
    return out;
  }
  /** Piano d'acquisto per un set di tipi (qty: quante scarpe per tipo, di base 1).
      { piano: [{ t, w, pronta, r, mar, urgente, fuoriSet, causa, ripiego, coppia }], sim, proiezione, prossimo } */
  function scPiano(ctx, set, qty = {}) {
    const piano = [], salta = new Set(); let sim;
    for (let giro = 0; giro < 16; giro++) {
      sim = scSimula(ctx, piano);
      const scatti = [...sim.scoperte.map((u) => ({ ...u, urgente: true })), ...sim.ripieghi.map((f) => ({ ...f, urgente: false })), ...scMancanti(sim, piano, set, qty)]
        .sort((a, b) => a.w - b.w || b.urgente - a.urgente)
        .filter((t) => t.urgente || (t.qt && !t.presenza) || t.w >= 2) // un ripiego nelle prossime 2 settimane si tiene: una scarpa nuova non farebbe in tempo a rodarsi
        .filter((t) => t.qt || !(!t.urgente && salta.has(t.r + (t.mar ? "M" : ""))))
        .filter((t) => !t.qt || !piano.some((p) => p.t === t.qt && p.w >= t.w - 8 && p.w <= t.w + 4 && piano.filter((x) => x.t === t.qt).length >= (qty[t.qt] || 1) - sim.S.filter((z) => z.t === t.qt && !z.nuova && (z.fine == null || z.fine > t.w)).length))
        .filter((t) => t.qt || !piano.some((p) => { const mx = t.mar ? SC_MXM : SC_MX[t.r]; return mx[p.t] && (t.urgente || mx[p.t].ok) && p.w <= t.w + 4 && p.w >= t.w - 8; }));
      if (!scatti.length) break;
      const t = scatti[0]; let tipo, fuoriSet = false;
      if (t.qt) tipo = t.qt; else { const x = scTipoPer(t, set); if (!x) { salta.add(t.r + (t.mar ? "M" : "")); continue; } tipo = x.tipo; fuoriSet = !!x.fuoriSet; }
      // si compra due settimane prima (rodaggio), tre per una gara corta; due acquisti mai a meno di tre settimane
      let w = Math.max(0, t.w - (t.r === "G" && !t.mar ? 3 : 2)); // per una gara corta una settimana in più: la scarpa arriva rodata
      if (!t.urgente) { const vicini = piano.filter((p) => Math.abs(p.w - w) < 3); if (vicini.length) w = Math.max(w, Math.max(...vicini.map((p) => p.w)) + 3); }
      let causa = null;
      if (t.r) {
        const mx = t.mar ? SC_MXM : SC_MX[t.r];
        for (let x = t.w - 1; x >= 0 && !causa; x--) {
          const e = Object.entries(sim.griglia[x]).find(([, v]) => v[t.r]);
          if (e) { const s = sim.S.find((z) => String(z.id) === e[0]); const ev = sim.eventi.find((z) => z.scarpa === s.nome && (z.tipo === "fine" || (z.tipo === "lascia" && z.r === t.r))); if (s && mx[s.t] && mx[s.t].ok) causa = { scarpa: s.nome, id: s.id, evento: ev || null }; }
        }
      }
      const rp = t.r && sim.ripieghi.find((f) => f.w === t.w && f.r === t.r);
      piano.push({ t: tipo, w, pronta: t.w, r: t.r || null, mar: !!t.mar, urgente: !!t.urgente, fuoriSet, causa, ripiego: rp ? rp.scarpa : null, coppia: t.qt && !t.presenza ? qty[t.qt] : 0 });
    }
    sim = scSimula(ctx, piano);
    // proiezione allo stesso ritmo dopo l'ultima gara: date di fine e prossimo acquisto
    const proiezione = scSimula(ctx, piano, sim.H + 40); let prossimo = null;
    const cand = [...proiezione.scoperte.map((u) => ({ ...u, urgente: true })), ...proiezione.ripieghi.map((f) => ({ ...f, urgente: false }))].filter((t) => t.w >= sim.H - 2).sort((a, b) => a.w - b.w);
    for (const t of cand) { const x = scTipoPer(t, set); if (x) { prossimo = { t: x.tipo, w: Math.max(0, t.w - 2) }; break; } }
    const qn = scMancanti(proiezione, piano, set, qty).filter((t) => t.w >= sim.H - 2).sort((a, b) => a.w - b.w)[0];
    if (qn && (!prossimo || qn.w - 2 < prossimo.w)) prossimo = { t: qn.qt, w: Math.max(0, qn.w - 2) };
    return { piano, sim, proiezione, prossimo };
  }
  /** Fine di una scarpa nella simulazione: { w, come: "fine"|"fino"|"oltre", q (fine qualità), f (fine facili) }. */
  function scFineScarpa(sim, id) {
    const s = sim.S.find((x) => String(x.id) === String(id)); if (!s) return null;
    const lim = (w) => Math.min(w, sim.H);
    const ultimo = s.ultIdeale < 0 ? s.da : s.ultIdeale + 1;
    const due = s.ultQ >= 0 && s.ultF > s.ultQ + 2 ? { q: lim(s.ultQ + 1), f: lim(Math.min(s.ultF + 1, s.fine != null ? s.fine : 999)) } : {};
    if (s.fine != null && s.fine <= ultimo) return { w: s.fine, come: "fine", ...due };
    if (ultimo < sim.H - 3) return { w: ultimo, come: "fino", ...due };
    return { w: sim.H, come: "oltre", ...due };
  }
  /** Settimana per settimana: copertura delle uscite raggruppate (Facile, Veloce, Lunghi e gare): "ok"|"ripiego"|"scoperta"|null. */
  const SC_RIGHE = [{ k: "facile", nome: "Facile", ruoli: ["F"] }, { k: "veloce", nome: "Veloce", ruoli: ["V"] }, { k: "lunghi", nome: "Lunghi e gare", ruoli: ["LF", "R", "G"] }];
  function scCoperture(ctx, sim) {
    const ciclo = scWeekend(ctx.mix);
    return SC_RIGHE.map((riga) => ({ ...riga, settimane: Array.from({ length: sim.H }, (_, w) => {
      if (!scUscite(ctx, w, ciclo).u.some((u) => riga.ruoli.includes(u[0]))) return null;
      return sim.scoperte.some((u) => u.w === w && riga.ruoli.includes(u.r)) ? "scoperta" : sim.ripieghi.some((f) => f.w === w && riga.ruoli.includes(f.r)) ? "ripiego" : "ok";
    }) }));
  }
  /** Percentuale di vita settimana per settimana (null prima che arrivi). */
  function scVita(sim, s) { const out = []; let km = s.km0; for (let w = 0; w < sim.H; w++) { if (w < s.da) { out.push(null); continue; } const c = sim.griglia[w][s.id]; if (c) for (const r in c) km += c[r]; out.push(Math.min(1.05, km / s.max)); } return out; }
  /** Km medi a settimana. */
  const scKmSettimana = (ctx) => Math.round((Number(ctx.wk.F) || 0) + (Number(ctx.wk.V) || 0) + ["LF", "R", "G"].reduce((t, k) => t + (ctx.mix[k].n || 0) * (ctx.mix[k].km || 0), 0) / 4);
  /** Costo per mantenere il set a regime: { mese (€ arrotondati a 5), per100, anno: { tipo: scarpe l'anno } }. */
  function scCosto(ctx, set, prezzi = SC_PREZZO) {
    const M = 4.345, km = { F: ctx.wk.F * M, V: ctx.wk.V * M, LF: ctx.mix.LF.n * ctx.mix.LF.km, R: ctx.mix.R.n * ctx.mix.R.km, G: ctx.mix.G.n * ctx.mix.G.km };
    const mesi = Math.max(1, scOrizzonte(ctx) / M), uso = {}, add = (t, k) => { uso[t] = (uso[t] || 0) + k; };
    const scegli = (mx) => { const o = Object.keys(mx).sort((a, b) => mx[a].p - mx[b].p); return o.find((t) => mx[t].ok && set.includes(t)) || o.find((t) => set.includes(t)); };
    for (const r of SC_RK) { const t = scegli(SC_MX[r]); if (t) add(t, km[r]); }
    (ctx.gare || []).filter((g) => scSettimana(ctx, g.data) >= 0).forEach((g) => { const t = scegli(g.km >= 30 ? SC_MXM : SC_MX.G); if (t) add(t, g.km / mesi); });
    const usabile = { DA: 1, ST: 0.8, TE: 0.8, GA: 1 }, anno = {}; let costo = 0;
    for (const t in uso) { if (t === "DA") continue; const n = uso[t] / (usabile[t] * scDurata(t, ctx.peso)); anno[t] = n * 12; costo += n * prezzi[t]; }
    if (anno.ST && uso.DA) uso.DA = Math.max(0, uso.DA - (anno.ST / 12) * 0.2 * scDurata("ST", ctx.peso)); // il super-trainer finisce sui facili
    if (uso.DA) { const n = uso.DA / scDurata("DA", ctx.peso); anno.DA = n * 12; costo += n * prezzi.DA; }
    const tot = Object.values(km).reduce((a, b) => a + b, 0);
    return { mese: Math.round(costo / 5) * 5, per100: tot ? Math.round((costo / tot) * 100) : 0, anno };
  }
  /** Domande per tipo nel passo dei modelli; la prima opzione di ogni domanda è quella di partenza. */
  const SC_DOMANDE = {
    DA: [{ k: "feel", q: "Sui km facili preferisci", o: [["any", "Indifferente"], ["soft", "Morbida e protettiva"], ["light", "Più leggera e reattiva"]] }, { k: "drop", q: "Drop", o: [["any", "Indifferente"], ["same", "Simile alle tue (8 mm)"]] }],
    ST: [{ k: "feel", q: "Dal super-trainer vuoi", o: [["any", "Indifferente"], ["soft", "Più protezione"], ["light", "Più spinta e leggerezza"]] }, { k: "plate", q: "Piastra", o: [["any", "Indifferente"], ["no", "Senza"], ["yes", "Con piastra"]] }],
    TE: [{ k: "lavori", q: "La userai soprattutto per", o: [["lunghi", "Tempo e lavori lunghi"], ["brevi", "Ripetute brevi"]] }, { k: "race", q: "La userai anche in gara su 10 km e mezza?", o: [["yes", "Sì"], ["no", "No, solo allenamento"]] }, { k: "plate", q: "Piastra", o: [["any", "Indifferente"], ["carbon", "Carbonio"], ["other", "Nylon o fibra"]] }],
    GA: [{ k: "dist", q: "Per quali gare?", o: [["both", "Tutte"], ["mar", "Maratona"], ["half", "10 km e mezza"]] }, { k: "stride", q: "Quando acceleri", o: [["any", "Non so"], ["long", "Allunghi il passo"], ["freq", "Aumenti la frequenza"]] }],
  };
  const SC_BUDGET = { DA: 120, ST: 160, TE: 140, GA: 160 };
  /** Protezione per il peso del runner: "alta" | "media" | "bassa" | null. Conta l'altezza della suola al tallone
   *  rispetto a quella che serve al peso (32 mm sotto i 65 kg, 36 mm fino a 79, 40 mm da 80 in su); senza suola,
   *  l'ammortizzazione dichiarata. L'ammortizzazione massima alza di un gradino. Non è l'indicazione di corporatura di
   *  Runnea, che è troppo prudente: per scegliere conta quanta schiuma c'è sotto il piede. */
  function scProtezione(c, peso) {
    peso = Number(peso) || 0; if (!peso) return null;
    const serve = peso >= 80 ? 40 : peso >= 65 ? 36 : 32, max = c.ammortizzazione === "massima";
    if (c.suola) { const g = c.suola >= serve ? 2 : c.suola >= serve - 5 ? 1 : 0; return ["bassa", "media", "alta"][Math.min(2, g + (max && g < 2 ? 1 : 0))]; }
    return max ? "alta" : c.ammortizzazione === "media" ? "media" : null;
  }
  /** Punteggio e motivi di un modello del catalogo (content/scarpe.json) per le risposte e il profilo. */
  function scValuta(c, risp, ctx) {
    const pro = [], contro = [], peso = Number(ctx.peso) || 0;
    let s = ((c.score || 9.2) - 8.5) * 20;
    // protezione per il peso: pesa meno per le ripetute brevi con la Tempo e per le scarpe da gara
    const prot = scProtezione(c, peso), brevi = c.tipo === "TE" && risp.lavori === "brevi", leggero = brevi || c.tipo === "GA", k = brevi ? 0.25 : leggero ? 0.5 : 1;
    const suola = c.suola ? ` (suola ${c.suola} mm)` : "";
    if (prot === "alta") { s += 20 * k; pro.push(c.suola && c.suola >= 40 ? `Suola alta (${c.suola} mm): protezione alta per i tuoi ${peso} kg` : `Protezione alta per i tuoi ${peso} kg${suola}`); }
    else if (prot === "media") { s += 5 * k; if (peso >= 80 && !leggero) contro.push(`Protezione media per ${peso} kg${suola}: meglio sui lavori non troppo lunghi`); }
    else if (prot === "bassa") { s -= 20 * k; contro.push(`Protezione bassa per ${peso} kg${suola}`); }
    if (c.tipo === "TE" && risp.lavori === "brevi" && c.peso && c.peso <= 230) { s += 15; pro.push(`Leggera: ${c.peso} g`); }
    if (c.tipo === "DA" || c.tipo === "ST") {
      if (risp.feel === "soft") { if (c.ammortizzazione === "massima") { s += 20; pro.push("Ammortizzazione massima"); } else s -= 10; }
      if (risp.feel === "light") { if (c.peso && c.peso <= 260) { s += 20; pro.push(`Leggera: ${c.peso} g`); } else s -= 10; }
    }
    if (c.tipo === "DA" && risp.drop === "same" && c.drop != null) { if (Math.abs(c.drop - 8) <= 1) { s += 10; pro.push(`Drop ${c.drop} mm come le tue`); } else { s -= 5; contro.push(`Drop ${c.drop} mm, diverso dalle tue`); } }
    if (c.tipo === "ST" && risp.plate === "no") s += c.piastra ? -15 : 10;
    if (c.tipo === "ST" && risp.plate === "yes") { if (c.piastra) { s += 15; pro.push(`Piastra in ${c.piastra}`); } else s -= 10; }
    if (c.tipo === "TE" && risp.race === "yes") { if (/gara|misto/.test(c.uso || "")) { s += 15; pro.push("Adatta anche alla gara"); } else contro.push("Pensata per l'allenamento"); }
    if (c.tipo === "TE" && risp.plate === "carbon") { if (c.piastra === "carbonio") { s += 15; pro.push("Piastra in carbonio"); } else s -= 10; }
    if (c.tipo === "TE" && risp.plate === "other") { if (c.piastra && c.piastra !== "carbonio") { s += 15; pro.push(`Piastra in ${c.piastra}, più morbida`); } else s -= 10; }
    if (c.tipo === "GA") {
      if (risp.dist === "mar" || risp.dist === "both") { if (c.ammortizzazione === "massima") { s += 15; pro.push("Più schiuma: regge i 42 km"); } if (c.peso && c.peso >= 220) s += 5; }
      if (risp.dist === "half" && c.peso && c.peso <= 195) { s += 10; pro.push(`Leggerissima: ${c.peso} g`); }
      if (risp.stride && risp.stride !== "any" && (c.falcata || []).includes(risp.stride)) { s += 10; pro.push(risp.stride === "long" ? "Pensata per chi allunga il passo" : "Rullata adatta a chi aumenta la frequenza"); }
    }
    const mie = (ctx.scarpe || []).map((x) => String(x.nome || "").toLowerCase()), linea = String(c.linea || "").toLowerCase();
    if (linea && mie.some((n) => n.includes(linea))) { s += 15; pro.push("Stessa linea di una scarpa che hai"); }
    else if (mie.some((n) => n.startsWith(String(c.marca).toLowerCase()))) { s += 5; pro.push(`${c.marca}, la marca che usi`); }
    if (c.listino) { const sc = Math.round((1 - c.prezzo / c.listino) * 100); if (sc >= 30) { s += sc / 5; pro.push(`−${sc}% sul listino`); } }
    if (c.precedente) pro.push("Versione precedente: costa meno");
    if (c.score) pro.unshift(`Runnea score ${String(c.score).replace(".", ",")}`); else contro.push(`Non ancora su Runnea: dati da ${c.fonte}`);
    return { punti: s, pro: pro.slice(0, 4), contro };
  }
  /** I 3 modelli migliori del catalogo per un tipo: filtri marca e budget (se nessuno ci sta, il più economico). */
  function scModelli(catalogo, tipo, risp, ctx) {
    const marche = risp.marche || [], tutti = (catalogo || []).filter((c) => c.tipo === tipo && (!marche.length || marche.includes(c.marca)));
    const valutati = tutti.map((c) => ({ c, ...scValuta(c, risp, ctx) }));
    const dentro = valutati.filter((x) => x.c.prezzo <= (risp.budget || SC_BUDGET[tipo]));
    const lista = (dentro.length ? dentro : valutati.slice().sort((a, b) => a.c.prezzo - b.c.prezzo).slice(0, 1)).sort((a, b) => b.punti - a.punti).slice(0, 3);
    return { lista, fuoriBudget: !dentro.length && !!valutati.length };
  }

  // ---------------------------------------------------------------- porting: da Safari all'app (o a un altro telefono)
  // Il profilo sta solo nella memoria del browser, e su iPhone Safari e l'app nella Home hanno memorie separate. Il codice
  // "RB1.<dati>.<controllo>" porta lo stato così com'è, compreso il codice segreto del gruppo (quindi resti lo stesso membro,
  // niente doppioni). Non porta: iscrizione alle notifiche (legata al dispositivo), data simulata, chat Buddy, foto di
  // tessera e certificato (restano nel browser di origine).
  const PORTING_V = "RB1";
  const controlloPorting = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); };
  const b64Utf8 = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const daB64Utf8 = (b) => decodeURIComponent(escape(atob(b.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b.length + 3) % 4))));
  function portingCrea(stato) {
    const s = JSON.parse(JSON.stringify(stato || {}));
    delete s.push; delete s.prova;
    if (s.buddy && typeof s.buddy === "object") s.buddy = { ...s.buddy, chat: [] };
    const json = JSON.stringify(s);
    return `${PORTING_V}.${b64Utf8(json)}.${controlloPorting(json)}`;
  }
  /** { ok: true, stato } oppure { ok: false, errore }. Tollera spazi e a capo (incolla da messaggi). */
  function portingLeggi(codice) {
    const c = String(codice || "").replace(/\s+/g, "");
    if (!c) return { ok: false, errore: "Incolla il codice" };
    const p = c.split(".");
    if (p.length !== 3 || p[0] !== PORTING_V) return { ok: false, errore: "Non è un codice di RaceBuddy" };
    let json, stato;
    try { json = daB64Utf8(p[1]); } catch (e) { return { ok: false, errore: "Codice incompleto: copialo di nuovo per intero" }; }
    if (controlloPorting(json) !== p[2]) return { ok: false, errore: "Codice incompleto: copialo di nuovo per intero" };
    try { stato = JSON.parse(json); } catch (e) { return { ok: false, errore: "Codice non leggibile" }; }
    if (!stato || typeof stato !== "object" || Array.isArray(stato)) return { ok: false, errore: "Codice non leggibile" };
    return { ok: true, stato };
  }

  const api = { portingCrea, portingLeggi, fuoriMisura, esatte, kmAltra, fmtKm, etichettaDist, baseKm, PUNTI, CENTRATO, scartoObiettivo, garaDellaSocieta, garaSocDi, obiettivoAperto, eventiPunti, classificaImpegno, puntiCarriera, LIVELLI, livello, classificaObiettivo, alboEta, miglioramento12, badgeAtleta, gareMembri, riepilogoMembri, registrabile, ESITO_LABEL, mieGareClassifica, STATO_MIE, cercaMieGare, riepilogoMie, diffDays, addDays, todayISO, fmtBreve, fmtGiorno, DIST_LABEL, RUOLO_LABEL, fase, vociGara, stato, checklist, adatta, inCasa, kmAlGiorno, scarpaAlVia, personeProposte, tempiUniti, tempiPerDistanza, tempiDellaGara, nomeRisultato, POST_GARA, FINE_GARA, finitaPrima, ciclo, dividiGare, ultimoDebrief, gareAttive, pillola, pillolePool, vestizione, descriviMeteo, tipoCielo, avvisiMeteo, perTe, varieta, segnaVisti, ordinaNovita, novitaInEvidenza, sorriso, prossimaUscita, cercaGare, cercaEstero, circuitiDi, benvenutoTop, introEstera, nelMirino, statoScarpa, leggiTempo, tempoDaParti, candidatiPersonali, corsaDellaGara, SEZIONI_GARA, sezioneSwipe, PASSI_PREPARA, passiPrepara, leggiDocumento, contestoBuddy, sessoCategoria, conPosizioni, classificaGareCorse, pbEventi, classificaPBStagione, alboDoro, recordCategorie, primiETu, recuperoAperto, recuperoInEvidenza, daRecuperare, fontiNuove, fonteAperta, nuoveFontiInEvidenza, PASSI_ENTRA, passiEntra, prossimoEntra, SC_TIPI, SC_TK, SC_DA_APP, SC_A_APP, SC_PREZZO, SC_RUOLI, SC_RIGHE, SC_DOMANDE, SC_BUDGET, scDurata, scInizio, scSettimana, scData, scOrizzonte, scWeekend, scUscite, scSimula, scPiano, scFineScarpa, scCoperture, scVita, scKmSettimana, scCosto, scValuta, scModelli, scProtezione };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RBLogic = api;
})(typeof self !== "undefined" ? self : this);
