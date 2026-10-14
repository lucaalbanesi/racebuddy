-- RaceBuddy – personali del gruppo su un database già creato (ottobre 2026).
-- Da eseguire una volta nell'SQL Editor di Supabase. Per un database nuovo basta docs/supabase_gruppo.sql.
-- La classifica non legge più la bacheca ma i personali (uno per distanza). I migliori tempi già in
-- classifica diventano i personali di partenza; dal telefono arrivano poi quelli inseriti a mano.

begin;

alter table public.membri add column if not exists mostra_pb boolean not null default true;

-- personali: uno per membro e distanza, inseriti a mano o aggiornati dopo una gara
create table if not exists public.pb_membri (
  membro_id uuid not null references public.membri(id) on delete cascade,
  distanza text not null check (distanza in ('10', '21', '42')),
  tempo text not null check (tempo ~ '^\d{1,2}:\d{2}:\d{2}$'),
  secondi integer not null check (secondi > 0),
  gara_nome text check (char_length(gara_nome) <= 120),
  data date,
  primary key (membro_id, distanza)
);

alter table public.pb_membri enable row level security;

insert into public.pb_membri (membro_id, distanza, tempo, secondi, gara_nome, data)
select distinct on (b.membro_id, b.distanza) b.membro_id, b.distanza,
  case when b.tempo ~ '^\d{1,2}:\d{2}$' then '0:' || b.tempo else b.tempo end, b.secondi, b.gara_nome, b.data_gara
from public.bacheca b
where b.tipo = 'risultato' and b.in_classifica and b.secondi is not null and b.distanza in ('10', '21', '42')
order by b.membro_id, b.distanza, b.secondi
on conflict do nothing;

create or replace function public.sincronizza_pb(p_token text, p_pb jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  delete from public.pb_membri where membro_id = m.id;
  if not m.mostra_pb then return; end if;
  if jsonb_array_length(coalesce(p_pb, '[]')) > 3 then raise exception 'troppi personali'; end if;
  insert into public.pb_membri (membro_id, distanza, tempo, secondi, gara_nome, data)
  select distinct on (e->>'distanza') m.id, e->>'distanza', e->>'tempo', public._secondi(e->>'tempo'), nullif(left(trim(e->>'gara'), 120), ''), nullif(e->>'data', '')::date
  from jsonb_array_elements(coalesce(p_pb, '[]')) e
  where e->>'distanza' in ('10', '21', '42');
end $$;

create or replace function public.imposta_mostra_pb(p_token text, p_mostra boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  update public.membri set mostra_pb = coalesce(p_mostra, true) where id = m.id;
  if p_mostra = false then delete from public.pb_membri where membro_id = m.id; end if;
end $$;

create or replace function public.stato_gruppo(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  return (select json_build_object(
    'gruppo', (select json_build_object('id', g.id, 'nome', g.nome, 'codice', case when m.ruolo in ('admin', 'organizzatore') then g.codice end) from public.gruppi g where g.id = m.gruppo_id),
    'io', json_build_object('id', m.id, 'nome', m.nome, 'ruolo', m.ruolo, 'mostra_gare', m.mostra_gare, 'mostra_pb', m.mostra_pb),
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
    'classifica', (select coalesce(json_agg(json_build_object('distanza', p.distanza, 'tempo', p.tempo, 'secondi', p.secondi, 'gara_nome', p.gara_nome, 'data_gara', p.data,
                  'membro', x.nome, 'mio', p.membro_id = m.id) order by p.distanza, p.secondi), '[]')
                from public.pb_membri p join public.membri x on x.id = p.membro_id where x.gruppo_id = m.gruppo_id and x.mostra_pb)
  ));
end $$;

do $$
declare f text;
begin
  foreach f in array array['sincronizza_pb(text,jsonb)', 'imposta_mostra_pb(text,boolean)', 'stato_gruppo(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;

commit;
