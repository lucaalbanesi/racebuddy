-- RaceBuddy – quote gara con la società (novembre 2026).
--
-- Il direttivo dà a una gara della società una quota (prezzo per l'atleta). L'atleta sceglie se iscriversi con la
-- società o per conto suo; con la società riceve un codice di 5 caratteri da mettere nella causale del bonifico (per
-- aiutare il tesoriere a riconciliare l'estratto conto), fa il bonifico dalla sua banca e segna in app che ha pagato.
-- RaceBuddy non vede né muove soldi: "pagato" è quello che dichiara l'atleta, la società non conferma niente in app
-- (per ora). Il direttivo vede, gara per gara, chi si iscrive con la società, con codice, importo e data del bonifico.
-- Intestatario e IBAN della società li imposta l'amministratore in Gestione, dove ogni società accende o spegne la
-- funzione (gruppi.quote_attive, spenta di partenza): spenta, niente si vede e niente si scrive, i dati restano.
--
-- Richiede gruppo, classifiche, stagione e distanza (in quest'ordine). Ripetibile: lo applica il workflow "Pubblica
-- funzioni Supabase" dopo la distanza; provato in tests/test_quote.sql.
begin;

-- ------------------------------------------------------------------ tabelle
alter table public.gruppi add column if not exists intestatario text check (char_length(intestatario) between 1 and 120);
alter table public.gruppi add column if not exists iban text check (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$');
alter table public.gruppi add column if not exists quote_attive boolean not null default false;
-- quota della società per quella gara; null = niente iscrizione con la società
alter table public.gare_societa add column if not exists quota numeric(6,2) check (quota > 0 and quota < 1000);

create table if not exists public.iscrizioni_quote (
  id uuid primary key default gen_random_uuid(),
  gara_id uuid not null references public.gare_societa(id) on delete cascade,
  membro_id uuid not null references public.membri(id) on delete cascade,
  scelta text not null check (scelta in ('societa', 'conto_mio')),
  -- codice per la causale: 5 caratteri senza quelli che si confondono (0/O, 1/I/L); resta lo stesso se si cambia idea
  codice text unique check (codice ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$'),
  importo numeric(6,2),                  -- la quota al momento della scelta (se il direttivo la cambia, resta questa)
  pagato date,                           -- data del bonifico dichiarata dall'atleta; null = da pagare
  creato timestamptz not null default now(),
  aggiornato timestamptz not null default now(),
  unique (gara_id, membro_id)
);
alter table public.iscrizioni_quote enable row level security;

-- ------------------------------------------------------------------ supporto (non esposte)
create or replace function public._codice_quota() returns text
language plpgsql volatile set search_path = '' as $$
declare alfa constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; c text;
begin
  loop
    select string_agg(substr(alfa, 1 + floor(random() * 31)::int, 1), '') into c from generate_series(1, 5);
    exit when not exists (select 1 from public.iscrizioni_quote where codice = c);
  end loop;
  return c;
end $$;

create or replace function public._quota_testo(t text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  t := replace(replace(trim(coalesce(t, '')), '€', ''), ',', '.');
  if t = '' then return null; end if;
  if t !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' then raise exception 'quota non valida'; end if;
  v := t::numeric;
  if v <= 0 or v >= 1000 then raise exception 'quota non valida'; end if;
  return v;
end $$;

-- la gara della società del gruppo del membro, con le quote accese nel gruppo
create or replace function public._gara_quota(m public.membri, p_id uuid) returns public.gare_societa
language plpgsql stable security definer set search_path = '' as $$
declare s public.gare_societa;
begin
  if not coalesce((select g.quote_attive from public.gruppi g where g.id = m.gruppo_id), false) then raise exception 'quote gara spente nel gruppo'; end if;
  select * into s from public.gare_societa where id = p_id and gruppo_id = m.gruppo_id;
  if s.id is null then raise exception 'gara della società non trovata'; end if;
  return s;
end $$;

-- ------------------------------------------------------------------ interruttore della società (amministratore)
create or replace function public.admin_quote(p_token text, p_on boolean) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if m.ruolo <> 'admin' then raise exception 'solo per l''amministratore'; end if;
  update public.gruppi set quote_attive = coalesce(p_on, false) where id = m.gruppo_id;
  return json_build_object('attive', coalesce(p_on, false));
end $$;

-- ------------------------------------------------------------------ conto della società (amministratore)
create or replace function public.quote_conto(p_token text, p jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
  v_int text := nullif(regexp_replace(trim(coalesce(p->>'intestatario', '')), '\s+', ' ', 'g'), '');
  v_iban text := nullif(upper(regexp_replace(coalesce(p->>'iban', ''), '\s', '', 'g')), '');
begin
  if m.ruolo <> 'admin' then raise exception 'solo per l''amministratore'; end if;
  if v_iban is not null and v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then raise exception 'IBAN non valido'; end if;
  if char_length(v_int) > 120 then raise exception 'intestatario troppo lungo'; end if;
  update public.gruppi set intestatario = v_int, iban = v_iban where id = m.gruppo_id;
  return json_build_object('intestatario', v_int, 'iban', v_iban);
end $$;

-- ------------------------------------------------------------------ quota di una gara (direttivo)
create or replace function public.quota_gara(p_token text, p_id uuid, p_quota text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); s public.gare_societa; v numeric := public._quota_testo(p_quota);
begin
  if m.ruolo not in ('admin', 'organizzatore') then raise exception 'solo per il direttivo'; end if;
  s := public._gara_quota(m, p_id);
  update public.gare_societa set quota = v where id = s.id;
  return json_build_object('id', s.id, 'quota', v);
end $$;

-- ------------------------------------------------------------------ scelta dell'atleta
-- p_scelta: 'societa' | 'conto_mio' | null (toglie la scelta). Con la società serve la quota e la gara non ancora corsa.
create or replace function public.scegli_iscrizione(p_token text, p_id uuid, p_scelta text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); s public.gare_societa; i public.iscrizioni_quote;
begin
  s := public._gara_quota(m, p_id);
  if p_scelta is null then
    delete from public.iscrizioni_quote where gara_id = s.id and membro_id = m.id;
    return json_build_object('gara_id', s.id, 'scelta', null);
  end if;
  if p_scelta not in ('societa', 'conto_mio') then raise exception 'scelta non valida'; end if;
  select * into i from public.iscrizioni_quote where gara_id = s.id and membro_id = m.id;
  if p_scelta = 'societa' and coalesce(i.scelta, '') <> 'societa' then
    if s.quota is null then raise exception 'la società non ha una quota per questa gara'; end if;
    if s.data < (now() at time zone 'Europe/Rome')::date then raise exception 'la gara è già passata'; end if;
  end if;
  insert into public.iscrizioni_quote as q (gara_id, membro_id, scelta, codice, importo)
  values (s.id, m.id, p_scelta, case when p_scelta = 'societa' then public._codice_quota() end, case when p_scelta = 'societa' then s.quota end)
  on conflict (gara_id, membro_id) do update set
    scelta = excluded.scelta,
    codice = coalesce(q.codice, excluded.codice),
    importo = case when excluded.scelta = 'societa' and q.scelta <> 'societa' then excluded.importo when excluded.scelta = 'societa' then q.importo end,
    pagato = case when excluded.scelta = 'societa' then q.pagato end,
    aggiornato = now()
  returning * into i;
  return json_build_object('gara_id', i.gara_id, 'scelta', i.scelta, 'codice', case when i.scelta = 'societa' then i.codice end, 'importo', i.importo, 'pagato', i.pagato);
end $$;

-- p_data: data del bonifico (non nel futuro, entro un anno); null = annulla
create or replace function public.segna_pagato(p_token text, p_id uuid, p_data date) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); s public.gare_societa; oggi date := (now() at time zone 'Europe/Rome')::date; n int;
begin
  s := public._gara_quota(m, p_id);
  if p_data is not null and (p_data > oggi or p_data < oggi - 365) then raise exception 'data del bonifico non valida'; end if;
  update public.iscrizioni_quote set pagato = p_data, aggiornato = now() where gara_id = s.id and membro_id = m.id and scelta = 'societa';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'non sei iscritto con la società a questa gara'; end if;
  return json_build_object('gara_id', s.id, 'pagato', p_data);
end $$;

-- ------------------------------------------------------------------ lettura
-- conto della società, quote delle gare, le mie scelte; per il direttivo chi si iscrive con la società, gara per gara
create or replace function public.stato_quote(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); g public.gruppi; dir boolean := m.ruolo in ('admin', 'organizzatore');
begin
  select * into g from public.gruppi where id = m.gruppo_id;
  if not g.quote_attive then  -- spente: solo l'interruttore (e il conto per l'amministratore, per prepararlo)
    return json_build_object('attive', false, 'conto', case when m.ruolo = 'admin' then json_build_object('intestatario', g.intestatario, 'iban', g.iban) end,
      'quote', '[]'::json, 'mie', '[]'::json, 'elenco', '[]'::json);
  end if;
  return json_build_object(
    'attive', true,
    'conto', json_build_object('intestatario', g.intestatario, 'iban', g.iban),
    'quote', (select coalesce(json_agg(json_build_object('id', s.id, 'quota', s.quota)), '[]')
      from public.gare_societa s where s.gruppo_id = m.gruppo_id and s.quota is not null),
    'mie', (select coalesce(json_agg(json_build_object('gara_id', i.gara_id, 'scelta', i.scelta, 'codice', case when i.scelta = 'societa' then i.codice end,
        'importo', i.importo, 'pagato', i.pagato)), '[]') from public.iscrizioni_quote i where i.membro_id = m.id),
    'elenco', case when dir then (select coalesce(json_agg(json_build_object('gara_id', i.gara_id, 'membro_id', x.id, 'nome', x.nome, 'codice', i.codice,
        'importo', i.importo, 'pagato', i.pagato) order by x.nome), '[]')
      from public.iscrizioni_quote i join public.membri x on x.id = i.membro_id
      where x.gruppo_id = m.gruppo_id and i.scelta = 'societa') else '[]'::json end
  );
end $$;

-- ------------------------------------------------------------------ permessi
revoke all on function public._codice_quota(), public._quota_testo(text), public._gara_quota(public.membri, uuid) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['admin_quote(text,boolean)', 'quote_conto(text,jsonb)', 'quota_gara(text,uuid,text)', 'scegli_iscrizione(text,uuid,text)', 'segna_pagato(text,uuid,date)', 'stato_quote(text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;

commit;
