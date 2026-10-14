// Supabase Edge Function "strava": l'involucro per Deno. Tutta la logica è in gestisci.js (provata in tests/test_strava.mjs).
// Segreti (Supabase → Edge Functions → Secrets): STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, APP_URL (facoltativo).
// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY li mette Supabase da solo.
import { crea } from "./gestisci.js";

Deno.serve(crea(Deno.env.toObject()));
