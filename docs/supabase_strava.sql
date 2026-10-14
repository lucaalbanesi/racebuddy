-- RaceBuddy – Strava senza account (ottobre 2026). Da eseguire nell'SQL Editor di Supabase, dopo supabase_gruppo.sql.
-- Si può rilanciare finché le tabelle sono vuote (ogni esecuzione le ricrea).
--
-- Il collegamento a Strava è legato al codice segreto del telefono (lo stesso del gruppo): online ne va solo l'impronta
-- (sha256), mai il codice. I token di Strava stanno solo qui e li usa solo la funzione "strava" (con la chiave segreta).
-- Se lo stesso atleta Strava si ricollega da un telefono nuovo, il collegamento vecchio viene sostituito.
-- In prova: al massimo 10 atleti.

drop function if exists public.strava_stato();
drop function if exists public.strava_stato(text);
drop table if exists public.strava_stati;
drop table if exists public.strava_atleti;

create table public.strava_atleti (
  proprietario text primary key,          -- impronta del codice segreto del telefono
  athlete_id bigint not null unique,
  access_token text not null,
  refresh_token text not null,
  scade timestamptz not null,
  collegato timestamptz not null default now()
);
-- collegamenti avviati e non ancora tornati da Strava (si scartano dopo 15 minuti)
create table public.strava_stati (
  stato text primary key,
  proprietario text not null,
  creato timestamptz not null default now()
);
alter table public.strava_atleti enable row level security;
alter table public.strava_stati enable row level security;

-- Per l'app: se questo telefono è collegato e quanti posti di tester sono occupati.
create or replace function public.strava_stato(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  if char_length(coalesce(p_token, '')) < 32 then raise exception 'token non valido'; end if;
  return json_build_object(
    'collegato', exists (select 1 from public.strava_atleti where proprietario = public._hash(p_token)),
    'posti', (select count(*) from public.strava_atleti),
    'massimo', 10);
end $$;

revoke all on function public.strava_stato(text) from public;
grant execute on function public.strava_stato(text) to anon;
