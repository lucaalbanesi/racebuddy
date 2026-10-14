# RaceBuddy – note per Claude

- Progetto personale di Luca: web app (PWA, GitHub Pages) + bot Telegram per accompagnare runner amatoriali nella preparazione di 10 km, mezza e maratona.
- Lingua del prodotto e dei contenuti: italiano. Le fonti esterne (feed, canali, podcast) solo in italiano.
- Il cuore è il percorso legato alla data della gara (`content/percorso.json`), con la checklist pre-gara come capitolo finale. Più gare per utente, con ruolo: obiettivo, tappa, divertimento.
- Il buddy dice cosa provare, mai quanto correre: nessuna prescrizione di allenamento, nessuna diagnosi, nessun consiglio personalizzato su integratori.
- Dati Strava: solo all'utente stesso, mai in prompt o funzioni AI (regole API Strava).
- Segreti (token Telegram, chiavi Supabase) solo nei GitHub Secrets, mai nel codice o in chat.
- Stack: HTML/JS statico senza build, Supabase (piano gratuito), GitHub Actions per i job programmati.
- Tenere bassa la manutenzione: preferire soluzioni senza server e senza dipendenze.
