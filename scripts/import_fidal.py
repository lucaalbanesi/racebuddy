#!/usr/bin/env python3
"""Importa il calendario gare FIDAL (feed iCal mensili) in data/gare.json.

Uso:
    python scripts/import_fidal.py            # scarica i prossimi 12 mesi
    python scripts/import_fidal.py --mesi 6   # solo i prossimi 6 mesi
    python scripts/import_fidal.py --file feed.ics  # usa un file locale (test)

Scarica il calendario nazionale e regionale. Tiene solo le gare su strada di 10 km, mezza maratona e maratona.
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
    """Una voce per ciascuna distanza di interesse dell'evento."""
    nome = ev.get("SUMMARY", "").strip()
    descr = ev.get("DESCRIPTION", "")
    data = parse_date(ev.get("DTSTART"))
    if not nome or not data:
        return []
    return [g for g in (_gara(ev, nome, descr, data, d) for d in distanze(nome, descr)) if g]


def to_gara(ev: dict) -> dict | None:
    g = to_gare(ev)
    return g[0] if g else None


def _gara(ev: dict, nome: str, descr: str, data: str, dist: str) -> dict | None:
    annullata = bool(re.match(r"\s*annullat[ao]\b", nome, re.I))
    nome_pulito = re.sub(r"^\s*annullat[ao]\s*[-–]\s*", "", nome, flags=re.I)
    url = ev.get("URL", "")
    cod = codice_fidal(url, descr)
    luogo = ev.get("LOCATION", "").strip()
    # L'UID del feed cambia a ogni download: usiamo il codice FIDAL o un hash stabile
    base = cod or "H" + hashlib.sha1(f"{data}|{nome_pulito}|{luogo}".encode()).hexdigest()[:10]
    gid = f"{base}-{dist}"
    return {
        "id": gid,
        "nome": nome_pulito,
        "data": data,
        "luogo": luogo,
        "distanza": dist,
        "annullata": annullata,
        "fonte": "FIDAL",
        "url": url or (f"https://www.fidal.it/calendario/x/{cod}" if cod else "https://www.fidal.it/calendario.php"),
    }


def deduplica(gare: dict[str, dict]) -> dict[str, dict]:
    """La stessa gara compare nel calendario nazionale e in quello regionale con nomi diversi:
    a parità di data, luogo e distanza tiene il nome più breve (di solito quello nazionale)."""
    scelte: dict[tuple, dict] = {}
    for g in gare.values():
        k = (g["data"], g["luogo"].upper(), g["distanza"])
        cur = scelte.get(k)
        if cur is None or (cur["annullata"], len(cur["nome"])) > (g["annullata"], len(g["nome"])):
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
            if g["data"] >= oggi.isoformat() and g["data"][:7] not in mesi_letti and g["id"] not in gare:
                gare[g["id"]] = g
        gare = deduplica(gare)

    elenco = sorted(gare.values(), key=lambda g: (g["data"], g["nome"]))
    if not elenco and errori:
        print("Nessuna gara scaricata: il file esistente non viene toccato.", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "aggiornato": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fonte": "Calendario FIDAL, https://www.fidal.it/calendario.php",
        "gare": elenco,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    per_dist = {d: sum(1 for g in elenco if g["distanza"] == d) for d in ("10", "21", "42")}
    print(f"{len(elenco)} gare salvate (10 km: {per_dist['10']}, mezza: {per_dist['21']}, maratona: {per_dist['42']}); mesi non scaricati: {errori}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
