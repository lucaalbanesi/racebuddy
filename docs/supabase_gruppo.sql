-- RaceBuddy – il gruppo (società): membri, gare in comune, bacheca, classifica PB, amministrazione.
-- Da eseguire una volta nell'SQL Editor di Supabase.
--
-- Identità senza account: ogni telefono genera un codice segreto casuale (token) e lo tiene per sé.
-- Nel database se ne salva solo l'impronta (sha256). Tutte le operazioni passano da funzioni che
-- ricevono il token: l'app non può leggere o scrivere le tabelle direttamente.

create extension if not exists pgcrypto with schema extensions;

create table public.gruppi (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 2 and 60),
  codice text not null unique,
  creato timestamptz not null default now()
);

create table public.membri (
  id uuid primary key default gen_random_uuid(),
  gruppo_id uuid not null references public.gruppi(id) on delete cascade,
  token_hash text not null,
  nome text not null check (char_length(nome) between 1 and 40),
  ruolo text not null default 'membro' check (ruolo in ('admin', 'organizzatore', 'membro')),
  mostra_gare boolean not null default true,
  creato timestamptz not null default now(),
  visto timestamptz not null default now(),
  unique (gruppo_id, token_hash)
);
create index on public.membri (token_hash);

create table public.gare_membri (
  membro_id uuid not null references public.membri(id) on delete cascade,
  gara_id text not null,
  nome text not null,
  data date not null,
  luogo text,
  distanza text not null check (distanza in ('10', '21', '42')),
  ruolo text,
  tempo text,
  primary key (membro_id, gara_id)
);

create table public.bacheca (
  id uuid primary key default gen_random_uuid(),
  gruppo_id uuid not null references public.gruppi(id) on delete cascade,
  membro_id uuid not null references public.membri(id) on delete cascade,
  tipo text not null check (tipo in ('risultato', 'iscrizione')),
  gara_id text,
  gara_nome text,
  distanza text,
  data_gara date,
  tempo text check (tempo ~ '^\d{1,2}:\d{2}(:\d{2})?$'),
  secondi integer,
  pb boolean not null default false,
  in_classifica boolean not null default false,
  testo text check (char_length(testo) <= 280),
  creato timestamptz not null default now()
);

create table public.applausi (
  post_id uuid not null references public.bacheca(id) on delete cascade,
  membro_id uuid not null references public.membri(id) on delete cascade,
  primary key (post_id, membro_id)
);

alter table public.gruppi enable row level security;
alter table public.membri enable row level security;
alter table public.gare_membri enable row level security;
alter table public.bacheca enable row level security;
alter table public.applausi enable row level security;

-- ------------------------------------------------------------------ funzioni di supporto (non esposte)
create or replace function public._hash(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

create or replace function public._io(p_token text) returns public.membri
language plpgsql security definer set search_path = '' as $$
declare m public.membri;
begin
  if p_token is null or char_length(p_token) < 32 then raise exception 'token non valido'; end if;
  select * into m from public.membri where token_hash = public._hash(p_token) order by creato limit 1;
  if m.id is null then raise exception 'non sei in un gruppo'; end if;
  update public.membri set visto = now() where id = m.id;
  return m;
end $$;

create or replace function public._codice() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 8);
$$;

create or replace function public._secondi(t text) returns integer
language sql immutable set search_path = '' as $$
  select case when t ~ '^\d{1,2}:\d{2}:\d{2}$' then split_part(t, ':', 1)::int * 3600 + split_part(t, ':', 2)::int * 60 + split_part(t, ':', 3)::int
              when t ~ '^\d{1,2}:\d{2}$' then split_part(t, ':', 1)::int * 60 + split_part(t, ':', 2)::int end;
$$;

