"""Calendario di Gare Podistiche Lazio (garepodistichelazio.it) per data/gare.json, al pari di quello FIDAL.

Due pagine pubbliche: i prossimi mesi (gare-lazio.php) e l'anno successivo (gare-anno-successivo.php?tipo=0).
Ogni riga: data e ora (o "Annullata" / "Rinviata al …"), nome, km, località (provincia), termine iscrizione, quota,
scheda gara, sito e Facebook. Si tengono le gare su strada di 10 km, mezza e maratona e quelle di altra distanza tra
5 e 50 km (con "km" e la classica più vicina come "distanza") con le stesse regole del calendario FIDAL (stesse parole
escluse; fuori i trail, che hanno il dislivello nei km).

Una gara già nel calendario FIDAL (stessa data, luogo e distanza) resta quella FIDAL, con il suo id: si aggiungono
solo i dati che FIDAL non ha (ora di partenza, quota, iscrizioni, sito). Le altre entrano con fonte
"Gare Podistiche Lazio" e id stabile "L<hash>-<distanza>".
"""
import hashlib
import html
import re
import sys
import time
import urllib.request

PAGINE = ("https://www.garepodistichelazio.it/gare-lazio.php", "https://www.garepodistichelazio.it/gare-anno-successivo.php?tipo=0")
BASE = "https://www.garepodistichelazio.it/"
FONTE = "Gare Podistiche Lazio"
USER_AGENT = "RaceBuddy-calendario/0.1 (progetto amatoriale; contatto via GitHub lucaalbanesi/racebuddy)"

RIGA = re.compile(r"<tr style='background-color:#(?:f8f8f8|e5e4e2);'>(.*?)</tr>", re.S)
CELLA = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
DATA = re.compile(r"(\d{2})/(\d{2})/(\d{4})")


def testo(s: str) -> str:
    s = re.sub(r"<br\s*/?>", " ", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def leggi(pagina: str, classe, esclusi) -> list[dict]:
    """Le gare di interesse di una pagina del calendario. `classe(km)` (`classifica_km` del calendario FIDAL:
    (distanza, km reali o None) o None) ed `esclusi` (regex) sono quelli del calendario FIDAL, così le due fonti
    seguono le stesse regole."""
    out = []
    for riga in RIGA.findall(pagina):
        celle = CELLA.findall(riga)
        if len(celle) < 7:
            continue
        quando, nome, km_txt, luogo_txt, iscr, quota = testo(celle[0]), testo(celle[2]), testo(celle[3]), testo(celle[4]), testo(celle[5]), testo(celle[6])
        if "D+" in km_txt.upper() or "+" in km_txt or esclusi.search(nome):
            continue
        m = re.match(r"^\s*(\d+(?:[.,]\d+)?)", km_txt.replace(".", "").replace(",", "."))
        c = classe(float(m.group(1))) if m else None
        dist, km = (c if isinstance(c, tuple) else (c, None)) if c else (None, None)
        date = DATA.findall(quando)
        if not dist or not date:
            continue
        g, me, a = date[-1]  # "Rinviata al 24/01/2027": vale la nuova data
        data = f"{a}-{me}-{g}"
        ora = re.search(r"\((\d{1,2}[:.]\d{2})\)", quando)
        lm = re.match(r"^(.*?)\s*\(([A-Z]{2})\)\s*$", luogo_txt)
        luogo, prov = (lm.group(1), lm.group(2)) if lm else (luogo_txt, "")
        link = re.findall(r"href='([^']+)'", riga)
        scheda = next((x for x in link if "info-gara-" in x), "")
        esterni = [x for x in link if x.startswith("http")]
        scad = DATA.search(iscr)
        h = hashlib.sha1(f"{data}|{nome}|{luogo}".encode()).hexdigest()[:10]
        gara = {
            "id": f"L{h}-{'k' + format(km, 'g') if km else dist}", "nome": nome, "data": data, "luogo": luogo.upper(), "provincia": prov, "distanza": dist,
            "annullata": "annullat" in quando.lower(), "fonte": FONTE,
            "url": BASE + html.unescape(scheda) if scheda else BASE + "gare-lazio.php",
        }
        if km:
            gara["km"] = km
        if ora:
            gara["ora"] = ora.group(1).replace(".", ":")
        if quota and "non disponibile" not in quota.lower():
            gara["quota"] = quota
        if scad and f"{scad.group(3)}-{scad.group(2)}-{scad.group(1)}" <= data:  # una scadenza dopo la gara è un refuso
            gara["iscrizioni"] = f"{scad.group(3)}-{scad.group(2)}-{scad.group(1)}"
        elif "chiuse" in iscr.lower():
            gara["iscrizioni"] = "chiuse" + (", possibili sul posto" if "posto" in iscr.lower() else "")
        sito = next((x for x in esterni if "facebook.com" not in x), "")
        if sito:
            gara["sito"] = sito
        out.append(gara)
    return out


ARRICCHISCI = ("ora", "quota", "iscrizioni", "sito", "provincia")
VUOTE = {"di", "del", "della", "delle", "dei", "la", "il", "lo", "le", "e", "a", "al", "alla", "in", "per", "run", "corsa", "gara",
         "half", "marathon", "maratona", "maratonina", "mezza", "10k", "km", "trofeo", "memorial", "edizione"}


def parole(nome: str) -> set[str]:
    n = re.sub(r"\b[IVXLCDM]+\^", " ", nome.upper()).lower()
    return {w for w in re.findall(r"[a-zà-ù0-9]+", n) if len(w) > 2 and w not in VUOTE}


def stessa(fidal: dict, lazio: dict, quante_lazio: int) -> bool:
    """Stessa data, luogo e distanza; se quel giorno nella stessa città il Lazio ha più gare, serve anche una parola
    del nome in comune (a Roma la domenica si corrono più 10 km)."""
    return quante_lazio == 1 or bool(parole(fidal["nome"]) & parole(lazio["nome"]))


def unisci(gare: dict[str, dict], lazio: list[dict], chiave_luogo, oggi: str) -> int:
    """Aggiunge le gare di Gare Podistiche Lazio a quelle FIDAL. Ritorna quante sono nuove."""
    k = lambda g: (g["data"], chiave_luogo(g["luogo"]), g["distanza"], g.get("km"))
    fidal: dict[tuple, list[dict]] = {}
    for g in gare.values():
        if g.get("fonte") != FONTE:
            fidal.setdefault(k(g), []).append(g)
    quante: dict[tuple, int] = {}
    for l in lazio:
        quante[k(l)] = quante.get(k(l), 0) + 1
    nuove = 0
    for l in lazio:
        if l["data"] < oggi:
            continue
        g = next((x for x in fidal.get(k(l), []) if stessa(x, l, quante[k(l)])), None)
        if g is None:
            if l["id"] not in gare:
                nuove += 1
            gare[l["id"]] = l
            continue
        for campo in ARRICCHISCI:
            if l.get(campo) and not g.get(campo):
                g[campo] = l[campo]
        g["scheda_lazio"] = l["url"]
        g["annullata"] = g["annullata"] or l["annullata"]
    return nuove


def scarica() -> list[str]:
    pagine = []
    for url in PAGINE:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            pagine.append(urllib.request.urlopen(req, timeout=60).read().decode("utf-8", errors="replace"))
        except Exception as e:
            print(f"Attenzione: {url} non scaricato ({e})", file=sys.stderr)
        time.sleep(2)
    return pagine
