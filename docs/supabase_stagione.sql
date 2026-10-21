-- RaceBuddy – la stagione del gruppo (fase 2 della gamification): gare della società, obiettivo bloccato alla vigilia,
-- Borsa pronta, percentuale per età (Albo d'oro) e inviti personali (nuovi soci).
-- Le classifiche Impegno e Obiettivo centrato, i badge e i livelli li calcola l'app (app/logic.js) da stato_stagione.
--
-- Richiede docs/supabase_gruppo.sql, docs/supabase_classifiche.sql e docs/supabase_age_grade.sql (in quest'ordine).
-- Ripetibile: lo applica il workflow "Pubblica funzioni Supabase" dopo le classifiche; provato in tests/test_stagione.sql.
--
-- Online, solo per chi partecipa: tempo obiettivo (si blocca alle 23:59 della vigilia), "Borsa pronta" sì/no (non le voci),
-- anno di nascita e sesso facoltativi (mai mostrati: escono solo come percentuale), chi ti ha invitato.
-- Questo file ridefinisce info_invito ed entra_gruppo per accettare anche i codici personali: va applicato DOPO
-- docs/supabase_classifiche.sql.
begin;

alter table public.membri add column if not exists anno_nascita int check (anno_nascita between 1900 and 2100);
alter table public.membri add column if not exists sesso text check (sesso in ('M', 'F'));
alter table public.membri add column if not exists invitato_da uuid references public.membri(id) on delete set null;

-- le gare della società: le sceglie il direttivo; solo queste fanno punti Impegno
create table if not exists public.gare_societa (
  id uuid primary key default gen_random_uuid(),
  gruppo_id uuid not null references public.gruppi(id) on delete cascade,
  data date not null,
  distanza text not null check (distanza in ('10', '21', '42')),
  nome text not null check (char_length(nome) between 1 and 120),
  luogo text check (char_length(luogo) <= 80),
  gara_id text check (char_length(gara_id) <= 40),
  aggiunta_da uuid references public.membri(id) on delete set null,
  creato timestamptz not null default now(),
  unique (gruppo_id, data, distanza)
);
alter table public.gare_societa enable row level security;

-- tempo obiettivo: si scrive fino alla mezzanotte (ora di Roma) del giorno della gara, poi resta com'è
create table if not exists public.obiettivi_gara (
  membro_id uuid not null references public.membri(id) on delete cascade,
  data date not null,
  distanza text not null check (distanza in ('10', '21', '42')),
  secondi int not null check (secondi > 0),
  aggiornato timestamptz not null default now(),
  primary key (membro_id, data, distanza)
);
alter table public.obiettivi_gara enable row level security;

-- Borsa pronta prima della mezzanotte della vigilia: solo sì/no, non le voci
create table if not exists public.borse_pronte (
  membro_id uuid not null references public.membri(id) on delete cascade,
  data date not null,
  distanza text not null check (distanza in ('10', '21', '42')),
  pronta_il timestamptz not null default now(),
  primary key (membro_id, data, distanza)
);
alter table public.borse_pronte enable row level security;

-- link d'invito personale: chi entra con questo codice risulta invitato da quel membro
create table if not exists public.inviti_personali (
  codice text primary key,
  membro_id uuid not null unique references public.membri(id) on delete cascade
);
alter table public.inviti_personali enable row level security;

-- ------------------------------------------------------------------ supporto (non esposte)
-- Fino alla mezzanotte, ora di Roma, del giorno della gara (cioè fino alle 23:59 della vigilia)
create or replace function public._aperta(d date) returns boolean
language sql stable set search_path = '' as $$ select now() < (d::timestamp at time zone 'Europe/Rome'); $$;

-- Età per le tabelle: dall'anno di nascita, altrimenti dall'inizio della categoria FIDAL (SM45 → 45, SM → 23,
-- PM → 20, JM → 18, AM → 16). Null se non si sa.
create or replace function public._eta(p_anno int, p_cat text, p_data date) returns int
language sql immutable set search_path = '' as $$
  select case when e is null then null else greatest(5, least(100, e)) end from (select coalesce(
    extract(year from p_data)::int - p_anno,
    (regexp_match(upper(coalesce(p_cat, '')), '^[A-Z][MF](\d{2})$'))[1]::int,
    case when upper(coalesce(p_cat, '')) ~ '^[A-Z][MF]$' then
      case left(upper(p_cat), 1) when 'S' then 23 when 'P' then 20 when 'J' then 18 when 'A' then 16 end end) as e) t;
$$;

-- Percentuale per età: (standard open / fattore) / tempo * 100, una cifra decimale
create or replace function public._age_grade(p_sesso text, p_dist text, p_eta int, p_sec int) returns numeric
language sql stable set search_path = '' as $$
  select round(a.open_sec / a.fattore / p_sec * 100, 1) from public.age_grade a
  where a.sesso = p_sesso and a.distanza = p_dist and a.eta = p_eta and p_sec > 0;
$$;

create or replace function public._io_stagione(p_token text) returns public.membri
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if not (select g.classifiche from public.gruppi g where g.id = m.gruppo_id) then raise exception 'classifiche spente nel gruppo'; end if;
  return m;
end $$;

-- Il gruppo di un codice: quello del gruppo o un codice personale di un suo membro
create or replace function public._gruppo_da_codice(p_codice text, out g public.gruppi, out da uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  select * into g from public.gruppi where codice = upper(trim(p_codice));
  if g.id is null then
    select i.membro_id into da from public.inviti_personali i where i.codice = upper(trim(p_codice));
    if da is not null then select x.* into g from public.gruppi x join public.membri m on m.gruppo_id = x.id where m.id = da; end if;
  end if;
end $$;

-- Chi smette di partecipare: via anche obiettivi e borse online (i risultati li toglie partecipa_classifiche)
create or replace function public._fuori_stagione() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.obiettivi_gara where membro_id = new.id;
  delete from public.borse_pronte where membro_id = new.id;
  return new;
end $$;
drop trigger if exists fuori_stagione on public.membri;
create trigger fuori_stagione after update of partecipa on public.membri
  for each row when (old.partecipa and not new.partecipa) execute function public._fuori_stagione();

-- ------------------------------------------------------------------ inviti (ridefinite: accettano i codici personali)
create or replace function public.info_invito(p_codice text) returns json
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  select * into r from public._gruppo_da_codice(p_codice);
  if (r.g).id is null then return null; end if;
  return json_build_object('nome', (r.g).nome, 'membri', (select count(*) from public.membri m where m.gruppo_id = (r.g).id),
    'admin', coalesce((select m.nome from public.membri m where m.id = r.da),
                      (select m.nome from public.membri m where m.gruppo_id = (r.g).id and m.ruolo = 'admin' order by m.creato limit 1)),
    'iniziali', (select json_agg(x.nome) from (select m.nome from public.membri m where m.gruppo_id = (r.g).id order by m.visto desc limit 6) x),
    'classifiche', coalesce((r.g).classifiche, false),
    'partecipanti', (select count(*) from public.membri m where m.gruppo_id = (r.g).id and m.partecipa));
end $$;

create or replace function public.entra_gruppo(p_token text, p_codice text, p_nome text, p_mostra boolean) returns json
language plpgsql security definer set search_path = '' as $$
declare r record; m public.membri; nuovo boolean;
begin
  if char_length(coalesce(p_token, '')) < 32 then raise exception 'token non valido'; end if;
  select * into r from public._gruppo_da_codice(p_codice);
  if (r.g).id is null then raise exception 'invito non valido'; end if;
  if exists (select 1 from public.membri where token_hash = public._hash(p_token) and gruppo_id <> (r.g).id) then raise exception 'sei già in un altro gruppo'; end if;
  if (select count(*) from public.membri where gruppo_id = (r.g).id) >= 300 then raise exception 'gruppo pieno'; end if;
  nuovo := not exists (select 1 from public.membri where gruppo_id = (r.g).id and token_hash = public._hash(p_token));
  insert into public.membri (gruppo_id, token_hash, nome, mostra_gare, invitato_da)
  values ((r.g).id, public._hash(p_token), trim(p_nome), coalesce(p_mostra, true), r.da)
  on conflict (gruppo_id, token_hash) do update set nome = excluded.nome, mostra_gare = excluded.mostra_gare
  returning * into m;
  return json_build_object('gruppo', (r.g).id, 'membro', m.id, 'invitato_da', case when nuovo then r.da end);
end $$;

-- Il mio link personale (lo crea la prima volta)
create or replace function public.mio_invito(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); c text;
begin
  select codice into c from public.inviti_personali where membro_id = m.id;
  if c is null then
    loop
      c := public._codice();
      exit when not exists (select 1 from public.gruppi where codice = c) and not exists (select 1 from public.inviti_personali where codice = c);
    end loop;
    insert into public.inviti_personali (codice, membro_id) values (c, m.id);
  end if;
  return c;
end $$;

-- ------------------------------------------------------------------ gare della società (direttivo)
create or replace function public.gare_societa_aggiungi(p_token text, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io_stagione(p_token); d date; dist text := p->>'distanza'; r uuid;
begin
  if m.ruolo not in ('admin', 'organizzatore') then raise exception 'solo per il direttivo'; end if;
  begin d := (p->>'data')::date; exception when others then raise exception 'data non valida'; end;
  if d is null or dist is null or dist not in ('10', '21', '42') or nullif(trim(p->>'nome'), '') is null then raise exception 'gara non valida'; end if;
  if (select count(*) from public.gare_societa x where x.gruppo_id = m.gruppo_id and extract(year from x.data) = extract(year from d)) >= 40 then
    raise exception 'al massimo 40 gare della società in un anno';
  end if;
  insert into public.gare_societa (gruppo_id, data, distanza, nome, luogo, gara_id, aggiunta_da)
  values (m.gruppo_id, d, dist, left(trim(p->>'nome'), 120), nullif(left(trim(p->>'luogo'), 80), ''), nullif(left(p->>'gara_id', 40), ''), m.id)
  on conflict (gruppo_id, data, distanza) do update set nome = excluded.nome, luogo = excluded.luogo, gara_id = excluded.gara_id
  returning id into r;
  return r;
end $$;

create or replace function public.gare_societa_togli(p_token text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io_stagione(p_token);
begin
  if m.ruolo not in ('admin', 'organizzatore') then raise exception 'solo per il direttivo'; end if;
  delete from public.gare_societa where id = p_id and gruppo_id = m.gruppo_id;
end $$;

-- ------------------------------------------------------------------ dal telefono di chi partecipa
-- Tempo obiettivo: tempo vuoto = toglierlo. Dopo le 23:59 della vigilia non cambia più.
create or replace function public.fissa_obiettivo(p_token text, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io_classifiche(p_token); d date; dist text := p->>'distanza'; sec int;
begin
  begin d := (p->>'data')::date; exception when others then raise exception 'data non valida'; end;
  if d is null or dist is null or dist not in ('10', '21', '42') then raise exception 'gara non valida'; end if;
  if not public._aperta(d) then raise exception 'obiettivo bloccato: la gara è già iniziata'; end if;
  if nullif(trim(coalesce(p->>'tempo', '')), '') is null then
    delete from public.obiettivi_gara where membro_id = m.id and data = d and distanza = dist; return;
  end if;
  sec := public._secondi(p->>'tempo');
  if not public._passo_ok(dist, sec) then raise exception 'tempo non valido'; end if;
  insert into public.obiettivi_gara (membro_id, data, distanza, secondi) values (m.id, d, dist, sec)
  on conflict (membro_id, data, distanza) do update set secondi = excluded.secondi, aggiornato = now();
end $$;

-- Borsa pronta sì/no, fino alle 23:59 della vigilia. "Sì" ripetuto tiene il primo orario.
create or replace function public.segna_borsa(p_token text, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io_classifiche(p_token); d date; dist text := p->>'distanza';
begin
  begin d := (p->>'data')::date; exception when others then raise exception 'data non valida'; end;
  if d is null or dist is null or dist not in ('10', '21', '42') then raise exception 'gara non valida'; end if;
  if not public._aperta(d) then raise exception 'borsa bloccata: la gara è già iniziata'; end if;
  if coalesce((p->>'pronta')::boolean, false) then
    insert into public.borse_pronte (membro_id, data, distanza) values (m.id, d, dist) on conflict do nothing;
  else
    delete from public.borse_pronte where membro_id = m.id and data = d and distanza = dist;
  end if;
end $$;

-- Anno di nascita e sesso per la percentuale per età (facoltativi; null li toglie)
create or replace function public.dati_eta(p_token text, p_anno int, p_sesso text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if p_anno is not null and (p_anno < 1920 or p_anno > extract(year from now())::int - 8) then raise exception 'anno di nascita non valido'; end if;
  if p_sesso is not null and p_sesso not in ('M', 'F') then raise exception 'sesso non valido'; end if;
  update public.membri set anno_nascita = p_anno, sesso = p_sesso where id = m.id;
end $$;

-- ------------------------------------------------------------------ lettura
-- Tutto per Impegno, Obiettivo centrato, Albo d'oro per età, badge e scheda post-gara. Degli altri si vedono gli
-- obiettivi e le borse solo a gara iniziata (prima restano privati); l'età non esce mai, solo la percentuale.
create or replace function public.stato_stagione(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); g public.gruppi; vede boolean;
begin
  select * into g from public.gruppi where id = m.gruppo_id;
  vede := g.classifiche and m.partecipa;
  return json_build_object(
    'io', json_build_object('anno_nascita', m.anno_nascita, 'sesso', m.sesso),
    'partecipanti', case when vede then (select coalesce(json_agg(json_build_object('id', x.id, 'nome', x.nome) order by x.nome), '[]')
      from public.membri x where x.gruppo_id = m.gruppo_id and x.partecipa) else '[]'::json end,
    'gare_societa', (select coalesce(json_agg(json_build_object('id', s.id, 'data', s.data, 'distanza', s.distanza, 'nome', s.nome, 'luogo', s.luogo,
        'gara_id', s.gara_id) order by s.data), '[]') from public.gare_societa s where s.gruppo_id = m.gruppo_id),
    'obiettivi', case when vede then (select coalesce(json_agg(json_build_object('membro_id', o.membro_id, 'data', o.data, 'distanza', o.distanza,
        'secondi', o.secondi)), '[]') from public.obiettivi_gara o join public.membri x on x.id = o.membro_id
      where x.gruppo_id = m.gruppo_id and x.partecipa and (o.membro_id = m.id or not public._aperta(o.data))) else '[]'::json end,
    'borse', case when vede then (select coalesce(json_agg(json_build_object('membro_id', b.membro_id, 'data', b.data, 'distanza', b.distanza)), '[]')
      from public.borse_pronte b join public.membri x on x.id = b.membro_id
      where x.gruppo_id = m.gruppo_id and x.partecipa and (b.membro_id = m.id or not public._aperta(b.data))) else '[]'::json end,
    'inviti', case when vede then (select coalesce(json_agg(json_build_object('invitante_id', x.invitato_da, 'invitato_id', x.id)), '[]')
      from public.membri x where x.gruppo_id = m.gruppo_id and x.partecipa and x.invitato_da is not null) else '[]'::json end,
    'eta', case when vede then (select coalesce(json_agg(json_build_object('id', r.id, 'ag', a.ag, 'circa', x.anno_nascita is null, 'sesso', a.sesso)), '[]')
      from public.risultati_gruppo r join public.membri x on x.id = r.membro_id
      cross join lateral (select coalesce(x.sesso, case when upper(coalesce(r.categoria, '')) ~ '^[A-Z][MF]' then substr(upper(r.categoria), 2, 1) end) as sesso) s
      cross join lateral (select s.sesso, public._age_grade(s.sesso, r.distanza, public._eta(x.anno_nascita, r.categoria, r.data), r.secondi) as ag) a
      where x.gruppo_id = m.gruppo_id and x.partecipa and r.stato = 'certificato' and r.esito = 'arrivato' and a.ag is not null) else '[]'::json end
  );
end $$;

-- ------------------------------------------------------------------ permessi
revoke all on function public._aperta(date), public._eta(int, text, date), public._age_grade(text, text, int, int),
  public._io_stagione(text), public._gruppo_da_codice(text), public._fuori_stagione() from public, anon, authenticated;
revoke all on function public.info_invito(text) from public;
grant execute on function public.info_invito(text) to anon;
do $$
declare f text;
begin
  foreach f in array array[
    'entra_gruppo(text,text,text,boolean)', 'mio_invito(text)', 'gare_societa_aggiungi(text,jsonb)', 'gare_societa_togli(text,uuid)',
    'fissa_obiettivo(text,jsonb)', 'segna_borsa(text,jsonb)', 'dati_eta(text,int,text)', 'stato_stagione(text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;

commit;
