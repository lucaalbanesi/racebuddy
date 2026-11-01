-- RaceBuddy – distanza ufficiale delle gare della società e tempi caricati dal direttivo (novembre 2026).
--
-- 1. Distanza ufficiale: il direttivo corregge la distanza di una gara della società già corsa (entro 30 giorni), con
--    il link alla fonte (regolamento o comunicato). Vale per tutti i risultati del gruppo su quella gara, al posto della
--    distanza arrivata dalle classifiche: entro ±50 m dalla classica la gara diventa esatta (km_reali null), altrimenti
--    resta "fuori misura" con i km ufficiali. Lo storico resta (distanze_gare); l'ultima correzione si può annullare.
-- 2. Obiettivi riadattati: obiettivi_gara.km = i km su cui l'atleta ha fissato il tempo (null = la classica). L'app
--    calcola l'obiettivo sulla distanza ufficiale con lo stesso passo (L.obiettiviAdattati); qui l'originale non cambia.
-- 3. Tempi caricati dal direttivo: la funzione "tempi" (azioni soci_cerca / soci_carica) legge i soci con _soci_gara e
--    scrive con _registra_dal_direttivo, solo con la chiave segreta. Non tocca chi ha già un tempo certificato né chi
--    ha segnato ritirato / non partito / annullata.
-- 4. Esiti per le notifiche: _esiti_push dà al job delle notifiche i risultati recenti dei telefoni iscritti (per
--    impronta del codice), per non chiedere "Com'è andata?" a chi ha già il tempo e per avvisare quando il tempo è
--    certificato dal direttivo o deciso dal referente.
--
-- Richiede gruppo, classifiche e stagione (in quest'ordine). Ripetibile: lo applica il workflow "Pubblica funzioni
-- Supabase" dopo la stagione; provato in tests/test_distanza.sql. Ridefinisce fissa_obiettivo e stato_stagione.
begin;

-- ------------------------------------------------------------------ tabelle
alter table public.gare_societa add column if not exists km_uff numeric(6,3) check (km_uff between 5 and 50);
alter table public.obiettivi_gara add column if not exists km numeric(6,3) check (km between 5 and 50);

create table if not exists public.distanze_gare (
  id uuid primary key default gen_random_uuid(),
  gara_id uuid not null references public.gare_societa(id) on delete cascade,
  km_prima numeric(7,4) not null,        -- distanza in vigore prima (ufficiale, del calendario o la classica)
  km numeric(6,3) not null,              -- distanza ufficiale nuova
  km_uff_prima numeric(6,3),             -- gare_societa.km_uff prima della correzione (per annullare)
  prima jsonb not null default '[]',     -- km_reali dei risultati prima della correzione [{id, km}] (per annullare)
  fonte text not null check (fonte ~ '^https?://' and char_length(fonte) <= 300),
  nota text check (char_length(nota) <= 200),
  da uuid references public.membri(id) on delete set null,
  creato timestamptz not null default now(),
  annullata timestamptz
);
alter table public.distanze_gare enable row level security;
alter table public.distanze_gare alter column creato set default clock_timestamp();  -- due correzioni di fila restano in ordine

-- ------------------------------------------------------------------ supporto (non esposte)
create or replace function public._km_classica(dist text) returns numeric
language sql immutable set search_path = '' as $$ select case dist when '10' then 10 when '21' then 21.0975 when '42' then 42.195 end; $$;
-- km_reali di un risultato con quella distanza: null se è la classica esatta (±50 m), come distanzaDaKm in cerca.js
create or replace function public._km_ris(km numeric, dist text) returns numeric
language sql immutable set search_path = '' as $$ select case when abs(km - public._km_classica(dist)) <= 0.05 then null else km end; $$;

-- Ogni risultato arrivato su una gara della società con la distanza corretta prende quella distanza, da qualunque
-- strada entri (ricerca dell'atleta, referente, amministratore, direttivo).
create or replace function public._km_ufficiali() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k numeric;
begin
  if new.esito <> 'arrivato' or new.secondi is null then return new; end if;
  select s.km_uff into k from public.gare_societa s join public.membri x on x.gruppo_id = s.gruppo_id
  where x.id = new.membro_id and s.data = new.data and s.distanza = new.distanza and s.km_uff is not null;
  if k is not null then new.km_reali := public._km_ris(k, new.distanza); end if;
  return new;
end $$;
drop trigger if exists km_ufficiali on public.risultati_gruppo;
create trigger km_ufficiali before insert or update on public.risultati_gruppo for each row execute function public._km_ufficiali();

-- la gara della società del direttivo, finita da non più di 30 giorni
create or replace function public._gara_direttivo(m public.membri, p_id uuid) returns public.gare_societa
language plpgsql stable security definer set search_path = '' as $$
declare s public.gare_societa;
begin
  if m.ruolo not in ('admin', 'organizzatore') then raise exception 'solo per il direttivo'; end if;
  if not coalesce((select g.classifiche from public.gruppi g where g.id = m.gruppo_id), false) then raise exception 'classifiche spente nel gruppo'; end if;
  select * into s from public.gare_societa where id = p_id and gruppo_id = m.gruppo_id;
  if s.id is null then raise exception 'gara della società non trovata'; end if;
  if s.data > (now() at time zone 'Europe/Rome')::date then raise exception 'la gara non è ancora corsa'; end if;
  if s.data < (now() at time zone 'Europe/Rome')::date - 30 then raise exception 'passati 30 giorni dalla gara'; end if;
  return s;
end $$;

-- ------------------------------------------------------------------ distanza ufficiale (direttivo)
create or replace function public.correggi_distanza(p_token text, p_id uuid, p jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); s public.gare_societa; v_km numeric := public._km_json(replace(p->>'km', ',', '.'));
  ora numeric; fonte text := trim(coalesce(p->>'fonte', '')); pr jsonb; n int;
begin
  s := public._gara_direttivo(m, p_id);
  if v_km is null or v_km not between 5 and 50 or public._base_km(v_km) <> s.distanza then raise exception 'km non validi per questa gara'; end if;
  if fonte !~ '^https?://' or char_length(fonte) > 300 then raise exception 'serve il link alla fonte'; end if;
  ora := coalesce(s.km_uff, s.km, public._km_classica(s.distanza));
  if s.km_uff is not null and abs(s.km_uff - v_km) < 0.0005 then raise exception 'è già questa la distanza'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'km', r.km_reali)), '[]') into pr
  from public.risultati_gruppo r join public.membri x on x.id = r.membro_id
  where x.gruppo_id = s.gruppo_id and r.data = s.data and r.distanza = s.distanza and r.esito = 'arrivato' and r.secondi is not null;
  insert into public.distanze_gare (gara_id, km_prima, km, km_uff_prima, prima, fonte, nota, da)
  values (s.id, ora, v_km, s.km_uff, pr, fonte, nullif(left(trim(coalesce(p->>'nota', '')), 200), ''), m.id);
  update public.gare_societa set km_uff = v_km where id = s.id;
  -- il trigger mette i km ufficiali su ogni risultato arrivato della gara
  update public.risultati_gruppo r set km_reali = public._km_ris(v_km, s.distanza)
  from public.membri x where x.id = r.membro_id and x.gruppo_id = s.gruppo_id and r.data = s.data and r.distanza = s.distanza
    and r.esito = 'arrivato' and r.secondi is not null;
  get diagnostics n = row_count;
  return json_build_object('km', v_km, 'esatta', public._km_ris(v_km, s.distanza) is null, 'risultati', n);
