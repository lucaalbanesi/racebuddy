/* Configurazione pubblica dell'app. La chiave "publishable" di Supabase è fatta per stare nel browser:
   i permessi sono limitati dalle regole del database (solo aggiunta e lettura delle gare segnalate).
   Qui NON vanno mai la secret key / service_role né password. */
window.RB_CONFIG = {
  supabaseUrl: "https://cjjtefepsyviazmimarz.supabase.co",
  supabaseKey: "sb_publishable_CgobJLAyW_dDIUAJxtaN-w_Yjr9vXoo",
  // Chiave pubblica per le notifiche push (la privata è solo nei GitHub Secrets).
  vapidPublic: "BJyKMwWISnW3fvymSckSRbscGl2DmTIMin0stisNCgwRUiGCfNVZqFLako75Djg5MATIa7nN4NNLgmQJH-_D9tc",
};
