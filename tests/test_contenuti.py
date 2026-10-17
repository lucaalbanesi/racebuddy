"""Test dell'importatore di contenuti: python3 tests/test_contenuti.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import importa_contenuti as c

RSS = """<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>X</title>
<item><title>Come gestire il gel nella mezza maratona</title><link>https://ex.it/a</link><pubDate>Tue, 13 Oct 2026 08:00:00 +0200</pubDate>
<description><![CDATA[<p>Il rifornimento durante la gara è importante: ecco come provarlo nei lunghi prima della mezza.</p><img src="https://ex.it/i.jpg">]]></description></item>
<item><title>Jak zarejestrować konto w Mostbet</title><link>https://ex.it/b</link><pubDate>Tue, 13 Oct 2026 08:00:00 +0200</pubDate><description>casino bonus</description></item>
</channel></rss>"""
ATOM = """<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<entry><title>Tapering: la settimana prima della maratona</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><published>2026-10-12T10:00:00+00:00</published>
<media:group><media:title>t</media:title><media:thumbnail url="https://i.ytimg.com/vi/abc/hqdefault.jpg"/><media:description>Cosa fare negli ultimi giorni prima della gara</media:description></media:group></entry></feed>"""

v = c.voci_feed(RSS)
assert v[0]["titolo"].startswith("Come gestire") and v[0]["data"] == "2026-10-13" and v[0]["immagine"] == "https://ex.it/i.jpg", v[0]
assert "rifornimento" in v[0]["testo"]
assert c.SPAM.search(v[1]["titolo"] + " " + v[1]["testo"])
e = c.etichette(v[0]["titolo"], v[0]["testo"])
assert "rifornimento" in e["argomenti"] and e["distanze"] == ["21"] and "costruzione" in e["fasi"], e
y = c.voci_feed(ATOM)
assert y[0]["link"] == "https://www.youtube.com/watch?v=abc" and y[0]["immagine"].startswith("https://i.ytimg.com") and y[0]["data"] == "2026-10-12", y[0]
e = c.etichette(y[0]["titolo"], y[0]["testo"])
assert "scarico" in e["fasi"] and "42" in e["distanze"], e
assert c.taglia("a " * 200, 20).endswith("…")

# immagine nel testo con lazy-load e virgolette singole
assert c.immagine(c.ET.fromstring("<item/>"), "<p><img class='x' data-src='https://ex.it/l.jpg' src='data:,'></p>") == "https://ex.it/l.jpg"

# feed senza immagine: si prende og:image dalla pagina, si riusa quella già trovata, non si riprova prima di 3 giorni
class Risp:
    def __init__(self, t): self.t = t.encode()
    def read(self, n): return self.t
    def __enter__(self): return self
    def __exit__(self, *a): pass
pagine = {"https://ex.it/a": '<html><head><meta property="og:image" content="https://ex.it/og.jpg"></head>',
          "https://ex.it/b": "<html><head></head>",
          "https://fm.it/x": '<img src="https://fm.it/wp-content/uploads/logo.png"><img src="https://fm.it/wp-content/uploads/2026/08/sold-out.png">'}
aperte = []
def finto(req, timeout=0):
    aperte.append(req.full_url); return Risp(pagine.get(req.full_url, ""))
c.urllib.request.urlopen = finto
c.time.sleep = lambda s: None
voci = [{"id": "a", "tipo": "articolo", "link": "https://ex.it/a", "immagine": None},
        {"id": "b", "tipo": "articolo", "link": "https://ex.it/b", "immagine": None},
        {"id": "v", "tipo": "video", "link": "https://ex.it/v", "immagine": None},
        {"id": "k", "tipo": "articolo", "link": "https://ex.it/k", "immagine": None},
        {"id": "r", "tipo": "articolo", "link": "https://ex.it/r", "immagine": None}]
vecchie = {"k": {"immagine": "https://ex.it/k.jpg"}, "r": {"immagineCercata": "2026-10-16"}}
assert c.completa_immagini(voci, vecchie, "2026-10-17", 10) == 1
assert voci[0]["immagine"] == "https://ex.it/og.jpg" and "immagineCercata" not in voci[0]
assert voci[1]["immagine"] is None and voci[1]["immagineCercata"] == "2026-10-17"
assert voci[3]["immagine"] == "https://ex.it/k.jpg" and voci[4]["immagineCercata"] == "2026-10-16"
assert aperte == ["https://ex.it/a", "https://ex.it/b"], aperte  # niente video, niente già note, niente tentativi recenti
assert c.immagine_pagina("https://fm.it/x") == "https://fm.it/wp-content/uploads/2026/08/sold-out.png"
print("ok")
