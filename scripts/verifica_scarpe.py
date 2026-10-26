"""Controllo del catalogo della Scarpiera (content/scarpe.json): usato dal workflow "Catalogo scarpe" prima di pubblicare."""
import json
import sys

TIPI = ("DA", "ST", "TE", "GA")
d = json.load(open("content/scarpe.json", encoding="utf-8"))
m = d.get("modelli") or []
errori = []
if not d.get("aggiornato"):
    errori.append("manca aggiornato")
if len(m) < 12:
    errori.append(f"solo {len(m)} modelli")
for x in m:
    if not (x.get("modello") and x.get("marca") and x.get("tipo") in TIPI and isinstance(x.get("prezzo"), (int, float)) and x["prezzo"] > 0 and str(x.get("url", "")).startswith("http")):
        errori.append(f"modello non valido: {x.get('modello', '?')}")
for t in TIPI:
    if not any(x.get("tipo") == t for x in m):
        errori.append(f"nessun modello di tipo {t}")
    if not isinstance((d.get("prezzi_tipici") or {}).get(t), (int, float)):
        errori.append(f"manca prezzi_tipici.{t}")
nomi = [x.get("modello") for x in m]
if len(nomi) != len(set(nomi)):
    errori.append("modelli doppi")
# casi sospetti sul tipo: non bloccano, finiscono nel riepilogo (file avvisi_tipo.txt)
avvisi = []
for x in m:
    t, piastra, uso, nome = x.get("tipo"), str(x.get("piastra") or "").lower(), str(x.get("uso") or ""), x.get("modello", "?")
    if not x.get("perche"):
        avvisi.append(f"{nome}: manca `perche` (motivo del tipo)")
    if t == "GA" and "carbon" not in piastra:
        avvisi.append(f"{nome}: Gara senza piastra in carbonio")
    if t == "ST" and not piastra and uso == "allenamento" and not x.get("perche"):
        avvisi.append(f"{nome}: Super-trainer senza piastra e con uso solo allenamento (forse Daily?)")
    if t == "DA" and "carbon" in piastra:
        avvisi.append(f"{nome}: Daily con piastra in carbonio (forse Super-trainer?)")
if errori:
    print("\n".join(errori))
    sys.exit(1)
if avvisi:
    open("avvisi_tipo.txt", "w", encoding="utf-8").write("\n".join(avvisi) + "\n")
    print("avvisi sul tipo:\n" + "\n".join(avvisi))
print(f"ok: {len(m)} modelli")
