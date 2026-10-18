// Supabase Edge Function "tempi": l'involucro per Deno. Tutta la logica è in cerca.js (provata in tests/test_tempi.mjs).
// Nessun segreto: legge solo pagine pubbliche (Gare Podistiche Lazio e FIDAL) e non salva niente.
import { crea } from "./cerca.js";

Deno.serve(crea({ APP_ORIGIN: (Deno.env.get("APP_ORIGIN") || "").trim() }));
