// Test della funzione "strava" con Strava e database finti: node tests/test_strava.mjs
import assert from "node:assert";
import { crea, MAX_ATLETI } from "../supabase/functions/strava/gestisci.js";

const env = { SUPABASE_URL: "https://sb.test", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_ANON_KEY: "anon", STRAVA_CLIENT_ID: "123", STRAVA_CLIENT_SECRET: "segreto", APP_URL: "https://app.test/" };
const db = { strava_atleti: [], strava_stati: [] };
const chiamate = [];
let attivita = [], scarpe = [];
const risp = (corpo, status = 200, headers = {}) => new Response(corpo == null ? null : JSON.stringify(corpo), { status, headers });
const filtro = (rows, q) => { const p = new URLSearchParams(q); let out = rows; for (const [k, v] of p) { if (["select", "on_conflict"].includes(k)) continue; const [op, val] = v.split(/\.(.*)/); out = out.filter((r) => (op === "eq" ? String(r[k]) === decodeURIComponent(val) : op === "lt" ? String(r[k]) < val : true)); } return out; };

async function finto(url, opt = {}) {
  const u = new URL(url), metodo = opt.method || "GET", h = new Headers(opt.headers || {});
  chiamate.push(`${metodo} ${u.host}${u.pathname}`);
  if (u.host === "sb.test" && u.pathname === "/auth/v1/user") return h.get("authorization") === "Bearer jwt-luca" ? risp({ id: "u1" }) : risp({ msg: "no" }, 401);
  if (u.host === "sb.test" && u.pathname.startsWith("/rest/v1/")) {
    assert.strictEqual(h.get("apikey"), "service"); // solo con la chiave segreta
    const t = u.pathname.slice(9), q = u.search.slice(1);
    if (metodo === "GET") { const r = filtro(db[t], q); return risp(r, 200, { "content-range": `0-0/${db[t].length}` }); }
    if (metodo === "POST") { const v = JSON.parse(opt.body); if (q.includes("on_conflict")) db[t] = db[t].filter((r) => r.user_id !== v.user_id); db[t].push({ creato: new Date().toISOString(), ...v }); return risp(null, 201); }
    if (metodo === "DELETE") { const via = new Set(filtro(db[t], q)); db[t] = db[t].filter((r) => !via.has(r)); return risp(null, 204); }
    if (metodo === "PATCH") { for (const r of filtro(db[t], q)) Object.assign(r, JSON.parse(opt.body)); return risp(null, 204); }
  }
  if (u.host === "www.strava.com") {
    if (u.pathname === "/oauth/token") {
      const b = JSON.parse(opt.body); assert.strictEqual(b.client_secret, "segreto");
      if (b.grant_type === "authorization_code") return b.code === "buono" ? risp({ access_token: "acc1", refresh_token: "ref1", expires_at: Math.floor(Date.now() / 1000) + 21600, athlete: { id: 777 } }) : risp({}, 400);
      return risp({ access_token: "acc2", refresh_token: "ref2", expires_at: Math.floor(Date.now() / 1000) + 21600 });
    }
    if (u.pathname === "/oauth/deauthorize") return risp({});
    if (u.pathname === "/api/v3/athlete") return risp({ id: 777, shoes: scarpe });
    if (u.pathname === "/api/v3/athlete/activities") {
      const page = Number(u.searchParams.get("page") || 1), per = Number(u.searchParams.get("per_page"));
      return risp(attivita.slice((page - 1) * per, page * per));
    }
  }
  throw new Error("chiamata inattesa " + url);
}
const f = crea(env, finto);
const post = (corpo, jwt = "jwt-luca") => f(new Request("https://sb.test/functions/v1/strava", { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify(corpo) }));
const get = (q) => f(new Request(`https://sb.test/functions/v1/strava?${q}`));

// senza login, OPTIONS
assert.strictEqual((await post({ azione: "inizio" }, "sbagliato")).status, 401);
assert.strictEqual((await f(new Request("https://sb.test/functions/v1/strava", { method: "OPTIONS" }))).status, 204);

// inizio: link di autorizzazione con lo stato salvato
let r = await (await post({ azione: "inizio" })).json();
const link = new URL(r.url);
assert.strictEqual(link.host, "www.strava.com"); assert.strictEqual(link.searchParams.get("redirect_uri"), "https://sb.test/functions/v1/strava");
assert.ok(link.searchParams.get("scope").includes("activity:read"));
const stato = link.searchParams.get("state");
assert.strictEqual(db.strava_stati.length, 1); assert.strictEqual(db.strava_stati[0].user_id, "u1");

