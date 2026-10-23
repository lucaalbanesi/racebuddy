// RaceBuddy – funzione "tempi" (Supabase Edge Function). Logica pura: fetch arriva da fuori, così si prova in Node.
//
// POST {nome, cognome[, anno][, codice]}
//   Cerca i risultati ufficiali su 10 km, mezza e maratona di chi si chiama così, in due fonti pubbliche:
//   - Gare Podistiche Lazio (garepodistichelazio.it): una pagina per nome, dal 2019, anche le non competitive.
//     Gli omonimi finiscono nella stessa pagina: si separano per società.
//   - FIDAL (fidal.it): ricerca atleti, poi la scheda di ognuno con lo stesso nome (gare FIDAL dal 2005).
//   - MarathonView (marathonview.net, da ottobre 2026): una pagina per nome con tutte le maratone; teniamo SOLO quelle
//     all'estero (Major e grandi gare che FIDAL non ha): per le italiane MarathonView ricopia altre fonti, tra cui ENDU,
//     che non usiamo. Una richiesta semplice senza cookie, una per ricerca (il sito conta le ricerche anonime per cookie):
//     va bene finché siamo pochi; se si cresce, va chiesto il permesso al sito o usato un account.
//     Niente società: gli omonimi si separano per nazionalità e sesso, e la scelta resta al runner.
//   `anno` (facoltativo) limita Gare Podistiche Lazio a quell'anno (per il tempo di una gara appena corsa).
//   `codice` (facoltativo) è il codice della società sulla tessera (es. RM123): mette quella persona davanti in FIDAL.
//   Risposta: { persone: [{ id, fonte, nome, societa, codice, categoria, risultati: [...] }], fonti: { gpl, fidal, mview } }
//   (le persone di MarathonView hanno anche `paese`, la nazionalità in tre lettere, e `descr` da mostrare al posto della società)
//
// Il nome serve solo alla ricerca: non si salva da nessuna parte. Si interroga una pagina per volta, solo su richiesta.
//
// POST {azione:"certifica", nome, cognome[, anno][, codice], persone:[id], risultati:[id]}  (classifiche del gruppo)
//   Con il codice del telefono nell'intestazione x-racebuddy-token. Rifà la stessa ricerca, tiene solo i risultati
//   scelti delle persone scelte (quelli che esistono davvero nelle classifiche ufficiali) e li registra nel database con
//   la chiave segreta (funzione _registra_certificati: certificati se il nome cercato è quello del membro, altrimenti al
//   referente). Il telefono non può scrivere un risultato certificato da solo. Nel database va l'impronta del codice,
//   mai il codice. Risposta: { certificati, in_approvazione, saltati, righe }.

export const GPL = "https://www.garepodistichelazio.it";
export const FIDAL = "https://www.fidal.it";
export const MVIEW = "https://marathonview.net";
export const PRIMO_ANNO_GPL = 2019;
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36 RaceBuddy";
const MAX_SCHEDE_FIDAL = 4;
const ORDINE_FONTI = ["gpl", "fidal", "mview"];
const DISTANZE = { "10": 10, "21": 21.0975, "42": 42.195 };

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", agrave: "à", egrave: "è", eacute: "é", igrave: "ì", ograve: "ò", ugrave: "ù", raquo: "»", laquo: "«" };
export const testo = (s) => String(s || "").replace(/<[^>]+>/g, " ")
  .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)
  .replace(/\s+/g, " ").trim();
// Per confrontare i nomi: senza accenti, apostrofi e maiuscole.
export const chiave = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "02:23:18", "00:58:52", "1h51:29", "2h05:18", "59:01", "27:57.4" → secondi (decimi troncati). null se non è un tempo. */
export function secondi(s) {
  const t = String(s || "").trim().replace(/h/i, ":").replace(/[.,]\d+$/, "");
  const p = t.split(":");
  if (p.length < 2 || p.length > 3 || p.some((x) => !/^\d{1,2}$/.test(x))) return null;
  const n = p.map(Number), [h, m, x] = p.length === 3 ? n : [0, ...n];
  return m < 60 && x < 60 ? h * 3600 + m * 60 + x : null;
}
export const hms = (sec) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

