"""Esporta da Supabase l'elenco delle gare seguite dagli utenti in data/gare_seguite.json.
Solo dati pubblici delle gare. Gira in GitHub Actions (il sito di Supabase non è raggiungibile altrove)."""
import json, re, urllib.request, datetime, pathlib

cfg = pathlib.Path("app/config.js").read_text()
URL = re.search(r"https://[a-z0-9]+\.supabase\.co", cfg).group(0)
KEY = re.search(r"sb_publishable_[A-Za-z0-9_-]+", cfg).group(0)

req = urllib.request.Request(f"{URL}/rest/v1/gare_aggiunte?select=gara_id,nome,data,luogo,distanza,fonte,creato&order=creato.asc&limit=10000",
                             headers={"apikey": KEY})
righe = json.load(urllib.request.urlopen(req, timeout=30))
oggi = datetime.date.today().isoformat()

gare = {}
for r in righe:
    if r["gara_id"] == "TEST" or r["data"] < oggi:
        continue
    g = gare.setdefault(r["gara_id"], {"id": r["gara_id"], "nome": r["nome"], "data": r["data"], "luogo": r["luogo"],
                                       "distanza": r["distanza"], "fonte": r["fonte"], "prima_aggiunta": r["creato"][:10], "aggiunte": 0})
    g["aggiunte"] += 1
    g["ultima_aggiunta"] = r["creato"][:10]

out = {"aggiornato": oggi, "gare": sorted(gare.values(), key=lambda g: (g["data"], g["nome"]))}
dest = pathlib.Path("data/gare_seguite.json")
vecchio = json.loads(dest.read_text()) if dest.exists() else {}
if vecchio.get("gare") != out["gare"]:
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"Aggiornato: {len(out['gare'])} gare seguite")
else:
    print("Nessuna novità")
