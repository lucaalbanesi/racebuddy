// RaceBuddy – funzione "strava" (Supabase Edge Function). Logica pura: env e fetch arrivano da fuori, così si prova in Node.
//
// GET  ?code=…&state=…        ritorno da Strava dopo l'autorizzazione → reindirizza all'app (#/io?strava=…)
// POST {azione:"inizio"}      link per autorizzare su Strava (o {pieno:true} se i 10 posti di tester sono occupati)
// POST {azione:"scarpe"}      scarpe dell'atleta con i km
// POST {azione:"gare"}        corse segnate come gara (per i personali)
// POST {azione:"giorno", data:"AAAA-MM-GG"}  corse di quel giorno (per il tempo a fine gara)
// POST {azione:"scollega"}    revoca l'autorizzazione e cancella i token
//
// I token di Strava restano nel database (tabella strava_atleti, solo con la chiave segreta): mai al telefono.
// I dati letti da Strava vanno solo all'utente che li chiede.

export const MAX_ATLETI = 10;
const STRAVA = "https://www.strava.com";
const SCOPE = "read,profile:read_all,activity:read";

export function crea(env, fetchImpl = fetch) {
  const SB = env.SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY, APP = env.APP_URL || "https://lucaalbanesi.github.io/racebuddy/";
  const ritornoUrl = `${SB}/functions/v1/strava`;
  const cors = { "Access-Control-Allow-Origin": env.APP_ORIGIN || "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
  const json = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
  const vaiAllApp = (esito) => new Response(null, { status: 302, headers: { Location: `${APP}#/io?strava=${esito}` } });
  const db = (q, opt = {}) => fetchImpl(`${SB}/rest/v1/${q}`, { ...opt, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(opt.headers || {}) } });
  const righe = async (q) => { const r = await db(q); return r.ok ? r.json() : []; };

  async function utente(req) {
    const auth = req.headers.get("authorization") || "";
    if (!/^Bearer\s+\S+/.test(auth)) return null;
    const r = await fetchImpl(`${SB}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY || KEY, Authorization: auth } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  }
  async function posti() {
    const r = await db("strava_atleti?select=user_id", { headers: { Prefer: "count=exact", Range: "0-0" } });
    const tot = Number(((r.headers.get("content-range") || "").split("/")[1]) || 0);
    return Number.isFinite(tot) ? tot : 0;
  }
  async function token(uid) {
    const [a] = await righe(`strava_atleti?user_id=eq.${uid}&select=*`);
    if (!a) return null;
    if (new Date(a.scade).getTime() > Date.now() + 60_000) return a.access_token;
    const r = await fetchImpl(`${STRAVA}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: a.refresh_token }) });
    if (!r.ok) return null;
    const t = await r.json();
    await db(`strava_atleti?user_id=eq.${uid}`, { method: "PATCH", body: JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, scade: new Date(t.expires_at * 1000).toISOString() }) });
    return t.access_token;
  }
  const api = (tk, percorso) => fetchImpl(`${STRAVA}/api/v3/${percorso}`, { headers: { Authorization: `Bearer ${tk}` } });
  const corsa = (a) => /^(Run|TrailRun|VirtualRun)$/.test(a.sport_type || a.type || "");
  const voce = (a) => ({ id: String(a.id), nome: a.name || "", data: String(a.start_date_local || a.start_date || "").slice(0, 10), metri: Math.round(a.distance || 0),
    secondi: a.elapsed_time || 0, movimento: a.moving_time || 0, gara: a.workout_type === 1 });

  async function ritorno(url) {
    const stato = url.searchParams.get("state") || "";
    const [s] = stato ? await righe(`strava_stati?stato=eq.${encodeURIComponent(stato)}&select=*`) : [];
    if (s) await db(`strava_stati?stato=eq.${encodeURIComponent(stato)}`, { method: "DELETE" });
    if (!s || Date.now() - new Date(s.creato).getTime() > 15 * 60_000) return vaiAllApp("scaduto");
    if (url.searchParams.get("error")) return vaiAllApp("negato");
    const scope = url.searchParams.get("scope") || "";
    if (!scope.includes("activity:read") || !scope.includes("profile:read_all")) return vaiAllApp("permessi");
    const gia = (await righe(`strava_atleti?user_id=eq.${s.user_id}&select=user_id`)).length > 0;
    if (!gia && (await posti()) >= MAX_ATLETI) return vaiAllApp("pieno");
    const r = await fetchImpl(`${STRAVA}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, code: url.searchParams.get("code"), grant_type: "authorization_code" }) });
    if (!r.ok) return vaiAllApp("errore");
    const t = await r.json();
    const ok = await db("strava_atleti?on_conflict=user_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: s.user_id, athlete_id: t.athlete && t.athlete.id, access_token: t.access_token, refresh_token: t.refresh_token, scade: new Date(t.expires_at * 1000).toISOString() }) });
    return vaiAllApp(ok.ok ? "ok" : "errore");
  }

  return async function gestisci(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (req.method === "GET") return ritorno(url);
    if (req.method !== "POST") return json({ errore: "metodo" }, 405);
    const uid = await utente(req);
    if (!uid) return json({ errore: "serve il login" }, 401);
    let corpo = {};
    try { corpo = await req.json(); } catch (e) { /* vuoto */ }
    const az = corpo.azione;
    if (az === "inizio") {
      const gia = (await righe(`strava_atleti?user_id=eq.${uid}&select=user_id`)).length > 0;
      if (!gia && (await posti()) >= MAX_ATLETI) return json({ pieno: true });
      const stato = crypto.randomUUID();
      await db(`strava_stati?creato=lt.${new Date(Date.now() - 15 * 60_000).toISOString()}`, { method: "DELETE" });
      await db("strava_stati", { method: "POST", body: JSON.stringify({ stato, user_id: uid }) });
      const q = new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, response_type: "code", redirect_uri: ritornoUrl, approval_prompt: "auto", scope: SCOPE, state: stato });
      return json({ url: `${STRAVA}/oauth/authorize?${q}` });
    }
    if (az === "scollega") {
      const [a] = await righe(`strava_atleti?user_id=eq.${uid}&select=access_token`);
      if (a) await fetchImpl(`${STRAVA}/oauth/deauthorize`, { method: "POST", headers: { Authorization: `Bearer ${a.access_token}` } }).catch(() => null);
      await db(`strava_atleti?user_id=eq.${uid}`, { method: "DELETE" });
      return json({ ok: true });
    }
    const tk = await token(uid);
    if (!tk) return json({ errore: "non collegato" }, 404);
    if (az === "scarpe") {
      const r = await api(tk, "athlete");
      if (!r.ok) return json({ errore: "strava", stato: r.status }, 502);
      const a = await r.json();
      return json({ scarpe: (a.shoes || []).map((s) => ({ id: String(s.id), nome: s.name || s.nickname || "Scarpa", km: Math.round((s.distance || 0) / 100) / 10, ritirata: !!s.retired, principale: !!s.primary })) });
    }
    if (az === "gare") {
      const out = [];
      for (let p = 1; p <= 5; p++) {   // fino a 1.000 attività: basta per anni di corse
        const r = await api(tk, `athlete/activities?per_page=200&page=${p}`);
        if (!r.ok) return json({ errore: "strava", stato: r.status }, 502);
        const lista = await r.json();
        out.push(...lista.filter((a) => corsa(a) && a.workout_type === 1).map(voce));
        if (lista.length < 200) break;
      }
      return json({ gare: out });
    }
    if (az === "giorno") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(corpo.data || "")) return json({ errore: "data" }, 400);
      const t0 = Date.parse(corpo.data + "T00:00:00Z") / 1000;
      const r = await api(tk, `athlete/activities?after=${t0 - 86400}&before=${t0 + 2 * 86400}&per_page=50`);
      if (!r.ok) return json({ errore: "strava", stato: r.status }, 502);
      return json({ corse: (await r.json()).filter(corsa).map(voce).filter((a) => a.data === corpo.data) });
    }
    return json({ errore: "azione" }, 400);
  };
}
