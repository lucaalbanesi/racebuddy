"""Test dell'importatore su un feed di esempio con formati realistici."""
import sys, datetime as dt
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import import_fidal as f

FUT = (dt.date.today() + dt.timedelta(days=40)).strftime("%Y%m%d")
ICS = f"""BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:20261013T175503CEST-7506UXKaj1@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:IX^ StraBresso (5km)\r
LOCATION:Bresso\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a2@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:XX^ Monza21 (10K)\r
LOCATION:Monza\r
URL:https://www.fidal.it/calendario/XX^-Monza21-(10K)/COD14816\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a3@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:Firenze Marathon (42.195km)\r
LOCATION:Firenze\r
DESCRIPTION:Maratona internazionale\\, con staffetta e ten\r
  miles non competitiva\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a4@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:Annullata - Mezza di Esempio (21.0975km)\r
LOCATION:Roma\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a5@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:Trail dei Colli (21km)\r
LOCATION:Bologna\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a6@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:Maratonina del Mare\r
LOCATION:Ostia\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a7@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:X^ Parma Marathon (km 10)\r
LOCATION:Parma\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a8@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:Maratonina di Prova (15km)\r
LOCATION:Prova\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a9@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:Verbania (VB) - 15a Lago Maggiore Marathon - Km. 42,195/33/21,0975/10\r
LOCATION:VERBANIA\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a10@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:XV^ Lago Maggiore Marathon - Maratona\r
LOCATION:VERBANIA\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a11@fidal.it\r
DTSTART;VALUE=DATE:{FUT}\r
SUMMARY:XXXI^ Straffetta Maratona Citta' di Palermo 4X10.5\r
LOCATION:PALERMO\r
END:VEVENT\r
END:VCALENDAR\r
"""

def test_classifica():
    gare = [g for g in (f.to_gara(e) for e in f.parse_ics(ICS)) if g]
    by = {g["luogo"]: g for g in gare}
    assert "Bresso" not in by            # 5 km esclusa
    assert by["Monza"]["distanza"] == "10" and by["Monza"]["id"] == "COD14816-10"
    assert by["Firenze"]["distanza"] == "42"   # 'staffetta' nella descrizione non la esclude
    assert by["Roma"]["distanza"] == "21" and by["Roma"]["annullata"] and by["Roma"]["nome"].startswith("Mezza")
    assert "Bologna" not in by           # trail escluso
    assert by["Ostia"]["distanza"] == "21"     # maratonina = mezza
    assert by["Parma"]["distanza"] == "10"    # km nel nome vince su "Marathon"
    assert "Prova" not in by             # 15 km esclusa anche se "maratonina"
    tutte = {g["id"]: g for e in f.parse_ics(ICS) for g in f.to_gare(e)}
    verb = sorted(g["distanza"] for g in f.deduplica(tutte).values() if g["luogo"] == "VERBANIA")
    assert verb == ["10", "21", "42"]          # elenco regionale diviso, maratona non duplicata
    vm = [g for g in f.deduplica(tutte).values() if g["luogo"] == "VERBANIA" and g["distanza"] == "42"]
    assert vm[0]["nome"] == "XV^ Lago Maggiore Marathon - Maratona"   # tiene il nome più pulito
    assert not any(g["luogo"] == "PALERMO" for g in tutte.values())   # staffetta esclusa
    # id stabile per gare senza codice FIDAL
    again = [g for g in (f.to_gara(e) for e in f.parse_ics(ICS)) if g]
    assert {g["id"] for g in gare} == {g["id"] for g in again}

if __name__ == "__main__":
    test_classifica(); print("ok")
