# Job programmati: come funzionano e le operazioni manuali

Tutti i job partono da **Supabase** (pg_cron), che li lancia su GitHub Actions con l'API (workflow_dispatch).
Il cron di GitHub salta e ritarda i giri, quindi non si usa più, tranne come riserva su "Notifiche push".
Nessun segreto va nel codice o in chat.

## I job e gli orari

Orari fissati in UTC dentro Supabase (`docs/supabase_cron.sql`). A Roma sono +2 ore con l'ora legale e +1 con l'ora solare
(dal 25 ottobre 2026 i job partono un'ora prima rispetto all'orologio di Roma).

| Job (workflow) | UTC | Roma, ora legale | Claude | Cosa fa |
|---|---|---|---|---|
| Esporta gare seguite (`seguite.yml`) | 3:23 | 5:23 | – | gare seguite dall'app → `data/gare_seguite.json` |
| Schede gara (`schede.yml`) | 3:53 | 5:53 | **sì** | Claude Code compila e ricontrolla le schede dai siti ufficiali (al massimo 8 gare per giro, limite 40 min) → `content/schede.json` |
| Novità delle gare (`novita.yml`) | ogni ora :50, 3-19 | 5:50-21:50 | – | novità ufficiali, tema e urgenza decisi con regole → `data/novita_gare.json` |
| Notifiche push (`push.yml`) | :07 e :37, 3-20 | 5:07-22:37 | – | messaggio del mattino, vigilia, gara, novità urgenti |
| Aggiorna contenuti (`contenuti.yml`) | 4:41 e 15:41 | 6:41 e 17:41 | – | articoli e video dai feed → `data/contenuti.json` |
| Aggiorna calendario gare (`calendario.yml`) | lunedì 4:17 | lunedì 6:17 | – | calendario FIDAL + Gare Podistiche Lazio → `data/gare.json` |
| Gare estere (`estero.yml`) | giorno 1 alle 4:29 | giorno 1 alle 6:29 | **sì** | Claude Code aggiorna date ufficiali, iscrizioni e ballottaggi (limite 60 min) → `content/estero.json` |
| Catalogo scarpe (`scarpe.yml`) | giorno 15 alle 4:31 | giorno 15 alle 5:31 (6:31 con l'ora legale) | **sì** | Claude Code aggiorna prezzi, dati e modelli del catalogo della Scarpiera da Runnea e RunRepeat (limite 60 min) → `content/scarpe.json` |
| Controllo salute (`salute.yml`) | ogni ora :41, 4-21 | 6:41-23:41 | – | controlla job, dati e servizi → `salute_controlli` in Supabase, pagina `#/salute`, push al superamministratore solo se KO; se non gira è Supabase giù (lo dice la pagina) |

Solo **Schede gara**, **Gare estere** e **Catalogo scarpe** usano Claude (Claude Code in GitHub Actions con l'abbonamento di Luca, secret
`CLAUDE_CODE_OAUTH_TOKEN`). Claude modifica solo il proprio file di dati e scrive messaggio di commit e riepilogo;
controllo del JSON, commit e riepilogo sull'issue li fa il workflow. Tutti gli altri job sono script senza AI.

Ogni job è in coda con sé stesso: due giri dello stesso job non si sovrappongono mai.

### Job non programmati (si lanciano a mano o partono da soli)

| Job (workflow) | Quando parte | Claude | Cosa fa |
|---|---|---|---|
| Pubblica web app (`pages.yml`) | push su `main` (app, contenuti, dati) e dopo il calendario | – | test della logica e pubblicazione su GitHub Pages |
| Pubblica funzioni Supabase (`funzioni.yml`) | push sulle funzioni o a mano | – | applica i contatori del Buddy e le statistiche, pubblica le Edge Function `tempi`, `strava` e `buddy`, prova `tempi` e la quota del `buddy` dal vivo |
| Foto delle città (`foto-citta.yml`) | push sul ramo `foto-citta` o a mano | – | cerca su Wikimedia Commons foto CC0/pubblico dominio delle città (`content/foto_ricerca.json`): provini in `foto_candidati/`, scarica quelle con `file` in `content/sfondi/` + `sfondi.json`. La scelta si fa a vista in chat con Claude; il ramo poi va su `main` senza i provini |
| Verifica fonti contenuti (`fonti.yml`) | a mano | – | controlla che i feed dei contenuti rispondano → `data/fonti_verificate.json` |
| Innesco job (Supabase) (`innesco-push.yml`) | a mano | – | installa calendario e token dell'innesco su Supabase (vedi sotto) |
| Verifica collegamento Supabase (`supabase-verifica.yml`) | a mano | – | prova il collegamento a Supabase |
| Test database gruppo (`test-db.yml`) | push sui file SQL o a mano | – | prova le funzioni del gruppo su un database di test |

### Dove vedo cosa è successo
- **Stato dell'app** (Io → Strumenti di prova → Stato dell'app, solo sul telefono del superamministratore): l'ultimo controllo orario di job, dati e servizi, gli ultimi 24 esiti e gli avvisi push su questo telefono (solo quando qualcosa è KO).
- **Actions** su GitHub: ogni giro con la spunta verde o la X rossa; i giri lanciati da Supabase risultano "workflow_dispatch".
- **Notifiche push**: in ogni giro l'annotazione "Invii notifiche" (iscritti, inviati per tipo, falliti). Gialla se qualcosa è fallito.
- **Schede gara** e **Gare estere**: il riepilogo arriva come commento sulle issue **"Riepilogo schede gara"** e
  **"Riepilogo gare estere"** (notifica GitHub, app o email) e nella pagina del giro.

