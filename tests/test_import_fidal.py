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
    test_classifica(); 
# Calendario PDF di maratone e mezze: righe come escono dalla tabella
righe = [
    ["Data fine", "Codice società", "Denominazione società", "Manifestazione", "Edizione", "Città", "Provincia", "Regione", "Tipologia", "Durata"],
    ["14/03/2027", "RM001", "SOC", "Run Rome The Marathon", "XXXII", "Roma", "RM", "Lazio", "STRADA", "42.195km"],
    ["28/02/2027", "RM002", "SOC", "RomaOstia Half Marathon", "LII", "Roma", "RM", "Lazio", "STRADA", "21.0975km"],
    ["01/05/2027", "XX", "SOC", "Trail del Monte", "I", "Paese", "XX", "Lazio", "STRADA", "21.0975km"],
    ["02/05/2027", "XX", "SOC", "Ultra 50", "I", "Paese", "XX", "Lazio", "STRADA", "50km"],
]
gp = f.gare_da_righe(righe, "u")
assert [(g["data"], g["distanza"], g["luogo"]) for g in gp] == [("2027-03-14", "42", "ROMA"), ("2027-02-28", "21", "ROMA")], gp
assert gp[0]["nome"] == "XXXII^ Run Rome The Marathon" and gp[0]["id"].startswith("P")
# a parità di data, luogo e distanza vince il calendario iCal
ical = {"id": "COD1-42", "nome": "XXXII^ Run Rome The Marathon e altro", "data": "2027-03-14", "luogo": "ROMA", "distanza": "42", "annullata": False, "fonte": "FIDAL"}
d = f.deduplica({g["id"]: g for g in gp + [ical]})
assert "COD1-42" in d and gp[0]["id"] not in d
assert f.chiave_luogo("Montecatini-Terme") == f.chiave_luogo("MONTECATINI TERME")
print("ok")

# ---------------------------------------------------------------- Gare Podistiche Lazio (pagine vere, solo le righe)
import calendario_gpl as GPL
FX = Path(__file__).resolve().parent / "fixtures" / "calendario"
mesi = GPL.leggi((FX / "gpl_mesi.html").read_text(encoding="utf-8"), f._classe, f.ESCLUSI)
dopo = GPL.leggi((FX / "gpl_anno_dopo.html").read_text(encoding="utf-8"), f._classe, f.ESCLUSI)
per_nome = {g["nome"]: g for g in mesi + dopo}
rh = per_nome["Rome Half Marathon"]
assert (rh["data"], rh["ora"], rh["distanza"], rh["luogo"], rh["provincia"], rh["quota"]) == ("2026-10-18", "09:00", "21", "ROMA", "RM", "€ 45-65"), rh
assert rh["iscrizioni"] == "chiuse" and rh["sito"].startswith("https://www.romehalfmarathon") and rh["url"].endswith("info-gara-Rome-Half-Marathon")
assert rh["id"].startswith("L") and rh["id"].endswith("-21") and rh["fonte"] == "Gare Podistiche Lazio"
assert per_nome["Straviterbo"]["distanza"] == "10"  # 9,6 km: come nel calendario FIDAL (9,5-10,5)
assert per_nome["Straviterbo"]["iscrizioni"] == "chiuse, possibili sul posto"
assert "Fondi In Rosa" not in per_nome  # 8,5 km
assert not any("Trail" in n for n in per_nome)  # dislivello nei km
assert per_nome["Maratona di Latina"]["distanza"] == "42" and per_nome["Maratona di Latina (10K)"]["distanza"] == "10"
assert per_nome["Run Rome The Marathon"]["data"] == "2027-03-14"
assert "iscrizioni" not in per_nome["Roma Urbs Mundi"]  # scadenza dopo la gara: refuso, fuori
assert per_nome["We Run Rome"]["iscrizioni"] == "2026-12-23"
assert per_nome["Scorrendo Tra Le Fonti"]["data"] == "2027-01-24" if "Scorrendo Tra Le Fonti" in per_nome else True  # rinviata: vale la nuova data
assert GPL.leggi(GPL.leggi.__doc__ or "", f._classe, f.ESCLUSI) == []
# unione con FIDAL: la stessa gara resta FIDAL (stesso id) e prende ora, quota, iscrizioni e sito; le altre entrano
fidal = {"COD9-21": {"id": "COD9-21", "nome": "III^ Rome Half Marathon", "data": "2026-10-18", "luogo": "ROMA", "distanza": "21", "annullata": False, "fonte": "FIDAL", "url": "x"}}
nuove = GPL.unisci(fidal, mesi + dopo, f.chiave_luogo, "2026-10-01")
assert nuove == len(mesi) + len(dopo) - 1, nuove
assert fidal["COD9-21"]["nome"] == "III^ Rome Half Marathon" and fidal["COD9-21"]["ora"] == "09:00" and fidal["COD9-21"]["quota"] == "€ 45-65"
assert fidal["COD9-21"]["scheda_lazio"].endswith("info-gara-Rome-Half-Marathon") and fidal["COD9-21"]["fonte"] == "FIDAL"
assert not any(g["nome"] == "Rome Half Marathon" for g in fidal.values())
assert GPL.unisci(fidal, mesi, f.chiave_luogo, "2026-10-01") == 0  # di nuovo: niente doppioni
assert GPL.unisci({}, mesi, f.chiave_luogo, "2026-11-01") == sum(1 for g in mesi if g["data"] >= "2026-11-01")  # le passate no
print("ok lazio")
