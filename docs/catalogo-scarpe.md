# Catalogo scarpe: come si tiene aggiornato `content/scarpe.json`

Procedura seguita dal workflow "Catalogo scarpe" (Claude Code in GitHub Actions, una volta al mese, il giorno 15).
Il catalogo serve al passo "Scegli i modelli" della Scarpiera (`docs/scarpiera.md`): per ogni tipo di scarpa
l'app propone i 3 modelli migliori per l'atleta. È un catalogo **curato**, non un comparatore: pochi modelli buoni
e attuali, con dati veri.

## Quali modelli

- Quattro tipi (classificazione RaceBuddy, campo `tipo`). Il tipo dice **per cosa la usa un amatore**, non quanto
  è morbida o costosa. Si decide con la regola qui sotto, nell'ordine, e mai da una fonte sola (Runnea, RunRepeat,
  Doctors of Running o Road Trail Run, il produttore):
  1. `GA` **Gara**: piastra in carbonio e schiuma da gara, proposta dal produttore per gareggiare
     (es. Vaporfly, Metaspeed, Adios Pro, Endorphin Pro, Rocket X, Deviate Nitro Elite).
  2. `TE` **Tempo**: leggera (di solito sotto i 260 g) e reattiva, per ripetute e gare su 10 km e mezza; spesso con
     piastra in nylon, Pebax o fibra (es. Magic Speed, Sonicblast, Zoom Fly, Deviate Nitro, Boston, Endorphin Speed,
     Mach X).
  3. `ST` **Super-trainer**: schiuma da gara in una scarpa alta e protettiva che le recensioni promuovono **sia** per i
     lunghi **sia** per i lavori a ritmo gara (rimbalzo, piastra o geometria rigida a dondolo: "super trainer",
     "versatile anche per il ritmo"). Esempi: Superblast, Megablast, Skyward X.
  4. `DA` **Daily**: tutto il resto da allenamento, dalla versatile alla massima protezione, **anche con schiuma da
     gara** se le recensioni dicono che sul ritmo è lenta o "non ama andare forte" (es. Novablast, Pegasus, Nimbus,
     Clifton, Bondi, Vomero, Vomero Plus, 1080, Triumph, Glycerin, Cumulus).
  5. Nel dubbio tra due tipi conta l'uso che almeno due recensioni indipendenti consigliano (il marketing del
     produttore pesa meno). Il dubbio va nel riepilogo.
- Ogni modello ha `perche`: una riga sul tipo con le fonti, es. "ZoomX senza piastra, per facili e lunghi, lenta al
  ritmo (Doctors of Running, Road Trail Run)". Ogni mese il tipo si **ricontrolla per tutti i modelli**, non solo per
  i nuovi: se le recensioni lo smentiscono si corregge e si scrive nel riepilogo ("X passa da ST a DA, perché …").
- Il controllo automatico (`scripts/verifica_scarpe.py`) segnala i casi sospetti (Gara senza carbonio, Super-trainer
  senza piastra con uso "allenamento", Daily con piastra in carbonio, `perche` mancante): vanno risolti o spiegati
  nel riepilogo.
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

## Fonti

1. **Runnea Italia** (www.runnea.it, la pagina del modello `…/scarpe-running/<marca>/<modello>/<id>/`; stessi id
   del sito spagnolo, prezzi dei negozi che vendono in Italia): prezzo "Da" (il minimo tra i negozi), listino (prezzo
   barrato), peso uomo, drop, ammortizzazione (Media → `media`, Massima → `massima`), uso (Allenamento / Competizione
   / Misto), costituzione (Leggera L, Media M, Forte F), piastra in carbonio, **RUNNEA score**. È la fonte
   principale; l'`url` punta qui. Solo se un dato manca su runnea.it si guarda runnea.com (spagnolo), mai per l'url.
