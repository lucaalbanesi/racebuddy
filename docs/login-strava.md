# Login e Strava: le operazioni manuali

Il codice è già online ma **spento**: in `app/config.js` ci sono `login: false` e `strava: false`.
Si accendono, uno alla volta, quando i passi qui sotto sono fatti. Nessun segreto va nel codice o in chat.

## 1. Database (SQL Editor di Supabase)

Esegui `docs/supabase_account.sql` (dopo gli altri script già eseguiti). Si può rilanciare.

## 2. Email dei codici con Brevo

1. Crea un account gratuito su brevo.com. In **Senders, Domains & Dedicated IPs** aggiungi e verifica il mittente
   (es. `racebuddy@…` o la tua email).
2. In **SMTP & API → SMTP** genera una **SMTP key**. Ti servono: server `smtp-relay.brevo.com`, porta `587`,
   login (quello mostrato da Brevo) e la chiave.
3. Supabase → **Authentication → Emails → SMTP Settings**: attiva "Custom SMTP" e inserisci server, porta, login,
   chiave, mittente e nome mittente "RaceBuddy".
4. Supabase → **Authentication → Rate Limits**: "emails sent per hour" a 30 (basta per il gruppo).

## 3. Login con codice di 6 cifre (Supabase)

1. **Authentication → Sign In / Providers → Email**: email attiva, **Email OTP expiration** a `600` (10 minuti),
   lunghezza del codice 6.
2. **Authentication → Emails → Templates**: nei modelli **Magic Link** e **Confirm signup** sostituisci il testo con:

   Oggetto: `Il tuo codice per RaceBuddy`

   ```html
   <p>Ciao!</p>
   <p>Il tuo codice per entrare in RaceBuddy è:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
   <p>Vale 10 minuti. Se non l'hai chiesto tu, ignora questa email.</p>
   ```

   Senza `{{ .Token }}` arriverebbe un link invece del codice, e su iPhone il link non entra nell'app installata.
3. **Authentication → URL Configuration**: Site URL `https://lucaalbanesi.github.io/racebuddy/`.
4. Accendi il login: in `app/config.js` metti `login: true` (lo faccio io quando mi dici che è pronto).
5. Prova: Io → Account → la tua email → codice → "Sei entrato". Dal secondo telefono, stesso login: ritrovi il gruppo.

## 4. Strava (dopo il login)

1. Su **strava.com/settings/api** crea l'app:
   - Application Name: `RaceBuddy` · Category: `Training` · Website: `https://lucaalbanesi.github.io/racebuddy/`
   - **Authorization Callback Domain**: `cjjtefepsyviazmimarz.supabase.co`
   - carica un'icona (puoi usare `app/icon-512.png`).
2. Annota **Client ID** e **Client Secret**.
3. Supabase → **Edge Functions → Secrets**: aggiungi `STRAVA_CLIENT_ID` e `STRAVA_CLIENT_SECRET`
   (facoltativo `APP_URL` se l'indirizzo dell'app cambia).
4. Pubblicazione della funzione: Supabase → **Account → Access Tokens** → crea un token, poi su GitHub
   **Settings → Secrets and variables → Actions** aggiungi `SUPABASE_ACCESS_TOKEN`. Lancia il workflow
   **"Pubblica funzioni Supabase"** (Actions → Run workflow): pubblica la funzione `strava`.
5. Su Strava, nelle impostazioni dell'app, porta la **capacità** da 1 a 10 atleti (tester).
6. Accendi Strava: in `app/config.js` metti `strava: true` (lo faccio io).
7. Prova: Io → Strava → Collega → autorizza su Strava (lascia spuntati profilo e attività) → torni in Io con
   "Strava collegato". In Le mie scarpe arrivano le scarpe di Strava; in I miei personali → "Cerca i miei personali su Strava".

## Cosa fa il codice, in breve

- **Account** (`supabase_account.sql`): il profilo del gruppo e l'iscrizione alle notifiche si legano all'account
  (`collega_account`); da un altro telefono, dopo il login, il profilo si ritrova (tabella `dispositivi`).
  `cancella_account` cancella profilo, telefoni, notifiche, Strava e l'account; se era l'unico amministratore,
  lo diventa il membro più vecchio.
- **Strava** (`supabase/functions/strava`): collegamento, scarpe, gare per i personali, corse del giorno della gara,
  scollegamento. I token di Strava restano nel database (`strava_atleti`), mai sul telefono. Al massimo 10 tester.
- **App**: la sessione del login sta in una chiave a parte del telefono (`racebuddy.account`), non nei dati dell'app.