end $$;

-- Annulla l'ultima correzione: torna la distanza di prima e, sui risultati che c'erano già, i km di prima.
create or replace function public.annulla_distanza(p_token text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); s public.gare_societa; c public.distanze_gare; x jsonb;
begin
  s := public._gara_direttivo(m, p_id);
  select * into c from public.distanze_gare where gara_id = s.id and annullata is null order by creato desc limit 1;
  if c.id is null then raise exception 'nessuna correzione da annullare'; end if;
  update public.distanze_gare set annullata = now() where id = c.id;
  update public.gare_societa set km_uff = c.km_uff_prima where id = s.id;
  for x in select * from jsonb_array_elements(c.prima) loop
    update public.risultati_gruppo set km_reali = (x->>'km')::numeric where id = (x->>'id')::uuid;
  end loop;
  -- quelli arrivati dopo la correzione: se torna una distanza ufficiale vale quella (trigger), altrimenti restano
  update public.risultati_gruppo r set km_reali = r.km_reali from public.membri y
  where y.id = r.membro_id and y.gruppo_id = s.gruppo_id and r.data = s.data and r.distanza = s.distanza and c.km_uff_prima is not null;
end $$;

-- ------------------------------------------------------------------ obiettivo: anche i km su cui è fissato
create or replace function public.fissa_obiettivo(p_token text, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io_classifiche(p_token); d date; dist text := p->>'distanza'; sec int; kmr numeric := public._km_json(p->>'km_reali');
begin
  begin d := (p->>'data')::date; exception when others then raise exception 'data non valida'; end;
  if d is null or dist is null or dist not in ('10', '21', '42') then raise exception 'gara non valida'; end if;
  if not public._aperta(d) then raise exception 'obiettivo bloccato: la gara è già iniziata'; end if;
  if nullif(trim(coalesce(p->>'tempo', '')), '') is null then
    delete from public.obiettivi_gara where membro_id = m.id and data = d and distanza = dist; return;
  end if;
  sec := public._secondi(p->>'tempo');
  -- altra distanza (km_reali, es. 9,9 km): passo sui km veri; altrimenti sulla classica
  if p->>'km_reali' is not null then
    if not public._km_ok(dist, kmr, sec) then raise exception 'tempo o km non validi'; end if;
  elsif not public._passo_ok(dist, sec) then raise exception 'tempo non valido'; end if;
  insert into public.obiettivi_gara (membro_id, data, distanza, secondi, km) values (m.id, d, dist, sec, kmr)
  on conflict (membro_id, data, distanza) do update set secondi = excluded.secondi, km = excluded.km, aggiornato = now();
end $$;

-- ------------------------------------------------------------------ lettura (come prima, più distanza ufficiale e km degli obiettivi)
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
        'gara_id', s.gara_id, 'km', s.km, 'km_uff', s.km_uff,
        'correzioni', (select coalesce(json_agg(json_build_object('km_prima', c.km_prima, 'km', c.km, 'fonte', c.fonte, 'nota', c.nota,
            'da', y.nome, 'creato', c.creato, 'annullata', c.annullata) order by c.creato), '[]')
          from public.distanze_gare c left join public.membri y on y.id = c.da where c.gara_id = s.id)) order by s.data), '[]')
      from public.gare_societa s where s.gruppo_id = m.gruppo_id),
    'obiettivi', case when vede then (select coalesce(json_agg(json_build_object('membro_id', o.membro_id, 'data', o.data, 'distanza', o.distanza,
        'secondi', o.secondi, 'km', o.km)), '[]') from public.obiettivi_gara o join public.membri x on x.id = o.membro_id
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
      where x.gruppo_id = m.gruppo_id and x.partecipa and r.stato = 'certificato' and r.esito = 'arrivato' and r.km_reali is null and a.ag is not null) else '[]'::json end
  );
