#!/usr/bin/env python3
"""Importa il calendario gare FIDAL (feed iCal mensili) in data/gare.json.

Uso:
    python scripts/import_fidal.py            # scarica i prossimi 12 mesi
    python scripts/import_fidal.py --mesi 6   # solo i prossimi 6 mesi
    python scripts/import_fidal.py --file feed.ics  # usa un file locale (test)

Scarica il calendario nazionale e regionale. Tiene le gare su strada di 10 km, mezza maratona e maratona e, da ottobre
2026, anche quelle di altra distanza tra 5 e 50 km dichiarata nel nome (es. Appia Run 16 km): hanno "km" con i
chilometri reali e come "distanza" la classica più vicina (10/21/42), che serve a preparazione e avvisi.
Le gare annullate restano nell'elenco con "annullata": true, così l'app
può avvisare chi le aveva scelte.
Fonte dati: calendario pubblico FIDAL (https://www.fidal.it/calendario.php).
"""
import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

# submit=Invia è necessario: senza, il feed restituisce sempre il mese in corso
FEED_URL = "https://www.fidal.it/ical/ical_man.php?&submit=Invia&anno={anno}&mese={mese}&livello={livello}"
LIVELLI = ("COD", "REG")  # calendario nazionale e regionale
OUT = Path(__file__).resolve().parent.parent / "data" / "gare.json"
USER_AGENT = "RaceBuddy-calendario/0.1 (progetto amatoriale; contatto via GitHub lucaalbanesi/racebuddy)"

# Parole che escludono una gara anche se la distanza coincide
ESCLUSI = re.compile(r"\b(trail|montagna|cross|pista|marcia|nordic|staffetta|straffetta|ultra|vertical|skyrace|indoor)\b|\b\d+\s*x\s*\d", re.I)


# ---------------------------------------------------------------- parsing iCal
def unfold(text: str) -> list[str]:
    """Riunisce le righe spezzate secondo RFC 5545 (continuano con spazio o tab)."""
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def unescape(value: str) -> str:
    return (value.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",")
            .replace("\\;", ";").replace("\\\\", "\\").strip())


def parse_ics(text: str) -> list[dict]:
    events, cur = [], None
    for line in unfold(text):
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            if cur is not None:
                events.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            key, _, value = line.partition(":")
            name = key.split(";", 1)[0].upper()
            cur[name] = unescape(value)
    return events


def parse_date(value: str | None) -> str | None:
    if not value:
        return None
    m = re.match(r"(\d{4})(\d{2})(\d{2})", value)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


# ------------------------------------------------------------ classificazione
KM = re.compile(r"(\d+(?:[.,]\d+)?)\s*k(?:m)?\b|\bkm\.?\s*(\d+(?:[.,]\d+)?)", re.I)


def _classe(val: float) -> str | None:
    if 9.5 <= val <= 10.5:
        return "10"
    if 21.0 <= val <= 21.2:
        return "21"
    if 42.0 <= val <= 42.3:
        return "42"
    return None


# Altre distanze: da 5 a 50 km. "distanza" = la classica più vicina (fino a 15,5 km la 10, fino a 31,6 la mezza).
KM_MIN, KM_MAX = 5.0, 50.0


def base_km(val: float) -> str:
    return "10" if val < 15.5 else "21" if val < 31.6 else "42"


def classifica_km(val: float) -> tuple[str, float | None] | None:
    """("10"|"21"|"42", None) per le distanze classiche, (classica più vicina, km) per le altre tra 5 e 50 km."""
    c = _classe(val)
    if c:
        return c, None
    if KM_MIN <= val <= KM_MAX:
        return base_km(val), round(val, 3)
    return None


def _valori_km(testo: str) -> list[float]:
    valori = [float((a or b).replace(",", ".")) for a, b in KM.findall(testo)]
    for elenco in re.findall(r"\bkm\.?\s*((?:\d+(?:[.,]\d+)?\s*/\s*)+\d+(?:[.,]\d+)?)", testo, re.I):
        valori += [float(v.replace(",", ".")) for v in re.split(r"\s*/\s*", elenco)]
    return valori


def altre_distanze(nome: str) -> list[float]:
    """Le altre distanze (5-50 km, non classiche) dichiarate nel nome. Solo il nome: la descrizione cita spesso
    gare collaterali (camminate, non competitive)."""
    if ESCLUSI.search(nome):
        return []
    out: list[float] = []
    for v in _valori_km(nome):
        c = classifica_km(v)
        if c and c[1] is not None and c[1] not in out:
            out.append(c[1])
    return out


