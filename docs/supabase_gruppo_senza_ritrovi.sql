-- RaceBuddy – togliere i ritrovi da un database del gruppo già creato (ottobre 2026).
-- Da eseguire una volta nell'SQL Editor di Supabase. Per un database nuovo basta docs/supabase_gruppo.sql.
-- Prima si aggiorna la lettura del gruppo (così l'app non vede errori), poi si cancellano funzioni e tabelle.

begin;

create or replace function public.stato_gruppo(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  return (select json_build_object(
    'gruppo', (select json_build_object('id', g.id, 'nome', g.nome, 'codice', case when m.ruolo in ('admin', 'organizzatore') then g.codice end) from public.gruppi g where g.id = m.gruppo_id),
    'io', json_build_object('id', m.id, 'nome', m.nome, 'ruolo', m.ruolo, 'mostra_gare', m.mostra_gare),
    'membri', (select coalesce(json_agg(json_build_object('id', x.id, 'nome', x.nome, 'ruolo', x.ruolo, 'visto', x.visto::date) order by x.nome), '[]') from public.membri x where x.gruppo_id = m.gruppo_id),
    'gare', (select coalesce(json_agg(json_build_object('gara_id', gm.gara_id, 'nome', gm.nome, 'data', gm.data, 'luogo', gm.luogo, 'distanza', gm.distanza,
                  'membro', x.nome, 'membro_id', x.id, 'ruolo', gm.ruolo, 'tempo', gm.tempo) order by gm.data, x.nome), '[]')
             from public.gare_membri gm join public.membri x on x.id = gm.membro_id where x.gruppo_id = m.gruppo_id and x.mostra_gare and gm.data >= current_date - 1),
    'bacheca', (select coalesce(json_agg(p order by p.creato desc), '[]') from (
                  select b.id, b.tipo, b.gara_nome, b.distanza, b.data_gara, b.tempo, b.pb, b.testo, b.creato, x.nome as membro, b.membro_id = m.id as mio,
                    (select count(*) from public.applausi a where a.post_id = b.id) as applausi,
                    exists (select 1 from public.applausi a where a.post_id = b.id and a.membro_id = m.id) as applaudito
                  from public.bacheca b join public.membri x on x.id = b.membro_id
                  where b.gruppo_id = m.gruppo_id order by b.creato desc limit 40) p),
    'classifica', (select coalesce(json_agg(c order by c.distanza, c.secondi), '[]') from (
                  select distinct on (b.membro_id, b.distanza) b.distanza, b.tempo, b.secondi, b.gara_nome, b.data_gara, x.nome as membro, b.membro_id = m.id as mio
                  from public.bacheca b join public.membri x on x.id = b.membro_id
                  where b.gruppo_id = m.gruppo_id and b.tipo = 'risultato' and b.in_classifica and b.secondi is not null
                  order by b.membro_id, b.distanza, b.secondi) c)
  ));
end $$;

drop function if exists public.crea_ritrovo(text, jsonb);
drop function if exists public.annulla_ritrovo(text, uuid);
drop function if exists public.rispondi_ritrovo(text, uuid, text);
drop table if exists public.risposte;
drop table if exists public.ritrovi;

commit;
