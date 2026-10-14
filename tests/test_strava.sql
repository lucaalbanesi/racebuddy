-- Prova delle tabelle di Strava su un Postgres vuoto (GitHub Actions), dopo supabase_gruppo.sql e supabase_strava.sql.
\set ON_ERROR_STOP on
do $$
declare a text := repeat('a', 40); j json;
begin
  begin perform public.strava_stato('corto'); assert false, 'token corto';
  exception when others then if sqlerrm not like '%token non valido%' then raise; end if; end;
  j := public.strava_stato(a);
  assert not (j->>'collegato')::boolean and (j->>'posti')::int = 0 and (j->>'massimo')::int = 10, 'stato iniziale';
  insert into public.strava_atleti (proprietario, athlete_id, access_token, refresh_token, scade) values (public._hash(a), 42, 't', 'r', now());
  j := public.strava_stato(a);
  assert (j->>'collegato')::boolean and (j->>'posti')::int = 1, 'collegato';
  assert not (public.strava_stato(repeat('b', 40))->>'collegato')::boolean, 'un altro telefono non è collegato';
  assert not exists (select 1 from public.strava_atleti where proprietario = a), 'il codice segreto non è mai salvato in chiaro';
  raise notice 'strava ok';
end $$;

set role anon;
do $$ begin
  perform public.strava_stato(repeat('c', 40));
  begin perform 1 from public.strava_atleti; assert false, 'anon legge i token'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.strava_stati; assert false, 'anon legge gli stati'; exception when insufficient_privilege then null; end;
  raise notice 'permessi strava ok';
end $$;
