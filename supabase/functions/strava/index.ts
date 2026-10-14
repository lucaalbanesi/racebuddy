// Supabase Edge Function "strava": l'involucro per Deno. Tutta la logica è in gestisci.js (provata in tests/test_strava.mjs).
// Segreti (Supabase → Edge Functions → Secrets): STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, APP_URL (facoltativo).
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY li mette Supabase da solo.
import { crea } from "./gestisci.js";

// Le variabili si leggono una per una: è il modo documentato da Supabase, e si legge solo quello che serve.
const NOMI = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "APP_URL", "APP_ORIGIN"];
const env = Object.fromEntries(NOMI.map((n) => [n, (Deno.env.get(n) || "").trim()]));

Deno.serve(crea(env));
