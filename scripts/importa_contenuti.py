#!/usr/bin/env python3
"""Raccoglie i contenuti recenti (articoli, video, podcast) dalle fonti italiane attive e li classifica.

Ingresso: data/fonti_verificate.json (fonti con stato "attivo") ed eventuali esclusioni in content/fonti_escluse.json.
Uscita:   data/contenuti.json con titolo, link, data, breve estratto, immagine e le etichette usate dall'app
          per scegliere cosa mostrare a ciascuno (fase della preparazione, distanza, argomento).

Si mostrano solo titolo, estratto breve e link alla fonte originale: i contenuti restano sui siti degli autori.
Regole di qualità: solo italiano, niente spam (scommesse, casinò…), per le fonti non dedicate alla corsa
solo contenuti che parlano di corsa.
"""
import datetime as dt
import email.utils
import hashlib
import html
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "contenuti.json"
UA = {"User-Agent": "Mozilla/5.0 (compatible; RaceBuddy-contenuti/0.1; +https://github.com/lucaalbanesi/racebuddy)"}
GIORNI = 60          # quanto indietro si tiene un contenuto
MAX_PER_FONTE = 40   # per non far dominare una sola fonte
ESTRATTO = 180

SPAM = re.compile(r"\b(casin[oò]|scommess|betting|bet\b|mostbet|slot|poker|bonus senza deposito|crypto|bitcoin|forex|escort|viagra)", re.I)
CORSA = re.compile(r"\b(cors[aei]|corr(ere|o|i|endo)|runn(er|ing)|maraton|mezza|10 ?km|podis|gara|garmin forerunner|scarpe da (corsa|running)|trail|allenament|ripetut|ritmo)", re.I)
# Temi che non promuoviamo (dimagrimento, diete): non coerenti con lo spirito dell'app
EVITA = re.compile(r"perder(e)? peso|dimagr|calorie bruciate|pancia piatta|bruciare (i )?grassi", re.I)
STOP_IT = re.compile(r"\b(il|lo|la|le|gli|di|del|della|dei|che|per|con|una|un|non|come|più|sono|alla|nel|nella|anche|dopo|prima|quando)\b", re.I)

ARGOMENTI = {
    "rifornimento": r"\bgel\b|rifornim|integrator|carboidrat|idrata|\bbere\b|sali minerali|borraccia|ristor",
    "alimentazione": r"aliment|colazion|dieta|mangi|cibo|nutri|pasta|proteine",
    "scarpe": r"scarp|ammortizz|drop\b|intersuola|rotazione",
    "allenamento": r"allenament|ripetut|\blungh?[oi]\b|ritmo|soglia|fartlek|interval|tabella|chilometragg|progressiv|vo2",
    "forza": r"\bforza\b|mobilit|stretching|palestra|\bcore\b|esercizi|pliometri",
    "recupero": r"recuper|riposo|sonno|massagg|defatic|scarico muscolare",
    "gara": r"\bgara\b|\bgare\b|maraton|mezza|griglia|pettorale|vigilia|tapering|race day|al via|traguardo",
    "mente": r"mental|motivaz|ansia|\btesta\b|paura|concentraz|nervosismo",
    "abbigliamento": r"abbigl|vestir|vestizione|giacca|guanti|maglia|freddo|caldo|pioggia|calze",
    "tecnologia": r"orologi|\bgps\b|garmin|coros|polar|suunto|\bapp\b|strava|cardiofrequenz",
    "racconti": r"\bvlog\b|la mia (gara|maratona)|racconto|diario|esperienza|com'è andata",
    "notizie": r"vince|vincono|risultati|classifica|record|campion",
}
# Parole che legano un contenuto a una fase della preparazione (oltre agli argomenti tipici di quella fase)
FASI = {
    "si_parte": r"inizi|principiant|primo (piano|mese)|obiettivo|come preparare|preparazione|iscriver|scegliere la (gara|maratona)",
    "costruzione": r"lungh?[oi]\b|chilometragg|base aerobic|allenament|forza|prima prova",
    "picco": r"lungo più lungo|ritmo gara|prova generale|lunghissim|ultim[ie] lungh",
    "scarico": r"tapering|scarico|settimana prima|vigilia|carico di carboidrati|pre ?gara|cosa portare|borsa|pettorale|griglia|ultimi giorni",
    "gara": r"race day|giorno della gara|in gara|strategia di gara|partenza|negative split|ristori",
    "dopo": r"dopo la (gara|maratona|mezza)|recuper|riposo|bilancio|post ?gara|prossima gara",
}
FASE_DA_ARGOMENTO = {"rifornimento": ["costruzione", "picco", "scarico"], "forza": ["si_parte", "costruzione"],
                     "recupero": ["dopo"], "scarpe": ["si_parte", "costruzione", "picco"],
                     "mente": ["scarico", "gara"], "alimentazione": ["costruzione", "scarico"]}


