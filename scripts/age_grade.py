"""Tabelle di age-grading per RaceBuddy (Albo d'oro per età).

Fonte: tabelle stradali 2025 di Alan Jones, approvate da USATF MLDR (CC0 1.0),
https://github.com/AlanLyttonJones/Age-Grade-Tables, cartella "2025 Files".

Uso (una volta, o quando escono tabelle nuove):
  python3 scripts/age_grade.py MaleRoadStd2025.xlsx FemaleRoadStd2025.xlsx

Scrive docs/supabase_age_grade.sql (tabella public.age_grade, ripetibile); le percentuali le calcola il database
(_age_grade in docs/supabase_stagione.sql), così l'anno di nascita non esce mai.
Percentuale = (standard open / fattore dell'età) / tempo * 100.
"""
import sys
from pathlib import Path

import openpyxl

COLONNE = {"10": "10 km", "21": "H. Mar", "42": "Marathon"}
RADICE = Path(__file__).resolve().parent.parent


def leggi(percorso):
    ws = openpyxl.load_workbook(percorso, data_only=True).worksheets[0]
    righe = list(ws.iter_rows(values_only=True))
    testa = next(r for r in righe if r and "Age" in r and "10 km" in r)
    oc = next(r for r in righe if r and "OC sec" in r)
    eta_col = list(testa).index("Age")
    out = {}
    for dist, nome in COLONNE.items():
        i = list(testa).index(nome)
        fattori = {}
        for r in righe:
            if r and isinstance(r[eta_col], (int, float)) and isinstance(r[i], (int, float)) and 5 <= r[eta_col] <= 100:
                fattori[str(int(r[eta_col]))] = round(float(r[i]), 4)
        out[dist] = {"open": round(float(oc[i])), "fattori": fattori}
    return out


def main(maschi, femmine):
    dati = {"fonte": "Alan Jones, tabelle stradali 2025 approvate da USATF MLDR (CC0)", "versione": "2025",
            "M": leggi(maschi), "F": leggi(femmine)}
    for s in ("M", "F"):
        for d in COLONNE:
            assert len(dati[s][d]["fattori"]) == 96, (s, d, len(dati[s][d]["fattori"]))
    righe = []
    for s in ("M", "F"):
        for d, t in dati[s].items():
            for eta, f in t["fattori"].items():
                righe.append(f"('{s}','{d}',{eta},{t['open']},{f})")
    sql = [
        "-- RaceBuddy – tabelle di age-grading (Albo d'oro per età). GENERATO da scripts/age_grade.py: non modificare a mano.",
        "-- Fonte: " + dati["fonte"] + ". Percentuale = (open / fattore) / tempo * 100. Ripetibile.",
        "begin;",
        "create table if not exists public.age_grade (sesso text not null, distanza text not null, eta int not null,",
        "  open_sec int not null, fattore numeric not null, primary key (sesso, distanza, eta));",
        "alter table public.age_grade enable row level security;",
        "revoke all on public.age_grade from anon, authenticated;",
        "delete from public.age_grade;",
        "insert into public.age_grade (sesso, distanza, eta, open_sec, fattore) values",
        ",\n".join(righe) + ";",
        "commit;",
    ]
    (RADICE / "docs/supabase_age_grade.sql").write_text("\n".join(sql) + "\n")
    print(f"{len(righe)} fattori scritti")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
