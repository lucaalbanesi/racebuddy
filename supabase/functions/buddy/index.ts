// Supabase Edge Function "buddy": l'involucro per Deno. Tutta la logica è in gestisci.js (provata in tests/test_buddy.mjs).
// Segreti (Supabase → Edge Functions → Secrets): GROQ_API_KEY; facoltativi BUDDY_MODELLO, BUDDY_BUDGET, APP_ORIGIN.
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY li mette Supabase da solo.
import { crea } from "./gestisci.js";

const NOMI = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GROQ_API_KEY", "BUDDY_MODELLO", "BUDDY_BUDGET", "BUDDY_BUDGET_TOKEN", "BUDDY_QUOTA", "APP_ORIGIN"];
const env: Record<string, unknown> = Object.fromEntries(NOMI.map((n) => [n, (Deno.env.get(n) || "").trim()]));
if (env.BUDDY_QUOTA === "") delete env.BUDDY_QUOTA; // non impostato: vale QUOTA_TEST di gestisci.js

Deno.serve(crea(env));
