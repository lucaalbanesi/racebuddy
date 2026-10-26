# Scarpiera

Aiuta l'atleta a gestire la rotazione delle scarpe fino alle gare obiettivo: quando finiscono le scarpe che ha, che rotazione vuole, cosa comprare e quando, quali modelli. Le scarpe da comprare finiscono in Oggi come attività con scadenza. Tutto sul telefono (`S.scarpiera`, `S.profilo.peso`), nessun dato online. Motore in `app/logic.js` (`L.sc*`, testato in `tests/test_logic.js`), viste in `app/app.js` (`vistaScarpiera`, `cardScarpiera`), catalogo in `content/scarpe.json`. Requisito con le schermate del prototipo: https://claude.ai/artifact/4kF6tKWnMXLHrV1T17MZB6

## Modello
- Tipi (`L.SC_TIPI`): Daily (`allenamento` nell'app, comprende la massima protezione), Super-trainer (`ritmo`), Tempo (`tempo`), Gara (`gara`). Trail fuori dalla rotazione. Set = base obbligatoria Daily + Super-trainer, aggiunte facoltative Tempo e/o Gara.
- Uscite: Facile, Lungo facile, Veloce / qualità, Lunghissimo / ritmo gara, Gara (10 km e mezza); la maratona (gare da 30 km) ha la sua priorità. Priorità e ripieghi in `SC_MX` / `SC_MXM`:

| Uscita | Daily | Super-trainer | Tempo | Gara |
|---|---|---|---|---|
| Facile | **1** | *2* | ✗ | ✗ |
| Lungo facile | **1** | **2** | *3* | ✗ |
| Veloce | *4* | **2** | **1** | *3* |
| Lunghissimo / ritmo gara | *4* | **1** | **2** | **3** |
| Gara 10 km e mezza | *4* | *3* | **2** | **1** |
| Maratona | ✗ | **2** | *3* | **1** |

  Grassetto ideale, corsivo ripiego, ✗ mai.
- Durata (`L.scDurata`): Daily 800, Super-trainer 750, Tempo 575, Gara 340 km, -0,87% per kg sopra i 70 (massimo -25%), arrotondata a 10. Se l'atleta la corregge (Scarpiera o Io) vale la sua (`s.limiteMano`).
- Età della scarpa: fino all'80% fa tutto, dall'80% lascia veloce, lunghissimi e gare, dal 90% anche il lungo facile. Il Super-trainer uscito dalla qualità finisce la vita sui facili (fine corsa, non è un ripiego); Tempo e Gara vanno in pensione. La Gara arriva al 100% quando esce dalle gare e non scende mai sui base; in allenamento al massimo il 30% della sua vita.
- Scelta tra scarpe adatte: in allenamento prima quella con meno ruoli rimasti, poi la più consumata; in gara la più fresca. Rodaggio: 40 km prima di una gara.

## Piano
- Settimana 0 = il primo lunedì da oggi. Periodo: fino a 6 settimane dopo l'ultima gara obiettivo (minimo 20, massimo 52). Proiezione di altre 40 settimane allo stesso ritmo, solo per le date di fine e il prossimo acquisto.
- Settimana tipo: Facile e Veloce ogni settimana, più il weekend dal ciclo del mese (lunghissimi alternati a lunghi facili e gare; i 4 weekend devono sommare 4). Settimana prima di una mezza o maratona: scarico; dopo: recupero.
- Acquisti (`L.scPiano`): alla prima settimana in cui un'uscita va su un ripiego o resta senza scarpa, due settimane prima, con il tipo ideale del set. Due acquisti mai a meno di tre settimane. Un tipo scelto e non posseduto entra solo quando serve. Più scarpe dello stesso tipo (`qty`) si danno il cambio.
- Costo per mantenere il set (`L.scCosto`): euro al mese a regime con i prezzi tipici in sconto (`SC_PREZZO`: Daily 110, Super-trainer 150, Tempo 100, Gara 150).

## Funnel `#/scarpiera/:passo`
1. `scarpe`: peso, tipo, km e durata di ogni scarpa, aggiunta.
2. `corsa`: km di Facile e Veloce, weekend del mese, gare obiettivo (da Le mie gare, sola lettura).
3. `set`: base, aggiunte Tempo e Gara con il costo in più, costo del set, due scarpe dello stesso tipo, grafico senza acquisti con le coperture (Facile, Veloce, Lunghi e gare).
4. `piano`: cosa comprare e quando con il motivo, gare obiettivo con la scarpa e i km al via, grafico con le scarpe nuove.
5. `modelli?i=N`: una scheda per acquisto con due domande del tipo (`SC_DOMANDE`), marca, spesa massima e i 3 modelli migliori con i motivi (`L.scModelli`). "Aggiungi a Oggi" crea le attività.

Ingressi: Io → Scarpe ("Pianifica la rotazione"), voce "La scarpa arriva alla gara?" quando non arriva ("Pianifica gli acquisti"), scheda in Oggi quando una scarpa supera l'85% e non c'è un piano ("Più tardi" = 3 giorni).

Oggi: una scheda per scarpa da comprare (scadenza grigia, gialla entro 14 giorni, rossa se passata). "L'ho comprata" aggiunge la scarpa con 0 km e la durata stimata; "Chiudi" la toglie.

## Catalogo `content/scarpe.json`
Una riga per modello: `modello`, `marca`, `linea` (per riconoscere le scarpe che l'atleta ha già), `tipo` (classificazione RaceBuddy), `prezzo` (minimo), `listino`, `peso` (g, uomo), `drop`, `suola` (mm al tallone, quando c'è), `ammortizzazione` (media/massima), `uso`, `corporatura` (L/M/F di Runnea), `piastra`, `score` (Runnea), `falcata` (solo Gara: long/freq), `precedente`, `fonte`, `url`.

Aggiornamento: workflow "Catalogo scarpe" (`.github/workflows/scarpe.yml`, Claude Code il giorno 15 di ogni mese) secondo `docs/catalogo-scarpe.md`, con controllo di `scripts/verifica_scarpe.py` e riepilogo sull'issue "Riepilogo catalogo scarpe". `prezzi_tipici` (mediana per tipo) alimenta il costo del set nell'app.

## Da fare
- Notifiche push a 14 e 2 giorni dalla scadenza di un acquisto (servirebbe mandare le date al server, come le scadenze dei documenti).
- Chiudere da sola l'attività quando la scarpa nuova arriva da Strava.
