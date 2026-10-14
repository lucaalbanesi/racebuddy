-- Prova delle funzioni del gruppo su un Postgres vuoto (GitHub Actions). Si ferma al primo errore.
\set ON_ERROR_STOP on
do $$
declare
  a text := repeat('a', 40); b text := repeat('b', 40); c text := repeat('c', 40);
  j json; cod text; rid uuid; pid uuid; mb uuid; n int;
begin
  j := public.crea_gruppo(a, 'Corriamo Insieme', 'Marco');
  cod := j->>'codice';
  assert length(cod) = 8, 'codice invito';
  j := public.info_invito(lower(cod));
  assert j->>'nome' = 'Corriamo Insieme' and (j->>'membri')::int = 1 and j->>'admin' = 'Marco', 'info invito';
  perform public.entra_gruppo(b, cod, 'Giulia', true);
  perform public.entra_gruppo(c, cod, 'Paolo', false);
  begin perform public.crea_gruppo(b, 'Altro', 'Giulia'); assert false, 'doppio gruppo';
  exception when others then if sqlerrm not like '%già in un gruppo%' then raise; end if; end;

  -- gare: Giulia le mostra (e in bacheca compare l'iscrizione), Paolo no
  perform public.sincronizza_gare(b, '[{"id":"F-42","nome":"Firenze Marathon","data":"2099-11-29","distanza":"42","ruolo":"obiettivo","tempo":"3:45:00"}]');
  perform public.sincronizza_gare(b, '[{"id":"F-42","nome":"Firenze Marathon","data":"2099-11-29","distanza":"42","ruolo":"obiettivo","tempo":"3:45:00"}]');
  perform public.sincronizza_gare(c, '[{"id":"F-42","nome":"Firenze Marathon","data":"2099-11-29","distanza":"42"}]');
  j := public.stato_gruppo(a);
  assert json_array_length(j->'membri') = 3, 'membri';
  assert json_array_length(j->'gare') = 1 and j->'gare'->0->>'membro' = 'Giulia', 'gare visibili';
  assert json_array_length(j->'bacheca') = 1 and j->'bacheca'->0->>'tipo' = 'iscrizione', 'iscrizione in bacheca una volta sola';
  assert j->'gruppo'->>'codice' = cod, 'admin vede il codice';
  assert (public.stato_gruppo(b))->'gruppo'->>'codice' is null, 'membro non vede il codice';

  -- ritrovi: solo organizzatori
  begin perform public.crea_ritrovo(b, '{"titolo":"Lungo","quando":"2099-10-25T08:00:00+02"}'); assert false, 'membro crea ritrovo';
  exception when others then if sqlerrm not like '%organizzatori%' then raise; end if; end;
  select id into mb from public.membri where nome = 'Giulia';
  perform public.admin_ruolo(a, mb, 'organizzatore');
  rid := public.crea_ritrovo(b, '{"titolo":"Lungo della domenica","quando":"2099-10-25T08:00:00+02","luogo":"Piazza","tipo":"allenamento"}');
  perform public.rispondi_ritrovo(a, rid, 'si');
  perform public.rispondi_ritrovo(c, rid, 'no');
  j := public.stato_gruppo(c);
  assert json_array_length(j->'ritrovi') = 1, 'ritrovo visibile';
  assert json_array_length(j->'ritrovi'->0->'si') = 2 and (j->'ritrovi'->0->>'no')::int = 1 and j->'ritrovi'->0->>'mia' = 'no', 'risposte';
  -- ritrovo solo per chi corre una gara: Paolo non mostra le gare, quindi non lo vede
  perform public.crea_ritrovo(a, '{"titolo":"Foto prima del via","quando":"2099-11-29T07:30:00+01","gara_id":"F-42"}');
  assert json_array_length((public.stato_gruppo(c))->'ritrovi') = 1, 'ritrovo di gara nascosto a chi non la corre';
  assert json_array_length((public.stato_gruppo(b))->'ritrovi') = 2, 'ritrovo di gara visibile a chi la corre';
  perform public.annulla_ritrovo(b, rid);
  assert ((public.stato_gruppo(a))->'ritrovi'->0->>'annullato')::boolean, 'annullato';

  -- risultati, applausi, classifica
  pid := public.pubblica_risultato(b, '{"gara_id":"R-21","gara_nome":"Rome Half","distanza":"21","data_gara":"2026-10-18","tempo":"1:42:10","pb":true,"testo":"Crisi al 16"}');
  perform public.pubblica_risultato(a, '{"gara_id":"R-21","gara_nome":"Rome Half","distanza":"21","data_gara":"2026-10-18","tempo":"1:35:02"}');
  perform public.pubblica_risultato(a, '{"gara_id":"X-21","gara_nome":"Altra","distanza":"21","data_gara":"2026-09-01","tempo":"1:38:00"}');
  perform public.applaudi(a, pid); perform public.applaudi(c, pid); perform public.applaudi(c, pid);
  j := public.stato_gruppo(b);
  select (x->>'applausi')::int into n from json_array_elements(j->'bacheca') x where x->>'id' = pid::text;
  assert n = 1, 'applausi a interruttore';
  assert json_array_length(j->'classifica') = 2 and j->'classifica'->0->>'membro' = 'Marco' and j->'classifica'->0->>'tempo' = '1:35:02', 'classifica: miglior tempo per membro';
  begin perform public.pubblica_risultato(b, '{"distanza":"21","data_gara":"2026-10-18","tempo":"abc"}'); assert false, 'tempo non valido accettato';
  exception when check_violation then null; end;

  -- amministrazione
  begin perform public.admin_ruolo(b, mb, 'admin'); assert false, 'non admin';
  exception when others then if sqlerrm not like '%amministratori%' then raise; end if; end;
  begin perform public.admin_ruolo(a, (select id from public.membri where nome = 'Marco'), 'membro'); assert false, 'ultimo admin';
  exception when others then if sqlerrm not like '%almeno un amministratore%' then raise; end if; end;
  assert public.admin_gruppo(a, 'Corriamo Roma', true) <> cod, 'nuovo codice';
  assert public.info_invito(cod) is null, 'vecchio codice non vale più';
  perform public.admin_rimuovi(a, (select id from public.membri where nome = 'Paolo'));
  assert json_array_length((public.stato_gruppo(a))->'membri') = 2, 'rimosso';
  begin perform public.stato_gruppo(c); assert false, 'rimosso vede ancora';
  exception when others then if sqlerrm not like '%non sei in un gruppo%' then raise; end if; end;
  begin perform public.esci_gruppo(a); assert false, 'admin unico esce';
  exception when others then if sqlerrm not like '%nomina prima%' then raise; end if; end;
  perform public.esci_gruppo(b);
  perform public.esci_gruppo(a);
  assert (select count(*) from public.gruppi) = 0, 'gruppo vuoto cancellato';
  raise notice 'ok';
end $$;

-- permessi: anon non legge le tabelle e non chiama le funzioni interne
set role anon;
do $$ begin
  begin perform 1 from public.membri; assert false, 'anon legge membri'; exception when insufficient_privilege then null; end;
  begin perform public._io(repeat('a', 40)); assert false, 'anon chiama _io'; exception when insufficient_privilege then null; end;
  perform public.info_invito('XXXXXXXX');
  raise notice 'permessi ok';
end $$;
