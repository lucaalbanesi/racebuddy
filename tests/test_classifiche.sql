-- Prova delle classifiche del gruppo (docs/supabase_classifiche.sql) su un Postgres con lo schema del gruppo.
-- Si ferma al primo errore; in fondo "permessi classifiche ok".
\set ON_ERROR_STOP on
do $$
declare
  a text := repeat('d', 40); b text := repeat('e', 40); c text := repeat('f', 40);
  j json; cod text; n int; rid uuid; hb text := public._hash(repeat('e', 40));
begin
  j := public.crea_gruppo(a, 'Classifiche Roma', 'Luca Albanesi');
  cod := j->>'codice';
  perform public.entra_gruppo(b, cod, 'Giulia Neri', true);
  perform public.entra_gruppo(c, cod, 'Paolo', true);

  -- nomi a confronto
  assert public._norm_nome('D''Angelo  Maria') = public._norm_nome('maria d angelo'), 'apostrofi e ordine';
  assert public._norm_nome('Niccolò Rossi') = 'niccolo rossi', 'accenti';

  -- interruttore del gruppo: solo l'amministratore; prima non si partecipa
  begin perform public.partecipa_classifiche(b, true); assert false, 'partecipa a classifiche spente';
  exception when others then if sqlerrm not like '%spente%' then raise; end if; end;
  begin perform public.admin_classifiche(b, true); assert false, 'membro accende';
  exception when others then if sqlerrm not like '%amministratori%' then raise; end if; end;
  perform public.admin_classifiche(a, true);
  j := public.info_invito(cod);
  assert (j->>'classifiche')::boolean and (j->>'partecipanti')::int = 0 and (j->>'membri')::int = 3, 'invito con classifiche: ' || j::text;
  j := public.stato_classifiche(b);
  assert (j->>'attive')::boolean and not (j->'io'->>'partecipa')::boolean and json_array_length(j->'risultati') = 0, 'acceso, non partecipa';
  perform public.partecipa_classifiche(a, true);
  perform public.partecipa_classifiche(b, true);
  assert (public.stato_classifiche(a)->>'partecipanti')::int = 2, 'due partecipanti';

  -- certificati dalla funzione: nome uguale → certificati; ripetere non duplica
  j := public._registra_certificati(hb, 'Neri Giulia', '[
    {"data":"2026-10-18","distanza":"21","secondi":6350,"gara_nome":"Rome Half","fonte":"gpl","categoria":"SF35","societa":"Podistica"},
    {"data":"2025-03-16","distanza":"42","secondi":14500,"gara_nome":"Maratona di Roma","fonte":"fidal","categoria":"SF35"},
    {"data":"2026-10-18","distanza":"10","secondi":10,"fonte":"gpl"},
    {"data":"2026-10-18","distanza":"5","secondi":1500,"fonte":"gpl"},
    {"data":"2026-10-11","distanza":"10","secondi":2700,"fonte":"strava"}]');
  assert (j->>'certificati')::int = 2 and (j->>'saltati')::int = 3, 'due certificati, tre scartati: ' || j::text;
  j := public._registra_certificati(hb, 'Giulia Neri', '[{"data":"2026-10-18","distanza":"21","secondi":6350,"fonte":"gpl"}]');
  assert (j->>'saltati')::int = 1, 'stesso tempo già certificato';
  -- nome diverso: va al referente, e non tocca un certificato
  j := public._registra_certificati(hb, 'Giulia Bianchi', '[{"data":"2026-09-07","distanza":"10","secondi":2900,"fonte":"gpl"},{"data":"2026-10-18","distanza":"21","secondi":6000,"fonte":"gpl"}]');
  assert (j->>'in_approvazione')::int = 1 and (j->>'saltati')::int = 1, 'nome diverso in coda: ' || j::text;
  begin perform public._registra_certificati(public._hash(c), 'Paolo', '[{"data":"2026-10-18","distanza":"10","secondi":2700,"fonte":"gpl"}]'); assert false, 'non partecipa e certifica';
  exception when others then if sqlerrm not like '%non partecipi%' then raise; end if; end;

  -- lettura: le classifiche solo partecipando, solo i certificati
  j := public.stato_classifiche(a);
  assert json_array_length(j->'risultati') = 2, 'risultati certificati visibili';
  assert (select count(*) from json_array_elements(j->'risultati') x where x->>'membro' = 'Giulia Neri' and x->>'categoria' = 'SF35') = 2, 'con categoria';
  assert (j->>'da_approvare')::int = 1, 'uno in coda per il referente';
  assert json_array_length(public.stato_classifiche(c)->'risultati') = 0, 'chi non partecipa non vede';
  assert json_array_length(public.stato_classifiche(b)->'miei') = 3, 'i miei, anche in coda';

  -- tempo mandato a mano al referente; limite di 5 in coda; mai sopra un certificato
  rid := public.invia_risultato(b, '{"data":"2026-10-04","distanza":"10","tempo":"0:48:12","gara_nome":"Corsa di Ognissanti","link":"https://esempio.it/classifica.pdf","nota":"solo PDF"}');
  begin perform public.invia_risultato(b, '{"data":"2026-10-18","distanza":"21","tempo":"1:40:00"}'); assert false, 'sopra un certificato';
  exception when others then if sqlerrm not like '%già un tempo certificato%' then raise; end if; end;
  begin perform public.invia_risultato(b, '{"data":"2026-10-04","distanza":"10","tempo":"abc"}'); assert false, 'tempo non valido';
  exception when others then if sqlerrm not like '%tempo non valido%' then raise; end if; end;
  perform public.invia_risultato(b, '{"data":"2026-08-01","distanza":"10","tempo":"0:50:00"}');
  perform public.invia_risultato(b, '{"data":"2026-07-01","distanza":"10","tempo":"0:50:00"}');
  perform public.invia_risultato(b, '{"data":"2026-06-01","distanza":"10","tempo":"0:50:00"}');
  begin perform public.invia_risultato(b, '{"data":"2026-05-01","distanza":"10","tempo":"0:50:00"}'); assert false, 'sesto in coda';
  exception when others then if sqlerrm not like '%5 tempi in attesa%' then raise; end if; end;
  begin perform public.invia_risultato(c, '{"data":"2026-10-04","distanza":"10","tempo":"0:48:12"}'); assert false, 'non partecipa e invia';
  exception when others then if sqlerrm not like '%non partecipi%' then raise; end if; end;

  -- referente: un membro non vede la coda; l'amministratore approva e rifiuta
  begin perform public.da_approvare(b); assert false, 'membro vede la coda';
  exception when others then if sqlerrm not like '%amministratori e organizzatori%' then raise; end if; end;
  assert json_array_length(public.da_approvare(a)) = 5, 'cinque in coda';
  perform public.decidi_risultato(a, rid, true);
  perform public.decidi_risultato(a, (select id from public.risultati_gruppo where data = '2026-08-01'), false);
  begin perform public.decidi_risultato(a, rid, false); assert false, 'deciso due volte';
  exception when others then if sqlerrm not like '%già deciso%' then raise; end if; end;
  assert json_array_length(public.stato_classifiche(a)->'risultati') = 3, 'approvato entra in classifica';
  -- il proprio tempo lo approva un altro referente
  perform public.invia_risultato(a, '{"data":"2026-10-04","distanza":"10","tempo":"0:44:00"}');
  perform public.admin_ruolo(a, (select id from public.membri where nome = 'Giulia Neri'), 'organizzatore');
  begin perform public.decidi_risultato(a, (select r.id from public.risultati_gruppo r join public.membri x on x.id = r.membro_id where x.nome = 'Luca Albanesi'), true); assert false, 'si approva da solo';
  exception when others then if sqlerrm not like '%un altro referente%' then raise; end if; end;
  perform public.decidi_risultato(b, (select r.id from public.risultati_gruppo r join public.membri x on x.id = r.membro_id where x.nome = 'Luca Albanesi'), true);
  -- annullare un certificato: solo l'amministratore
  begin perform public.annulla_risultato(b, rid); assert false, 'organizzatore annulla';
  exception when others then if sqlerrm not like '%amministratori%' then raise; end if; end;
  perform public.annulla_risultato(a, rid);
  assert (select stato from public.risultati_gruppo where id = rid) = 'rifiutato', 'annullato';

  -- le gare di tutti: solo l'amministratore, in ogni stato, anche di chi non è in classifica
  begin perform public.gare_membri(b); assert false, 'organizzatore vede le gare di tutti';
  exception when others then if sqlerrm not like '%amministratori%' then raise; end if; end;
  j := public.gare_membri(a);
  assert json_array_length(j->'membri') = 3, 'tutti i membri: ' || (j->'membri')::text;
  assert (select count(*) from json_array_elements(j->'risultati')) = (select count(*) from public.risultati_gruppo), 'tutti i risultati';
  assert exists (select 1 from json_array_elements(j->'risultati') x where x->>'stato' = 'in_approvazione' and x->>'membro' = 'Giulia Neri'), 'anche in approvazione';
  assert exists (select 1 from json_array_elements(j->'risultati') x where x->>'id' = rid::text and x->>'stato' = 'rifiutato' and x->>'deciso_da' = 'Luca Albanesi'), 'chi ha deciso';
  perform public.partecipa_classifiche(a, false);
  assert json_array_length(public.gare_membri(a)->'risultati') > 0, 'l''amministratore vede anche senza partecipare';
  perform public.partecipa_classifiche(a, true);

  -- esiti senza tempo
  perform public.segna_esito(b, '{"data":"2026-10-25","distanza":"42","esito":"ritirato","gara_nome":"Maratona"}');
  assert (select esito from public.risultati_gruppo where data = '2026-10-25') = 'ritirato', 'esito salvato';
  begin perform public.segna_esito(b, '{"data":"2026-10-18","distanza":"21","esito":"ritirato"}'); assert false, 'esito sopra un certificato';
  exception when others then if sqlerrm not like '%già un tempo certificato%' then raise; end if; end;
  perform public.segna_esito(b, '{"data":"2026-10-25","distanza":"42","esito":"nessuno"}');
  assert not exists (select 1 from public.risultati_gruppo where data = '2026-10-25'), 'esito tolto';

  -- fuori misura (es. la Corsa di Miguel, 9,9 km): entra come 10 km con km_reali; troppo lontana dalla distanza no
  j := public._registra_certificati(hb, 'Giulia Neri', '[
    {"data":"2026-01-18","distanza":"10","secondi":2474,"gara_nome":"La Corsa di Miguel","fonte":"gpl","km_reali":9.9},
    {"data":"2026-04-19","distanza":"21","secondi":5118,"gara_nome":"Appia Run","fonte":"gpl","km_reali":19}]');
  assert (j->>'certificati')::int = 1 and (j->>'saltati')::int = 1, 'fuori misura: ' || j::text;
  assert (select km_reali from public.risultati_gruppo where data = '2026-01-18') = 9.9, 'km_reali salvato';
  assert exists (select 1 from json_array_elements(public.stato_classifiche(a)->'risultati') x where x->>'data' = '2026-01-18' and (x->>'km_reali')::numeric = 9.9), 'km_reali in classifica';
  assert exists (select 1 from json_array_elements(public.stato_classifiche(b)->'miei') x where x->>'data' = '2026-01-18' and (x->>'km_reali')::numeric = 9.9), 'km_reali nei miei';
  assert (select count(*) from json_array_elements(public.stato_classifiche(a)->'risultati') x where x->>'km_reali' is not null) = 1, 'le esatte senza km_reali';

  -- dopo i 30 giorni del recupero: le gare vecchie no, le nuove sì
  update public.membri set partecipa_dal = now() - interval '40 days' where nome = 'Giulia Neri';
  j := public._registra_certificati(hb, 'Giulia Neri', format('[{"data":"2024-04-07","distanza":"21","secondi":6500,"fonte":"gpl"},{"data":"%s","distanza":"10","secondi":2650,"fonte":"gpl"}]', current_date - 1)::jsonb);
  assert (j->>'certificati')::int = 1 and (j->>'saltati')::int = 1, 'recupero chiuso: ' || j::text;

  -- togliere un proprio risultato; uscire dalle classifiche cancella i risultati online
  perform public.togli_risultato(b, (select id from public.risultati_gruppo where data = '2024-04-07' or data = current_date - 1 limit 1));
  perform public.partecipa_classifiche(b, false);
  assert not exists (select 1 from public.risultati_gruppo r join public.membri x on x.id = r.membro_id where x.nome = 'Giulia Neri'), 'risultati cancellati';
  assert (public.stato_classifiche(a)->>'partecipanti')::int = 1, 'un partecipante';
  -- chi esce dal gruppo porta via tutto
  perform public.esci_gruppo(c); perform public.esci_gruppo(b); perform public.esci_gruppo(a);
  assert (select count(*) from public.risultati_gruppo) = 0, 'niente resta';
  raise notice 'ok';
end $$;

-- permessi: anon non legge i risultati e non scrive certificati
set role anon;
do $$ begin
  begin perform 1 from public.risultati_gruppo; assert false, 'anon legge risultati'; exception when insufficient_privilege then null; end;
  begin perform public._registra_certificati('x', 'x', '[]'); assert false, 'anon certifica'; exception when insufficient_privilege then null; end;
  begin perform public._io_classifiche(repeat('a', 40)); assert false, 'anon chiama _io_classifiche'; exception when insufficient_privilege then null; end;
  raise notice 'permessi classifiche ok';
end $$;
reset role;
