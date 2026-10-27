-- RaceBuddy – profili doppi nel gruppo: avviso sull'omonimo all'ingresso e unione approvata dal referente.
-- Ripetibile. Va dopo docs/supabase_gruppo.sql, docs/supabase_classifiche.sql e docs/supabase_stagione.sql (usa _norm_nome).
--
-- Il caso: su iPhone chi entra dal link in Safari e poi apre l'app nella Home riparte da zero e crea un secondo profilo
-- (il telefono ha un altro codice segreto, quindi per il database è un altro membro). Qui:
--  1. all'ingresso l'app chiede se nel gruppo c'è già un membro con lo stesso nome (omonimo_invito);
--  2. chi non ha più il vecchio profilo manda una richiesta al referente (chiedi_unione);
--  3. l'amministratore vede i profili doppi (admin_omonimi) e li unisce (admin_unisci): il vecchio membro, con tutti i
--     suoi dati (tempi certificati, punti, ruolo, obiettivi), prende il codice del telefono nuovo e il doppione sparisce.
-- Il nome da solo non dimostra niente: per questo l'unione non è automatica ma la decide un amministratore.

create table if not exists public.richieste_unione (
  nuovo_id uuid primary key references public.membri(id) on delete cascade,
  gruppo_id uuid not null references public.gruppi(id) on delete cascade,
  creato timestamptz not null default now()
);
alter table public.richieste_unione enable row level security;

-- C'è già un membro con questo nome (a meno di maiuscole, accenti, ordine di nome e cognome)? Per chi sta per entrare.
create or replace function public.omonimo_invito(p_token text, p_codice text, p_nome text) returns json
language plpgsql security definer set search_path = '' as $$
declare r record; x public.membri;
begin
  if char_length(coalesce(p_token, '')) < 32 then raise exception 'token non valido'; end if;
  select * into r from public._gruppo_da_codice(p_codice);
  if (r.g).id is null then raise exception 'invito non valido'; end if;
  if public._norm_nome(p_nome) = '' then return json_build_object('omonimi', 0); end if;
  select m.* into x from public.membri m
   where m.gruppo_id = (r.g).id and m.token_hash <> public._hash(p_token) and public._norm_nome(m.nome) = public._norm_nome(p_nome)
   order by m.creato limit 1;
  if x.id is null then return json_build_object('omonimi', 0); end if;
  return json_build_object('omonimi', (select count(*) from public.membri m where m.gruppo_id = (r.g).id
      and m.token_hash <> public._hash(p_token) and public._norm_nome(m.nome) = public._norm_nome(p_nome)), 'nome', x.nome);
end $$;

-- "Sono già nel gruppo, ma non ho più il vecchio profilo": il membro appena entrato chiede l'unione al referente.
create or replace function public.chiedi_unione(p_token text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if not exists (select 1 from public.membri x where x.gruppo_id = m.gruppo_id and x.id <> m.id and public._norm_nome(x.nome) = public._norm_nome(m.nome)) then
    raise exception 'nessun omonimo nel gruppo';
  end if;
  insert into public.richieste_unione (nuovo_id, gruppo_id) values (m.id, m.gruppo_id) on conflict (nuovo_id) do nothing;
end $$;

create or replace function public.mia_unione(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  return json_build_object('richiesta', exists (select 1 from public.richieste_unione where nuovo_id = m.id));
end $$;

-- Per gli amministratori: i gruppi di membri con lo stesso nome, con chi ha chiesto l'unione.
create or replace function public.admin_omonimi(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token);
begin
  if m.ruolo <> 'admin' then raise exception 'solo per gli amministratori'; end if;
  return coalesce((
    select json_agg(json_build_object('nome', c.nome, 'richieste', c.richieste, 'membri', c.gruppo) order by c.richieste desc, c.nome)
    from (
      select min(x.nome) as nome, count(*) filter (where r.nuovo_id is not null) as richieste,
        (select json_agg(json_build_object('id', y.id, 'nome', y.nome, 'ruolo', y.ruolo, 'creato', y.creato, 'visto', y.visto,
            'richiesta', exists (select 1 from public.richieste_unione q where q.nuovo_id = y.id),
            'tuo', y.id = m.id,
            'risultati', (select count(*) from public.risultati_gruppo z where z.membro_id = y.id)) order by y.creato)
         from public.membri y where y.gruppo_id = m.gruppo_id and public._norm_nome(y.nome) = public._norm_nome(min(x.nome))) as gruppo
      from public.membri x left join public.richieste_unione r on r.nuovo_id = x.id
      where x.gruppo_id = m.gruppo_id and public._norm_nome(x.nome) <> ''
      group by public._norm_nome(x.nome)
      having count(*) > 1
    ) c
  ), '[]'::json);
end $$;

-- Unisce due profili dello stesso gruppo: il membro p_vecchio (con i suoi dati e il suo ruolo) prende il codice del telefono
-- di p_nuovo, che sparisce con quello che aveva online (le gare e i personali tornano al prossimo salvataggio del telefono).
create or replace function public.admin_unisci(p_token text, p_nuovo uuid, p_vecchio uuid) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); n public.membri; v public.membri;
begin
  if m.ruolo <> 'admin' then raise exception 'solo per gli amministratori'; end if;
  if p_nuovo = p_vecchio then raise exception 'scegli due profili diversi'; end if;
  if p_vecchio = m.id then raise exception 'il tuo profilo è quello da tenere: chiedi a un altro amministratore'; end if;
  select * into n from public.membri where id = p_nuovo and gruppo_id = m.gruppo_id;
  select * into v from public.membri where id = p_vecchio and gruppo_id = m.gruppo_id;
  if n.id is null or v.id is null then raise exception 'profilo non trovato'; end if;
  -- Strava: il collegamento passa al telefono nuovo (se anche il nuovo ne ha uno, vale quello)
  if to_regclass('public.strava_atleti') is not null then
    if exists (select 1 from public.strava_atleti where proprietario = n.token_hash) then
      delete from public.strava_atleti where proprietario = v.token_hash;
    else
      update public.strava_atleti set proprietario = n.token_hash where proprietario = v.token_hash;
    end if;
    delete from public.strava_stati where proprietario = v.token_hash;
  end if;
  delete from public.membri where id = n.id;   -- porta via le sue gare, i personali, le richieste
  update public.membri set token_hash = n.token_hash, visto = now() where id = v.id;
  return json_build_object('membro', v.id, 'nome', v.nome);
end $$;

-- ------------------------------------------------------------------ permessi
do $$
declare f text;
begin
  foreach f in array array['omonimo_invito(text,text,text)', 'chiedi_unione(text)', 'mia_unione(text)', 'admin_omonimi(text)', 'admin_unisci(text,uuid,uuid)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;