def _da_km(testo: str) -> tuple[bool, list[str]]:
    """(trovato_km, distanze) dai chilometri scritti nel testo.
    Gestisce anche gli elenchi del calendario regionale: "Km. 42,195/33/21,0975/10"."""
    valori = [float((a or b).replace(",", ".")) for a, b in KM.findall(testo)]
    for elenco in re.findall(r"\bkm\.?\s*((?:\d+(?:[.,]\d+)?\s*/\s*)+\d+(?:[.,]\d+)?)", testo, re.I):
        valori += [float(v.replace(",", ".")) for v in re.split(r"\s*/\s*", elenco)]
    out: list[str] = []
    for v in valori:
        c = _classe(v)
        if c and c not in out:
            out.append(c)
    return bool(valori), out


def _da_parole(testo: str) -> str | None:
    low = testo.lower()
    if re.search(r"\bmezza\b|\bmaratonina\b|half\s*marathon", low):
        return "21"
    if re.search(r"\bmaratona\b|\bmarathon\b", low):
        return "42"
    return None


def distanze(nome: str, descr: str) -> list[str]:
    """Distanze di interesse ('10', '21', '42') della gara, lista vuota se nessuna.
    Ordine: km scritti nel nome, parole chiave nel nome, poi la descrizione."""
    if ESCLUSI.search(nome):  # solo sul nome: la descrizione cita spesso gare collaterali
        return []
    trovati, d = _da_km(nome)
    if trovati:
        return d  # il nome dichiara una distanza: vale quella (es. "Parma Marathon (km 10)")
    p = _da_parole(nome)
    if p:
        return [p]
    trovati, d = _da_km(descr)
    if trovati:
        return d
    p = _da_parole(descr)
    return [p] if p else []


def distanza(nome: str, descr: str) -> str | None:
    d = distanze(nome, descr)
    return d[0] if d else None


def codice_fidal(*testi: str) -> str | None:
    for t in testi:
        m = re.search(r"\b(COD\d+)\b", t or "")
        if m:
            return m.group(1)
    return None


def to_gare(ev: dict) -> list[dict]:
    """Una voce per ciascuna distanza di interesse dell'evento (classiche e altre)."""
    nome = ev.get("SUMMARY", "").strip()
    descr = ev.get("DESCRIPTION", "")
    data = parse_date(ev.get("DTSTART"))
    if not nome or not data:
        return []
    classiche = [g for g in (_gara(ev, nome, descr, data, d) for d in distanze(nome, descr)) if g]
    return classiche + [g for g in (_gara(ev, nome, descr, data, base_km(k), k) for k in altre_distanze(nome)) if g]


def to_gara(ev: dict) -> dict | None:
    g = to_gare(ev)
    return g[0] if g else None


def id_km(km: float) -> str:
    """Suffisso dell'id per le altre distanze: 16 → "k16", 8,5 → "k8.5"."""
    return "k" + f"{km:g}"


def _gara(ev: dict, nome: str, descr: str, data: str, dist: str, km: float | None = None) -> dict | None:
    annullata = bool(re.match(r"\s*annullat[ao]\b", nome, re.I))
    nome_pulito = re.sub(r"^\s*annullat[ao]\s*[-–]\s*", "", nome, flags=re.I)
    url = ev.get("URL", "")
    cod = codice_fidal(url, descr)
    luogo = ev.get("LOCATION", "").strip()
    # L'UID del feed cambia a ogni download: usiamo il codice FIDAL o un hash stabile
    base = cod or "H" + hashlib.sha1(f"{data}|{nome_pulito}|{luogo}".encode()).hexdigest()[:10]
    gid = f"{base}-{id_km(km) if km else dist}"
    g = {
        "id": gid,
        "nome": nome_pulito,
        "data": data,
        "luogo": luogo,
        "distanza": dist,
        "annullata": annullata,
        "fonte": "FIDAL",
        "url": url or (f"https://www.fidal.it/calendario/x/{cod}" if cod else "https://www.fidal.it/calendario.php"),
    }
    if km:
        g["km"] = km
    return g