def get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(5_000_000).decode("utf-8", "replace")


def testo(s: str | None) -> str:
    s = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", s).strip()


def taglia(s: str, n: int = ESTRATTO) -> str:
    if len(s) <= n:
        return s
    t = s[:n].rsplit(" ", 1)[0].rstrip(",;:.- ")
    return t + "…"


def data_iso(s: str | None) -> str | None:
    if not s:
        return None
    s = s.strip()
    try:
        return email.utils.parsedate_to_datetime(s).date().isoformat()
    except (TypeError, ValueError):
        pass
    m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else None


def figlio(el, nome: str):
    for c in el:
        if c.tag.split("}")[-1] == nome:
            return c
    return None


def figli(el, nome: str):
    return [c for c in el.iter() if c.tag.split("}")[-1] == nome]


def immagine(el, descr_html: str) -> str | None:
    for nome in ("thumbnail", "content"):
        for c in figli(el, nome):
            u = c.get("url")
            if u and (nome == "thumbnail" or (c.get("medium") == "image" or re.search(r"\.(jpe?g|png|webp)", u, re.I))):
                return u
    enc = figlio(el, "enclosure")
    if enc is not None and (enc.get("type") or "").startswith("image"):
        return enc.get("url")
    img = figli(el, "image")
    for c in img:
        if c.get("href"):
            return c.get("href")
    m = re.search(r'<img[^>]+src="([^"]+)"', descr_html or "")
    return m.group(1) if m else None


def voci_feed(xml: str) -> list[dict]:
    root = ET.fromstring(xml.encode("utf-8"))
    out = []
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        t = figlio(el, "title")
        link = figlio(el, "link")
        href = (link.get("href") if link is not None and link.get("href") else (link.text if link is not None else "")) or ""
        descr_el = next((x for x in (figlio(el, n) for n in ("encoded", "description", "summary", "content")) if x is not None and x.text), None)
        if descr_el is None:
            g = figlio(el, "group")
            descr_el = figlio(g, "description") if g is not None else None
        descr_html = descr_el.text if descr_el is not None else ""
        d = None
        for n in ("pubDate", "published", "updated", "date"):
            x = figlio(el, n)
            if x is not None and x.text:
                d = data_iso(x.text)
                break
        enc = figlio(el, "enclosure")
        audio = enc is not None and (enc.get("type") or "").startswith("audio")
        dur = figlio(el, "duration")
        out.append({"titolo": testo(t.text if t is not None else ""), "link": href.strip(), "data": d,
                    "testo": testo(descr_html), "immagine": immagine(el, descr_html), "audio": audio,
                    "durata": dur.text.strip() if dur is not None and dur.text else None})
    # immagine del podcast come ripiego
    canale = next((c for c in root.iter() if c.tag.split("}")[-1] == "channel"), None)
    if canale is not None:
        copertina = next((c.get("href") for c in figli(canale, "image") if c.get("href")), None)
        for o in out:
            if o["audio"] and not o["immagine"]:
                o["immagine"] = copertina
    return out


def etichette(titolo: str, corpo: str) -> dict:
    t = f"{titolo} {corpo}".lower()
    arg = [a for a, rx in ARGOMENTI.items() if re.search(rx, t)]
    dist = []
    if re.search(r"maraton(a|e)\b|42 ?km|42,195|marathon", t) and not re.search(r"mezza maraton|half marathon", titolo.lower()):
        dist.append("42")
    if re.search(r"mezza|half marathon|21 ?km|21,097", t):
        dist.append("21")
    if re.search(r"\b10 ?km\b|\b10k\b|diecimila", t):
        dist.append("10")
    fasi = {f for f, rx in FASI.items() if re.search(rx, t)}
    for a in arg:
        fasi.update(FASE_DA_ARGOMENTO.get(a, []))
    ordine = ["si_parte", "costruzione", "picco", "scarico", "gara", "dopo"]
    return {"argomenti": arg[:4], "distanze": dist, "fasi": [f for f in ordine if f in fasi]}


