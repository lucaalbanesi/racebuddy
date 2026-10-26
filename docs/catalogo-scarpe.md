# Catalogo scarpe: come si tiene aggiornato `content/scarpe.json`

Procedura seguita dal workflow "Catalogo scarpe" (Claude Code in GitHub Actions, una volta al mese, il giorno 15).
Il catalogo serve al passo "Scegli i modelli" della Scarpiera (`docs/scarpiera.md`): per ogni tipo di scarpa
l'app propone i 3 modelli migliori per l'atleta. È un catalogo **curato**, non un comparatore: pochi modelli buoni
e attuali, con dati veri.

## Quali modelli

- Quattro tipi (classificazione RaceBuddy, campo `tipo`):
  - `DA` **Daily**: scarpe da allenamento per km facili e lunghi facili, dalla versatile alla massima protezione
    (es. Novablast, Pegasus, Nimbus, Clifton, Bondi, Vomero, 1080, Triumph, Glycerin, Cumulus).
  - `ST` **Super-trainer**: schiuma da gara in una scarpa da allenamento alta e protettiva, per lunghi e lavori
    (es. Superblast, Megablast, Vomero Plus, SC Trainer). Può avere una piastra morbida.
  - `TE` **Tempo**: leggera e reattiva per ripetute e gare su 10 km e mezza, spesso con piastra da allenamento
    (es. Magic Speed, Sonicblast, Zoom Fly, Deviate Nitro, Boston, Hyperion Max, Mach X, Endorphin Speed).
  - `GA` **Gara**: piastra in carbonio e schiuma da gara (es. Vaporfly, Metaspeed, Adios Pro, Endorphin Pro,
    Rocket X, Deviate Nitro Elite).
- Da 6 a 12 modelli per tipo, 30-45 in tutto. Solo strada: niente trail, pista, chiodate, minimaliste.
- Le marche più diffuse tra i runner italiani: ASICS, Nike, HOKA, Adidas, Saucony, Brooks, New Balance, Puma, Mizuno,
  On. Almeno 3 marche per tipo.
- Il catalogo va svecchiato ogni mese: le versioni nuove entrano sempre, anche a tipo pieno.
- Versione nuova e precedente: la precedente resta (`precedente: true`) solo se costa almeno 20 € meno della nuova
  e ha uno score uguale o più alto di 8,5; altrimenti la nuova la sostituisce. Mai tre versioni della stessa linea.
- Tipo pieno (12 modelli) e un modello nuovo migliore: entra togliendo, nell'ordine, una versione precedente, poi
  il modello con lo score più basso, poi quello in vendita da più tempo. Mai sotto 3 marche per tipo. Ogni scambio
  va nel riepilogo ("entra X al posto di Y, perché …").
- Si tolgono i modelli che non si trovano più in vendita, quelli con una versione nuova uscita da più di un anno e
  quelli lanciati da più di due anni se nel tipo c'è un'alternativa recente con score uguale o migliore.
- Nel dubbio sul tipo (es. una "tempo" alta e protettiva), si sceglie quello per cui il produttore la propone e lo
  si scrive nel riepilogo, così Luca lo può correggere.

## Fonti

1. **Runnea** (www.runnea.com, la pagina del modello `…/zapatillas-running/<marca>/<modello>/<id>/`): prezzo "Desde"
   (il minimo tra i negozi), listino (prezzo barrato), peso uomo, drop, ammortiguación (Media → `media`,
   Tope → `massima`), uso (Entrenamiento / Competición / Mixta), constitución (Ligera L, Media M, Fuerte F),
   placa de carbono, **Runnea score**. È la fonte principale; l'`url` punta qui.
2. **RunRepeat** (runrepeat.com, meglio le pagine in spagnolo `runrepeat.com/es/<modello>`): altezza della suola al
   tallone misurata in laboratorio (`suola`, in mm) e peso misurato quando Runnea non lo dà.
3. Solo se un modello non è su Runnea: un negozio online europeo (es. Sportsshoes, Tradeinn) per il prezzo e una
   recensione seria per i dati; `fonte` = il nome del sito usato per il prezzo, `url` = quella pagina, niente `score`.

Mai inventare un dato: se non si trova, il campo si omette.

## Formato

```json
{
  "aggiornato": "2026-11-15",
  "nota": "…",
  "prezzi_tipici": { "DA": 110, "ST": 150, "TE": 100, "GA": 150 },
  "modelli": [
    { "modello": "ASICS Gel Nimbus 28", "marca": "ASICS", "linea": "nimbus", "tipo": "DA",
      "prezzo": 114, "listino": 200, "peso": 285, "drop": 8, "suola": 41, "ammortizzazione": "massima",
      "uso": "allenamento", "corporatura": "MF", "score": 9.5, "fonte": "Runnea",
      "url": "https://www.runnea.com/zapatillas-running/asics/gel-nimbus-28/1058964/" }
  ]
}
```

- `modello`: marca + nome come lo scrive il produttore. `linea`: il nome della linea in minuscolo senza numero
  (`superblast`, `nimbus`, `magic speed`): serve a riconoscere le scarpe che l'atleta ha già.
- `prezzo` e `listino` in euro interi (arrotondati), `peso` in grammi (uomo), `drop` e `suola` in mm.
- `uso`: `allenamento`, `gara`, `misto` o `allenamento e gara`. `corporatura`: lettere tra L, M, F.
- `piastra` solo se c'è: `carbonio`, `nylon`, `Pebax`, `barre in fibra`…
- `falcata` solo per le `GA`, se il produttore lo dice: `["long"]` (per chi allunga il passo) o `["freq"]` (per chi
  aumenta la frequenza).
- `precedente: true` per la versione precedente ancora in vendita.
- `prezzi_tipici`: per ogni tipo la mediana dei `prezzo` dei suoi modelli, arrotondata a 5 €. Li usa il costo del set.
- `aggiornato`: la data del giro.
- Ordine: per tipo (DA, ST, TE, GA), dentro il tipo come si preferisce.

## Il giro

1. Per ogni modello: riapri la sua pagina, aggiorna prezzo, listino e score; correggi gli altri campi se cambiati.
2. Cerca le novità del mese per tipo (Runnea "Lo más visitado", "modelos/todas/" con i filtri di uso e
   ammortizzazione, le uscite annunciate dai produttori, RunRepeat per le uscite recenti) e aggiungi i modelli che
   mancano; a tipo pieno, scambia secondo le regole sopra.
3. Togli i modelli usciti dal mercato e quelli vecchi secondo le regole sopra.
4. Ricalcola `prezzi_tipici` e scrivi `aggiornato`.
5. Scrivi `messaggio_commit.txt` (prima riga breve, es. "Catalogo scarpe di novembre: 3 nuovi, prezzi aggiornati")
   e `riepilogo.md`: modelli aggiunti, tolti e scambiati (con il motivo), prezzi cambiati di più di 15 €, dubbi sul tipo, pagine che non si
   aprivano. In italiano, breve.

Il workflow controlla che il JSON sia valido e che ogni modello abbia `modello`, `marca`, `tipo` (DA/ST/TE/GA),
`prezzo` e `url`; se no, non pubblica.
