-- RaceBuddy – account (login con email e codice) e Strava (ottobre 2026).
-- Da eseguire nell'SQL Editor di Supabase DOPO supabase.sql, supabase_gruppo.sql e supabase_gruppo_personali.sql.
-- Si può rilanciare.
--
-- Il login è facoltativo. Chi entra lega all'account il suo profilo del gruppo e la sua iscrizione alle notifiche:
-- su un altro telefono, dopo il login, ritrova lo stesso profilo (niente doppioni nella classifica).
-- Online, in più, c'è solo l'email (in auth.users, gestita da Supabase).

create extension if not exists pgcrypto with schema extensions;

alter table public.membri add column if not exists user_id uuid references auth.users(id) on delete set null;
create unique index if not exists membri_user_id on public.membri (user_id) where user_id is not null;
alter table public.push_iscrizioni add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- Altri telefoni dello stesso membro (dopo il login): il loro token vale come quello originale.
create table if not exists public.dispositivi (
  token_hash text primary key,
  membro_id uuid not null references public.membri(id) on delete cascade,
  creato timestamptz not null default now()
);
alter table public.dispositivi enable row level security;

-- Il membro di un token: quello originale o un telefono aggiunto dopo il login.
create or replace function public._io(p_token text) returns public.membri
language plpgsql security definer set search_path = '' as $$
declare m public.membri; h text;
begin
  if p_token is null or char_length(p_token) < 32 then raise exception 'token non valido'; end if;
  h := public._hash(p_token);
  select * into m from public.membri where token_hash = h order by creato limit 1;
  if m.id is null then
    select x.* into m from public.membri x join public.dispositivi d on d.membro_id = x.id where d.token_hash = h limit 1;
  end if;
  if m.id is null then raise exception 'non sei in un gruppo'; end if;
  update public.membri set visto = now() where id = m.id;
  return m;
end $$;

-- Dopo il login, da ogni telefono. Lega profilo del gruppo e notifiche all'account, oppure ritrova il profilo.
-- Risponde: {"gruppo": nome o null, "stato": "legato" | "ritrovato" | "nessuno" | "conflitto"}
create or replace function public.collega_account(p_token text, p_endpoint text) returns json
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); h text; m_tok public.membri; m_acc public.membri; st text := 'nessuno'; g text;
begin
  if uid is null then raise exception 'serve il login'; end if;
  if p_endpoint is not null then update public.push_iscrizioni set user_id = uid where endpoint = p_endpoint; end if;
  if char_length(coalesce(p_token, '')) >= 32 then
    h := public._hash(p_token);
    select * into m_tok from public.membri where token_hash = h order by creato limit 1;
    if m_tok.id is null then select x.* into m_tok from public.membri x join public.dispositivi d on d.membro_id = x.id where d.token_hash = h limit 1; end if;
  end if;
  select * into m_acc from public.membri where user_id = uid;
  if m_acc.id is null and m_tok.id is not null then
    update public.membri set user_id = uid where id = m_tok.id; st := 'legato'; g := (select nome from public.gruppi where id = m_tok.gruppo_id);
  elsif m_acc.id is not null and m_tok.id is null then
    if h is not null then insert into public.dispositivi (token_hash, membro_id) values (h, m_acc.id) on conflict (token_hash) do update set membro_id = excluded.membro_id; end if;
    st := 'ritrovato'; g := (select nome from public.gruppi where id = m_acc.gruppo_id);
  elsif m_acc.id is not null and m_tok.id = m_acc.id then
    st := 'legato'; g := (select nome from public.gruppi where id = m_acc.gruppo_id);
  elsif m_acc.id is not null then
    st := 'conflitto';   -- questo telefono è già un altro membro: lo decide l'utente (esce e rientra)
  end if;
  return json_build_object('stato', st, 'gruppo', g);
end $$;

-- Cancella tutto quello che è online di questo utente, poi l'account.
create or replace function public.cancella_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); m public.membri;
begin
  if uid is null then raise exception 'serve il login'; end if;
  select * into m from public.membri where user_id = uid;
  -- l'unico amministratore se ne va: lo diventa il membro più vecchio, il gruppo non resta senza
  if m.ruolo = 'admin' and not exists (select 1 from public.membri where gruppo_id = m.gruppo_id and ruolo = 'admin' and id <> m.id) then
    update public.membri set ruolo = 'admin' where id = (select id from public.membri where gruppo_id = m.gruppo_id and id <> m.id order by creato limit 1);
  end if;
  delete from public.membri where user_id = uid;
  delete from public.gruppi g where g.id = m.gruppo_id and not exists (select 1 from public.membri x where x.gruppo_id = g.id);
  delete from public.push_iscrizioni where user_id = uid;
  delete from public.strava_atleti where user_id = uid;
  delete from auth.users where id = uid;
end $$;

-- ------------------------------------------------------------------ Strava (in prova: al massimo 10 atleti)
-- I token di Strava stanno solo qui e li usa solo la funzione "strava" (Edge Function, con la chiave segreta).
create table if not exists public.strava_atleti (
  user_id uuid primary key references auth.users(id) on delete cascade,
  athlete_id bigint not null unique,
  access_token text not null,
  refresh_token text not null,
  scade timestamptz not null,
  collegato timestamptz not null default now()
);
-- collegamenti avviati e non ancora tornati da Strava (si scartano dopo 15 minuti)
create table if not exists public.strava_stati (
  stato text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  creato timestamptz not null default now()
);
alter table public.strava_atleti enable row level security;
alter table public.strava_stati enable row level security;

-- Per l'app: se sono collegato e quanti posti di tester sono occupati.
create or replace function public.strava_stato() returns json
language sql security definer set search_path = '' as $$
  select json_build_object(
    'collegato', exists (select 1 from public.strava_atleti where user_id = auth.uid()),
    'da', (select collegato from public.strava_atleti where user_id = auth.uid()),
    'posti', (select count(*) from public.strava_atleti),
    'massimo', 10);
$$;

revoke all on function public.collega_account(text, text) from public, anon;
revoke all on function public.cancella_account() from public, anon;
revoke all on function public.strava_stato() from public, anon;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.collega_account(text, text) to authenticated';
    execute 'grant execute on function public.cancella_account() to authenticated';
    execute 'grant execute on function public.strava_stato() to authenticated';
  end if;
end $$;
