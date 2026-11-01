-- Bonifica una tantum (1 novembre 2026): gli obiettivi della Corsa dei Santi 2026 erano stati fissati sui 9,5 km
-- (la distanza che la squadra conosceva, con la "Distanza vera" sul telefono), ma prima di docs/supabase_distanza.sql
-- i km dell'obiettivo non arrivavano online. Qui si scrivono 9,5 km sugli obiettivi di quella gara che non hanno km,
-- nei gruppi che l'hanno tra le gare della società. Il tempo non cambia. Ripetibile: tocca solo i km ancora vuoti.
-- Si lancia a mano con il workflow "Bonifica una tantum".
with u as (
  update public.obiettivi_gara o set km = 9.5
  from public.membri x, public.gare_societa s
  where o.membro_id = x.id and s.gruppo_id = x.gruppo_id and s.data = '2026-11-01' and s.distanza = '10' and s.nome ilike '%santi%'
    and o.data = s.data and o.distanza = s.distanza and o.km is null
  returning 1)
select count(*) as obiettivi_bonificati from u;
