-- Prova di docs/supabase_nomi.sql: psql -f tests/test_nomi.sql (dopo gruppo e nomi)
do $$
declare a text := repeat('n', 40); b text := repeat('m', 40); cod text;
begin
  perform public.crea_gruppo(a, 'Nomi Prova', '  mario   rossi ');
  assert (select nome from public.membri where token_hash = public._hash(a)) = 'MARIO ROSSI', 'maiuscolo alla creazione';
  select codice into cod from public.gruppi where nome = 'Nomi Prova';
  perform public.entra_gruppo(b, cod, 'Niccolò Bianchi', true);
  assert (select nome from public.membri where token_hash = public._hash(b)) = 'NICCOLÒ BIANCHI', 'maiuscolo con accento all''ingresso';
  perform public.aggiorna_profilo(b, 'niccolò bianchi jr', null);
  assert (select nome from public.membri where token_hash = public._hash(b)) = 'NICCOLÒ BIANCHI JR', 'maiuscolo cambiando il nome';
  delete from public.gruppi where nome = 'Nomi Prova';
  raise notice 'permessi nomi ok';
end $$;
