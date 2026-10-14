# Schede gara: come si compilano e si tengono aggiornate

Procedura seguita dall'attività programmata di Claude. Una scheda raccoglie le informazioni pratiche di una gara,
prese **solo dal sito ufficiale dell'organizzatore** (o dai documenti che pubblica: regolamento, guida
dell'atleta, PDF), e vale per tutti gli utenti che seguono quella gara.

## Ingressi e uscite

- Ingresso: `data/gare_seguite.json` (gare aggiunte dagli utenti, esportate ogni notte da Supabase).
- Uscita: `content/schede.json`, un oggetto con chiave = id della gara.
- Pubblicazione: **con approvazione**. Le modifiche vanno su un ramo `schede/AAAA-MM-GG` e in una pull request
  verso `main`; vanno online solo quando Luca la approva. Mai committare direttamente su `main`.

## Formato di una scheda

```json
"COD14816-42": {
  "partenza": "8:30",
  "luogoPartenza": "Partenza Lungarno …, arrivo Piazza …",
  "pettorale": "Expo …, venerdì 10-19 e sabato 9-19. Serve documento e certificato.",
  "griglia": "Griglie per tempo dichiarato, chiusura 8:10",
  "deposito": "…, fino alle 8:00",
  "ristori": "Ogni 5 km acqua e sali; gel al 25° km",
  "arrivare": "…",
  "sito": "https://…",
  "note": "…",
  "fonti": ["https://… pagina usata", "https://… regolamento.pdf"],
  "verificato": "2026-10-15",
  "edizione": "2026"
}
```

Tutti i campi testuali sono facoltativi: **un campo si scrive solo se l'informazione è sul sito ufficiale per
l'edizione in corso**. Se non si trova, il campo resta assente (nell'app l'utente può compilarlo a mano).

## Regole

1. Fonti: solo il sito ufficiale della gara o dell'organizzatore, il regolamento, la guida atleta. La pagina
   FIDAL va bene solo per orario e luogo. Niente blog, forum, social di terzi, siti di iscrizione generici
   (salvo che siano il canale ufficiale indicato dall'organizzatore).
2. Edizione: controllare che le informazioni siano dell'edizione della data della gara. Se il sito mostra
   ancora l'edizione precedente, non riportare orari e luoghi: scrivere in `note` "Informazioni dell'edizione
   AAAA non ancora pubblicate" e mettere `sito`.
3. Mai inventare o dedurre: niente orari "probabili", niente griglie "di solito".
4. Testi brevi, in italiano, in forma pratica (una riga per campo, massimo due).
5. Nessun dato personale, nessun consiglio di allenamento, integrazione o salute.
6. Se la gara risulta annullata o spostata: scriverlo in `note` all'inizio ("ANNULLATA" / "SPOSTATA al …")
   e segnalarlo nella descrizione della pull request.

## Quando controllare una gara

Per ogni gara di `gare_seguite.json` con data da oggi in poi:

- senza scheda → compilarla;
- con scheda, `verificato` più vecchio di 14 giorni e gara oltre 30 giorni → ricontrollare;
- gara entro 30 giorni e `verificato` più vecchio di 7 giorni → ricontrollare;
- gara entro 3 giorni e ultima verifica fatta prima di quella finestra → ultimo controllo.

Al massimo 8 gare per esecuzione, dalle più vicine. Le schede di gare passate da più di 30 giorni si possono
togliere.

Ricontrollare significa riaprire le fonti: se nulla è cambiato si aggiorna solo `verificato`; se qualcosa è
cambiato si aggiorna il campo e lo si segnala nella pull request.

## Pull request

Titolo: `Schede gara del AAAA-MM-GG: N nuove, M aggiornate`. Nel testo, per ogni gara: nome, data, cosa è
nuovo o cambiato (prima → dopo), link alle fonti, campi non trovati. Se non c'è nessuna modifica (nemmeno di
`verificato`), non aprire la pull request.