// ritorno: rifiuto, permessi mancanti, stato sconosciuto
let g = await get(`state=${stato}&error=access_denied`);
assert.strictEqual(g.headers.get("location"), "https://app.test/#/io?strava=negato");
r = await (await post({ azione: "inizio" })).json();
g = await get(`state=${new URL(r.url).searchParams.get("state")}&code=buono&scope=read`);
assert.ok(g.headers.get("location").endsWith("strava=permessi"));
g = await get(`state=inventato&code=buono&scope=read,activity:read,profile:read_all`);
assert.ok(g.headers.get("location").endsWith("strava=scaduto"));

// ritorno buono: token salvati solo nel database
r = await (await post({ azione: "inizio" })).json();
g = await get(`state=${new URL(r.url).searchParams.get("state")}&code=buono&scope=read,activity:read,profile:read_all`);
assert.ok(g.headers.get("location").endsWith("strava=ok"));
assert.strictEqual(db.strava_atleti.length, 1); assert.strictEqual(db.strava_atleti[0].athlete_id, 777); assert.strictEqual(db.strava_atleti[0].access_token, "acc1");
assert.strictEqual(db.strava_stati.length, 0, "stato consumato");

// scarpe: km e ritirate
scarpe = [{ id: "g1", name: "Pegasus 41", distance: 704321, primary: true }, { id: "g2", name: "Vecchie", distance: 900000, retired: true }];
r = await (await post({ azione: "scarpe" })).json();
assert.deepStrictEqual(r.scarpe[0], { id: "g1", nome: "Pegasus 41", km: 704.3, ritirata: false, principale: true });
assert.ok(r.scarpe[1].ritirata);

// token scaduto: si rinnova da solo
db.strava_atleti[0].scade = new Date(Date.now() - 1000).toISOString();
await post({ azione: "scarpe" });
assert.strictEqual(db.strava_atleti[0].access_token, "acc2");

// gare: solo corse segnate come gara, su più pagine
attivita = Array.from({ length: 230 }, (_, i) => ({ id: i, name: `Corsa ${i}`, sport_type: i % 3 ? "Run" : "Ride", workout_type: i % 10 === 1 ? 1 : 0, distance: 21200, elapsed_time: 6200, moving_time: 6100, start_date_local: "2026-03-01T09:00:00Z" }));
r = await (await post({ azione: "gare" })).json();
assert.ok(r.gare.length > 0 && r.gare.every((x) => x.gara)); assert.ok(r.gare.some((x) => Number(x.id) > 200), "seconda pagina letta");
assert.deepStrictEqual(Object.keys(r.gare[0]).sort(), ["data", "gara", "id", "metri", "movimento", "nome", "secondi"]);

// giorno: solo le corse di quel giorno
attivita = [{ id: 1, name: "Firenze Marathon", sport_type: "Run", workout_type: 1, distance: 42400, elapsed_time: 13325, moving_time: 13200, start_date_local: "2026-11-29T08:30:00Z" },
  { id: 2, name: "Riscaldamento", sport_type: "Run", distance: 2000, elapsed_time: 700, start_date_local: "2026-11-29T07:50:00Z" },
  { id: 3, name: "Defaticamento ieri", sport_type: "Run", distance: 3000, elapsed_time: 1000, start_date_local: "2026-11-28T18:00:00Z" }];
r = await (await post({ azione: "giorno", data: "2026-11-29" })).json();
assert.deepStrictEqual(r.corse.map((x) => x.id), ["1", "2"]);
assert.strictEqual((await post({ azione: "giorno", data: "ieri" })).status, 400);

// posti esauriti per un altro utente
db.strava_atleti.push(...Array.from({ length: MAX_ATLETI - 1 }, (_, i) => ({ user_id: `x${i}`, athlete_id: i, access_token: "a", refresh_token: "r", scade: new Date().toISOString() })));
const f2 = crea(env, async (url, opt) => (String(url).includes("/auth/v1/user") ? risp({ id: "nuovo" }) : finto(url, opt)));
r = await (await f2(new Request("https://sb.test/functions/v1/strava", { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ azione: "inizio" }) }))).json();
assert.deepStrictEqual(r, { pieno: true });
r = await (await post({ azione: "inizio" })).json();
assert.ok(r.url, "chi è già collegato può ricollegarsi");

// scollega: revoca e cancella
chiamate.length = 0;
r = await (await post({ azione: "scollega" })).json();
assert.ok(r.ok && chiamate.includes("POST www.strava.com/oauth/deauthorize"));
assert.ok(!db.strava_atleti.some((a) => a.user_id === "u1"));
assert.strictEqual((await post({ azione: "scarpe" })).status, 404);
console.log("ok");