/** Distanza in km → "10" | "21" | "42", solo se è proprio quella (le gare da 9,9 o 21,5 km non sono personali). */
export function distanzaDaKm(km) {
  for (const [d, v] of Object.entries(DISTANZE)) if (Math.abs(km - v) <= 0.05 + 1e-9) return d; // 1e-9: 10,050 - 10 in virgola mobile è 0,0500000000000007
  return null;
}
// Altre distanze (ottobre 2026): ogni gara tra 5 e 50 km che non è una classica esatta (la Corsa di Miguel a 9,9 km,
// l'Appia Run a 16 o 19 km). Entra con km_reali e come distanza la classica più vicina (come il calendario: fino a
// 15,5 km la 10, fino a 31,6 la mezza); vale solo per Gare corse e arrivo e Borsa Impegno, mai per personali, PB,
// Albo d'oro, obiettivo e percentuale per età.
export const KM_MIN = 5, KM_MAX = 50;
export const baseKm = (km) => (km < 15.5 ? "10" : km < 31.6 ? "21" : "42");
// Come le parole escluse del calendario, più le gare a tempo ("6 Ore di Roma"): per le altre distanze non sono corse su strada a distanza
export const ESCLUSE_ALTRE = /\b(trail|montagna|cross|pista|marcia|nordic|staffetta|ultra|vertical|skyrace|indoor|ore)\b|\b\d+\s*x\s*\d/i;
export function distanzaCirca(km) {
  if (!(km >= KM_MIN && km <= KM_MAX) || distanzaDaKm(km)) return null;
  return baseKm(km);
}
// Passi impossibili (errori di inserimento, es. una 6 ore registrata come 10 km in 21 minuti): fuori.
export const passoPlausibile = (sec, d, km) => { const p = sec / (km || DISTANZE[d]); return p >= 150 && p <= 900; };

/** Gare Podistiche Lazio: le gare di una pagina atleta (scheda o elenco di un anno). */
export function leggiGpl(html) {
  const out = [];
  for (const blocco of String(html || "").match(/<details>[\s\S]*?<\/details>/gi) || []) {
    const sum = (blocco.match(/<summary>([\s\S]*?)<\/summary>/i) || [])[1] || "";
    const [dataTxt, garaTxt] = sum.split(/<br\s*\/?>/i).map(testo);
    const t = testo(blocco.replace(/<br\s*\/?>/gi, "\n"));
    const campo = (nome) => (t.match(new RegExp(`${nome}\\s*:\\s*(.*?)(?= (?:Località|Distanza|Classifica Gara|Dati Atleta|Società|Categoria|Riscontri Cronometrici|Tempo|Passo|Velocità|Posizionamento Gara|Posizione \\w+)\\s*:| Dati Atleta| Riscontri| Posizionamento|$)`, "i")) || [])[1] || "";
    const d = (dataTxt || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!d) continue;
    const km = Number(campo("Distanza").replace(/km/i, "").replace(/\./g, "").replace(",", "."));
    const sec = secondi(campo("Tempo"));
    out.push({
      data: `${d[3]}-${d[2]}-${d[1]}`, gara: (garaTxt || "").replace(/\s*\(\s*[^)]*\)\s*$/, "").trim(), luogo: campo("Località"),
      km, tempo: sec ? hms(sec) : "", secondi: sec, societa: campo("Società"), categoria: campo("Categoria").split(" ")[0],
    });
  }
  return out;
}

