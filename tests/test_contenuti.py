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
print("ok")
