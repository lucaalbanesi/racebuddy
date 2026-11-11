/* Configurazione pubblica dell'app. La chiave "publishable" di Supabase è fatta per stare nel browser:
   i permessi sono limitati dalle regole del database (solo aggiunta e lettura delle gare segnalate).
   Qui NON vanno mai la secret key / service_role né password. */
window.RB_CONFIG = {
  supabaseUrl: "https://cjjtefepsyviazmimarz.supabase.co",
  supabaseKey: "sb_publishable_CgobJLAyW_dDIUAJxtaN-w_Yjr9vXoo",
  // Chiave pubblica per le notifiche push (la privata è solo nei GitHub Secrets).
  vapidPublic: "BJyKMwWISnW3fvymSckSRbscGl2DmTIMin0stisNCgwRUiGCfNVZqFLako75Djg5MATIa7nN4NNLgmQJH-_D9tc",
  // Login con email e codice (Supabase Auth) e integrazione Strava: si accendono quando la configurazione manuale è fatta
  // (vedi docs/login-strava.md).
  login: false,
  strava: true,
  // Tempi dalle classifiche (Gare Podistiche Lazio e FIDAL) con la Edge Function "tempi".
  tempi: true,
  // Buddy, la chat AI su scarpe, integratori e allenamento (Edge Function "buddy", Groq).
  buddy: true,
  // Classifiche del gruppo (fase 1: Gare corse, PB della stagione, Albo d'oro con i tempi certificati). Restano spente
  // finché l'amministratore non le accende in Gestione; servono docs/supabase_classifiche.sql e la funzione "tempi".
  classifiche: true,
};