## Come è fatto l'innesco
- Funzione `racebuddy_lancia(workflow)` su Supabase: chiama l'API di GitHub con il token salvato nel **Vault**
  (segreto `github_dispatch_token`).
- Calendario: tabella `cron.job`, righe `racebuddy-*`.
- Tutto si installa (e si reinstalla) con il workflow **"Innesco job (Supabase)"** (`innesco-push.yml`), che legge
  `docs/supabase_cron.sql`, mette il token nel Vault e fa una chiamata di prova. Si può rilanciare quante volte si vuole.

## Il token di Claude (schede gara e gare estere)

Il token è già installato (secret `CLAUDE_CODE_OAUTH_TOKEN`). Per crearne uno nuovo:

1. Sul computer dove hai Claude Code, nel terminale: `claude setup-token`. Si apre il browser: entra con il tuo account
   Claude e autorizza. Nel terminale compare il token (inizia con `sk-ant-oat`).
   Il terminale lo mostra spezzato su due righe: incollalo prima in un editor, unisci le righe e controlla che non ci
   siano spazi. Deve essere **una riga sola**.
2. GitHub, repo racebuddy → **Settings → Secrets and variables → Actions** → `CLAUDE_CODE_OAUTH_TOKEN` → Update.

Per un giro a mano: Actions → **"Schede gara"** (o **"Gare estere"**) → Run workflow. Il campo "Indicazione in più" è
facoltativo (es. "dai priorità alla Firenze Marathon").

## Manutenzione: i token che scadono

| Secret su GitHub | A cosa serve | Come si rinnova |
|---|---|---|
| `DISPATCH_TOKEN` | Supabase lancia i workflow | GitHub → Settings → Developer settings → Fine-grained tokens → token di racebuddy → **Regenerate** (stessi permessi: solo repo racebuddy, Actions: Read and write). Aggiorna il secret, poi Actions → **"Innesco job (Supabase)"** → Run workflow |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code in schede gara e gare estere | `claude setup-token` sul computer, poi aggiorna il secret. Non serve rilanciare nulla |
| `GROQ_API_KEY` (in **Supabase** → Edge Functions → Secrets, non su GitHub) | il Buddy, la chat AI dell'app (piano gratuito di Groq) | console.groq.com → API Keys → nuova chiave, poi aggiorna il segreto in Supabase. Non serve ripubblicare |
| `SUPABASE_ACCESS_TOKEN` | installare l'innesco e pubblicare le funzioni | Supabase → Account → Access Tokens, poi aggiorna il secret |

Segnali che un token è scaduto:
- **DISPATCH_TOKEN**: in Actions non compaiono più giri nuovi (nessun job parte). Rilanciando "Innesco job (Supabase)"
  il passo "Il token può lanciare il workflow?" diventa rosso.
- **CLAUDE_CODE_OAUTH_TOKEN**: i giri di "Schede gara" e "Gare estere" sono rossi e le issue di riepilogo ricevono un
  commento "Il giro non è andato a buon fine".

## Aggiungere o spostare un job
1. Il workflow deve avere `workflow_dispatch:` tra gli eventi (e niente `schedule:`).
2. Aggiungi o modifica la riga `cron.schedule(...)` in `docs/supabase_cron.sql` (orario in UTC).
3. Actions → **"Innesco job (Supabase)"** → Run workflow. Nel passo "Cron registrati" trovi l'elenco aggiornato.