def main() -> int:
    fonti = [f for f in json.loads((ROOT / "data/fonti_verificate.json").read_text())["fonti"] if f.get("stato") == "attivo" and f.get("feed")]
    escl_path = ROOT / "content/fonti_escluse.json"
    escluse = set(json.loads(escl_path.read_text())) if escl_path.exists() else set()
    fonti = [f for f in fonti if f["id"] not in escluse]
    fonti = [f for f in fonti if f["tipo"] != "podcast"]  # podcast tolti dall'app (ottobre 2026)
    oggi = dt.date.today()
    limite = (oggi - dt.timedelta(days=GIORNI)).isoformat()

    vecchi = json.loads(OUT.read_text()).get("contenuti", []) if OUT.exists() else []
    per_id = {c["id"]: c for c in vecchi if c.get("data", "") >= limite and c.get("fonteId") not in escluse
              and not SPAM.search(c["titolo"]) and not EVITA.search(c["titolo"])}
    scartati = {"spam": 0, "lingua": 0, "fuori tema": 0}
    errori = 0
    for f in fonti:
        try:
            voci = voci_feed(get(f["feed"]))
        except Exception as e:  # una fonte che non risponde non blocca le altre
            errori += 1
            print(f"Attenzione: {f['nome']} non letto ({e})", file=sys.stderr)
            continue
        dedicata = f.get("categoria", "") not in ("brand · orologi",)
        prese = 0
        for v in voci:
            if not v["titolo"] or not v["link"].startswith("http") or not v["data"] or v["data"] < limite or v["data"] > oggi.isoformat():
                continue
            insieme = f"{v['titolo']} {v['testo'][:600]}"
            if SPAM.search(insieme):
                scartati["spam"] += 1
                continue
            if EVITA.search(v["titolo"]):
                scartati["evitati"] = scartati.get("evitati", 0) + 1
                continue
            if f["tipo"] != "youtube" and len(STOP_IT.findall(insieme)) < 3:
                scartati["lingua"] += 1
                continue
            if not dedicata and not CORSA.search(insieme):
                scartati["fuori tema"] += 1
                continue
            if f["tipo"] == "podcast" or v["audio"]:
                continue  # podcast tolti dall'app (ottobre 2026)
            cid = hashlib.sha1(v["link"].encode()).hexdigest()[:12]
            tipo = "video" if f["tipo"] == "youtube" else "podcast" if (f["tipo"] == "podcast" or v["audio"]) else "articolo"
            per_id[cid] = {
                "id": cid, "tipo": tipo, "fonte": f["nome"], "fonteId": f["id"], "titolo": taglia(v["titolo"], 140),
                "estratto": taglia(v["testo"]) if tipo != "video" else taglia(v["testo"], 140),
                "link": v["link"], "data": v["data"],
                "immagine": v["immagine"] if v["immagine"] and v["immagine"].startswith("https://") else None,
                **({"durata": v["durata"]} if tipo == "podcast" and v["durata"] else {}),
                **etichette(v["titolo"], v["testo"][:1500]),
            }
            prese += 1
            if prese >= MAX_PER_FONTE:
                break
        time.sleep(1)

    elenco = sorted(per_id.values(), key=lambda c: (c["data"], c["titolo"]), reverse=True)
    if not elenco and errori:
        print("Nessun contenuto letto: file non modificato.", file=sys.stderr)
        return 1
    OUT.write_text(json.dumps({"aggiornato": oggi.isoformat(), "contenuti": elenco}, ensure_ascii=False, indent=1) + "\n")
    tipi = {t: sum(1 for c in elenco if c["tipo"] == t) for t in ("articolo", "video", "podcast")}
    print(f"{len(elenco)} contenuti ({tipi}); scartati {scartati}; fonti non lette {errori}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