-- ------------------------------------------------------------------ entrare e uscire
create or replace function public.crea_gruppo(p_token text, p_gruppo text, p_nome text) returns json
language plpgsql security definer set search_path = '' as $$
declare g public.gruppi; m public.membri;
begin
  if char_length(coalesce(p_token, '')) < 32 then raise exception 'token non valido'; end if;
  if exists (select 1 from public.membri where token_hash = public._hash(p_token)) then raise exception 'sei già in un gruppo'; end if;
  insert into public.gruppi (nome, codice) values (trim(p_gruppo), public._codice()) returning * into g;
  insert into public.membri (gruppo_id, token_hash, nome, ruolo) values (g.id, public._hash(p_token), trim(p_nome), 'admin') returning * into m;
  return json_build_object('gruppo', g.id, 'membro', m.id, 'codice', g.codice);
end $$;

create or replace function public.info_invito(p_codice text) returns json
language sql security definer set search_path = '' as $$
  select json_build_object('nome', g.nome, 'membri', (select count(*) from public.membri m where m.gruppo_id = g.id),
    'admin', (select m.nome from public.membri m where m.gruppo_id = g.id and m.ruolo = 'admin' order by m.creato limit 1),
    'iniziali', (select json_agg(x.nome) from (select m.nome from public.membri m where m.gruppo_id = g.id order by m.visto desc limit 6) x))
  from public.gruppi g where g.codice = upper(trim(p_codice));
$$;

create or replace function public.entra_gruppo(p_token text, p_codice text, p_nome text, p_mostra boolean) returns json
language plpgsql security definer set search_path = '' as $$
declare g public.gruppi; m public.membri;
begin
  if char_length(coalesce(p_token, '')) < 32 then raise exception 'token non valido'; end if;
  select * into g from public.gruppi where codice = upper(trim(p_codice));
  if g.id is null then raise exception 'invito non valido'; end if;
  if exists (select 1 from public.membri where token_hash = public._hash(p_token) and gruppo_id <> g.id) then raise exception 'sei già in un altro gruppo'; end if;
  if (select count(*) from public.membri where gruppo_id = g.id) >= 300 then raise exception 'gruppo pieno'; end if;
  insert into public.membri (gruppo_id, token_hash, nome, mostra_gare) values (g.id, public._hash(p_token), trim(p_nome), coalesce(p_mostra, true))
  on conflict (gruppo_id, token_hash) do update set nome = excluded.nome, mostra_gare = excluded.mostra_gare
  returning * into m;
  return json_build_object('gruppo', g.id, 'membro', m.id);
end $$;

create or replace function public.esci_gruppo(p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if m.ruolo = 'admin' and (select count(*) from public.membri where gruppo_id = m.gruppo_id and ruolo = 'admin') = 1
     and (select count(*) from public.membri where gruppo_id = m.gruppo_id) > 1 then
    raise exception 'nomina prima un altro amministratore';
  end if;
  delete from public.membri where id = m.id;
  delete from public.gruppi g where g.id = m.gruppo_id and not exists (select 1 from public.membri x where x.gruppo_id = g.id);
end $$;

create or replace function public.aggiorna_profilo(p_token text, p_nome text, p_mostra boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  update public.membri set nome = coalesce(nullif(trim(p_nome), ''), nome), mostra_gare = coalesce(p_mostra, mostra_gare) where id = m.id;
  if p_mostra = false then delete from public.gare_membri where membro_id = m.id; end if;
end $$;

-- ------------------------------------------------------------------ gare dei membri
create or replace function public.sincronizza_gare(p_token text, p_gare jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); x jsonb;
begin
  if not m.mostra_gare then delete from public.gare_membri where membro_id = m.id; return; end if;
  if jsonb_array_length(coalesce(p_gare, '[]')) > 30 then raise exception 'troppe gare'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_gare, '[]')) loop
    if not exists (select 1 from public.gare_membri where membro_id = m.id and gara_id = x->>'id')
       and (x->>'data')::date >= current_date then
      insert into public.bacheca (gruppo_id, membro_id, tipo, gara_id, gara_nome, distanza, data_gara)
      values (m.gruppo_id, m.id, 'iscrizione', x->>'id', left(x->>'nome', 120), x->>'distanza', (x->>'data')::date);
    end if;
  end loop;
  delete from public.gare_membri where membro_id = m.id;
  insert into public.gare_membri (membro_id, gara_id, nome, data, luogo, distanza, ruolo, tempo)
  select m.id, left(e->>'id', 40), left(e->>'nome', 120), (e->>'data')::date, left(e->>'luogo', 80), e->>'distanza', e->>'ruolo', left(e->>'tempo', 12)
  from jsonb_array_elements(coalesce(p_gare, '[]')) e
  where e->>'distanza' in ('10', '21', '42');
