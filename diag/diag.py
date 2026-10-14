import re, urllib.request, urllib.parse, itertools
UA={"User-Agent":"RaceBuddy-calendario/0.1 (diagnostica una tantum)"}
def get(u): return urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=60).read().decode("utf-8","replace")
out=[]
base={"anno":"2026","mese":"11"}
extra=[{},{"submit":"Invia"},{"livello":"COD"},{"livello":"COD","submit":"Invia"},{"new_tipo":"0","submit":"Invia"},
       {"livello":"COD","new_tipo":"0","submit":"Invia"},{"livello":"","new_regione":"","new_tipo":"0","new_categoria":"","submit":"Invia"},
       {"livello":"COD","new_regione":"","new_tipo":"0","new_categoria":"","new_campionati":"0","omologazione":"","omologazione_tipo":"","submit":"Invia"},
       {"livello":"COD","new_tipo":"0","new_campionati":"0","submit":"Invia"}]
h0=get("https://www.fidal.it/calendario.php")
m=re.search(r"<select[^>]*name=[\"']mese[\"'][^>]*>(.*?)</select>",h0,re.S|re.I)
out.append("opzioni mese: "+re.sub(r"\s+"," ",m.group(1))[:600] if m else "select mese non trovato")
m=re.search(r"<select[^>]*name=[\"']new_campionati[\"'][^>]*>(.*?)</select>",h0,re.S|re.I)
out.append("opzioni campionati: "+re.sub(r"\s+"," ",m.group(1))[:300] if m else "no campionati")
for e in extra:
    q=urllib.parse.urlencode({**base,**e})
    try:
        h=get("https://www.fidal.it/calendario.php?"+q)
        err="ERRORE" if "PDOException" in h else "ok"
        date=sorted(set(re.findall(r">\s*(\d\d(?:-\d\d)?/\d\d)\s*<",h)))
        ic=re.findall(r"ical_man\.php\?[^\"'<>]*",h)
        out.append(f"{q}\n   -> {err}; date: {date[:5]}...{date[-2:] if date else ''} ({len(date)}); ical: {ic[:1]}")
    except Exception as ex: out.append(f"{q} -> eccezione {ex}")
for q in ["anno=2026&mese=11&livello=COD","anno=2026&mese=11&livello=","anno=2026&mese=11&livello=REG","anno=2026&mese=11"]:
    ics=get("https://www.fidal.it/ical/ical_man.php?&"+q)
    out.append(f"ICAL {q}: mesi {sorted(set(re.findall(r'DTSTART[^:]*:(\d{{6}})',ics)))} eventi {ics.count('BEGIN:VEVENT')}")
open("diag/risultato.txt","w").write("\n".join(out)+"\n")
