#!/usr/bin/env python3
"""Verifica le fonti di contenuti in content/fonti.json.

Per ogni fonte trova il feed (RSS/Atom del sito, feed del canale YouTube,
feed del podcast tramite la ricerca podcast di Apple), lo scarica e annota:
se funziona, quanti contenuti ha pubblicato negli ultimi 30 giorni e l'ultimo titolo.
Risultato in data/fonti_verificate.json. Non copia i contenuti: solo metadati.
"""
import datetime as dt
import email.utils
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Mozilla/5.0 (compatible; RaceBuddy-fonti/0.1; +https://github.com/lucaalbanesi/racebuddy)"}
PERCORSI_FEED = ["/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/blog/feed"]


def get(url: str, timeout: int = 30) -> tuple[int, str, str]:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.geturl(), r.read(3_000_000).decode("utf-8", "replace")


def parse_feed(xml: str) -> list[dict]:
    """Restituisce [{titolo, data}] da RSS o Atom; [] se non è un feed."""
    try:
        root = ET.fromstring(xml.encode("utf-8"))
    except ET.ParseError:
        return []
    items = []
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag not in ("item", "entry"):
            continue
        titolo, data = "", None
        for ch in el:
            t = ch.tag.split("}")[-1]
            if t == "title":
                titolo = (ch.text or "").strip()
            elif t in ("pubDate", "published", "updated", "date") and ch.text and not data:
                data = parse_data(ch.text.strip())
        items.append({"titolo": titolo, "data": data})
    return items


def parse_data(s: str) -> str | None:
    try:
        return email.utils.parsedate_to_datetime(s).date().isoformat()
    except Exception:
        pass
    m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else None


def trova_feed_sito(url: str) -> str | None:
    try:
        _, finale, html = get(url)
    except Exception:
        html, finale = "", url
    for m in re.finditer(r"<link[^>]+>", html, re.I):
        tag = m.group(0)
        if re.search(r"application/(rss|atom)\+xml", tag, re.I):
            href = re.search(r'href=["\']([^"\']+)', tag)
            if href:
                return urllib.parse.urljoin(finale, href.group(1))
    base = url.rstrip("/")
    for p in PERCORSI_FEED:
        cand = base + p
        try:
            _, _, x = get(cand, timeout=20)
            if parse_feed(x):
                return cand
        except Exception:
            continue
    return None


def trova_feed_youtube(url: str) -> str | None:
    _, _, html = get(url)
    m = re.search(r'"channelId":"(UC[\w-]{22})"', html) or re.search(r'channel/(UC[\w-]{22})', html)
    return f"https://www.youtube.com/feeds/videos.xml?channel_id={m.group(1)}" if m else None


def trova_feed_podcast(termine: str) -> tuple[str | None, str | None]:
    q = urllib.parse.urlencode({"term": termine, "media": "podcast", "country": "IT", "limit": 3})
    _, _, js = get(f"https://itunes.apple.com/search?{q}")
    res = json.loads(js).get("results", [])
    if not res:
        return None, None
    return res[0].get("feedUrl"), res[0].get("collectionName")


def main() -> int:
    fonti = json.loads((ROOT / "content" / "fonti.json").read_text(encoding="utf-8"))
    oggi = dt.date.today()
    limite = (oggi - dt.timedelta(days=30)).isoformat()
    out = []
    for f in fonti:
        r = {**f, "feed": None, "stato": "non trovato", "ultimi_30_giorni": 0, "ultimo": None, "nota": ""}
        try:
            if f["tipo"] == "youtube":
                r["feed"] = trova_feed_youtube(f["url"])
            elif f["tipo"] == "podcast":
                r["feed"], trovato = trova_feed_podcast(f["cerca"])
                r["nota"] = f"trovato come: {trovato}" if trovato else ""
            else:
                r["feed"] = trova_feed_sito(f["url"])
            if r["feed"]:
                _, _, x = get(r["feed"])
                items = parse_feed(x)
                if items:
                    date = sorted([i["data"] for i in items if i["data"]], reverse=True)
                    r["ultimi_30_giorni"] = sum(1 for d in date if d >= limite)
                    r["ultimo"] = {"data": date[0] if date else None,
                                   "titolo": next((i["titolo"] for i in items if i["data"] == (date[0] if date else None)), items[0]["titolo"])}
                    r["stato"] = "attivo" if r["ultimi_30_giorni"] else "fermo"
                else:
                    r["stato"] = "feed non leggibile"
        except Exception as e:
            r["stato"] = "errore"
            r["nota"] = str(e)[:160]
        print(f'{r["stato"]:<18} {r["ultimi_30_giorni"]:>3}  {f["nome"]}')
        out.append(r)
        time.sleep(1)
    (ROOT / "data" / "fonti_verificate.json").write_text(json.dumps(
        {"verificato": oggi.isoformat(), "fonti": out}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
