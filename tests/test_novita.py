"""Test delle novità delle gare: python3 tests/test_novita.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import novita_gare as n

firenze = {"id": "F-42", "nome": "XLII^ ESTRA Firenze Marathon", "data": "2026-11-29", "luogo": "FIRENZE", "distanza": "42"}
roma = {"id": "R-21", "nome": "III^ Rome Half Marathon", "data": "2026-10-18", "luogo": "ROMA", "distanza": "21"}
nf = n.nomi_gara(firenze, {"nomi": ["Firenze Marathon"]})
nr = n.nomi_gara(roma, {})
assert "firenze marathon" in nf and "maratona di firenze" in nf and "estra firenze marathon" in nf, nf
assert "rome half marathon" in nr and "mezza maratona di roma" in nr, nr

c = lambda titolo, data="2026-10-20", gara=firenze, nomi=nf, uff=True: n.classifica(titolo, data, gara, nomi, uff)

# temi e urgenze dal sito ufficiale (titoli veri dei feed)
assert c("Ecco la medaglia della 42^ Estra Firenze Marathon") == {"tema": "medaglia", "urgenza": "subito"}
assert c("40° Estra Firenze Marathon: 🏅 Una medaglia, mille storie")["tema"] == "medaglia"
assert c("Il percorso ufficiale della terza edizione della Wizz Air Rome Half Marathon by Brooks 2026", "2026-09-15", roma, nr) == {"tema": "percorso", "urgenza": "subito"}
assert c("Svelata la partenza della Wizz Air Rome Half Marathon by Brooks", "2026-09-08", roma, nr)["urgenza"] == "subito"
assert c("La nuova maglia della Wizz Air Rome Half Marathon by Brooks 2026", "2026-07-22", roma, nr)["tema"] == "maglia"
assert c("ULTIMI PETTORALI DISPONIBILI") == {"tema": "iscrizioni", "urgenza": "app"}      # non è il ritiro del pettorale
assert c("E’ sold out la 42^ Estra Firenze Marathon.")["urgenza"] == "app"
assert c("Il merchandising ufficiale è tornato ⚜️") == {"tema": "promo", "urgenza": "app"}
assert c("Diventa Pacer della Estra Firenze Marathon 2026 🏃‍♂️") == {"tema": "pacer", "urgenza": "mattino"}
assert c("Solo 11 giorni al via della terza edizione, domenica 18 ottobre ore 8.00", "2026-10-07", roma, nr)["urgenza"] == "mattino"  # niente countdown urgenti
assert c("Expo: orari e ritiro dei pettorali")["urgenza"] == "subito"
assert c("Maratona annullata per allerta meteo") == {"tema": "annullata", "urgenza": "subito"}
# risultati e foto: urgenti solo dopo la gara
assert c("Le foto ufficiali della gara", "2026-11-30")["urgenza"] == "subito"
assert c("Le foto dell'allenamento ufficiale", "2026-10-20")["urgenza"] == "mattino"
# altri eventi dello stesso organizzatore: solo app, mai notifiche
assert c("86^ CONAD Notturna di San Giovanni: SOLD OUT") == {"tema": "altro", "urgenza": "app"}
assert c("Medaglia della Notturna di San Giovanni") == {"tema": "altro", "urgenza": "app"}
# edizione: la medaglia del 2024 non vale per la gara del 2026
assert c("40° Estra Firenze Marathon: Una medaglia, mille storie", "2024-12-04") is None
# riviste: solo se nominano la gara
assert c("Svelata la medaglia della Maratona di Firenze 2026", uff=False) == {"tema": "medaglia", "urgenza": "subito"}
assert c("Come gestire il gel in maratona", uff=False) is None
assert c("Rome Half Marathon: 26mila iscritti", "2026-09-01", roma, nr, False)["urgenza"] == "app"
assert c("Mostbet bonus casino Firenze Marathon", uff=False) is None
assert n.nid("https://x.it/a", "F-42") != n.nid("https://x.it/a", "R-21")
print("ok")
