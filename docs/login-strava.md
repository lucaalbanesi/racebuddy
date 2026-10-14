# Strava (e login): le operazioni manuali

Il codice è già online ma **spento**: in `app/config.js` ci sono `strava: false` e `login: false`.
Si accendono quando i passi qui sotto sono fatti. Nessun segreto va nel codice o in chat.

## Strava (non serve il login)

Il collegamento a Strava è legato al codice segreto del telefono, lo stesso del gruppo: online ne va solo l'impronta.

1. **Database** (SQL Editor di Supabase): esegui `docs/supabase_strava.sql`. Poi riesegui anche
   `docs/supabase_account.sql` (aggiornato: non tocca più le tabelle di Strava). Si possono rilanciare.
2. **App su Strava**: su **strava.com/settings/api** crea l'app:
   - Application Name: `RaceBuddy` · Category: `Training` · Website: `https://lucaalbanesi.github.io/racebuddy/`
   - **Authorization Callback Domain**: `cjjtefepsyviazmimarz.supabase.co`
   - icona: puoi usare `app/icon-512.png`.
   Annota **Client ID** e **Client Secret**.
3. **Segreti della funzione**: su GitHub (**Settings → Secrets and variables → Actions**) aggiungi `STRAVA_CLIENT_ID` e
   `STRAVA_CLIENT_SECRET`: il workflow "Pubblica funzioni Supabase" li copia nel progetto Supabase giusto. (In alternativa:
   Supabase → Edge Functions → Secrets del progetto `cjjtefepsyviazmimarz`.)
4. **Pubblicazione della funzione**: Supabase → **Account → Access Tokens** → crea un token; su GitHub
   **Settings → Secrets and variables → Actions** aggiungi `SUPABASE_ACCESS_TOKEN`. Poi Actions →
   **"Pubblica funzioni Supabase"** → Run workflow.
5. **Capacità**: nelle impostazioni dell'app su Strava porta la capacità da 1 a 10 atleti.
6. Dimmelo: metto `strava: true` in `app/config.js` e proviamo insieme dal tuo telefono
   (Io → Strava → Collega → autorizza lasciando spuntati profilo e attività).

### Come funziona
- Funzione `strava` (`supabase/functions/strava`): collegamento, scarpe, gare per i personali, corse del giorno della gara,
  scollegamento. I token di Strava restano nel database (`strava_atleti`), mai sul telefono. Al massimo 10 tester.
- Se i dati del telefono si cancellano, basta ricollegare Strava: lo stesso atleta prende il posto del collegamento
  vecchio (anche a posti pieni, con "Sei già tester e hai cambiato telefono? Ricollegati").
- "Cancella tutti i miei dati" scollega anche Strava.

## Login con email e codice (rimandato)

Pronto nel codice ma spento, finché non c'è un mittente per le email (dominio o Gmail dedicata).
Quando si riprende:
1. `docs/supabase_account.sql` (già eseguito).
2. Brevo: account, mittente verificato, chiave SMTP → Supabase **Authentication → Emails → SMTP Settings**
   (server `smtp-relay.brevo.com`, porta 587); Rate Limits: 30 email all'ora.
3. Supabase **Authentication → Sign In / Providers → Email**: Email OTP expiration `600`.
   **Emails → Templates** "Magic Link" e "Confirm signup": oggetto `Il tuo codice per RaceBuddy`, testo con `{{ .Token }}`:
   ```html
   <p>Ciao!</p>
   <p>Il tuo codice per entrare in RaceBuddy è:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>Vale 10 minuti. Se non l'hai chiesto tu, ignora questa email.</p>
   ```
4. `login: true` in `app/config.js`.