end $$;

-- ------------------------------------------------------------------ bacheca e risultati
create or replace function public.pubblica_risultato(p_token text, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); r uuid;
begin
  insert into public.bacheca (gruppo_id, membro_id, tipo, gara_id, gara_nome, distanza, data_gara, tempo, secondi, pb, in_classifica, testo)
  values (m.gruppo_id, m.id, 'risultato', left(p->>'gara_id', 40), left(p->>'gara_nome', 120), p->>'distanza', (p->>'data_gara')::date,
          p->>'tempo', public._secondi(p->>'tempo'), coalesce((p->>'pb')::boolean, false), coalesce((p->>'in_classifica')::boolean, true), nullif(left(trim(p->>'testo'), 280), ''))
  returning id into r;
  return r;
end $$;

create or replace function public.applaudi(p_token text, p_post uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if not exists (select 1 from public.bacheca where id = p_post and gruppo_id = m.gruppo_id) then raise exception 'post non trovato'; end if;
  if exists (select 1 from public.applausi where post_id = p_post and membro_id = m.id) then
    delete from public.applausi where post_id = p_post and membro_id = m.id;
  else
    insert into public.applausi (post_id, membro_id) values (p_post, m.id);
  end if;
end $$;

create or replace function public.togli_post(p_token text, p_post uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  delete from public.bacheca where id = p_post and gruppo_id = m.gruppo_id and (membro_id = m.id or m.ruolo = 'admin');
end $$;

-- ------------------------------------------------------------------ lettura: tutto il gruppo in una chiamata
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

-- ------------------------------------------------------------------ amministrazione
create or replace function public.admin_ruolo(p_token text, p_membro uuid, p_ruolo text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if m.ruolo <> 'admin' then raise exception 'solo per gli amministratori'; end if;
  if p_ruolo not in ('admin', 'organizzatore', 'membro') then raise exception 'ruolo non valido'; end if;
  if p_membro = m.id and p_ruolo <> 'admin' and (select count(*) from public.membri where gruppo_id = m.gruppo_id and ruolo = 'admin') = 1 then
    raise exception 'serve almeno un amministratore';
  end if;
  update public.membri set ruolo = p_ruolo where id = p_membro and gruppo_id = m.gruppo_id;
end $$;

create or replace function public.admin_rimuovi(p_token text, p_membro uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if m.ruolo <> 'admin' then raise exception 'solo per gli amministratori'; end if;
  if p_membro = m.id then raise exception 'per uscire usa «Esci dal gruppo»'; end if;
  delete from public.membri where id = p_membro and gruppo_id = m.gruppo_id;
end $$;

create or replace function public.admin_gruppo(p_token text, p_nome text, p_nuovo_codice boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); c text;
begin
  if m.ruolo <> 'admin' then raise exception 'solo per gli amministratori'; end if;
  update public.gruppi set nome = coalesce(nullif(trim(p_nome), ''), nome),
    codice = case when p_nuovo_codice then public._codice() else codice end
  where id = m.gruppo_id returning codice into c;
  return c;
end $$;

-- ------------------------------------------------------------------ permessi: l'app usa solo queste funzioni
revoke all on function public._hash(text), public._io(text), public._codice(), public._secondi(text) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'crea_gruppo(text,text,text)', 'info_invito(text)', 'entra_gruppo(text,text,text,boolean)', 'esci_gruppo(text)',
    'aggiorna_profilo(text,text,boolean)', 'sincronizza_gare(text,jsonb)',
    'pubblica_risultato(text,jsonb)', 'applaudi(text,uuid)', 'togli_post(text,uuid)',
    'stato_gruppo(text)', 'admin_ruolo(text,uuid,text)', 'admin_rimuovi(text,uuid)', 'admin_gruppo(text,text,boolean)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;
