-- RaceBuddy – controllo salute (ottobre 2026). Ogni ora il workflow "Controllo salute" (scripts/salute.js) verifica job,
-- dati e servizi e scrive qui l'esito; la pagina #/salute dell'app lo mostra solo al superamministratore (il telefono di
-- Luca), che può ricevere una push quando qualcosa è KO. Nessun dato degli utenti: solo stati dei job e dei servizi.
--
-- Richiede docs/supabase.sql (push_iscrizioni) e docs/supabase_superadmin.sql (_super). Ripetibile: lo applica il
-- workflow "Pubblica funzioni Supabase"; provato in tests/test_salute.sql.
begin;

create table if not exists public.salute_controlli (
  id bigserial primary key,
  creato timestamptz not null default now(),
  ok boolean not null,
  dati jsonb not null default '{}'
);
create index if not exists salute_controlli_creato on public.salute_controlli (creato desc);
alter table public.salute_controlli enable row level security;
revoke all on public.salute_controlli from public, anon, authenticated;

-- I telefoni che ricevono gli avvisi (endpoint delle loro iscrizioni push): solo del superamministratore
create table if not exists public.salute_avvisi (
  endpoint text primary key,
  creato timestamptz not null default now()
);
alter table public.salute_avvisi enable row level security;
revoke all on public.salute_avvisi from public, anon, authenticated;

-- Gli ultimi controlli (il più recente per primo) e se questo telefono riceve gli avvisi
create or replace function public.stato_salute(p_token text, p_endpoint text default null) returns json
language plpgsql security definer set search_path = '' as $$
begin
  if not public._super(p_token) then raise exception 'solo per il superamministratore'; end if;
  return json_build_object(
    'controlli', (select coalesce(json_agg(json_build_object('creato', c.creato, 'ok', c.ok, 'dati', c.dati) order by c.creato desc, c.id desc), '[]')
      from (select * from public.salute_controlli order by creato desc, id desc limit 48) c),
    'avvisi', p_endpoint is not null and exists (select 1 from public.salute_avvisi a where a.endpoint = p_endpoint),
    'telefoni', (select count(*) from public.salute_avvisi));
end $$;

-- Avvisi push su questo telefono: sì o no (l'iscrizione push deve esserci già)
create or replace function public.salute_avvisi_imposta(p_token text, p_endpoint text, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public._super(p_token) then raise exception 'solo per il superamministratore'; end if;
  if p_endpoint is null or char_length(p_endpoint) > 1000 then raise exception 'iscrizione non valida'; end if;
  if coalesce(p_on, false) then
    if not exists (select 1 from public.push_iscrizioni i where i.endpoint = p_endpoint) then raise exception 'attiva prima le notifiche su questo telefono'; end if;
    insert into public.salute_avvisi (endpoint) values (p_endpoint) on conflict do nothing;
  else
    delete from public.salute_avvisi where endpoint = p_endpoint;
  end if;
end $$;

revoke all on function public.stato_salute(text, text), public.salute_avvisi_imposta(text, text, boolean) from public;
grant execute on function public.stato_salute(text, text), public.salute_avvisi_imposta(text, text, boolean) to anon;

commit;
