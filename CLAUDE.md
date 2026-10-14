# RaceBuddy – note per Claude

Progetto personale di Luca (Roma): una PWA che accompagna runner amatoriali verso la gara (10 km, mezza, maratona).
Nasce per il suo gruppo di amici/società (pochi utenti), ma deve poter crescere. Online: https://lucaalbanesi.github.io/racebuddy/

## Principi (non negoziabili)
- Tutto in italiano, prodotto e contenuti. Fonti esterne (feed, canali, podcast) solo in italiano.
- Il buddy dice cosa provare, mai quanto correre: nessuna prescrizione di allenamento, nessuna diagnosi, nessun consiglio personalizzato su integratori. Niente contenuti su diete/dimagrimento.
- Dati Strava (quando arriveranno): solo all'utente stesso, mai in prompt o funzioni AI.
- Segreti solo nei GitHub Secrets (`SUPABASE_SECRET_KEY`, `VAPID_PRIVATE_KEY`), mai nel codice o in chat. In `app/config.js` solo valori pubblici (URL Supabase, chiave publishable, chiave pubblica VAPID).
- Privacy: profilo, preparazione, spunte, scarpe, personali (online solo se in classifica: tempo, gara, data), documenti (tessera, certificato medico e foto) restano sul telefono (localStorage / IndexedDB). Online va solo il minimo necessario (vedi sotto).
- Manutenzione bassa: HTML/JS statico senza build né dipendenze, Supabase piano gratuito, GitHub Actions per i job.
- Prima di pubblicare: prova nel browser a larghezza telefono (390px), `node tests/test_logic.js`, `node tests/test_notifiche.js`.

## Struttura
- `app/` – la web app: `index.html`, `app.js` (viste, router a hash, azioni), `logic.js` (funzioni pure, testate), `style.css`, `sw.js` (service worker per le push, nessuna cache), `config.js`, `chiavi.html` (genera chiavi VAPID nel browser), icone.
- `content/` – contenuti curati: `fasi.json`, `percorso.json` (voci della preparazione; `notifica: true` = tappe chiave che generano push), `pillole.json`, `sorrisi.json` (battute originali), `schede.json` (info gara dai siti ufficiali), `fonti.json`.
- `data/` – dati generati dai job: `gare.json` (calendario), `gare_seguite.json`, `contenuti.json`, `fonti_verificate.json`.
- `scripts/` – `import_fidal.py` (iCal FIDAL + PDF maratone/mezze anno successivo), `esporta_seguite.py`, `importa_contenuti.py` (feed → etichette fase/distanza/argomento), `notifiche.js` (regole push, pure), `invia_push.js` (invio), `verifica_fonti.py`.
- `docs/` – `schede-gara.md` (procedura delle schede), `supabase.sql` (gare_aggiunte, push_iscrizioni), `supabase_gruppo.sql` (gruppo), migrazioni una tantum `supabase_gruppo_senza_ritrovi.sql` e `supabase_gruppo_personali.sql` (provata nel workflow "Test database gruppo").
- Deploy: push su `main` → workflow "Pubblica web app" → GitHub Pages. I file sono versionati con `?v=<sha>`.

## Architettura dell'app (barra: Oggi · Gare · Per te · Gruppo · Io)
- Oggi: gara in evidenza (conto alla rovescia, fasi, link La gara/Preparazione/Borsa), avvisi documenti, meteo e vestizione, momento, da fare oggi, pillola, Per te. Senza gare: invito a scegliere la gara + meteo, sorriso, pillola di stagione, contenuti.
- La gara (`#/gara/:id`): Panoramica (riassunto e rimandi) + sezioni `preparazione`, `info` (logistica, percorso di gara, meteo, fonti), `borsa` (checklist, vestizione, mattina della gara). Barra a segmenti in alto, freccia indietro → Panoramica. "Preparazione" = percorso di avvicinamento; "percorso" = solo il tracciato di gara.
- Per te: articoli/video/podcast classificati per fase e distanza (ranking sul telefono), sorrisi.
- Gruppo: invito con codice, ruoli admin/organizzatore (vede e condivide l'invito)/membro, gare in comune, bacheca con applausi, classifica dei personali (sezione sua, da `pb_membri`: un PB per persona e distanza, solo per chi sceglie di comparire), pagina di gestione. Identità senza account: token casuale sul telefono, online solo l'hash.
- I tuoi personali (`#/pb`): PB su 10/21/42 inseriti a mano (anche di gare passate) o aggiornati da "Com'è andata?"; tempo in tre caselle ore · min · sec (tastiera numerica, avanti da sole), controllato da `L.tempoDaParti` + `L.leggiTempo`. Invito al primo avvio (benvenuto) e una volta in Oggi.
- Benvenuto (primo avvio, rivedibile da Io): 5 schermate dimostrative – La preparazione (conto alla rovescia animato, fasi, oggi + contenuto), Meteo e avvisi, La gara, Il gruppo (primi 3 dei personali + chi corre la gara), Partiamo (gara · personali · invito).
- Io: sezioni a fisarmonica (Profilo con GPS, Tessera e certificato, Notifiche con preferenze, Gruppo, I miei personali, Scarpe), strumenti di prova (data simulata), tutorial.

## Online (Supabase + Actions)
- `gare_aggiunte`: l'app segnala le gare seguite (solo dati pubblici della gara). Ogni notte `esporta_seguite.py` → `data/gare_seguite.json`.
- Schede gara: attività programmata di Claude ogni mattina (5:53) secondo `docs/schede-gara.md`, pubblicazione automatica su `main`.
- `push_iscrizioni`: iscrizione push + dati minimi (ora uscita, zona ~1 km, gare, spunte, preferenze, date di scadenza documenti) e `stato` per le regole di non disturbo.
- Tabelle del gruppo: accesso solo tramite funzioni `security definer` con il token (vedi `docs/supabase_gruppo.sql`, testate in `tests/test_gruppo.sql` con il workflow "Test database gruppo").

## Notifiche push (regole in `scripts/notifiche.js`)
- Solo novità, mai countdown né doppioni; al mattino max 1 (un'ora prima dell'uscita; chi esce dopo le 12 alle 7). Mai di notte.
- Ordine: scheda gara cambiata/pronta, scadenze documenti (30/15/2 gg), cose rimandate, tappe chiave, meteo gara (prima volta a 7 gg e se cambia molto), meteo uscita solo se cambia davvero (max 2 a settimana, stesso avviso non ripetuto).
- Vigilia alle 19, mattina di gara 2 ore prima della partenza. Il gruppo non manda notifiche (i ritrovi sono stati tolti a ottobre 2026).

## Note operative
- Dall'ambiente cloud di Claude non si raggiungono fidal.it, supabase.co né github.io: le verifiche passano da GitHub Actions (es. workflow "Verifica collegamento Supabase"; errori leggibili come annotazioni dei job).
- Pull request via REST (`gh api`), non `gh pr create` (GraphQL bloccato).
- Commit come "Luca Albanesi <luca.alba8@gmail.com>".
