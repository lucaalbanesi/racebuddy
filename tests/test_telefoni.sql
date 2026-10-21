-- Prova dei telefoni del membro (docs/supabase_telefoni.sql): cambio di telefono e doppioni. In fondo "permessi telefoni ok".
\set ON_ERROR_STOP on
do $$
declare adm text := repeat('a', 40); dan text := repeat('d', 40); nuovo text := repeat('n', 40); saf text := repeat('s', 40);
  app text := repeat('p', 40); estraneo text := repeat('e', 40); j json; g uuid; cod text; c text; id_dan uuid; id_saf uuid; id_app uuid;
begin
  j := public.crea_gruppo(adm, 'Podistica Prova', 'Anna'); g := (j->>'gruppo')::uuid;
  cod := (select codice from public.gruppi where id = g);
  perform public.admin_classifiche(adm, true);

  -- ---------------------------------------------------------------- cambio di telefono
  j := public.entra_gruppo(dan, cod, 'Daniele Rossi', true); id_dan := (j->>'membro')::uuid;
  perform public.partecipa_classifiche(dan, true);
  perform public.sincronizza_gare(dan, '[{"id":"FI-42","nome":"Firenze Marathon","data":"2099-11-29","luogo":"Firenze","distanza":"42","ruolo":"obiettivo","tempo":"3:30:00"}]');
  insert into public.risultati_gruppo (membro_id, data, distanza, gara_nome, secondi, fonte, stato) values (id_dan, current_date - 3, '21', 'Mezza di Roma', 6000, 'gpl', 'certificato');

  -- il telefono nuovo chiede il codice; sempre lo stesso finché vale
  c := public.chiedi_ritorno(nuovo);
  assert char_length(c) = 8, 'codice di 8 caratteri';
  assert public.chiedi_ritorno(nuovo) = c, 'stesso codice alla seconda richiesta';
  begin perform public.stato_gruppo(nuovo); assert false, 'ancora fuori';
  exception when others then if sqlerrm not like '%non sei in un gruppo%' then raise; end if; end;
  -- chi è già in un gruppo non chiede codici
  begin perform public.chiedi_ritorno(dan); assert false, 'membro chiede ritorno';
  exception when others then if sqlerrm not like '%già in un gruppo%' then raise; end if; end;
  -- solo l'amministratore assegna
  begin perform public.admin_ritorno(dan, id_dan, c); assert false, 'membro assegna';
  exception when others then if sqlerrm not like '%amministratori%' then raise; end if; end;
  begin perform public.admin_ritorno(adm, id_dan, 'ZZZZZZZZ'); assert false, 'codice inventato';
  exception when others then if sqlerrm not like '%codice non valido%' then raise; end if; end;
  -- assegnato (anche scritto in minuscolo e con spazi): il telefono nuovo è Daniele
  assert public.admin_ritorno(adm, id_dan, lower(substr(c, 1, 4)) || ' ' || substr(c, 5)) = 'Daniele Rossi', 'nome restituito';
  assert (public.stato_gruppo(nuovo)->'io'->>'id')::uuid = id_dan, 'telefono nuovo = stesso membro';
  assert (select count(*) from public.membri where gruppo_id = g) = 2, 'nessun doppione';
  assert json_array_length(public.stato_classifiche(nuovo)->'miei') = 1, 'ritrova i risultati';
  assert (select count(*) from json_array_elements(public.stato_gruppo(nuovo)->'gare') e where (e->>'membro_id')::uuid = id_dan) = 1, 'ritrova le gare';
  assert not exists (select 1 from public.ritorni where codice = c), 'codice usato e cancellato';
  -- il codice usato non vale più; il telefono nuovo non può entrare in un altro gruppo né crearne uno
  begin perform public.admin_ritorno(adm, id_dan, c); assert false, 'codice riusato';
  exception when others then if sqlerrm not like '%codice non valido%' then raise; end if; end;
  begin perform public.crea_gruppo(nuovo, 'Altro', 'Daniele'); assert false, 'telefono aggiunto crea un gruppo';
  exception when others then if sqlerrm not like '%già in un gruppo%' then raise; end if; end;
  -- anche il vecchio telefono continua a valere
  assert (public.stato_gruppo(dan)->'io'->>'id')::uuid = id_dan, 'vecchio telefono valido';
  -- codici scaduti non valgono
  c := public.chiedi_ritorno(estraneo);
  update public.ritorni set creato = now() - interval '8 days' where codice = c;
  begin perform public.admin_ritorno(adm, id_dan, c); assert false, 'codice scaduto';
  exception when others then if sqlerrm not like '%scaduto%' then raise; end if; end;
  -- l'amministratore di un altro gruppo non assegna i membri di questo
  perform public.crea_gruppo(repeat('z', 40), 'Altro gruppo', 'Zeno');
  c := public.chiedi_ritorno(estraneo);
  begin perform public.admin_ritorno(repeat('z', 40), id_dan, c); assert false, 'altro gruppo';
  exception when others then if sqlerrm not like '%membro non trovato%' then raise; end if; end;

  -- ---------------------------------------------------------------- doppione dello stesso runner (Safari + app)
  j := public.entra_gruppo(saf, cod, 'Sara Bianchi', true); id_saf := (j->>'membro')::uuid;
  j := public.entra_gruppo(app, cod, 'Sara Bianchi', true); id_app := (j->>'membro')::uuid;
  update public.membri set ruolo = 'organizzatore', anno_nascita = 1985 where id = id_saf;
  perform public.partecipa_classifiche(saf, true);
  perform public.sincronizza_pb(saf, '[{"distanza":"10","tempo":"0:45:00","gara":"Corri Roma","data":"2026-05-01"},{"distanza":"21","tempo":"1:50:00"}]');
  perform public.sincronizza_pb(app, '[{"distanza":"10","tempo":"0:47:00"}]');
  insert into public.risultati_gruppo (membro_id, data, distanza, gara_nome, secondi, fonte, stato) values
    (id_saf, current_date - 5, '10', 'Corri Roma', 2700, 'gpl', 'certificato'),
    (id_saf, current_date - 9, '21', 'Mezza', 6600, 'gpl', 'certificato'),
    (id_app, current_date - 5, '10', 'Corri Roma', 2700, 'gpl', 'certificato');
  perform public.mio_invito(saf);
  -- in gruppi diversi non si fondono
  begin perform public.unisci_membri(app, repeat('z', 40)); assert false, 'gruppi diversi';
  exception when others then if sqlerrm not like '%gruppi diversi%' then raise; end if; end;
  j := public.unisci_membri(app, saf);
  assert (j->>'unito')::boolean and (j->>'membro')::uuid = id_app, 'unito in app';
  assert not exists (select 1 from public.membri where id = id_saf), 'doppione sparito';
  assert (select count(*) from public.membri where gruppo_id = g and nome = 'Sara Bianchi') = 1, 'un solo nome';
  assert (public.stato_gruppo(saf)->'io'->>'id')::uuid = id_app, 'il codice di Safari vale ancora';
  assert (select ruolo from public.membri where id = id_app) = 'organizzatore', 'ruolo più alto';
  assert (select partecipa and anno_nascita = 1985 from public.membri where id = id_app), 'partecipazione e dati';
  assert (select secondi from public.pb_membri where membro_id = id_app and distanza = '10') = 2700, 'personale migliore';
  assert exists (select 1 from public.pb_membri where membro_id = id_app and distanza = '21'), 'personale mancante preso';
  assert (select count(*) from public.risultati_gruppo where membro_id = id_app) = 2, 'risultati senza doppioni';
  assert exists (select 1 from public.inviti_personali where membro_id = id_app), 'link personale';
  -- unire un membro con sé stesso non fa niente
  assert not (public.unisci_membri(app, saf)->>'unito')::boolean, 'già unito';

  -- uscendo, se ne vanno anche i telefoni aggiunti
  perform public.esci_gruppo(nuovo);
  assert not exists (select 1 from public.dispositivi where membro_id = id_dan), 'telefoni del membro cancellati';
  perform public.esci_gruppo(app);
  perform public.esci_gruppo(repeat('z', 40));
  perform public.esci_gruppo(adm);
  delete from public.ritorni;
  raise notice 'ok';
end $$;

set role anon;
do $$ begin
  begin perform 1 from public.dispositivi; assert false, 'anon legge dispositivi'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.ritorni; assert false, 'anon legge ritorni'; exception when insufficient_privilege then null; end;
  begin perform public._membro_di('x'); assert false, 'anon chiama _membro_di'; exception when insufficient_privilege then null; end;
  perform public.chiedi_ritorno(repeat('q', 40));
  raise notice 'permessi telefoni ok';
end $$;
reset role;
delete from public.ritorni;
