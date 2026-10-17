#!/usr/bin/env python3
"""Novità ufficiali delle gare seguite: gira ogni ora in GitHub Actions.

Ingressi: data/gare_seguite.json (gare seguite dagli utenti), content/schede.json (canali ufficiali e nomi della gara),
          data/contenuti.json (articoli delle riviste italiane, per riconoscere quelli che parlano della gara).
Uscita:   data/novita_gare.json con, per ogni novità, la gara, il tema (medaglia, percorso, …) e l'urgenza:
          "subito" (notifica appena esce), "mattino" (dentro il messaggio del mattino), "app" (solo nell'app).

Fonti: solo i canali della gara indicati dal sito ufficiale (feed delle notizie e YouTube) e le riviste già verificate.
Instagram e Facebook non si leggono. Si tengono solo titolo, link, data e immagine: i contenuti restano sui siti originali.
"""
import datetime as dt
import hashlib
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importa_contenuti import SPAM, completa_immagini, get, taglia, voci_feed  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "novita_gare.json"
EDIZIONE = 300        # una novità vale per l'edizione se esce al massimo 300 giorni prima della gara
DOPO_GARA = 14        # le gare si seguono ancora per due settimane dopo (foto, risultati)
MAX_PER_GARA = 30

# Temi in ordine di precedenza (vince il primo che compare nel titolo).
TEMI = [
    ("annullata", r"annullat|rinviat|posticipat|sospes[ao]\b|cancellat"),
    ("medaglia", r"medagli|\bmedal"),
    ("maglia", r"\bmagli[ae]\b|t-?shirt|canott|\bjersey"),
    ("iscrizioni", r"iscrizion|iscritt|sold ?out|waiting list|lista d.attesa|ultimi pettorali|pettorali disponibili|\bquota\b|chiusura iscri"),
    ("percorso", r"percors|tracciat|\broute\b|\bmappa\b"),
    ("partenza", r"partenz|\borari\b|\borario\b|griglie|\bgriglia\b|cancelli\b|start time|onde di partenza"),
    ("pettorale", r"pettoral|\bexpo\b|ritiro|race pack|pacco gara"),
    ("risultati", r"risultat|classific|\bfoto\b|photo|gallery|tempi ufficiali|\barrivi\b"),
    ("pacer", r"\bpacer|\blepr[ie]\b"),
    ("allenamento", r"training|allenament"),
    ("video", r"aftermovie|after movie|docufilm|emozioni|\bvideo\b|highlights"),
    ("promo", r"promo\b|sconto|merchandis|\bshop\b|codice sconto|sponsor|partner|solidariet|charity"),
]
SUBITO = {"annullata", "medaglia", "maglia", "percorso", "partenza", "pettorale"}
SOLO_APP = {"iscrizioni", "promo", "altro"}
# Altri eventi dello stesso organizzatore (notturne, family run, …): restano nell'app, mai notifiche.
ALTRO_EVENTO = re.compile(r"\b(notturna|family|kids|bambini|staffetta|trail|non competitiv|camminata|ecomaratona)\b", re.I)
ORDINALE = re.compile(r"^\s*([IVXLCDM]+\^|\d+\s*[ªa°^])\s*", re.I)


def nomi_gara(gara: dict, scheda: dict) -> list[str]:
    """Frasi (minuscole) che indicano la gara in un titolo: nomi della scheda, nome FIDAL senza ordinale, città."""
    nomi = [n.lower() for n in (scheda.get("nomi") or []) if n]
    base = ORDINALE.sub("", gara.get("nome", "")).strip().lower()
    if base:
        nomi.append(base)
    citta = (gara.get("luogo") or "").strip().lower()
    if citta:
        d = gara.get("distanza")
        if d == "42":
            nomi += [f"maratona di {citta}", f"{citta} marathon"]
        elif d == "21":
            nomi += [f"mezza maratona di {citta}", f"mezza di {citta}", f"{citta} half marathon"]
        elif d == "10":
            nomi += [f"10 km di {citta}", f"10k di {citta}"]
    return list(dict.fromkeys(n for n in nomi if len(n) >= 6))


def parla_di(titolo: str, nomi: list[str]) -> bool:
    t = re.sub(r"\s+", " ", titolo.lower())
    return any(n in t for n in nomi)


def tema(titolo: str) -> str:
    t = titolo.lower()
    return next((k for k, rx in TEMI if re.search(rx, t)), "notizia")


def urgenza(t: str, data: str, data_gara: str) -> str:
    if t in SUBITO or (t == "risultati" and data >= data_gara):
        return "subito"
    return "app" if t in SOLO_APP else "mattino"


