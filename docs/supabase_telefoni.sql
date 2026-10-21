-- RaceBuddy – più telefoni per lo stesso membro, senza account (ottobre 2026).
-- Un membro del gruppo è riconosciuto dall'impronta del codice segreto del telefono (membri.token_hash).
-- Qui si aggiungono gli "altri telefoni" dello stesso membro (tabella dispositivi, la stessa del login in
-- docs/supabase_account.sql, che quando si accenderà la userà così com'è):
--   • cambio di telefono: il telefono nuovo chiede un codice (chiedi_ritorno), l'amministratore lo assegna al
--     vecchio profilo in Gestione (admin_ritorno). Stesso membro: tempi, punti, badge, gare condivise;
--   • doppione dello stesso runner (Safari e app nella Home dello stesso iPhone): il telefono, che ha in mano entrambi
--     i codici, fonde i due membri (unisci_membri).
-- Online in più solo il codice di ritorno (8 caratteri, vale 7 giorni) e l'impronta del telefono che lo ha chiesto.
--
-- Richiede docs/supabase_gruppo.sql, docs/supabase_classifiche.sql e docs/supabase_stagione.sql.
-- Ripetibile: lo applica il workflow "Pubblica funzioni Supabase" dopo la stagione; provato in tests/test_telefoni.sql.
begin;

-- Altri telefoni dello stesso membro: il loro codice vale come quello originale.
create table if not exists public.dispositivi (
  token_hash text primary key,
  membro_id uuid not null references public.membri(id) on delete cascade,
  creato timestamptz not null default now()
);
alter table public.dispositivi enable row level security;
revoke all on public.dispositivi from public, anon, authenticated;

-- Richieste di ritorno dal telefono nuovo: un codice da dare all'amministratore.
create table if not exists public.ritorni (
  codice text primary key,
  token_hash text not null unique,
  creato timestamptz not null default now()
);
alter table public.ritorni enable row level security;
revoke all on public.ritorni from public, anon, authenticated;

-- ------------------------------------------------------------------ supporto (non esposte)
-- Il membro di un'impronta: il telefono originale o uno aggiunto dopo.
create or replace function public._membro_di(h text) returns public.membri
language sql stable security definer set search_path = '' as $$
  select m from (
    select x as m, 0 as o, x.creato from public.membri x where x.token_hash = h
    union all
    select x, 1, x.creato from public.membri x join public.dispositivi d on d.membro_id = x.id where d.token_hash = h
  ) t order by o, creato limit 1;
$$;

-- Il membro di un codice (ridefinita: ora vale anche per i telefoni aggiunti). Uguale a quella di supabase_account.sql.
create or replace function public._io(p_token text) returns public.membri
language plpgsql security definer set search_path = '' as $$
declare m public.membri;
begin
  if p_token is null or char_length(p_token) < 32 then raise exception 'token non valido'; end if;
  m := public._membro_di(public._hash(p_token));
  if m.id is null then raise exception 'non sei in un gruppo'; end if;
  update public.membri set visto = now() where id = m.id;
  return m;
end $$;

-- Un telefono aggiunto a un membro non può diventare anche un altro membro (crea_gruppo, entra_gruppo, super_vai
-- controllano solo i telefoni originali): lo ferma il database, qualunque funzione ci provi.
create or replace function public._telefono_libero() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.dispositivi where token_hash = new.token_hash) then raise exception 'sei già in un gruppo'; end if;
  return new;
end $$;
drop trigger if exists telefono_libero on public.membri;
create trigger telefono_libero before insert on public.membri for each row execute function public._telefono_libero();

-- ------------------------------------------------------------------ cambio di telefono
-- Dal telefono nuovo (non ancora in un gruppo): il codice da dare all'amministratore. Sempre lo stesso finché vale.
create or replace function public.chiedi_ritorno(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare h text; c text;
begin
  if char_length(coalesce(p_token, '')) < 32 then raise exception 'token non valido'; end if;
  h := public._hash(p_token);
  if (public._membro_di(h)).id is not null then raise exception 'questo telefono è già in un gruppo'; end if;
  delete from public.ritorni where creato < now() - interval '7 days';
  select codice into c from public.ritorni where token_hash = h;
  if c is null then
    loop
      c := public._codice();
      exit when not exists (select 1 from public.ritorni where codice = c);
    end loop;
    insert into public.ritorni (codice, token_hash) values (c, h);
  end if;
  return c;
end $$;

-- L'amministratore assegna il telefono nuovo al vecchio profilo di un membro del suo gruppo.
create or replace function public.admin_ritorno(p_token text, p_membro uuid, p_codice text) returns text
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); r public.ritorni; chi public.membri;
begin
  if m.ruolo <> 'admin' then raise exception 'solo per gli amministratori'; end if;
  select * into chi from public.membri where id = p_membro and gruppo_id = m.gruppo_id;
  if chi.id is null then raise exception 'membro non trovato'; end if;
  select * into r from public.ritorni where codice = upper(regexp_replace(coalesce(p_codice, ''), '[^A-Za-z0-9]', '', 'g'))
    and creato >= now() - interval '7 days';
  if r.codice is null then raise exception 'codice non valido o scaduto: fallo rigenerare dal telefono nuovo'; end if;
  if (public._membro_di(r.token_hash)).id is not null then
    delete from public.ritorni where codice = r.codice;
    raise exception 'quel telefono è già in un gruppo';
  end if;
  insert into public.dispositivi (token_hash, membro_id) values (r.token_hash, chi.id);
  delete from public.ritorni where codice = r.codice;
  return chi.nome;
