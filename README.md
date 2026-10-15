# RaceBuddy

Il compagno del runner amatoriale per la preparazione di una gara, dal 10 km alla maratona: scegli la gara e il buddy costruisce il tuo percorso, settimana per settimana, fino alla checklist del giorno gara.

Nasce per un gruppo di amici che corrono insieme ed è pensato per crescere.

## Cosa c'è qui

| Cartella | Contenuto |
| --- | --- |
| `content/` | Contenuti approvati: `fasi.json`, `percorso.json` (momenti, cose da fare, checklist), `pillole.json` |
| `data/gare.json` | Calendario delle gare su strada (10 km, mezza, maratona), aggiornato ogni settimana dal calendario FIDAL |
| `scripts/import_fidal.py` | Importatore del calendario FIDAL |
| `tests/` | Test dell'importatore |
| `.github/workflows/calendario.yml` | Aggiornamento automatico del calendario, ogni lunedì |

## Documentazione

- [Architettura](docs/architettura.md): componenti, flussi e ciclo automatico dei job, con i disegni
- [Interfaccia](docs/ui.md): le schermate dell'app a larghezza telefono
- [Job programmati](docs/job-programmati.md): orari, innesco da Supabase, token e operazioni manuali
- [Schede gara](docs/schede-gara.md): la procedura con cui Claude compila le info gara
- [Strava e login](docs/login-strava.md): operazioni manuali per accenderli

## Come si leggono i giorni

Nel percorso ogni voce ha un giorno per distanza (`10`, `21`, `42`), contato rispetto alla gara: `0` è il giorno gara, `-7` una settimana prima, `+3` tre giorni dopo. `null` vuol dire che la voce non vale per quella distanza.

## Aggiornare il calendario a mano

Dalla scheda **Actions** del repository: **Aggiorna calendario gare → Run workflow**.

## Avvertenza

RaceBuddy dà indicazioni generali per runner amatoriali in salute. Non sostituisce il parere di un medico, di un nutrizionista o di un allenatore.

Dati gare: [calendario FIDAL](https://www.fidal.it/calendario.php).