def classifica(titolo: str, data: str, gara: dict, nomi: list[str], ufficiale: bool) -> dict | None:
    """Tema e urgenza di una voce per una gara; None se non riguarda la gara o non è dell'edizione."""
    inizio = (dt.date.fromisoformat(gara["data"]) - dt.timedelta(days=EDIZIONE)).isoformat()
    if not data or data < inizio or SPAM.search(titolo):
        return None
    nominata = parla_di(titolo, nomi)
    if not ufficiale and not nominata:
        return None
    t = "altro" if ufficiale and not nominata and ALTRO_EVENTO.search(titolo) else tema(titolo)
    return {"tema": t, "urgenza": urgenza(t, data, gara["data"])}


def nid(link: str, gara_id: str) -> str:
    return "n" + hashlib.sha1(f"{gara_id} {link}".encode()).hexdigest()[:11]


def main() -> int:
    oggi = dt.date.today().isoformat()
    adesso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    leggi = lambda p, d: json.loads((ROOT / p).read_text()) if (ROOT / p).exists() else d
    gare = [g for g in leggi("data/gare_seguite.json", {"gare": []}).get("gare", [])
            if g.get("data") and g["data"] >= (dt.date.today() - dt.timedelta(days=DOPO_GARA)).isoformat()]
    schede = leggi("content/schede.json", {})
    riviste = leggi("data/contenuti.json", {"contenuti": []}).get("contenuti", [])
    vecchie = {n["id"]: n for n in leggi("data/novita_gare.json", {"novita": []}).get("novita", [])}

    tutte, errori = {}, 0
    for g in gare:
        s = schede.get(g["id"], {})
        nomi = nomi_gara(g, s)
        canali = s.get("canali") or {}
        voci = []
        for chiave, tipo, fonte in (("notizie", "articolo", "Sito ufficiale"), ("youtube", "video", "YouTube della gara")):
            url = canali.get(chiave)
            if not url or not url.startswith("https://"):
                continue
            try:
                voci += [{**v, "tipo": tipo, "fonte": fonte, "ufficiale": True} for v in voci_feed(get(url))]
            except Exception as e:  # un canale che non risponde non blocca gli altri
                errori += 1
                print(f"Attenzione: {g['nome']} · {chiave} non letto ({e})", file=sys.stderr)
            time.sleep(1)
        voci += [{"titolo": c["titolo"], "link": c["link"], "data": c["data"], "immagine": c.get("immagine"),
                  "tipo": c["tipo"], "fonte": c["fonte"], "ufficiale": False} for c in riviste]
        prese = []
        for v in voci:
            if not v.get("titolo") or not str(v.get("link", "")).startswith("http") or (v.get("data") or "") > oggi:
                continue
            c = classifica(v["titolo"], v.get("data"), g, nomi, v["ufficiale"])
            if not c:
                continue
            i = nid(v["link"], g["id"])
            prima = vecchie.get(i, {})
            prese.append({"id": i, "gara": g["id"], **c, "titolo": taglia(v["titolo"], 140), "link": v["link"], "data": v["data"],
                          "fonte": v["fonte"], "ufficiale": v["ufficiale"], "tipo": v["tipo"],
                          "immagine": v["immagine"] if (v.get("immagine") or "").startswith("https://") else None,
                          "trovato": prima.get("trovato", adesso)})
        prese.sort(key=lambda n: (n["data"], n["ufficiale"]), reverse=True)
        for n in prese[:MAX_PER_GARA]:
            tutte[n["id"]] = n

    if not tutte and errori:
        print("Nessuna novità letta: file non modificato.", file=sys.stderr)
        return 1
    elenco = sorted(tutte.values(), key=lambda n: (n["data"], n["id"]), reverse=True)
    img = completa_immagini(elenco, vecchie, oggi, 20)
    if img:
        print(f"Immagini trovate nelle pagine: {img}")
    nuovo = {"novita": elenco}
    if OUT.exists() and json.loads(OUT.read_text()).get("novita") == elenco:
        print(f"{len(elenco)} novità, nessun cambiamento")
        return 0
    OUT.write_text(json.dumps({"aggiornato": adesso, **nuovo}, ensure_ascii=False, indent=1) + "\n")
    per_u = {u: sum(1 for n in elenco if n["urgenza"] == u) for u in ("subito", "mattino", "app")}
    print(f"{len(elenco)} novità per {len(gare)} gare ({per_u}); canali non letti {errori}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
