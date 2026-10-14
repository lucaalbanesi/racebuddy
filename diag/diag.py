import re, urllib.request, urllib.parse, http.cookiejar
UA={"User-Agent":"RaceBuddy-calendario/0.1 (diagnostica una tantum)"}
cj=http.cookiejar.CookieJar(); op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
def get(u,data=None):
    r=urllib.request.Request(u,data=data,headers=UA)
    return op.open(r,timeout=60).read().decode("utf-8","replace")
def mesi(ics): return sorted(set(re.findall(r"DTSTART[^:]*:(\d{6})",ics)))
out=[]
h=get("https://www.fidal.it/calendario.php")
forms=re.findall(r"<form.*?</form>",h,re.S|re.I)
for f in forms:
    if re.search(r"mese|anno",f,re.I):
        out.append("FORM:"+re.sub(r"\s+"," ",re.search(r"<form[^>]*>",f,re.I).group(0)))
        for n in re.findall(r"<(?:select|input)[^>]*name=[\"']([^\"']+)",f,re.I): out.append("  campo: "+n)
        for s in re.findall(r"<select[^>]*name=[\"']([^\"']+)[^>]*>(.*?)</select>",f,re.S|re.I):
            vals=re.findall(r"value=[\"']([^\"']*)",s[1])[:15]; out.append(f"  {s[0]} -> {vals}")
for l in re.findall(r"[^\"'<>]*ical[^\"'<>]*",h,re.I)[:5]: out.append("ICAL: "+l)
out.append("baseline mese=11: "+str(mesi(get("https://www.fidal.it/ical/ical_man.php?&anno=2026&mese=11&livello=COD"))))
for k in ["mese","new_mese","month","mm"]:
    try:
        d=urllib.parse.urlencode({"anno":"2026",k:"11"}).encode()
        h2=get("https://www.fidal.it/calendario.php",d)
        ic=re.findall(r"ical_man\.php\?[^\"'<>]*",h2)
        out.append(f"POST {k}=11 -> date nella pagina: {sorted(set(re.findall(r'(\d\d/1[0-2])',h2)))[:6]} ical:{ic[:1]}")
        out.append(f"   poi ical stesso cookie: {mesi(get('https://www.fidal.it/ical/ical_man.php?&anno=2026&mese=11&livello=COD'))}")
    except Exception as e: out.append(f"POST {k}: errore {e}")
open("diag/risultato.txt","w").write("\n".join(out)+"\n")
print("\n".join(out))
