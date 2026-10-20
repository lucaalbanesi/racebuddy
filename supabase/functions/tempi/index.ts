// Supabase Edge Function "tempi": l'involucro per Deno. Tutta la logica è in cerca.js (provata in tests/test_tempi.mjs).
// Legge solo pagine pubbliche (Gare Podistiche Lazio e FIDAL). Per l'azione "certifica" (classifiche del gruppo) scrive i
// risultati scelti nel database: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY li mette Supabase da solo, nessun segreto da aggiungere.
import { crea } from "./cerca.js";

const env = Object.fromEntries(["APP_ORIGIN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].map((n) => [n, (Deno.env.get(n) || "").trim()]));
Deno.serve(crea(env));
