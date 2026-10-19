#!/usr/bin/env python3
"""Foto delle città da Wikimedia Commons (solo CC0 o pubblico dominio).

Due modi, dal file content/foto_ricerca.json:
- `candidati`: per ogni città e tipo ('iconica', 'sfondo') senza 'file', cerca su Commons e salva un provino
  (foto_candidati/<tipo>-<città>.jpg, miniature numerate) con l'elenco in foto_candidati/candidati.json.
- `scarica`: per ogni voce con 'file', scarica la foto (lato lungo 1920 px, JPEG 72, senza EXIF) in
  content/sfondi/<città>.jpg (sfondo) o content/sfondi/<città>-iconica.jpg e la registra in content/sfondi.json
  (chiave = città come in `luogo`, in minuscolo; l'iconica sotto `iconica`).
Gira su GitHub Actions (workflow "Foto delle città"): dall'ambiente di Claude Commons non si raggiunge.
"""
import io, json, re, sys, time, unicodedata, urllib.parse, urllib.request
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

RADICE = Path(__file__).resolve().parent.parent
API = "https://commons.wikimedia.org/w/api.php"
UA = "RaceBuddy/1.0 (https://github.com/lucaalbanesi/racebuddy; foto delle città CC0)"
CC0, PD = "haswbstatement:P275=Q6938433", "haswbstatement:P6216=Q19652"


def chiama(params):
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json", "formatversion": 2})
    for prova in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.load(r)
        except Exception as e:  # rete o limite di richieste: si riprova
            print("  riprovo:", e, file=sys.stderr); time.sleep(3 * (prova + 1))
    return {}


def scarica_byte(url):
    for prova in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except Exception as e:
            print("  riprovo:", e, file=sys.stderr); time.sleep(4 * (prova + 1))
    raise RuntimeError("download non riuscito: " + url)


def testo(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html or "")).strip()


def licenza_ok(nome):
    n = (nome or "").lower()
    return "cc0" in n or "public domain" in n or n.startswith("pd")


def info_file(titoli, larghezza=None):
    p = {"action": "query", "titles": "|".join(titoli), "prop": "imageinfo",
         "iiprop": "url|size|extmetadata", "iiextmetadatafilter": "LicenseShortName|Artist|ObjectName"}
    if larghezza:
        p["iiurlwidth"] = larghezza
    return chiama(p).get("query", {}).get("pages", [])


def cerca(q, limite=12):
    d = chiama({"action": "query", "generator": "search", "gsrsearch": q, "gsrnamespace": 6, "gsrlimit": limite,
                "prop": "imageinfo", "iiprop": "url|size|extmetadata", "iiurlwidth": 400,
                "iiextmetadatafilter": "LicenseShortName|Artist|ObjectName"})
    pagine = d.get("query", {}).get("pages", [])
    return sorted(pagine, key=lambda p: p.get("index", 0))


def candidati(voce, n=8):
    visti, out = set(), []
    for q in voce.get("cerca", []):
        for filtro in (f'{CC0} incategory:"Quality_images"', f'{PD} incategory:"Quality_images"', CC0, PD):
            for p in cerca(f"{q} {filtro} filetype:bitmap"):
                ii = (p.get("imageinfo") or [{}])[0]
                meta = ii.get("extmetadata", {})
                lic = meta.get("LicenseShortName", {}).get("value", "")
                w, h = ii.get("width", 0), ii.get("height", 0)
                if p["title"] in visti or not licenza_ok(lic) or max(w, h) < 1600 or not ii.get("thumburl"):
                    continue
                visti.add(p["title"])
                out.append({"file": p["title"], "licenza": lic, "autore": testo(meta.get("Artist", {}).get("value")),
                            "w": w, "h": h, "miniatura": ii["thumburl"]})
                if len(out) >= n:
                    return out
    return out