end $$;

-- ------------------------------------------------------------------ tempi dal direttivo (solo funzione "tempi", chiave segreta)
-- La gara e i soci che partecipano, con quello che hanno già su quella gara; società = le più usate nei tempi che
-- i soci si sono certificati da soli (per riconoscere gli omonimi di altre società), più il nome del gruppo.
create or replace function public._soci_gara(p_hash text, p_gara uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri; s public.gare_societa;
begin
  select * into m from public.membri where token_hash = p_hash order by creato limit 1;
  if m.id is null then raise exception 'non sei in un gruppo'; end if;
  s := public._gara_direttivo(m, p_gara);
  return json_build_object(
    'gara', json_build_object('id', s.id, 'data', s.data, 'distanza', s.distanza, 'nome', s.nome, 'km', coalesce(s.km_uff, s.km)),
    'gruppo', (select g.nome from public.gruppi g where g.id = m.gruppo_id),
    'societa', (select coalesce(json_agg(t.societa), '[]') from (select r.societa from public.risultati_gruppo r join public.membri x on x.id = r.membro_id
        where x.gruppo_id = m.gruppo_id and r.stato = 'certificato' and r.deciso_da is null and r.fonte <> 'manuale' and nullif(trim(r.societa), '') is not null
        group by r.societa order by count(*) desc limit 5) t),
    'soci', (select coalesce(json_agg(json_build_object('id', x.id, 'nome', x.nome, 'stato', r.stato, 'esito', r.esito, 'secondi', r.secondi,
        'da_solo', r.id is not null and r.deciso_da is null and r.fonte <> 'manuale') order by x.nome), '[]')
      from public.membri x left join public.risultati_gruppo r on r.membro_id = x.id and r.data = s.data and r.distanza = s.distanza
      where x.gruppo_id = m.gruppo_id and x.partecipa));
end $$;

-- Scrive i tempi scelti dal direttivo (già verificati dalla funzione nelle classifiche ufficiali): certificati, con chi li
-- ha caricati. Saltati: chi ha già un tempo certificato (vince quello dell'atleta), chi ha segnato un esito senza tempo,
-- chi non è del gruppo o non partecipa, tempi o km non plausibili.
create or replace function public._registra_dal_direttivo(p_hash text, p_gara uuid, p_righe jsonb) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri; s public.gare_societa; x jsonb; mid uuid; sec int; kmr numeric; ok int := 0; saltati int := 0;
begin
  select * into m from public.membri where token_hash = p_hash order by creato limit 1;
  if m.id is null then raise exception 'non sei in un gruppo'; end if;
  s := public._gara_direttivo(m, p_gara);
  if jsonb_typeof(coalesce(p_righe, '[]')) <> 'array' or jsonb_array_length(coalesce(p_righe, '[]')) > 200 then raise exception 'troppi risultati'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_righe, '[]')) loop
    begin mid := (x->>'membro_id')::uuid; exception when others then mid := null; end;
    sec := case when x->>'secondi' ~ '^\d{1,6}$' then (x->>'secondi')::int end;
    kmr := public._km_json(x->>'km_reali');
    if mid is null or sec is null or not public._fonte_ok(x->>'fonte')
       or not exists (select 1 from public.membri y where y.id = mid and y.gruppo_id = m.gruppo_id and y.partecipa)
       or (x->>'km_reali' is not null and not public._km_ok(s.distanza, kmr, sec)) or (kmr is null and not public._passo_ok(s.distanza, sec))
       or exists (select 1 from public.risultati_gruppo r where r.membro_id = mid and r.data = s.data and r.distanza = s.distanza
                  and (r.stato = 'certificato' or r.esito <> 'arrivato')) then
      saltati := saltati + 1; continue;
    end if;
    insert into public.risultati_gruppo (membro_id, data, distanza, gara_nome, esito, secondi, fonte, categoria, societa, stato, nota, deciso_da, km_reali)
    values (mid, s.data, s.distanza, coalesce(nullif(left(trim(x->>'gara_nome'), 120), ''), s.nome), 'arrivato', sec, x->>'fonte',
            nullif(left(trim(x->>'categoria'), 12), ''), nullif(left(trim(x->>'societa'), 120), ''), 'certificato', 'Caricato dal direttivo', m.id, kmr)
    on conflict (membro_id, data, distanza) do update set gara_nome = excluded.gara_nome, esito = 'arrivato', secondi = excluded.secondi,
      fonte = excluded.fonte, categoria = excluded.categoria, societa = excluded.societa, stato = 'certificato', nota = excluded.nota,
      link = null, deciso_da = m.id, creato = now(), km_reali = excluded.km_reali;
    ok := ok + 1;
  end loop;
  return json_build_object('caricati', ok, 'saltati', saltati);