/** FIDAL: le righe "Atleti" della ricerca → { nome, link, societa, codice, categoria }. */
export function leggiFidalCerca(html) {
  const out = [];
  for (const riga of String(html || "").match(/<tr>[\s\S]*?<\/tr>/gi) || []) {
    const a = riga.match(/href="(https:\/\/www\.fidal\.it\/atleta\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const s = riga.match(/href="https:\/\/www\.fidal\.it\/societa\/[^"]*\/([A-Z0-9]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const cat = riga.match(/<abbr[^>]*>([\s\S]*?)<\/abbr>/i);
    if (out.some((x) => x.link === a[1])) continue;
    out.push({ nome: testo(a[2]), link: a[1], societa: s ? testo(s[2]) : "", codice: s ? s[1] : "", categoria: cat ? testo(cat[1]) : "" });
  }
  return out;
}

/** FIDAL: dalla scheda atleta i risultati su strada di 10 km, mezza e maratona (scheda "Risultati"). */
export function distanzaFidal(gara) {
  const g = chiave(gara);
  if (/^maratonina\b/.test(g) || /mezza maratona/.test(g)) return "21";
  if (/^maratona\b/.test(g)) return "42";
  if (/\bkm 10\b/.test(g) && /strada/.test(g) || /^10 km strada/.test(g)) return "10";
  return null;
}
/** FIDAL, altre distanze su strada: "Corsa strada Km 15" → 15 (5-50 km, non classiche). */
export function kmFidal(gara) {
  const t = String(gara || "");
  if (!/strada/i.test(t) || distanzaFidal(t)) return null;
  const m = t.match(/\bkm\.?\s*(\d+(?:[.,]\d+)?)/i) || t.match(/(\d+(?:[.,]\d+)?)\s*km\b/i);
  const km = m ? Number(m[1].replace(",", ".")) : null;
  return km && distanzaCirca(km) ? km : null;
}
export function leggiFidalAtleta(html) {
  const h = String(html || ""), a = h.indexOf('id="tab2"'), b = h.indexOf('id="tab3"', a);
  const sez = a < 0 ? "" : h.slice(a, b < 0 ? undefined : b), out = [];
  for (const m of sez.matchAll(/<h2 class="title-table">([\s\S]*?)<\/h2>([\s\S]*?)<\/table>/gi)) {
    const titolo = testo(m[1]), kmA = kmFidal(titolo), d = distanzaFidal(titolo) || (kmA ? baseKm(kmA) : null);
    if (!d) continue;
    for (const r of m[2].match(/<tr>[\s\S]*?<\/tr>/gi) || []) {
      const c = (r.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(testo);
      const [anno, gm, tipo, , cat, , prest, , citta] = c;
      if (!/^\d{4}$/.test(anno || "") || !/^\d{2}\/\d{2}$/.test(gm || "") || tipo === "I") continue;
      const sec = secondi(prest);
      if (!sec) continue;
      out.push({ data: `${anno}-${gm.slice(3, 5)}-${gm.slice(0, 2)}`, gara: "", luogo: citta || "", distanza: d, tempo: hms(sec), secondi: sec, categoria: cat || "", ...(kmA ? { km_reali: kmA } : {}) });
    }
  }
  return out;
}

/** MarathonView: le maratone di una pagina atleta (JSON scritto nella pagina: `const json={...};`). Solo maratone (42,0-42,4
 *  km) corse all'estero e con il nome cercato; tempo = quello personale (netto) se c'è, altrimenti quello ufficiale. */
export function leggiMview(html, nome) {
  const m = String(html || "").match(/const json=(\{.*\});\s*$/m);
  let j = null;
  try { j = m ? JSON.parse(m[1]) : null; } catch (_e) { j = null; }
  const voglio = parole(nome), out = [];
  for (const r of (j && j.data && j.data.results) || []) {
    if (!r || parole(`${r.first_name || ""} ${r.last_name || ""}`) !== voglio) continue;
    const paeseGara = String(r.event_country || "").toLowerCase();
    if (!paeseGara || paeseGara === "ita") continue;               // solo all'estero
    if (!(r.distance >= 42000 && r.distance <= 42400)) continue;    // solo maratone
    const sec = Number(r.personal_time != null && r.personal_time < r.result ? r.personal_time : r.result);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || "") || !(sec > 0)) continue;
    out.push({ data: r.date, gara: String(r.event_name || "").trim().slice(0, 120), luogo: paeseGara.toUpperCase(), distanza: "42", tempo: hms(sec), secondi: sec,
      categoria: String(r.category || "").slice(0, 12), paese: String(r.country || "").toLowerCase(), sesso: r.gender === "F" ? "F" : r.gender === "M" ? "M" : "" });
  }
  return out;
}
// "Maria Grazia D'Angelo" = "d angelo grazia maria": parole senza accenti, in ordine (come _norm_nome nel database)
const parole = (s) => chiave(s).split(" ").filter(Boolean).sort().join(" ");
const PAESI = { ita: "Italia", usa: "Stati Uniti", deu: "Germania", fra: "Francia", gbr: "Regno Unito", esp: "Spagna", sui: "Svizzera", che: "Svizzera", aut: "Austria", nld: "Paesi Bassi", bel: "Belgio", jpn: "Giappone" };
/** MarathonView: una "persona" per nazionalità e sesso (non c'è la società). Prima chi è italiano e chi ha più gare. */
export function personeMview(gare, nome) {
  const per = new Map();
  for (const g of gare) {
    const k = `${g.paese || "x"}-${g.sesso || "x"}`;
    if (!per.has(k)) per.set(k, { paese: g.paese, tutte: [] });
    per.get(k).tutte.push(g);
  }
  return [...per.entries()].map(([k, p]) => {
    const risultati = soloGara(p.tutte, "mview").map(({ paese, sesso, ...r }) => r);
    return { id: `mview:${k}`, fonte: "mview", nome, societa: "", codice: "", categoria: (risultati[0] || {}).categoria || "", paese: p.paese || "",
      descr: `Maratone all'estero${p.paese ? ` · nazionalità ${PAESI[p.paese] || p.paese.toUpperCase()}` : ""}`, gare: risultati.length, risultati };
  }).sort((a, b) => (b.paese === "ita") - (a.paese === "ita") || b.gare - a.gare);
}

/** Tiene 10 km, mezza e maratona e le altre distanze 5-50 km (con km_reali) con un passo credibile, dalla più recente. */
function soloGara(lista, fonte) {
  return lista
    .map((r) => { if (r.distanza || !r.km) return r; const d = distanzaDaKm(r.km), c = !d && !ESCLUSE_ALTRE.test(r.gara || "") ? distanzaCirca(r.km) : null; return { ...r, distanza: d || c, ...(c ? { km_reali: r.km } : {}) }; })
    .filter((r) => r.distanza && r.secondi && passoPlausibile(r.secondi, r.distanza, r.km_reali))
    .map(({ km, societa, ...r }) => ({ ...r, fonte, id: `${fonte}:${r.data}:${r.distanza}:${r.secondi}` }))
    .sort((x, y) => (x.data < y.data ? 1 : -1));
}

/** Gare Podistiche Lazio: le gare di tutti gli anni (o di uno), divise per società = una "persona" per società. */
export function personeGpl(gare, nome) {
  const per = new Map();
  for (const g of gare) {
    const k = chiave(g.societa) || "senza società";
    if (!per.has(k)) per.set(k, { societa: g.societa, categoria: g.categoria, tutte: [] });
    const p = per.get(k); p.tutte.push(g);
    if (g.data >= (p.ultima || "")) { p.ultima = g.data; p.categoria = g.categoria || p.categoria; p.societa = g.societa || p.societa; }
  }
  return [...per.entries()].map(([k, p]) => ({
    id: `gpl:${k}`, fonte: "gpl", nome, societa: p.societa, codice: "", categoria: p.categoria, gare: p.tutte.length,
    risultati: soloGara(p.tutte.filter((g, i, a) => a.findIndex((x) => x.data === g.data && x.gara === g.gara && x.secondi === g.secondi) === i), "gpl"),
  })).sort((a, b) => b.gare - a.gare);
}

export function crea(env = {}, fetchImpl = fetch, adesso = () => new Date()) {
  const cors = { "Access-Control-Allow-Origin": env.APP_ORIGIN || "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-racebuddy-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const json = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
  const pagina = async (url) => {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 12000);
    try { const r = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ctrl.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); }
    finally { clearTimeout(t); }
  };

  async function cercaGpl(nome, cognome, anno) {
    const na = encodeURIComponent(`${cognome} ${nome}`.toUpperCase());
    const ora = adesso().getFullYear(), anni = anno ? [anno] : Array.from({ length: ora - PRIMO_ANNO_GPL + 1 }, (_, i) => PRIMO_ANNO_GPL + i);
    const pagine = await Promise.all(anni.map((a) => pagina(`${GPL}/elenco-gare.php?na=${na}&page=2&anno=${a}`)));
    return personeGpl(pagine.flatMap(leggiGpl), `${nome} ${cognome}`);
  }
  async function cercaFidal(nome, cognome, codice) {
    const lista = leggiFidalCerca(await pagina(`${FIDAL}/result.php?id_sito=1&cerca=${encodeURIComponent(`${nome} ${cognome}`)}`));
    const voglio = [chiave(`${nome} ${cognome}`), chiave(`${cognome} ${nome}`)];
    const stessi = lista.filter((x) => voglio.includes(chiave(x.nome)))
      .sort((a, b) => (b.codice === codice) - (a.codice === codice))
      .slice(0, MAX_SCHEDE_FIDAL);
    const schede = await Promise.all(stessi.map((x) => pagina(x.link).then(leggiFidalAtleta).catch(() => [])));
    return stessi.map((x, i) => ({
      id: `fidal:${x.link.split("/").pop()}`, fonte: "fidal", nome: x.nome, societa: x.societa, codice: x.codice, categoria: x.categoria, gare: schede[i].length,
      risultati: soloGara(schede[i], "fidal"),
    }));
  }

  // Una richiesta, senza cookie (fetch non li conserva): il nome come nell'indirizzo del sito, con i trattini
  async function cercaMview(nome, cognome, anno) {
    const chi = `${nome} ${cognome}`, url = `${MVIEW}/marathon-results-of-${encodeURIComponent(chi.replace(/\s+/g, "-"))}`;
    const gare = leggiMview(await pagina(url), chi).filter((g) => !anno || g.data.startsWith(String(anno)));
    return personeMview(gare, chi);
  }

  async function cerca(nome, cognome, anno, codice) {
    const fonti = { gpl: cercaGpl(nome, cognome, anno), fidal: cercaFidal(nome, cognome, codice), mview: cercaMview(nome, cognome, anno) };
    const esiti = await Promise.allSettled(Object.values(fonti)), stato = {}, persone = [];
    Object.keys(fonti).forEach((k, i) => { stato[k] = esiti[i].status === "fulfilled" ? "ok" : "errore"; if (esiti[i].status === "fulfilled") persone.push(...esiti[i].value); });
    return { persone: persone.filter((p) => p.gare > 0), fonti: stato };
  }

  // impronta del codice segreto del telefono, come public._hash nel database (sha256 esadecimale)
  async function impronta(req) {
    const t = req.headers.get("x-racebuddy-token") || "";
    if (t.length < 32 || t.length > 200) return null;
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
    return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  async function certifica(req, b, nome, cognome, anno, codice) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ errore: "certificazione non configurata" }, 503);
    const hash = await impronta(req);
    if (!hash) return json({ errore: "manca il codice del telefono" }, 401);
    const idOk = (x) => typeof x === "string" && x.length <= 200;
    const chiPersone = Array.isArray(b.persone) ? b.persone.filter(idOk).slice(0, 8) : [];
    const chiRisultati = Array.isArray(b.risultati) ? b.risultati.filter(idOk).slice(0, 200) : [];
    if (!chiPersone.length || !chiRisultati.length) return json({ errore: "scegli persone e risultati" }, 400);
    const { persone } = await cerca(nome, cognome, anno, codice);
    // Gare Podistiche Lazio prima di FIDAL (ha il nome della gara), poi MarathonView: a parità di gara vince la prima
    const righe = [], viste = new Set();
    for (const p of persone.filter((x) => chiPersone.includes(x.id)).sort((x, y) => ORDINE_FONTI.indexOf(x.fonte) - ORDINE_FONTI.indexOf(y.fonte))) {
      for (const r of p.risultati.filter((x) => chiRisultati.includes(x.id))) {
        const k = `${r.data}:${r.distanza}`;
        if (viste.has(k)) continue;
        viste.add(k);
        righe.push({ data: r.data, distanza: r.distanza, secondi: r.secondi, gara_nome: r.gara || r.luogo || "", fonte: r.fonte, categoria: r.categoria || p.categoria || "", societa: p.societa || "", ...(r.km_reali ? { km_reali: r.km_reali } : {}) });
      }
    }
    if (!righe.length) return json({ certificati: 0, in_approvazione: 0, saltati: 0, righe: 0 });
    const r = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/_registra_certificati`, { method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_hash: hash, p_nome: `${nome} ${cognome}`, p_righe: righe }) });
    const testoR = await r.text();
    let j = {};
    try { j = JSON.parse(testoR); } catch (_e) { j = {}; }
    if (!r.ok) return json({ errore: String(j.message || "non registrato").slice(0, 160) }, r.status >= 500 ? 502 : 400);
    return json({ ...j, righe: righe.length });
  }

  return async function (req) {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ errore: "solo POST" }, 405);
    let b = {};
    try { b = await req.json(); } catch (_e) { return json({ errore: "richiesta non valida" }, 400); }
    const ok = (s) => typeof s === "string" && /^[\p{L}][\p{L}' .-]{0,39}$/u.test(s.trim());
    if (!ok(b.nome) || !ok(b.cognome)) return json({ errore: "nome e cognome" }, 400);
    const nome = b.nome.trim().replace(/\s+/g, " "), cognome = b.cognome.trim().replace(/\s+/g, " ");
    const anno = Number.isInteger(b.anno) && b.anno >= PRIMO_ANNO_GPL && b.anno <= adesso().getFullYear() ? b.anno : null;
    const codice = typeof b.codice === "string" && /^[A-Z]{2}\d{1,4}$/i.test(b.codice) ? b.codice.toUpperCase() : "";
    if (b.azione === "certifica") return certifica(req, b, nome, cognome, anno, codice);
    return json(await cerca(nome, cognome, anno, codice));
  };
}