2. **RunRepeat** (runrepeat.com, pagine in inglese o `runrepeat.com/it/<modello>` se c'è): altezza della suola al
   tallone misurata in laboratorio (`suola`, in mm) e peso misurato quando Runnea non lo dà.
   La `suola` serve per ogni modello: l'app la usa per dire se una scarpa protegge anche i runner pesanti (≥ 40 mm
   o ammortizzazione massima), perché l'indicazione di corporatura di Runnea da sola è troppo prudente. Se RunRepeat
   non ha ancora il modello, usa l'altezza al tallone dichiarata dal produttore e scrivilo nel riepilogo.
3. Solo se un modello non è su Runnea: un negozio online europeo (es. Sportsshoes, Tradeinn) per il prezzo e una
   recensione seria per i dati; `fonte` = il nome del sito usato per il prezzo, `url` = quella pagina, niente `score`.

4. **Recensioni per il tipo** (solo per decidere `tipo` e scrivere `perche`, non per prezzi o dati): almeno due tra
   Doctors of Running (doctorsofrunning.com), Road Trail Run (roadtrailrun.com), il verdetto di RunRepeat, Believe in
   the Run (believeintherun.com), Running Warehouse (runningwarehouse.com). Si guarda a cosa la consigliano: facili e
   lunghi, ritmo, gara. Per i modelli già controllati il mese prima basta una ricerca veloce di recensioni nuove.

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
      "perche": "FF Blast Max senza piastra, massima protezione per facili e lunghi (Runnea, Doctors of Running)",
      "url": "https://www.runnea.it/scarpe-running/asics/gel-nimbus-28/1058964/" }
  ]
}
```

- `modello`: marca + nome come lo scrive il produttore. `linea`: il nome della linea in minuscolo senza numero
  (`superblast`, `nimbus`, `magic speed`): serve a riconoscere le scarpe che l'atleta ha già.
- `prezzo` e `listino` in euro interi (arrotondati), `peso` in grammi (uomo), `drop` e `suola` in mm.
- `uso`: `allenamento`, `gara`, `misto` o `allenamento e gara`. `corporatura`: lettere tra L, M, F.
- `perche`: una riga sul tipo con le fonti (obbligatoria).
- `piastra` solo se c'è: `carbonio`, `nylon`, `Pebax`, `barre in fibra`…
- `falcata` solo per le `GA`, se il produttore lo dice: `["long"]` (per chi allunga il passo) o `["freq"]` (per chi
  aumenta la frequenza).
- `precedente: true` per la versione precedente ancora in vendita.
- `prezzi_tipici`: per ogni tipo la mediana dei `prezzo` dei suoi modelli, arrotondata a 5 €. Li usa il costo del set.
- `aggiornato`: la data del giro.
- Ordine: per tipo (DA, ST, TE, GA), dentro il tipo come si preferisce.

## Il giro

1. Per ogni modello: riapri la sua pagina, aggiorna prezzo, listino e score; correggi gli altri campi se cambiati;
   aggiungi la `suola` dove manca.
2. Cerca le novità del mese per tipo (Runnea Italia: le più viste e il catalogo con i filtri di uso e
   ammortizzazione, le uscite annunciate dai produttori, RunRepeat per le uscite recenti) e aggiungi i modelli che
   mancano; a tipo pieno, scambia secondo le regole sopra.
3. Togli i modelli usciti dal mercato e quelli vecchi secondo le regole sopra.
4. Ricalcola `prezzi_tipici` e scrivi `aggiornato`.
5. Scrivi `messaggio_commit.txt` (prima riga breve, es. "Catalogo scarpe di novembre: 3 nuovi, prezzi aggiornati")
   e `riepilogo.md`: modelli aggiunti, tolti e scambiati (con il motivo), prezzi cambiati di più di 15 €, dubbi sul tipo, pagine che non si
   aprivano. In italiano, breve.

Il workflow controlla che il JSON sia valido e che ogni modello abbia `modello`, `marca`, `tipo` (DA/ST/TE/GA),
`prezzo` e `url`; se no, non pubblica.