end $$;

-- ------------------------------------------------------------------ esiti per le notifiche (job, chiave segreta)
-- Per ogni impronta: i risultati degli ultimi 7 giorni. "da_altri" = deciso da un altro (direttivo o referente).
create or replace function public._esiti_push(p_hash text[]) returns json
language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('membro', x.token_hash, 'id', r.id, 'data', r.data, 'distanza', r.distanza, 'secondi', r.secondi,
      'stato', r.stato, 'esito', r.esito, 'da_altri', r.deciso_da is not null and r.deciso_da <> r.membro_id)), '[]')
  from public.risultati_gruppo r join public.membri x on x.id = r.membro_id
  where x.token_hash = any(p_hash) and x.partecipa and r.data >= current_date - 7;
$$;

-- ------------------------------------------------------------------ permessi
revoke all on function public._km_classica(text), public._km_ris(numeric, text), public._km_ufficiali(),
  public._gara_direttivo(public.membri, uuid), public._soci_gara(text, uuid), public._registra_dal_direttivo(text, uuid, jsonb),
  public._esiti_push(text[]) from public, anon, authenticated;
grant execute on function public._soci_gara(text, uuid), public._registra_dal_direttivo(text, uuid, jsonb), public._esiti_push(text[]) to service_role;
do $$
declare f text;
begin
  foreach f in array array['correggi_distanza(text,uuid,jsonb)', 'annulla_distanza(text,uuid)', 'fissa_obiettivo(text,jsonb)', 'stato_stagione(text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;

commit;
