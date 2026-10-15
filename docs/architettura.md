# Architettura di RaceBuddy

Una web app statica sul telefono, i dati pubblici su GitHub, i dati condivisi su Supabase.
Supabase fa anche da orologio: lancia tutti i job che aggiornano schede, novità, contenuti e notifiche.

Le schermate dell'app sono in [ui.md](ui.md); orari, token e operazioni manuali dei job in [job-programmati.md](job-programmati.md).

Colori: arancio = telefono, blu = GitHub, verde = Supabase, tratteggio = servizi esterni.

## 1. Quando usi l'app

![Quando usi l'app: telefono, GitHub Pages, Supabase e servizi esterni](img/architettura-app.svg)

- **GitHub Pages** serve il sito statico: `app/`, `content/` e `data/`. L'app scarica codice e dati JSON da lì.
- **Open-Meteo** dà previsioni e coordinate delle città; BigDataCloud trasforma la posizione GPS in città; Google Maps
  è solo un link alla partenza.
- **Supabase**: l'app chiama solo funzioni del database (`security definer`) con il codice segreto del telefono, di cui
  online va solo l'impronta. Servono per gare seguite, iscrizione alle notifiche, gruppo e contatori anonimi.
- **Strava** passa dalla Edge Function `strava`: i token di Strava restano su Supabase, mai sul telefono.

Le cose personali restano sul telefono. Online vanno solo i dati che servono a più persone o ai job.

## 2. Il ciclo automatico dei job

![Il ciclo dei job: pg_cron di Supabase, GitHub Actions, repo, Pages, notifiche](img/architettura-job.svg)

1. **pg_cron** di Supabase, alle ore fissate (in UTC), chiama l'API di GitHub con il token salvato nel **Vault** e fa
   partire il workflow.
2. Cinque job scrivono un file JSON e fanno commit su `main`:

   | Job | Legge da | Scrive |
   |---|---|---|
   | Esporta gare seguite | Supabase, `gare_aggiunte` | `data/gare_seguite.json` |
   | Schede gara (Claude Code) | gare seguite + siti ufficiali | `content/schede.json` |
   | Novità delle gare | feed dei siti, YouTube, riviste | `data/novita_gare.json` |
   | Contenuti | feed, video, podcast in italiano | `data/contenuti.json` |
   | Calendario gare | FIDAL (iCal e PDF) | `data/gare.json` |

3. Ogni push su `main` fa partire **"Pubblica web app"**: il sito su Pages si aggiorna e l'app legge i nuovi dati alla
   prossima apertura.
4. **Notifiche push** legge schede, novità e contenuti, le iscrizioni su Supabase e il meteo; applica le regole di non
   disturbo (`scripts/notifiche.js`) e invia con Web Push (VAPID) tramite i servizi di Apple, Google e Mozilla.
   Il service worker del telefono mostra la notifica. Su Supabase scrive lo stato di ogni iscrizione e i contatori degli invii.

Ogni job è in coda con sé stesso, quindi due giri dello stesso job non si sovrappongono.

## Dove stanno le cose

| Dove | Cosa |
|---|---|
| Telefono | profilo, preparazione e spunte; scarpe e personali (online solo se in classifica); tessera, certificato e foto; codice segreto del gruppo |
| GitHub (pubblico) | codice in `app/`, contenuti curati in `content/` (schede comprese), dati dei job in `data/`, workflow in `.github/workflows/` |
| Supabase | gare seguite, iscrizioni alle notifiche, gruppo, contatori anonimi, collegamenti Strava dei tester, calendario dei job |

### Segreti (mai nel codice)

| Dove | Segreti |
|---|---|
| GitHub Secrets | `SUPABASE_SECRET_KEY`, `VAPID_PRIVATE_KEY`, `SUPABASE_ACCESS_TOKEN`, `DISPATCH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| Supabase | `STRAVA_CLIENT_ID` e `STRAVA_CLIENT_SECRET` (segreti delle Edge Function), token GitHub nel Vault (`github_dispatch_token`) |

I disegni sono file SVG in `docs/img/`: seguono il tema chiaro o scuro del visualizzatore.
