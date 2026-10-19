-- RaceBuddy – statistiche d'uso (ottobre 2026). Si può rilanciare: lo applica anche il workflow "Pubblica funzioni Supabase".
--
-- Niente dati personali: solo contatori per giorno.
-- - aperture: il telefono manda un +1 la prima volta che apre l'app nel giorno ("giorno"), nella settimana ("settimana")
--   e in assoluto ("nuovo"). Lo ricorda lui stesso: online non arriva nessun identificativo.
-- - invii: quante notifiche ha mandato il job, per giorno e tipo (lo scrive GitHub Actions con la secret key).
-- - statistiche(parola): restituisce solo totali, se la parola d'ordine è giusta. Nel database c'è solo la sua impronta.
--
-- Per impostare (o cambiare) la parola d'ordine, nell'SQL Editor:
--   insert into public.statistiche_chiave (id, impronta) values (1, encode(extensions.digest('LA-TUA-PAROLA', 'sha256'), 'hex'))
--   on conflict (id) do update set impronta = excluded.impronta;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.aperture (
  giorno date not null,             -- per "settimana": il lunedì della settimana
  tipo text not null check (tipo in ('giorno', 'settimana', 'nuovo')),
  n integer not null default 0,
  primary key (giorno, tipo)
);
create table if not exists public.invii (
  giorno date not null,
  tipo text not null check (char_length(tipo) <= 20),
  n integer not null default 0,
  primary key (giorno, tipo)
);
create table if not exists public.statistiche_chiave (
  id integer primary key default 1 check (id = 1),
  impronta text not null
);
alter table public.aperture enable row level security;
alter table public.invii enable row level security;
alter table public.statistiche_chiave enable row level security;

-- L'app: un +1 anonimo per ciascun tipo indicato (al massimo uno per tipo a chiamata).
create or replace function public.conta_apertura(p_tipi text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare oggi date := (now() at time zone 'Europe/Rome')::date; t text;
begin
  foreach t in array (select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_tipi, '{}')) x where x in ('giorno', 'settimana', 'nuovo')) loop
    insert into public.aperture (giorno, tipo, n) values (case when t = 'settimana' then date_trunc('week', oggi)::date else oggi end, t, 1)
    on conflict (giorno, tipo) do update set n = public.aperture.n + 1;
  end loop;
end $$;

-- Il job delle notifiche: {"mattino": 3, "novita": 1, ...} per oggi.
create or replace function public.conta_invii(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare oggi date := (now() at time zone 'Europe/Rome')::date; k text; v jsonb;
begin
  for k, v in select * from jsonb_each(coalesce(p, '{}')) loop
    if jsonb_typeof(v) = 'number' and (v::text)::int > 0 then
      insert into public.invii (giorno, tipo, n) values (oggi, left(k, 20), (v::text)::int)
      on conflict (giorno, tipo) do update set n = public.invii.n + excluded.n;
    end if;
  end loop;
end $$;

-- La pagina delle statistiche: solo totali.
create or replace function public.statistiche(p_parola text) returns json
language plpgsql security definer set search_path = '' as $$
declare oggi date := (now() at time zone 'Europe/Rome')::date; lun date := date_trunc('week', oggi)::date;
begin
  if not exists (select 1 from public.statistiche_chiave where impronta = encode(extensions.digest(coalesce(p_parola, ''), 'sha256'), 'hex')) then
    perform pg_sleep(1);
    raise exception 'parola d''ordine errata';
  end if;
  return json_build_object(
    'oggi', oggi,
    'attivi', (select coalesce(json_object_agg(giorno, n), '{}') from public.aperture where tipo = 'giorno' and giorno > oggi - 90),
    'settimana', (select coalesce(sum(n), 0) from public.aperture where tipo = 'settimana' and giorno = lun),
    'settimana_prima', (select coalesce(sum(n), 0) from public.aperture where tipo = 'settimana' and giorno = lun - 7),
    'nuovi7', (select coalesce(sum(n), 0) from public.aperture where tipo = 'nuovo' and giorno > oggi - 7),
    'invii7', (select coalesce(json_object_agg(tipo, n), '{}') from (select tipo, sum(n) as n from public.invii where giorno > oggi - 7 group by tipo) x),
    'iscritti', (select count(*) from public.push_iscrizioni),
    'interruttori', (select json_build_object(
        'meteo', count(*) filter (where coalesce(dati->'pref'->>'meteo', 'true') <> 'false'),
        'percorso', count(*) filter (where coalesce(dati->'pref'->>'percorso', 'true') <> 'false'),
        'gara', count(*) filter (where coalesce(dati->'pref'->>'gara', 'true') <> 'false'),
        'novita', count(*) filter (where coalesce(dati->'pref'->>'novita', 'true') <> 'false'),
        'documenti', count(*) filter (where coalesce(dati->'pref'->>'documenti', 'true') <> 'false'),
        'fase', count(*) filter (where coalesce(dati->'pref'->>'fase', 'true') <> 'false')) from public.push_iscrizioni),
    'gare_totali', (select count(distinct gara_id) from public.gare_aggiunte where data >= oggi and gara_id <> 'TEST'),
    'gare', (select coalesce(json_agg(g order by g.n desc, g.data), '[]') from (
        select min(nome) as nome, min(data) as data, min(distanza) as distanza, count(*) as n
        from public.gare_aggiunte where data >= oggi and gara_id <> 'TEST' group by gara_id order by count(*) desc, min(data) limit 5) g),
    'gruppo', json_build_object(
        'membri', (select count(*) from public.membri),
        'attivi7', (select count(*) from public.membri where visto > now() - interval '7 days'),
        'risultati30', (select count(*) from public.bacheca where tipo = 'risultato' and creato > now() - interval '30 days'),
        'personali', (select count(*) from public.pb_membri)),
    'buddy', json_build_object( -- tabelle in docs/supabase_buddy.sql, da applicare prima di questo file
        'domande7', (select coalesce(sum(domande), 0) from public.buddy_giorno where giorno > oggi - 7),
        'oggi', (select coalesce(sum(domande), 0) from public.buddy_giorno where giorno = oggi),
        'token_oggi', (select coalesce(sum(token), 0) from public.buddy_giorno where giorno = oggi),
        'temi7', (select coalesce(json_object_agg(tema, n), '{}') from (select tema, sum(n) as n from public.buddy_temi where giorno > oggi - 7 group by tema) x),
        'temi30', (select coalesce(json_object_agg(tema, n), '{}') from (select tema, sum(n) as n from public.buddy_temi where giorno > oggi - 30 group by tema) x))
  );
end $$;

revoke all on function public.conta_apertura(text[]) from public;
revoke all on function public.conta_invii(jsonb) from public;
revoke all on function public.statistiche(text) from public;
grant execute on function public.conta_apertura(text[]) to anon;
grant execute on function public.statistiche(text) to anon;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.conta_invii(jsonb) to service_role';
  end if;
end $$;
