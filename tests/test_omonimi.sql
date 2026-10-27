-- Prova di omonimi e unione dei profili doppi (GitHub Actions, dopo gruppo, classifiche, stagione e Strava). Si ferma al primo errore.
\set ON_ERROR_STOP on
do $$
declare
  a text := repeat('a', 40); b text := repeat('b', 40); d text := repeat('d', 40); e text := repeat('e', 40); z text := repeat('z', 40);
  j json; cod text; mb uuid; mn uuid; ma uuid; me uuid; zid uuid; zcod text;
begin
  j := public.crea_gruppo(a, 'Corriamo Insieme', 'Marco');
  cod := j->>'codice';
  perform public.entra_gruppo(b, cod, 'Luca Albanesi', true);
  select id into mb from public.membri where nome = 'Luca Albanesi';
  select id into ma from public.membri where nome = 'Marco';
  perform public.admin_ruolo(a, mb, 'organizzatore');
  perform public.sincronizza_gare(b, '[{"id":"F-42","nome":"Firenze Marathon","data":"2099-11-29","distanza":"42","ruolo":"obiettivo"}]');
  insert into public.risultati_gruppo (membro_id, data, distanza, gara_nome, esito, secondi, fonte, stato)
    values (mb, '2026-10-18', '21', 'Rome Half', 'arrivato', 6130, 'gpl', 'certificato');
  insert into public.strava_atleti (proprietario, athlete_id, access_token, refresh_token, scade) values (public._hash(b), 111, 'x', 'y', now());

  -- 1. avviso sull'omonimo: maiuscole, ordine e accenti non contano; chi è già dentro non conta
  j := public.omonimo_invito(d, cod, 'albanesi LUCA');
  assert (j->>'omonimi')::int = 1 and j->>'nome' = 'Luca Albanesi', 'omonimo trovato';
  assert (public.omonimo_invito(d, cod, 'Luca Rossi')->>'omonimi')::int = 0, 'nome diverso';
  assert (public.omonimo_invito(d, cod, '   ')->>'omonimi')::int = 0, 'nome vuoto';
  assert (public.omonimo_invito(b, cod, 'Luca Albanesi')->>'omonimi')::int = 0, 'non sono omonimo di me stesso';
  begin perform public.omonimo_invito(d, 'XXXXXXXX', 'Luca'); assert false, 'invito sbagliato'; exception when others then if sqlerrm not like '%invito non valido%' then raise; end if; end;
  begin perform public.omonimo_invito('corto', cod, 'Luca'); assert false, 'token corto'; exception when others then if sqlerrm not like '%token non valido%' then raise; end if; end;

  -- 2. il secondo profilo entra e chiede l'unione
  perform public.entra_gruppo(d, cod, 'Luca Albanesi', true);
  select id into mn from public.membri where token_hash = public._hash(d);
  assert mn <> mb, 'due membri distinti';
  assert (public.mia_unione(d)->>'richiesta')::boolean is false, 'nessuna richiesta ancora';
  perform public.chiedi_unione(d);
  perform public.chiedi_unione(d);   -- ripetibile
  assert (public.mia_unione(d)->>'richiesta')::boolean, 'richiesta fatta';
  perform public.entra_gruppo(e, cod, 'Giulia Verdi', true);
  begin perform public.chiedi_unione(e); assert false, 'senza omonimo'; exception when others then if sqlerrm not like '%nessun omonimo%' then raise; end if; end;

  -- 3. l'amministratore vede i profili doppi (anche senza richiesta), gli altri no
  j := public.admin_omonimi(a);
  assert json_array_length(j) = 1, 'un solo nome doppio';
  assert json_array_length(j->0->'membri') = 2, 'due profili';
  assert (select count(*) from json_array_elements(j->0->'membri') x where (x->>'richiesta')::boolean) = 1, 'una richiesta';
  assert (select (x->>'risultati')::int from json_array_elements(j->0->'membri') x where x->>'id' = mb::text) = 1, 'conta i risultati';
  begin perform public.admin_omonimi(b); assert false, 'non admin'; exception when others then if sqlerrm not like '%solo per gli amministratori%' then raise; end if; end;

  -- 4. unione: solo admin, profili dello stesso gruppo, non il proprio da tenere
  begin perform public.admin_unisci(b, mn, mb); assert false, 'non admin unisce'; exception when others then if sqlerrm not like '%solo per gli amministratori%' then raise; end if; end;
  begin perform public.admin_unisci(a, mn, mn); assert false, 'stesso profilo'; exception when others then if sqlerrm not like '%due profili diversi%' then raise; end if; end;
  begin perform public.admin_unisci(a, mn, ma); assert false, 'il proprio da tenere'; exception when others then if sqlerrm not like '%chiedi a un altro amministratore%' then raise; end if; end;
  j := public.crea_gruppo(z, 'Altro gruppo', 'Zeno');
  select id into zid from public.membri where nome = 'Zeno';
  begin perform public.admin_unisci(a, mn, zid); assert false, 'altro gruppo'; exception when others then if sqlerrm not like '%profilo non trovato%' then raise; end if; end;
  begin perform public.admin_unisci(z, mn, mb); assert false, 'profili di un altro gruppo'; exception when others then if sqlerrm not like '%profilo non trovato%' then raise; end if; end;

  perform public.sincronizza_gare(d, '[{"id":"X-10","nome":"Una gara nuova","data":"2099-12-01","distanza":"10"}]');
  j := public.admin_unisci(a, mn, mb);
  assert (j->>'membro')::uuid = mb, 'resta il vecchio membro';
  assert (select count(*) from public.membri where gruppo_id = (select gruppo_id from public.membri where id = ma)) = 3, 'doppione tolto: Marco, Luca, Giulia';
  assert not exists (select 1 from public.membri where id = mn), 'il nuovo non c''è più';
  assert not exists (select 1 from public.richieste_unione), 'richiesta chiusa';
  -- il telefono nuovo (d) è ora il vecchio membro, con ruolo e dati di prima; il vecchio codice (b) non vale più
  assert (select ruolo from public.membri where id = mb) = 'organizzatore', 'ruolo del vecchio profilo';
  assert (public.stato_gruppo(d))->'gruppo'->>'codice' = cod, 'd è l''organizzatore e vede il codice';
  begin perform public.stato_gruppo(b); assert false, 'vecchio codice'; exception when others then if sqlerrm not like '%non sei in un gruppo%' then raise; end if; end;
  assert (select count(*) from public.risultati_gruppo where membro_id = mb) = 1, 'i tempi certificati restano';
  assert not exists (select 1 from public.gare_membri where gara_id = 'X-10'), 'le gare del doppione sono tolte (tornano al prossimo salvataggio)';
  assert exists (select 1 from public.strava_atleti where proprietario = public._hash(d) and athlete_id = 111), 'Strava passa al telefono nuovo';
  assert not exists (select 1 from public.strava_atleti where proprietario = public._hash(b)), 'Strava vecchio spostato';
  assert json_array_length(public.admin_omonimi(a)) = 0, 'niente più profili doppi';
  perform public.sincronizza_gare(d, '[{"id":"X-10","nome":"Una gara nuova","data":"2099-12-01","distanza":"10"}]');
  assert exists (select 1 from public.gare_membri where gara_id = 'X-10' and membro_id = mb), 'il telefono rimanda le gare e vanno al vecchio membro';

  -- 5. doppione senza richiesta (profili doppi di prima): l'admin li vede e li unisce lo stesso. Con Strava solo sul nuovo.
  perform public.entra_gruppo(repeat('f', 40), cod, 'Giulia Verdi', true);
  insert into public.strava_atleti (proprietario, athlete_id, access_token, refresh_token, scade) values (public._hash(repeat('f', 40)), 222, 'x', 'y', now());
  j := public.admin_omonimi(a);
  assert json_array_length(j) = 1 and (select count(*) from json_array_elements(j->0->'membri') x where (x->>'richiesta')::boolean) = 0, 'doppione di prima, senza richiesta';
  select id into me from public.membri where token_hash = public._hash(e);
  select id into mn from public.membri where token_hash = public._hash(repeat('f', 40));
  perform public.admin_unisci(a, mn, me);
  assert exists (select 1 from public.strava_atleti where proprietario = public._hash(repeat('f', 40)) and athlete_id = 222), 'Strava del nuovo resta';
  assert (select count(*) from public.membri where nome = 'Giulia Verdi') = 1, 'un solo profilo';
  raise notice 'ok';
end $$;

-- permessi: anon chiama le funzioni dell'app, non le tabelle
set role anon;
do $$ begin
  begin perform 1 from public.richieste_unione; assert false, 'anon legge le richieste'; exception when insufficient_privilege then null; end;
  begin perform public.omonimo_invito(repeat('q', 40), 'XXXXXXXX', 'Luca'); exception when others then if sqlerrm not like '%invito non valido%' then raise; end if; end;
  begin perform public.admin_omonimi(repeat('q', 40)); exception when others then if sqlerrm not like '%non sei in un gruppo%' then raise; end if; end;
  raise notice 'permessi omonimi ok';
end $$;
