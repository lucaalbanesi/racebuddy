# Gare estere: come si compila e si tiene aggiornato `content/estero.json`

Procedura seguita dal workflow "Gare estere" (Claude Code in GitHub Actions, una volta al mese, il giorno 1).
L'elenco è **curato**: non un calendario completo, ma le gare internazionali che contano per un runner italiano.

## Quali gare

1. **Abbott World Marathon Majors** (`major`): Tokyo, Boston, Londra, Sydney, Berlino, Chicago, New York e, dal 2027,
   Città del Capo. Una nuova Major (es. Shanghai) entra solo quando worldmarathonmajors.com la dà come ufficiale.
2. **SuperHalfs** (`superhalfs`): Lisbona, Praga, Berlino, Copenaghen, Cardiff, Valencia (mezze). Se la serie
   cambia, fa fede il sito ufficiale della serie.
3. **European Marathon Classics** (`classics`): Vienna, Londra, Madrid, Copenaghen, Varsavia, Lisbona, Francoforte
   (maratone). Roma fa parte del circuito ma è italiana: resta nel calendario italiano (`italiane.classics` = nomi delle
   gare italiane del circuito, per il bollino).
4. **Grandi gare europee** (`grandi`): maratone e mezze in Europa con circa 15.000 arrivati o più, oggi Siviglia,
   Barcellona, Parigi, Rotterdam, Amburgo, Valencia, Amsterdam, Atene, Praga (maratone), Göteborgsvarvet,
   Great North Run, mezze di Parigi, Barcellona e Madrid. Non più di 20 in tutto: l'elenco deve restare gestibile.
   Solo maratone e mezze: niente 10 km, niente trail.

Una gara in più circuiti ha più valori in `circuiti` (es. Londra: `["major", "classics"]`).

## Profondità

Per ogni gara: l'edizione dell'anno in corso se non è ancora corsa, e quella dell'anno successivo **appena la data è
ufficiale**. Le edizioni passate si tolgono. Un'edizione senza data ufficiale non si mette (non esistono date
"da confermare" nell'elenco).

## Formato

```json
{
  "id": "E-berlino-42-2027",
  "nome": "BMW Berlin Marathon",
  "luogo": "Berlino",
  "paese": "Germania",
  "data": "2027-09-26",
  "distanza": "42",
  "circuiti": ["major"],
  "sito": "https://www.bmw-berlin-marathon.com/",
  "iscrizione": "ballottaggio",
  "notaIscrizione": "Ballottaggio aperto fino al 5 novembre 2026; posti garantiti con tempi di qualificazione.",
  "racconto": "Due o tre frasi in italiano sulla gara e sulla città: il percorso, cosa la rende speciale, un'emozione.",
  "verificato": "2026-11-01"
}
```

- `id`: `E-<città in minuscolo, senza accenti, con trattini>[-mezza]-<distanza>-<anno>`. **Mai cambiarlo** per un'edizione
  che c'è già: gli utenti che la seguono lo hanno salvato. Se la data di un'edizione cambia, cambia solo `data`.
- `luogo` e `paese` in italiano. `nome` come lo usa l'organizzatore.
- `iscrizione`: `ballottaggio` (lotteria/sorteggio per i pettorali, anche se ci sono altre vie come charity o tempi),
  `qualificazione` (serve un tempo minimo, es. Boston) o `libera` (fino a esaurimento). `notaIscrizione`: una frase in
  italiano con le date del ballottaggio dell'edizione, se pubblicate (apertura, chiusura, estrazione).
- `racconto`: 2-3 frasi in italiano, calde ma vere, per la presentazione che l'utente vede la prima volta che apre la
  gara: la città, il percorso (punti di passaggio, arrivo), cosa la rende unica (folla, storia, record). Solo fatti presi
  dal sito ufficiale o dal circuito; niente superlativi inventati, niente tempi o consigli di allenamento.
- I circuiti in testa al file hanno `racconto`, `traguardo` (cosa si ottiene completandolo) e `citta`: correggili solo se
  il circuito cambia davvero (es. una nuova Major ufficiale).
- `verificato`: giorno in cui hai controllato data e iscrizione **sul sito ufficiale** della gara.

## Regole

- Solo fonti ufficiali: il sito della gara, del circuito (worldmarathonmajors.com, sito SuperHalfs, europeanmarathonclassics.eu)
  o dell'organizzatore. Gli aggregatori di calendari non bastano per scrivere `verificato`.
- Mai inventare: una data o un'iscrizione che non trovi non si scrive; un `sito` che non risponde si corregge.
- Mantieni l'ordine per data e il JSON valido, indentato di 2 spazi. Non toccare `circuiti` in testa al file se non
  cambia un circuito, e aggiorna `aggiornato` alla data di oggi.

## Uscite del giro

- `content/estero.json` modificato (l'unico file dei dati che puoi toccare).
- `messaggio_commit.txt`: "Gare estere del AAAA-MM-GG: N aggiunte, M aggiornate, K tolte" e nel corpo una riga per gara.
- `riepilogo.md`: breve, in italiano, per Luca: edizioni aggiunte, date cambiate, ballottaggi in apertura nei prossimi
  60 giorni (in evidenza), gare di cui non hai trovato la data ufficiale, fonti.
