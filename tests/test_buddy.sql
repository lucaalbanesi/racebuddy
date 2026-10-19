-- Prove dei contatori del Buddy (docs/supabase_buddy.sql + docs/supabase_statistiche.sql): psql -f tests/test_buddy.sql
do $$
declare j json; a text := repeat('a', 64); b text := repeat('b', 64);
begin
  insert into public.aperture (giorno, tipo, n) values (date_trunc('week', (now() at time zone 'Europe/Rome')::date)::date, 'settimana', 12)
  on conflict (giorno, tipo) do update set n = 12;
  perform public.buddy_conta(a, 'scarpe', 1200);
  perform public.buddy_conta(a, 'allenamento', 800);
  perform public.buddy_conta(b, 'politica', 300);         -- tema non previsto → altro
  j := public.buddy_stato(a);
  assert (j->>'mie')::int = 2, 'mie: ' || j::text;
  assert (j->>'tutte')::int = 3, 'tutte: ' || j::text;
  assert (j->>'token')::int = 2300, 'token: ' || j::text;
  assert (j->>'attivi')::int = 12, 'attivi: ' || j::text;
  assert (select n from public.buddy_temi where tema = 'altro') = 1, 'tema altro';
  -- niente accesso dall'app
  assert not has_function_privilege('anon', 'public.buddy_conta(text, text, integer)', 'execute'), 'anon non deve contare';
  assert not has_function_privilege('anon', 'public.buddy_stato(text)', 'execute'), 'anon non deve leggere lo stato';
  assert not has_table_privilege('anon', 'public.buddy_uso', 'select'), 'anon non deve leggere buddy_uso';
  raise notice 'permessi buddy ok';
end $$;