end $$;

-- ------------------------------------------------------------------ doppioni sullo stesso telefono
-- Il telefono ha due codici dello stesso gruppo (per esempio Safari e l'app nella Home dello stesso iPhone):
-- tutto quello che è online di "altro" passa a "tieni", poi il doppione sparisce. Il codice di "altro" resta valido
-- come telefono di "tieni". Dove i due si sovrappongono vince "tieni" (per i personali, il tempo migliore).
create or replace function public.unisci_membri(p_token text, p_altro text) returns json
language plpgsql security definer set search_path = '' as $$
declare m public.membri := public._io(p_token); a public.membri := public._io(p_altro);
  liv constant jsonb := '{"membro": 0, "organizzatore": 1, "admin": 2}';
begin
  if a.id = m.id then return json_build_object('membro', m.id, 'unito', false); end if;
  if a.gruppo_id <> m.gruppo_id then raise exception 'i due profili sono in gruppi diversi'; end if;

  -- gare condivise, personali (il migliore), bacheca e applausi
  insert into public.gare_membri (membro_id, gara_id, nome, data, luogo, distanza, ruolo, tempo)
    select m.id, gara_id, nome, data, luogo, distanza, ruolo, tempo from public.gare_membri where membro_id = a.id
    on conflict (membro_id, gara_id) do nothing;
  insert into public.pb_membri (membro_id, distanza, tempo, secondi, gara_nome, data)
    select m.id, distanza, tempo, secondi, gara_nome, data from public.pb_membri where membro_id = a.id
    on conflict (membro_id, distanza) do update set tempo = excluded.tempo, secondi = excluded.secondi, gara_nome = excluded.gara_nome, data = excluded.data
    where excluded.secondi < public.pb_membri.secondi;
  update public.bacheca set membro_id = m.id where membro_id = a.id;
  insert into public.applausi (post_id, membro_id) select post_id, m.id from public.applausi where membro_id = a.id on conflict do nothing;

  -- classifiche: i risultati che "tieni" non ha già (stessa data e distanza)
  update public.risultati_gruppo r set membro_id = m.id where r.membro_id = a.id
    and not exists (select 1 from public.risultati_gruppo x where x.membro_id = m.id and x.data = r.data and x.distanza = r.distanza);
  update public.risultati_gruppo set deciso_da = m.id where deciso_da = a.id;

  -- stagione: obiettivi, borse pronte, link personale, chi ha invitato chi, gare della società aggiunte
  insert into public.obiettivi_gara (membro_id, data, distanza, secondi, aggiornato)
    select m.id, data, distanza, secondi, aggiornato from public.obiettivi_gara where membro_id = a.id on conflict do nothing;
  insert into public.borse_pronte (membro_id, data, distanza, pronta_il)
    select m.id, data, distanza, pronta_il from public.borse_pronte where membro_id = a.id on conflict do nothing;
  if not exists (select 1 from public.inviti_personali where membro_id = m.id) then
    update public.inviti_personali set membro_id = m.id where membro_id = a.id;
  end if;
  update public.membri set invitato_da = m.id where invitato_da = a.id and id <> m.id;
  update public.gare_societa set aggiunta_da = m.id where aggiunta_da = a.id;

  -- il profilo che resta: il ruolo più alto, la partecipazione più vecchia, i dati facoltativi che mancano
  update public.membri set
    ruolo = case when (liv->>a.ruolo)::int > (liv->>m.ruolo)::int then a.ruolo else m.ruolo end,
    partecipa = m.partecipa or a.partecipa,
    partecipa_dal = case when m.partecipa or a.partecipa then least(m.partecipa_dal, a.partecipa_dal) end,
    anno_nascita = coalesce(m.anno_nascita, a.anno_nascita),
    sesso = coalesce(m.sesso, a.sesso),
    invitato_da = coalesce(m.invitato_da, case when a.invitato_da <> m.id then a.invitato_da end)
  where id = m.id;

  -- i telefoni del doppione diventano telefoni di "tieni", poi il doppione sparisce
  update public.dispositivi set membro_id = m.id where membro_id = a.id;
  insert into public.dispositivi (token_hash, membro_id) values (a.token_hash, m.id)
    on conflict (token_hash) do update set membro_id = excluded.membro_id;
  delete from public.membri where id = a.id;
  return json_build_object('membro', m.id, 'unito', true);
end $$;

-- ------------------------------------------------------------------ permessi
revoke all on function public._membro_di(text), public._io(text), public._telefono_libero() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['chiedi_ritorno(text)', 'admin_ritorno(text,uuid,text)', 'unisci_membri(text,text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;

commit;
