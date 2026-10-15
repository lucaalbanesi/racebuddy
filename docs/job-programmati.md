# Job programmati: come funzionano e le operazioni manuali

Tutti i job partono da **Supabase** (pg_cron), che li lancia su GitHub Actions con l'API (workflow_dispatch).
Il cron di GitHub salta e ritarda i giri, quindi non si usa più, tranne come riserva su "Notifiche push".
Nessun segreto va nel codice o in chat.

## I job e gli orari

Orari fissati in UTC dentro Supabase (`docs/supabase_cron.sql`). A Roma sono +2 ore con l'ora legale e +1 con l'ora solare
(dal 25 ottobre 2026 i job partono un'ora prima rispetto all'orologio di Roma).

| Job (workflow) | UTC | Roma, ora legale | Cosa fa |
|---|---|---|---|
| Esporta gare seguite (`seguite.yml`) | 3:23 | 5:23 | gare seguite dall'app → `data/gare_seguite.json` |
| Schede gara (`schede.yml`) | 3:53 | 5:53 | Claude Code compila le schede → `content/schede.json` |
| Novità delle gare (`novita.yml`) | ogni ora :50, 3-19 | 5:50-21:50 | novità ufficiali → `data/novita_gare.json` |
| Notifiche push (`push.yml`) | :07 e :37, 3-20 | 5:07-22:37 | messaggio del mattino, vigilia, gara, novità urgenti |
| Aggiorna contenuti (`contenuti.yml`) | 4:41 e 15:41 | 6:41 e 17:41 | articoli, video, podcast → `data/contenuti.json` |
| Aggiorna calendario gare (`calendario.yml`) | lunedì 4:17 | lunedì 6:17 | calendario FIDAL → `data/gare.json` |

Ogni job è in coda con sé stesso: due giri dello stesso job non si sovrappongono mai.

### Dove vedo cosa è successo
- **Actions** su GitHub: ogni giro con la spunta verde o la X rossa; i giri lanciati da Supabase risultano "workflow_dispatch".
- **Notifiche push**: in ogni giro l'annotazione "Invii notifiche" (iscritti, inviati per tipo, falliti). Gialla se qualcosa è fallito.
- **Schede gara**: il riepilogo arriva come commento sull'issue **"Riepilogo schede gara"** (notifica GitHub, app o email)
  e nella pagina del giro.

## Come è fatto l'innesco
- Funzione `racebuddy_lancia(workflow)` su Supabase: chiama l'API di GitHub con il token salvato nel **Vault**
  (segreto `github_dispatch_token`).
- Calendario: tabella `cron.job`, righe `racebuddy-*`.
- Tutto si installa (e si reinstalla) con il workflow **"Innesco job (Supabase)"** (`innesco-push.yml`), che legge
  `docs/supabase_cron.sql`, mette il token nel Vault e fa una chiamata di prova. Si può rilanciare quante volte si vuole.

## Operazione da fare ora: token di Claude per le schede gara

Le schede gara girano con **Claude Code in GitHub Actions**, con il tuo abbonamento Claude. Serve un token.

1. **Crea il token** sul computer dove hai Claude Code: nel terminale lancia
   ```
   claude setup-token
   ```
   Si apre il browser: entra con il tuo account Claude e autorizza. Nel terminale compare il token
   (una lunga stringa che inizia con `sk-ant-oat`). Copialo.
2. **Salvalo su GitHub**: repo racebuddy → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `CLAUDE_CODE_OAUTH_TOKEN`
   - Secret: il token copiato → **Add secret**
3. **Dimmelo in chat.** Io poi:
   - lancio un giro di prova di "Schede gara" e controllo commit e riepilogo;
   - se va bene, disattivo la vecchia attività programmata di Claude delle 5:53 (fino ad allora resta attiva,
     così le schede si aggiornano comunque e non partono mai due giri insieme);
   - rilancio "Innesco job (Supabase)" per mettere le schede nel calendario di Supabase.

Se vuoi provarlo tu: Actions → **"Schede gara"** → Run workflow. Il campo "Indicazione in più" è facoltativo
(es. "dai priorità alla Firenze Marathon").

## Manutenzione: i token che scadono

| Secret su GitHub | A cosa serve | Come si rinnova |
|---|---|---|
| `DISPATCH_TOKEN` | Supabase lancia i workflow | GitHub → Settings → Developer settings → Fine-grained tokens → token di racebuddy → **Regenerate** (stessi permessi: solo repo racebuddy, Actions: Read and write). Aggiorna il secret, poi Actions → **"Innesco job (Supabase)"** → Run workflow |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code nelle schede gara | `claude setup-token` sul computer, poi aggiorna il secret. Non serve rilanciare nulla |
| `SUPABASE_ACCESS_TOKEN` | installare l'innesco e pubblicare le funzioni | Supabase → Account → Access Tokens, poi aggiorna il secret |

Segnali che un token è scaduto:
- **DISPATCH_TOKEN**: in Actions non compaiono più giri nuovi (nessun job parte). Rilanciando "Innesco job (Supabase)"
  il passo "Il token può lanciare il workflow?" diventa rosso.
- **CLAUDE_CODE_OAUTH_TOKEN**: il giro di "Schede gara" è rosso e l'issue "Riepilogo schede gara" riceve un commento
  "Il giro non è andato a buon fine".

## Aggiungere o spostare un job
1. Il workflow deve avere `workflow_dispatch:` tra gli eventi (e niente `schedule:`).
2. Aggiungi o modifica la riga `cron.schedule(...)` in `docs/supabase_cron.sql` (orario in UTC).
3. Actions → **"Innesco job (Supabase)"** → Run workflow. Nel passo "Cron registrati" trovi l'elenco aggiornato.
