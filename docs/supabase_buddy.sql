-- RaceBuddy – Buddy, la chat AI (ottobre 2026). Si può rilanciare: lo applica il workflow "Pubblica funzioni Supabase".
--
-- Solo contatori, niente testo delle domande:
-- - buddy_uso: domande di oggi per telefono (impronta sha256 del codice segreto del telefono, come per Strava e gruppo).
--   Serve solo alla quota del giorno: le righe più vecchie di 2 giorni si cancellano da sole.
-- - buddy_giorno: domande e token usati in tutto, per giorno (per restare nel piano gratuito di Groq).
-- - buddy_temi: quante domande per tema (scarpe, integratori, allenamento, fuori_tema), per giorno.
-- Tutto passa dalla Edge Function "buddy" con la secret key: l'app non legge né scrive queste tabelle.

create table if not exists public.buddy_uso (
  giorno date not null,
  impronta text not null check (char_length(impronta) = 64),
  n integer not null default 0,
  primary key (giorno, impronta)
);
create table if not exists public.buddy_giorno (
  giorno date primary key,
  domande integer not null default 0,
  token integer not null default 0
);
create table if not exists public.buddy_temi (
  giorno date not null,
  tema text not null check (tema in ('scarpe', 'integratori', 'allenamento', 'fuori_tema', 'altro')),
  n integer not null default 0,
  primary key (giorno, tema)
);
alter table public.buddy_uso enable row level security;
alter table public.buddy_giorno enable row level security;
alter table public.buddy_temi enable row level security;

-- Stato per la quota: domande di oggi del telefono e di tutti, utenti attivi della settimana (questa e la scorsa).
create or replace function public.buddy_stato(p_impronta text) returns json
language plpgsql security definer set search_path = '' as $$
declare oggi date := (now() at time zone 'Europe/Rome')::date; lun date := date_trunc('week', oggi)::date;
begin
  return json_build_object(
    'oggi', oggi,
    'mie', coalesce((select n from public.buddy_uso where giorno = oggi and impronta = p_impronta), 0),
    'tutte', coalesce((select domande from public.buddy_giorno where giorno = oggi), 0),
    'token', coalesce((select token from public.buddy_giorno where giorno = oggi), 0),
    -- aperture è in docs/supabase_statistiche.sql: telefoni diversi questa settimana e la scorsa
    'attivi', (select coalesce(max(n), 0) from public.aperture where tipo = 'settimana' and giorno in (lun, lun - 7)));
end $$;

-- Una domanda fatta: +1 al telefono, al giorno (con i token) e al tema.
create or replace function public.buddy_conta(p_impronta text, p_tema text, p_token integer) returns void
language plpgsql security definer set search_path = '' as $$
declare oggi date := (now() at time zone 'Europe/Rome')::date;
  t text := case when p_tema in ('scarpe', 'integratori', 'allenamento', 'fuori_tema') then p_tema else 'altro' end;
begin
  insert into public.buddy_uso (giorno, impronta, n) values (oggi, p_impronta, 1)
  on conflict (giorno, impronta) do update set n = public.buddy_uso.n + 1;
  insert into public.buddy_giorno (giorno, domande, token) values (oggi, 1, greatest(coalesce(p_token, 0), 0))
  on conflict (giorno) do update set domande = public.buddy_giorno.domande + 1, token = public.buddy_giorno.token + excluded.token;
  insert into public.buddy_temi (giorno, tema, n) values (oggi, t, 1)
  on conflict (giorno, tema) do update set n = public.buddy_temi.n + 1;
  delete from public.buddy_uso where giorno < oggi - 2;
end $$;

revoke all on function public.buddy_stato(text) from public;
revoke all on function public.buddy_conta(text, text, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.buddy_stato(text) to service_role';
    execute 'grant execute on function public.buddy_conta(text, text, integer) to service_role';
  end if;
end $$;
