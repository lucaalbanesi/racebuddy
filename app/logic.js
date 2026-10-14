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

  /** Contenuti "per te": punteggio in base a fase e distanza della gara, freschezza e già letti.
      Tutto calcolato sul telefono: online non va nulla di personale. */
  const ARG_FASE = { si_parte: ["scarpe", "forza", "allenamento"], costruzione: ["allenamento", "rifornimento", "forza", "scarpe"],
    picco: ["allenamento", "rifornimento", "scarpe"], scarico: ["gara", "rifornimento", "mente", "alimentazione", "abbigliamento"],
    gara: ["gara", "mente", "abbigliamento"], dopo: ["recupero", "racconti"] };
  function punteggio(c, fase, distanza, oggi, letti = {}) {
    const giorni = Math.max(0, diffDays(oggi, c.data));
    let p = Math.max(0, 30 - giorni) / 10;
    if (fase && (c.fasi || []).includes(fase)) p += 3;
    if (distanza && (c.distanze || []).includes(distanza)) p += 2;
    else if (distanza && (c.distanze || []).length) p -= 1.5;
    p += (c.argomenti || []).filter((a) => (ARG_FASE[fase] || []).includes(a)).length * 0.7;
    if (letti[c.id]) p -= 6;
    return p;
  }
  function perTe(contenuti, { fase, distanza, oggi, letti = {}, tipo = "" }) {
    return contenuti
      .filter((c) => !tipo || c.tipo === tipo)
      .map((c) => ({ c, p: punteggio(c, fase, distanza, oggi, letti) }))
      .sort((a, b) => b.p - a.p || (a.c.data < b.c.data ? 1 : -1))
      .map((x) => ({ ...x.c, punteggio: Math.round(x.p * 10) / 10, perLaFase: !!fase && (x.c.fasi || []).includes(fase) }));
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
  function prossimaUscita(oraUscita, adesso) {
    const [h] = String(oraUscita || "7:00").split(":").map(Number);
    const oggi = todayISO(adesso);
    const giorno = adesso.getHours() > h ? addDays(oggi, 1) : oggi;
    return `${giorno}T${String(h).padStart(2, "0")}:00`;
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

  const api = { diffDays, addDays, todayISO, fmtBreve, fmtGiorno, DIST_LABEL, RUOLO_LABEL, fase, vociGara, stato, checklist, gareAttive, pillola, pillolePool, vestizione, descriviMeteo, tipoCielo, avvisiMeteo, perTe, sorriso, prossimaUscita, cercaGare, statoScarpa };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RBLogic = api;
})(typeof self !== "undefined" ? self : this);