def chiave_luogo(luogo: str) -> str:
    """'Montecatini-Terme' e 'MONTECATINI TERME' sono lo stesso luogo."""
    t = luogo.upper()
    for a, b in (("À", "A"), ("È", "E"), ("É", "E"), ("Ì", "I"), ("Ò", "O"), ("Ù", "U"), ("'", "")):
        t = t.replace(a, b)
    return re.sub(r"[^A-Z]", "", t)


# ----------------------------------------------------------------- calendario maratone e mezze (PDF FIDAL)
# FIDAL pubblica in anticipo (ottobre) il calendario dell'anno dopo per maratone e mezze, in PDF.
# Si cerca il link nella pagina della notizia; se la pagina cambia, si usa l'ultimo link noto.
CALENDARI_PDF = [
    ("https://www.fidal.it/content/Maratone-e-mezze-219-eventi-nel-2027/186849",
     "https://www.fidal.it/upload/files/Organizzazione/2027/Maratone%20e%20mezze%20maratone/Calendario%20Maratone%20e%20Mezze%20Maratone%202027%20agg.%2029%20settembre.pdf"),
]
DIST_PDF = {"21.0975km": "21", "42.195km": "42"}


def url_pdf(pagina: str, noto: str) -> str:
    try:
        req = urllib.request.Request(pagina, headers={"User-Agent": USER_AGENT})
        html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", errors="replace")
        m = re.search(r'upload/files/Organizzazione/\d{4}/[^"]*Calendario%20Maratone[^"]*\.pdf', html)
        if m:
            return "https://www.fidal.it/" + m.group(0)
    except Exception as e:
        print(f"Attenzione: pagina calendario maratone non letta ({e})", file=sys.stderr)
    return noto


def righe_pdf(dati: bytes) -> list[list[str]]:
    import io
    import pdfplumber  # installato nel workflow
    righe = []
    with pdfplumber.open(io.BytesIO(dati)) as pdf:
        for pagina in pdf.pages:
            for tab in pagina.extract_tables():
                righe += [[(c or "").strip() for c in r] for r in tab]
    return righe


def gare_da_righe(righe: list[list[str]], url: str) -> list[dict]:
    """Colonne: Data fine, Codice società, Denominazione società, Manifestazione, Edizione, Città, Provincia,
    Regione, Tipologia, Durata."""
    out = []
    for r in righe:
        if len(r) < 10 or not re.match(r"\d{2}/\d{2}/\d{4}$", r[0]):
            continue
        data = dt.datetime.strptime(r[0], "%d/%m/%Y").date().isoformat()
        nome, edizione, citta, tipo, durata = r[3].replace("\n", " "), r[4], r[5].replace("\n", " "), r[8].upper(), r[9].replace(" ", "")
        dist = DIST_PDF.get(durata)
        if not dist or tipo != "STRADA" or ESCLUSI.search(nome):
            continue
        nome = f"{edizione}^ {nome}" if edizione else nome
        h = hashlib.sha1(f"{data}|{r[3]}|{citta}".encode()).hexdigest()[:10]
        out.append({"id": f"P{h}-{dist}", "nome": nome, "data": data, "luogo": citta.upper(), "distanza": dist,
                    "annullata": False, "fonte": "FIDAL maratone e mezze", "url": url})
    return out


def gare_pdf() -> list[dict]:
    out = []
    for pagina, noto in CALENDARI_PDF:
        url = url_pdf(pagina, noto)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            out += gare_da_righe(righe_pdf(urllib.request.urlopen(req, timeout=60).read()), url)
        except Exception as e:
            print(f"Attenzione: calendario PDF non letto ({e})", file=sys.stderr)
    return out


def deduplica(gare: dict[str, dict]) -> dict[str, dict]:
    """La stessa gara compare nel calendario nazionale e in quello regionale con nomi diversi:
    a parità di data, luogo e distanza tiene il nome più breve (di solito quello nazionale)."""
    scelte: dict[tuple, dict] = {}
    # a parità, vince il calendario iCal FIDAL rispetto al PDF di maratone e mezze (prima esce, poi resta)
    for g in gare.values():
        k = (g["data"], chiave_luogo(g["luogo"]), g["distanza"], g.get("km"))
        cur = scelte.get(k)
        rank = lambda x: (x["annullata"], x.get("fonte") != "FIDAL", len(x["nome"]))
        if cur is None or rank(cur) > rank(g):
            scelte[k] = g
    return {g["id"]: g for g in scelte.values()}


