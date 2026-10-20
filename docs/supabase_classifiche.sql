-- RaceBuddy – classifiche del gruppo, fase 1.
-- Interruttore del gruppo (amministratore), partecipazione del singolo (consenso), risultati certificati dalle classifiche
-- ufficiali (li scrive solo la Edge Function "tempi", con la chiave segreta), tempi mandati al referente, esiti senza tempo.
-- Le classifiche (Gare corse, PB della stagione, Albo d'oro) le calcola l'app (app/logic.js) dai risultati certificati.
--
-- Richiede docs/supabase_gruppo.sql. Ripetibile: lo applica il workflow "Pubblica funzioni Supabase";
-- provato in tests/test_classifiche.sql (workflow "Test database gruppo").
--
-- Online, solo per chi partecipa: gara (nome, data, distanza), tempo o esito, da dove viene, categoria e società della
-- classifica ufficiale. Chi smette di partecipare cancella i suoi risultati online (sul telefono restano).
begin;

alter table public.gruppi add column if not exists classifiche boolean not null default false;
alter table public.membri add column if not exists partecipa boolean not null default false;
alter table public.membri add column if not exists partecipa_dal timestamptz;

create table if not exists public.risultati_gruppo (
  id uuid primary key default gen_random_uuid(),
  membro_id uuid not null references public.membri(id) on delete cascade,
  data date not null,
  distanza text not null check (distanza in ('10', '21', '42')),
  gara_nome text check (char_length(gara_nome) <= 120),
  esito text not null default 'arrivato' check (esito in ('arrivato', 'ritirato', 'non_partito', 'annullata')),
  secondi integer check (secondi > 0),
  fonte text not null check (fonte in ('gpl', 'fidal', 'manuale')),
  categoria text check (char_length(categoria) <= 12),
  societa text check (char_length(societa) <= 120),
  -- certificato: dalla classifica ufficiale o approvato dal referente; in_approvazione: in coda; rifiutato; dichiarato: esito senza tempo
  stato text not null check (stato in ('certificato', 'in_approvazione', 'rifiutato', 'dichiarato')),
  link text check (char_length(link) <= 300),
  nota text check (char_length(nota) <= 280),
  deciso_da uuid references public.membri(id) on delete set null,
  creato timestamptz not null default now(),
  unique (membro_id, data, distanza),
  check ((esito = 'arrivato') = (secondi is not null))
);
create index if not exists risultati_gruppo_membro on public.risultati_gruppo (membro_id);
alter table public.risultati_gruppo enable row level security;

-- ------------------------------------------------------------------ supporto (non esposte)
-- Nome per confronto: minuscole, senza accenti né segni, parole in ordine ("D'Angelo Maria" = "maria d angelo").
create or replace function public._norm_nome(t text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(string_agg(w, ' ' order by w), '')
  from unnest(regexp_split_to_array(trim(regexp_replace(
    translate(lower(coalesce(t, '')), 'àáâäãèéêëìíîïòóôöõùúûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), '[^a-z]+', ' ', 'g')), '\s+')) w
  where w <> '';
$$;

-- Passo credibile tra 2:30 e 15:00 al km, come nella funzione "tempi" (fuori, per esempio, una "6 ore" registrata come 10 km).
create or replace function public._passo_ok(dist text, sec int) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(sec / case dist when '10' then 10 when '21' then 21.0975 when '42' then 42.195 end between 150 and 900, false);
$$;

-- Si possono registrare le gare nuove (da una settimana prima dell'adesione) e, nei primi 30 giorni, anche quelle passate.
create or replace function public._puo_registrare(m public.membri, d date) returns boolean
language sql stable set search_path = '' as $$
  select m.partecipa_dal is not null and d <= current_date + 1
    and (d >= (m.partecipa_dal at time zone 'Europe/Rome')::date - 7 or now() <= m.partecipa_dal + interval '30 days');
$$;

create or replace function public._io_classifiche(p_token text) returns public.membri
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if not (select g.classifiche from public.gruppi g where g.id = m.gruppo_id) then raise exception 'classifiche spente nel gruppo'; end if;
  if not m.partecipa then raise exception 'non partecipi alle classifiche'; end if;
  return m;
end $$;

-- ------------------------------------------------------------------ interruttori
create or replace function public.admin_classifiche(p_token text, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if m.ruolo <> 'admin' then raise exception 'solo per gli amministratori'; end if;
  update public.gruppi set classifiche = coalesce(p_on, false) where id = m.gruppo_id;
end $$;

create or replace function public.partecipa_classifiche(p_token text, p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if coalesce(p_on, false) then
    if not (select g.classifiche from public.gruppi g where g.id = m.gruppo_id) then raise exception 'classifiche spente nel gruppo'; end if;
    if not m.partecipa then update public.membri set partecipa = true, partecipa_dal = now() where id = m.id; end if;
  else
    update public.membri set partecipa = false where id = m.id;
    delete from public.risultati_gruppo where membro_id = m.id;
  end if;
end $$;

-- ------------------------------------------------------------------ risultati certificati (solo dalla funzione "tempi")
-- p_hash: impronta del codice del telefono; p_nome: nome e cognome cercati; p_righe: [{data, distanza, secondi, gara_nome,
-- fonte, categoria, societa}] trovati dalla funzione nelle classifiche ufficiali. Se il nome cercato è quello del membro il
-- risultato è certificato, altrimenti va al referente.
create or replace function public._registra_certificati(p_hash text, p_nome text, p_righe jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri; x jsonb; stesso boolean; st text; d date; dist text; sec int; ok int := 0; attesa int := 0; saltati int := 0;
begin
  select * into m from public.membri where token_hash = p_hash order by creato limit 1;
  if m.id is null then raise exception 'non sei in un gruppo'; end if;
  if not (select g.classifiche from public.gruppi g where g.id = m.gruppo_id) or not m.partecipa then raise exception 'non partecipi alle classifiche'; end if;
  if jsonb_typeof(coalesce(p_righe, '[]')) <> 'array' or jsonb_array_length(coalesce(p_righe, '[]')) > 200 then raise exception 'troppi risultati'; end if;
  stesso := public._norm_nome(p_nome) <> '' and public._norm_nome(p_nome) = public._norm_nome(m.nome);
  st := case when stesso then 'certificato' else 'in_approvazione' end;
  for x in select * from jsonb_array_elements(coalesce(p_righe, '[]')) loop
    begin d := (x->>'data')::date; exception when others then d := null; end;
    dist := x->>'distanza';
    sec := case when x->>'secondi' ~ '^\d{1,6}$' then (x->>'secondi')::int end;
    if d is null or dist not in ('10', '21', '42') or not public._passo_ok(dist, sec) or coalesce(x->>'fonte', '') not in ('gpl', 'fidal')
       or not public._puo_registrare(m, d)
       or exists (select 1 from public.risultati_gruppo r where r.membro_id = m.id and r.data = d and r.distanza = dist and r.stato = 'certificato' and (r.secondi = sec or not stesso)) then
      saltati := saltati + 1; continue;
    end if;
    insert into public.risultati_gruppo (membro_id, data, distanza, gara_nome, esito, secondi, fonte, categoria, societa, stato, nota)
    values (m.id, d, dist, nullif(left(trim(x->>'gara_nome'), 120), ''), 'arrivato', sec, x->>'fonte', nullif(left(trim(x->>'categoria'), 12), ''),
            nullif(left(trim(x->>'societa'), 120), ''), st, case when not stesso then left('Nome nella classifica: ' || coalesce(p_nome, ''), 280) end)
    on conflict (membro_id, data, distanza) do update set gara_nome = excluded.gara_nome, esito = 'arrivato', secondi = excluded.secondi,
      fonte = excluded.fonte, categoria = excluded.categoria, societa = excluded.societa, stato = excluded.stato, nota = excluded.nota,
      link = null, deciso_da = null, creato = now();
    if stesso then ok := ok + 1; else attesa := attesa + 1; end if;
  end loop;
  return json_build_object('certificati', ok, 'in_approvazione', attesa, 'saltati', saltati);
end $$;

-- ------------------------------------------------------------------ dal telefono
-- Tempo non trovato nelle classifiche: va al referente con link o nota. Al massimo 5 in attesa per volta.
create or replace function public.invia_risultato(p_token text, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io_classifiche(p_token); d date; dist text := p->>'distanza'; sec int; r uuid;
begin
  begin d := (p->>'data')::date; exception when others then raise exception 'data non valida'; end;
  sec := public._secondi(p->>'tempo');
  if d is null or dist is null or dist not in ('10', '21', '42') or not public._passo_ok(dist, sec) then raise exception 'tempo non valido'; end if;
  if not public._puo_registrare(m, d) then raise exception 'gara troppo vecchia: dopo i primi 30 giorni si aggiungono solo le gare nuove'; end if;
  if exists (select 1 from public.risultati_gruppo x where x.membro_id = m.id and x.data = d and x.distanza = dist and x.stato = 'certificato') then
    raise exception 'questa gara ha già un tempo certificato';
  end if;
  if (select count(*) from public.risultati_gruppo x where x.membro_id = m.id and x.stato = 'in_approvazione' and not (x.data = d and x.distanza = dist)) >= 5 then
    raise exception 'hai già 5 tempi in attesa del referente';
  end if;
  insert into public.risultati_gruppo (membro_id, data, distanza, gara_nome, esito, secondi, fonte, stato, link, nota)
  values (m.id, d, dist, nullif(left(trim(p->>'gara_nome'), 120), ''), 'arrivato', sec, 'manuale', 'in_approvazione',
          nullif(left(trim(p->>'link'), 300), ''), nullif(left(trim(p->>'nota'), 280), ''))
  on conflict (membro_id, data, distanza) do update set gara_nome = excluded.gara_nome, esito = 'arrivato', secondi = excluded.secondi,
    fonte = 'manuale', categoria = null, societa = null, stato = 'in_approvazione', link = excluded.link, nota = excluded.nota, deciso_da = null, creato = now()
  returning id into r;
  return r;
end $$;

-- Esito senza tempo (ritirato, non partito, annullata) o 'nessuno' per toglierlo. Non conta nelle classifiche.
create or replace function public.segna_esito(p_token text, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io_classifiche(p_token); d date; dist text := p->>'distanza'; e text := p->>'esito';
begin
  begin d := (p->>'data')::date; exception when others then raise exception 'data non valida'; end;
  if d is null or dist is null or dist not in ('10', '21', '42') then raise exception 'gara non valida'; end if;
  if e = 'nessuno' then delete from public.risultati_gruppo x where x.membro_id = m.id and x.data = d and x.distanza = dist and x.stato = 'dichiarato'; return; end if;
  if e is null or e not in ('ritirato', 'non_partito', 'annullata') then raise exception 'esito non valido'; end if;
  if exists (select 1 from public.risultati_gruppo x where x.membro_id = m.id and x.data = d and x.distanza = dist and x.stato = 'certificato') then
    raise exception 'questa gara ha già un tempo certificato';
  end if;
  insert into public.risultati_gruppo (membro_id, data, distanza, gara_nome, esito, secondi, fonte, stato)
  values (m.id, d, dist, nullif(left(trim(p->>'gara_nome'), 120), ''), e, null, 'manuale', 'dichiarato')
  on conflict (membro_id, data, distanza) do update set gara_nome = excluded.gara_nome, esito = excluded.esito, secondi = null, fonte = 'manuale',
    categoria = null, societa = null, stato = 'dichiarato', link = null, nota = null, deciso_da = null, creato = now();
end $$;

create or replace function public.togli_risultato(p_token text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  delete from public.risultati_gruppo where id = p_id and membro_id = m.id;
end $$;

-- ------------------------------------------------------------------ referente (amministratori e organizzatori)
create or replace function public.da_approvare(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if m.ruolo not in ('admin', 'organizzatore') then raise exception 'solo per amministratori e organizzatori'; end if;
  return (select coalesce(json_agg(json_build_object('id', r.id, 'membro', x.nome, 'mio', x.id = m.id, 'data', r.data, 'distanza', r.distanza,
            'gara_nome', r.gara_nome, 'secondi', r.secondi, 'fonte', r.fonte, 'categoria', r.categoria, 'societa', r.societa, 'link', r.link, 'nota', r.nota)
          order by r.creato), '[]')
    from public.risultati_gruppo r join public.membri x on x.id = r.membro_id
    where x.gruppo_id = m.gruppo_id and r.stato = 'in_approvazione' and x.partecipa);
end $$;

-- Il proprio tempo lo approva un altro referente, se nel gruppo ce n'è un altro.
create or replace function public.decidi_risultato(p_token text, p_id uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); chi uuid;
begin
  if m.ruolo not in ('admin', 'organizzatore') then raise exception 'solo per amministratori e organizzatori'; end if;
  select r.membro_id into chi from public.risultati_gruppo r join public.membri x on x.id = r.membro_id
  where r.id = p_id and x.gruppo_id = m.gruppo_id and r.stato = 'in_approvazione';
  if chi is null then raise exception 'tempo non trovato o già deciso'; end if;
  if chi = m.id and exists (select 1 from public.membri o where o.gruppo_id = m.gruppo_id and o.id <> m.id and o.ruolo in ('admin', 'organizzatore')) then
    raise exception 'il tuo tempo lo approva un altro referente';
  end if;
  update public.risultati_gruppo set stato = case when coalesce(p_ok, false) then 'certificato' else 'rifiutato' end, deciso_da = m.id where id = p_id;
end $$;

-- Un tempo certificato sbagliato (per esempio un omonimo): l'amministratore lo annulla.
create or replace function public.annulla_risultato(p_token text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if m.ruolo <> 'admin' then raise exception 'solo per gli amministratori'; end if;
  update public.risultati_gruppo r set stato = 'rifiutato', nota = 'Annullato dal referente', deciso_da = m.id
  from public.membri x where x.id = r.membro_id and x.gruppo_id = m.gruppo_id and r.id = p_id and r.stato = 'certificato';
  if not found then raise exception 'tempo non trovato'; end if;
end $$;

-- ------------------------------------------------------------------ lettura
-- Le classifiche si vedono solo partecipando; i risultati sono quelli certificati (con il tempo) di chi partecipa.
create or replace function public.stato_classifiche(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); g public.gruppi; vede boolean;
begin
  select * into g from public.gruppi where id = m.gruppo_id;
  vede := g.classifiche and m.partecipa;
  return json_build_object(
    'attive', g.classifiche,
    'io', json_build_object('id', m.id, 'partecipa', m.partecipa, 'dal', m.partecipa_dal, 'recupero_fino', m.partecipa_dal + interval '30 days', 'ruolo', m.ruolo),
    'membri', (select count(*) from public.membri x where x.gruppo_id = m.gruppo_id),
    'partecipanti', (select count(*) from public.membri x where x.gruppo_id = m.gruppo_id and x.partecipa),
    'risultati', case when vede then (select coalesce(json_agg(json_build_object('id', r.id, 'membro_id', x.id, 'membro', x.nome, 'mio', x.id = m.id,
        'data', r.data, 'distanza', r.distanza, 'secondi', r.secondi, 'gara_nome', r.gara_nome, 'categoria', r.categoria, 'fonte', r.fonte) order by r.data), '[]')
      from (select r0.* from public.risultati_gruppo r0 join public.membri x0 on x0.id = r0.membro_id
            where x0.gruppo_id = m.gruppo_id and x0.partecipa and r0.stato = 'certificato' and r0.esito = 'arrivato' order by r0.data desc limit 5000) r
      join public.membri x on x.id = r.membro_id) else '[]'::json end,
    'miei', (select coalesce(json_agg(json_build_object('id', r.id, 'data', r.data, 'distanza', r.distanza, 'gara_nome', r.gara_nome, 'esito', r.esito,
        'secondi', r.secondi, 'fonte', r.fonte, 'stato', r.stato, 'nota', r.nota) order by r.data desc), '[]')
      from public.risultati_gruppo r where r.membro_id = m.id),
    'da_approvare', case when m.ruolo in ('admin', 'organizzatore') then (select count(*) from public.risultati_gruppo r join public.membri x on x.id = r.membro_id
      where x.gruppo_id = m.gruppo_id and x.partecipa and r.stato = 'in_approvazione') else 0 end
  );
end $$;

-- ------------------------------------------------------------------ permessi
-- Invito: anche se il gruppo ha le classifiche accese e quanti partecipano (per la prima schermata del funnel)
create or replace function public.info_invito(p_codice text) returns json
language sql security definer set search_path = '' as $$
  select json_build_object('nome', g.nome, 'membri', (select count(*) from public.membri m where m.gruppo_id = g.id),
    'admin', (select m.nome from public.membri m where m.gruppo_id = g.id and m.ruolo = 'admin' order by m.creato limit 1),
    'iniziali', (select json_agg(x.nome) from (select m.nome from public.membri m where m.gruppo_id = g.id order by m.visto desc limit 6) x),
    'classifiche', coalesce(g.classifiche, false),
    'partecipanti', (select count(*) from public.membri m where m.gruppo_id = g.id and m.partecipa))
  from public.gruppi g where g.codice = upper(trim(p_codice));
$$;
revoke all on function public.info_invito(text) from public;
grant execute on function public.info_invito(text) to anon;

revoke all on function public._norm_nome(text), public._passo_ok(text, int), public._puo_registrare(public.membri, date), public._io_classifiche(text) from public, anon, authenticated;
revoke all on function public._registra_certificati(text, text, jsonb) from public, anon, authenticated;
grant execute on function public._registra_certificati(text, text, jsonb) to service_role;
do $$
declare f text;
begin
  foreach f in array array[
    'admin_classifiche(text,boolean)', 'partecipa_classifiche(text,boolean)', 'invia_risultato(text,jsonb)', 'segna_esito(text,jsonb)',
    'togli_risultato(text,uuid)', 'da_approvare(text)', 'decidi_risultato(text,uuid,boolean)', 'annulla_risultato(text,uuid)', 'stato_classifiche(text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;

commit;
