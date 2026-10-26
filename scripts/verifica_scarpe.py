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
if errori:
    print("\n".join(errori))
    sys.exit(1)
print(f"ok: {len(m)} modelli")
