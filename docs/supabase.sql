-- RaceBuddy – schema Supabase (da eseguire nell'SQL Editor, in ordine)

-- 1) Gare seguite (14/10/2026)
-- vedi conversazione: tabella public.gare_aggiunte, insert/select per anon.

-- 2) Iscrizioni alle notifiche push (messaggio del mattino)
create table public.push_iscrizioni (
  endpoint text primary key check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  dati jsonb not null default '{}'::jsonb check (pg_column_size(dati) <= 20000),
  creato timestamptz not null default now(),
  aggiornato timestamptz not null default now(),
  ultimo_invio date,
  stato jsonb not null default '{}'::jsonb  -- memoria delle regole di non disturbo (cosa è già stato detto)
);

-- Nessun accesso diretto dall'app: solo le due funzioni qui sotto.
-- L'invio (GitHub Actions) legge con la secret key, che ignora queste regole.
alter table public.push_iscrizioni enable row level security;

create or replace function public.salva_iscrizione(p_endpoint text, p_p256dh text, p_auth text, p_dati jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.push_iscrizioni (endpoint, p256dh, auth, dati)
  values (p_endpoint, p_p256dh, p_auth, p_dati)
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, dati = excluded.dati, aggiornato = now();
$$;

create or replace function public.cancella_iscrizione(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_iscrizioni where endpoint = p_endpoint;
$$;

revoke all on function public.salva_iscrizione(text, text, text, jsonb) from public;
revoke all on function public.cancella_iscrizione(text) from public;
grant execute on function public.salva_iscrizione(text, text, text, jsonb) to anon;
grant execute on function public.cancella_iscrizione(text) to anon;