# ----------------------------------------------------------------- download
def scarica(anno: int, mese: int, livello: str) -> str:
    req = urllib.request.Request(FEED_URL.format(anno=anno, mese=mese, livello=livello), headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


def prossimi_mesi(n: int, oggi: dt.date) -> list[tuple[int, int]]:
    out, a, m = [], oggi.year, oggi.month
    for _ in range(n):
        out.append((a, m))
        m += 1
        if m > 12:
            a, m = a + 1, 1
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mesi", type=int, default=12)
    ap.add_argument("--file", help="file .ics locale invece del download")
    ap.add_argument("--senza-pdf", action="store_true", help="non leggere il calendario PDF di maratone e mezze")
    ap.add_argument("--senza-lazio", action="store_true", help="non leggere il calendario di Gare Podistiche Lazio")
    args = ap.parse_args()

    oggi = dt.date.today()
    eventi: list[dict] = []
    errori = 0
    if args.file:
        eventi = parse_ics(Path(args.file).read_text(encoding="utf-8"))
    else:
        for anno, mese in prossimi_mesi(args.mesi, oggi):
            for livello in LIVELLI:
                try:
                    ev = parse_ics(scarica(anno, mese, livello))
                    fuori = sum(1 for e in ev if not (e.get("DTSTART", "")[:6] == f"{anno}{mese:02d}"))
                    if ev and fuori == len(ev):
                        print(f"Attenzione: {anno}-{mese:02d} {livello}: il feed ha restituito un altro mese", file=sys.stderr)
                    eventi += ev
                except Exception as e:  # un mese che fallisce non blocca gli altri
                    errori += 1
                    print(f"Attenzione: {anno}-{mese:02d} {livello} non scaricato ({e})", file=sys.stderr)
                time.sleep(2)  # gentile con il server FIDAL

    gare: dict[str, dict] = {}
    for ev in eventi:
        for g in to_gare(ev):
            if g["data"] >= oggi.isoformat():
                gare[g["id"]] = g
    gare = deduplica(gare)

    # Conserva le gare future già note solo per i mesi che questa volta non sono arrivati
    # (download fallito): per i mesi scaricati fa fede il feed appena letto.
    if OUT.exists() and not args.file:
        mesi_letti = {g["data"][:7] for g in gare.values()}
        vecchie = json.loads(OUT.read_text(encoding="utf-8")).get("gare", [])
        for g in vecchie:
            # le gare del Lazio no: si rileggono sotto (o si tengono tutte, se il sito non risponde)
            if g["data"] >= oggi.isoformat() and g["data"][:7] not in mesi_letti and g["id"] not in gare and g.get("fonte") != "Gare Podistiche Lazio":
                gare[g["id"]] = g
        gare = deduplica(gare)

    if not args.file and not args.senza_pdf:
        extra = [g for g in gare_pdf() if g["data"] >= oggi.isoformat()]
        print(f"Calendario maratone e mezze (PDF): {len(extra)} gare")
        for g in extra:
            gare.setdefault(g["id"], g)
        gare = deduplica(gare)

    if not args.file and not args.senza_lazio:
        import calendario_gpl as GPL
        pagine = GPL.scarica()
        lazio = [g for p in pagine for g in GPL.leggi(p, classifica_km, ESCLUSI)]
        if not pagine and OUT.exists():  # sito non raggiungibile: restano le gare del Lazio già note
            lazio = [g for g in json.loads(OUT.read_text(encoding="utf-8")).get("gare", []) if g.get("fonte") == GPL.FONTE]
        nuove = GPL.unisci(gare, lazio, chiave_luogo, oggi.isoformat())
        print(f"Gare Podistiche Lazio: {len(lazio)} gare lette, {nuove} nuove (le altre arricchiscono quelle FIDAL)")

    elenco = sorted(gare.values(), key=lambda g: (g["data"], g["nome"]))
    if not elenco and errori:
        print("Nessuna gara scaricata: il file esistente non viene toccato.", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "aggiornato": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fonte": "Calendario FIDAL (https://www.fidal.it/calendario.php), calendario FIDAL di maratone e mezze dell'anno successivo e calendario di Gare Podistiche Lazio (https://www.garepodistichelazio.it/gare-lazio.php)",
        "gare": elenco,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    per_dist = {d: sum(1 for g in elenco if g["distanza"] == d) for d in ("10", "21", "42")}
    print(f"{len(elenco)} gare salvate (10 km: {per_dist['10']}, mezza: {per_dist['21']}, maratona: {per_dist['42']}); mesi non scaricati: {errori}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