def slug(citta):
    s = unicodedata.normalize("NFKD", citta).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def provino(titolo, lista, dest):
    celle, lato = [], 300
    for i, c in enumerate(lista):
        try:
            im = Image.open(io.BytesIO(scarica_byte(c["miniatura"]))).convert("RGB")
        except Exception:
            im = Image.new("RGB", (lato, lato), "#444")
        im = ImageOps.fit(im, (lato, lato))
        d = ImageDraw.Draw(im)
        d.rectangle([0, 0, 64, 40], fill="#000")
        d.text((10, 8), str(i + 1), fill="#fff", font_size=26)
        celle.append(im)
    col = 4
    righe = max(1, (len(celle) + col - 1) // col)
    tela = Image.new("RGB", (col * lato, righe * lato + 44), "#111")
    ImageDraw.Draw(tela).text((10, 8), titolo, fill="#fff", font_size=26)
    for i, im in enumerate(celle):
        tela.paste(im, ((i % col) * lato, 44 + (i // col) * lato))
    tela.save(dest, quality=80)


def modo_candidati(cfg):
    cart = RADICE / "foto_candidati"
    cart.mkdir(exist_ok=True)
    tutti = {}
    for citta, tipi in cfg["citta"].items():
        for tipo, voce in tipi.items():
            if voce.get("file"):
                continue
            lista = candidati(voce)
            print(f"{citta} {tipo}: {len(lista)} candidati")
            tutti[f"{citta}|{tipo}"] = [{k: v for k, v in c.items() if k != "miniatura"} for c in lista]
            if lista:
                provino(f"{citta} · {tipo}", lista, cart / f"{tipo}-{slug(citta)}.jpg")
    (cart / "candidati.json").write_text(json.dumps(tutti, ensure_ascii=False, indent=1))


def modo_scarica(cfg):
    p_sfondi = RADICE / "content" / "sfondi.json"
    sfondi = json.loads(p_sfondi.read_text())
    for citta, tipi in cfg["citta"].items():
        for tipo, voce in tipi.items():
            titolo = voce.get("file")
            if not titolo:
                continue
            nome = f"{slug(citta)}{'' if tipo == 'sfondo' else '-iconica'}.jpg"
            rel = f"content/sfondi/{nome}"
            gia = sfondi.get(citta, {}) if tipo == "sfondo" else sfondi.get(citta, {}).get("iconica", {})
            if gia.get("fonte", "").endswith(urllib.parse.quote(titolo.replace(" ", "_"), safe=":_()',-.")) and (RADICE / rel).exists():
                gia.update({k: voce[k] for k in ("titolo", "fuoco") if k in voce})
                continue
            pagine = info_file([titolo], 1920)
            if not pagine or "imageinfo" not in pagine[0]:
                print(f"{citta} {tipo}: file non trovato {titolo}", file=sys.stderr); continue
            ii = pagine[0]["imageinfo"][0]
            meta = ii.get("extmetadata", {})
            lic = meta.get("LicenseShortName", {}).get("value", "")
            if not licenza_ok(lic):
                print(f"{citta} {tipo}: licenza non ammessa ({lic}) {titolo}", file=sys.stderr); continue
            sorgente = ii["thumburl"] if ii.get("width", 0) > 1920 or ii.get("height", 0) > 1920 else ii["url"]
            im = Image.open(io.BytesIO(scarica_byte(sorgente)))
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((1920, 1920))
            (RADICE / "content" / "sfondi").mkdir(exist_ok=True)
            im.save(RADICE / rel, "JPEG", quality=72, optimize=True, progressive=True)
            dati = {"file": rel, "titolo": voce.get("titolo") or testo(meta.get("ObjectName", {}).get("value")),
                    "autore": testo(meta.get("Artist", {}).get("value")) or "autore sconosciuto",
                    "licenza": "CC0" if "cc0" in lic.lower() else "pubblico dominio",
                    "fonte": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(titolo.replace(" ", "_"), safe=":_()',-."),
                    "fuoco": voce.get("fuoco", [0.5, 0.4])}
            if tipo == "sfondo":
                sfondi[citta] = {**dati, **({"iconica": sfondi[citta]["iconica"]} if "iconica" in sfondi.get(citta, {}) else {})}
            else:
                sfondi.setdefault(citta, {})["iconica"] = dati
            print(f"{citta} {tipo}: {rel} ({im.size[0]}x{im.size[1]}, {lic})")
            time.sleep(1)
    p_sfondi.write_text(json.dumps(sfondi, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    cfg = json.loads((RADICE / "content" / "foto_ricerca.json").read_text())
    {"candidati": modo_candidati, "scarica": modo_scarica}[sys.argv[1] if len(sys.argv) > 1 else "candidati"](cfg)
