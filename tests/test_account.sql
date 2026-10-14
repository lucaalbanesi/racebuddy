-- Prova di account e Strava su un Postgres vuoto (GitHub Actions), dopo gli altri schemi e supabase_account.sql.
-- auth.uid() è simulato leggendo request.jwt.claim.sub, come fa Supabase.
\set ON_ERROR_STOP on
do $$
declare
  a text := repeat('a', 40); a2 text := repeat('d', 40); b text := repeat('b', 40);
  u1 uuid := '11111111-1111-1111-1111-111111111111'; u2 uuid := '22222222-2222-2222-2222-222222222222'; j json;
begin
  insert into auth.users (id, email) values (u1, 'marco@esempio.it'), (u2, 'giulia@esempio.it');
  perform public.crea_gruppo(a, 'Corriamo Roma', 'Marco');
  perform public.entra_gruppo(b, (select codice from public.gruppi limit 1), 'Giulia', true);
  insert into public.push_iscrizioni (endpoint, p256dh, auth, dati) values ('https://p/e1', 'k', 'x', '{}');

  -- senza login: niente
  begin perform public.collega_account(a, null); assert false, 'senza login';
  exception when others then if sqlerrm not like '%serve il login%' then raise; end if; end;

  -- primo login dal telefono di Marco: profilo e notifiche legati all'account
  perform set_config('request.jwt.claim.sub', u1::text, true);
  j := public.collega_account(a, 'https://p/e1');
  assert j->>'stato' = 'legato' and j->>'gruppo' = 'Corriamo Roma', 'primo login: legato';
  assert (select user_id from public.push_iscrizioni where endpoint = 'https://p/e1') = u1, 'notifiche legate';
  assert (public.collega_account(a, null))->>'stato' = 'legato', 'di nuovo dallo stesso telefono: niente di nuovo';

  -- telefono nuovo (token nuovo), stesso account: ritrova lo stesso profilo, senza doppioni
  j := public.collega_account(a2, null);
  assert j->>'stato' = 'ritrovato', 'telefono nuovo: ritrovato';
  assert (public.stato_gruppo(a2))->'io'->>'nome' = 'Marco', 'il telefono nuovo è Marco';
  assert (select count(*) from public.membri) = 2, 'nessun membro in più';
  perform public.sincronizza_pb(a2, '[{"distanza":"21","tempo":"1:40:00"}]');
  assert json_array_length((public.stato_gruppo(b))->'classifica') = 1, 'personale dal telefono nuovo, una riga sola';

  -- un telefono che è già un altro membro: conflitto, nessuna modifica
  assert (public.collega_account(b, null))->>'stato' = 'conflitto', 'conflitto';
  assert (select user_id from public.membri where nome = 'Giulia') is null, 'Giulia non toccata';

  -- Strava: stato iniziale
  j := public.strava_stato();
  assert not (j->>'collegato')::boolean and (j->>'posti')::int = 0 and (j->>'massimo')::int = 10, 'strava stato';
  insert into public.strava_atleti (user_id, athlete_id, access_token, refresh_token, scade) values (u1, 42, 't', 'r', now());
  assert (public.strava_stato()->>'collegato')::boolean, 'strava collegato';

  -- cancella account: via profilo, telefoni, notifiche, Strava, account; Giulia diventa amministratrice
  perform public.cancella_account();
  assert not exists (select 1 from auth.users where id = u1), 'account cancellato';
  assert not exists (select 1 from public.push_iscrizioni where endpoint = 'https://p/e1'), 'notifiche cancellate';
  assert not exists (select 1 from public.strava_atleti), 'strava cancellato';
  assert not exists (select 1 from public.dispositivi), 'telefoni cancellati';
  assert (select ruolo from public.membri where nome = 'Giulia') = 'admin', 'nuova amministratrice';
  begin perform public.stato_gruppo(a2); assert false, 'telefono nuovo ancora dentro';
  exception when others then if sqlerrm not like '%non sei in un gruppo%' then raise; end if; end;

  -- l'ultimo membro che cancella l'account: sparisce anche il gruppo
  perform set_config('request.jwt.claim.sub', u2::text, true);
  perform public.collega_account(b, null);
  perform public.cancella_account();
  assert (select count(*) from public.gruppi) = 0, 'gruppo vuoto cancellato';
  raise notice 'account ok';
end $$;

-- permessi: senza login le funzioni dell'account non si chiamano, le tabelle non si leggono
set role anon;
do $$ begin
  begin perform public.collega_account(repeat('a', 40), null); assert false, 'anon collega'; exception when insufficient_privilege then null; end;
  begin perform public.cancella_account(); assert false, 'anon cancella'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.strava_atleti; assert false, 'anon legge i token'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.dispositivi; assert false, 'anon legge i telefoni'; exception when insufficient_privilege then null; end;
  raise notice 'permessi account ok';
end $$;
