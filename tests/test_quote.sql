-- Prova delle quote gara con la società (docs/supabase_quote.sql), dopo gruppo, classifiche, age grade, stagione e
-- distanza. Si ferma al primo errore; in fondo "permessi quote ok".
\set ON_ERROR_STOP on
do $$
declare
  a text := repeat('q', 40); b text := repeat('r', 40); c text := repeat('s', 40);
  j json; cod text; aq int; gid uuid; senza uuid; passata uuid; ib uuid; codice text; oggi date := (now() at time zone 'Europe/Rome')::date;
begin
  j := public.crea_gruppo(a, 'Quote Roma', 'Luca Albanesi');
  cod := j->>'codice';
  perform public.entra_gruppo(b, cod, 'Roberto Bianchi', true);
  perform public.entra_gruppo(c, cod, 'Elena Verdi', true);
  perform public.admin_classifiche(a, true);
  select id into ib from public.membri where token_hash = public._hash(b);
  gid := public.gare_societa_aggiungi(a, jsonb_build_object('data', oggi + 20, 'distanza', '10', 'nome', 'Corsa di Miguel'));
  senza := public.gare_societa_aggiungi(a, jsonb_build_object('data', oggi + 30, 'distanza', '21', 'nome', 'Senza quota'));
  passata := public.gare_societa_aggiungi(a, jsonb_build_object('data', oggi - 3, 'distanza', '10', 'nome', 'Passata'));

  -- interruttore della società: spento di partenza, lo accende solo l'amministratore
  assert not (public.stato_quote(b)->>'attive')::boolean, 'spente di partenza';
  begin perform public.quota_gara(a, gid, '12'); assert false, 'quota a quote spente';
  exception when others then if sqlerrm not like '%spente%' then raise; end if; end;
  begin perform public.admin_quote(b, true); assert false, 'membro accende';
  exception when others then if sqlerrm not like '%amministratore%' then raise; end if; end;
  perform public.admin_quote(a, true);
  assert (public.stato_quote(b)->>'attive')::boolean, 'accese';

  -- conto: solo l'amministratore, IBAN controllato e normalizzato
  begin perform public.quote_conto(b, '{"intestatario": "X", "iban": "IT60X0542811101000000123456"}'); assert false, 'membro conto';
  exception when others then if sqlerrm not like '%amministratore%' then raise; end if; end;
  begin perform public.quote_conto(a, '{"intestatario": "ASD Quote", "iban": "12345"}'); assert false, 'iban sbagliato';
  exception when others then if sqlerrm not like '%IBAN%' then raise; end if; end;
  perform public.quote_conto(a, '{"intestatario": "  ASD   Quote Roma ", "iban": "it60 x054 2811 1010 0000 0123 456"}');
  assert (public.stato_quote(b)->'conto'->>'iban') = 'IT60X0542811101000000123456', 'iban normalizzato';
  assert (public.stato_quote(b)->'conto'->>'intestatario') = 'ASD Quote Roma', 'intestatario';

  -- quota: solo il direttivo, "12,50" va bene, testo no
  begin perform public.quota_gara(b, gid, '12'); assert false, 'membro quota';
  exception when others then if sqlerrm not like '%direttivo%' then raise; end if; end;
  begin perform public.quota_gara(a, gid, 'dodici'); assert false, 'quota testo';
  exception when others then if sqlerrm not like '%quota non valida%' then raise; end if; end;
  perform public.quota_gara(a, gid, '12,50');
  assert (select quota from public.gare_societa where id = gid) = 12.5, 'quota salvata';
  assert json_array_length(public.stato_quote(c)->'quote') = 1, 'una gara con quota';

  -- scelta: con la società serve la quota e la gara futura
  begin perform public.scegli_iscrizione(b, senza, 'societa'); assert false, 'senza quota';
  exception when others then if sqlerrm not like '%quota%' then raise; end if; end;
  perform public.quota_gara(a, passata, '10');
  begin perform public.scegli_iscrizione(b, passata, 'societa'); assert false, 'passata';
  exception when others then if sqlerrm not like '%passata%' then raise; end if; end;
  perform public.scegli_iscrizione(b, senza, 'conto_mio');   -- per conto mio va bene anche senza quota

  j := public.scegli_iscrizione(b, gid, 'societa');
  codice := j->>'codice';
  assert codice ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$', 'codice di 5 caratteri: ' || coalesce(codice, 'null');
  assert (j->>'importo')::numeric = 12.5 and j->>'pagato' is null, 'da pagare con la quota';

  -- il direttivo cambia la quota: chi ha già scelto resta con l'importo di allora
  perform public.quota_gara(a, gid, '15');
  assert (select importo from public.iscrizioni_quote where gara_id = gid and membro_id = ib) = 12.5, 'importo fermo';

  -- pagato: data non futura; annullabile; solo se iscritto con la società
  begin perform public.segna_pagato(b, gid, oggi + 1); assert false, 'data futura';
  exception when others then if sqlerrm not like '%data%' then raise; end if; end;
  perform public.segna_pagato(b, gid, oggi);
  assert (select pagato from public.iscrizioni_quote where gara_id = gid and membro_id = ib) = oggi, 'pagato';
  begin perform public.segna_pagato(c, gid, oggi); assert false, 'non iscritto';
  exception when others then if sqlerrm not like '%non sei iscritto%' then raise; end if; end;
  begin perform public.segna_pagato(b, senza, oggi); assert false, 'per conto mio';
  exception when others then if sqlerrm not like '%non sei iscritto%' then raise; end if; end;

  -- elenco: solo il direttivo, solo chi si iscrive con la società
  assert json_array_length(public.stato_quote(b)->'elenco') = 0, 'membro non vede l''elenco';
  j := public.stato_quote(a)->'elenco';
  assert json_array_length(j) = 1 and j->0->>'codice' = codice and j->0->>'nome' is not null and (j->0->>'pagato')::date = oggi, 'elenco direttivo';
  assert json_array_length(public.stato_quote(b)->'mie') = 2, 'le mie due scelte';

  -- cambiare idea: per conto mio toglie il pagato, il codice resta lo stesso; tornando con la società prende la quota nuova
  perform public.scegli_iscrizione(b, gid, 'conto_mio');
  assert json_array_length(public.stato_quote(a)->'elenco') = 0, 'fuori dall''elenco';
  j := public.scegli_iscrizione(b, gid, 'societa');
  assert j->>'codice' = codice and j->>'pagato' is null and (j->>'importo')::numeric = 15, 'stesso codice, quota nuova';
  perform public.scegli_iscrizione(b, gid, null);
  assert not exists (select 1 from public.iscrizioni_quote where gara_id = gid and membro_id = ib), 'scelta tolta';

  -- spente di nuovo: niente si vede né si scrive, i dati restano
  perform public.admin_quote(a, false);
  assert json_array_length(public.stato_quote(b)->'mie') = 0 and json_typeof(public.stato_quote(b)->'conto') = 'null', 'spente: niente';
  assert (public.stato_quote(a)->'conto'->>'iban') is not null, 'l''amministratore vede il conto anche spente';
  begin perform public.scegli_iscrizione(b, gid, 'societa'); assert false, 'scelta a quote spente';
  exception when others then if sqlerrm not like '%spente%' then raise; end if; end;
  assert exists (select 1 from public.iscrizioni_quote where membro_id = ib), 'dati restano';
  perform public.admin_quote(a, true);

  -- un altro gruppo non tocca queste gare
  perform public.crea_gruppo(repeat('t', 40), 'Altro Gruppo', 'Mario Rossi');
  perform public.admin_quote(repeat('t', 40), true);
  begin perform public.scegli_iscrizione(repeat('t', 40), gid, 'societa'); assert false, 'altro gruppo';
  exception when others then if sqlerrm not like '%non trovata%' then raise; end if; end;

  -- togliendo la gara dalle gare della società spariscono anche le iscrizioni
  perform public.scegli_iscrizione(b, gid, 'societa');
  delete from public.gare_societa where id = gid;
  assert not exists (select 1 from public.iscrizioni_quote where membro_id = ib and scelta = 'societa'), 'cascata';

  -- quota annuale: anno aperto secondo il mese (da luglio apre l'anno dopo)
  assert public._anno_quota('2026-11-23', 11) = 2027 and public._anno_quota('2026-10-31', 11) = 2026, 'novembre';
  assert public._anno_quota('2027-01-10', 1) = 2027 and public._anno_quota('2027-02-28', 3) = 2026 and public._anno_quota('2027-03-01', 3) = 2027, 'mesi primaverili';
  assert public._anno_quota('2026-07-01', 7) = 2027 and public._apertura_quota(2027, 11) = '2026-11-01' and public._apertura_quota(2027, 3) = '2027-03-01', 'apertura';

  -- solo l'amministratore; senza importo nessuna annualità
  aq := public._anno_quota(oggi, 11);
  assert (public.stato_quote(b)->'annuale'->>'anno') is null, 'nessuna quota annuale';
  begin perform public.admin_quota_annuale(b, '50', 11); assert false, 'membro quota annuale';
  exception when others then if sqlerrm not like '%amministratore%' then raise; end if; end;
  begin perform public.quota_annuale_scegli(b, aq, 'paga'); assert false, 'senza quota';
  exception when others then if sqlerrm not like '%non ha una quota%' then raise; end if; end;
  perform public.admin_quota_annuale(a, '45', 11);
  j := public.stato_quote(b)->'annuale';
  assert (j->>'anno')::int = aq and (j->>'importo')::numeric = 45 and json_array_length(j->'anni') = 1, 'annualità aperta';
  assert json_array_length(j->'elenco') = 0 and json_array_length(j->'soci') = 0, 'il membro non vede l''elenco';

  -- il socio apre la quota: codice univoco anche rispetto alle gare; il direttivo cambia l'importo, lui resta
  j := public.quota_annuale_scegli(b, aq, 'paga');
  codice := j->>'codice';
  assert codice ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$' and (j->>'importo')::numeric = 45 and j->>'pagato' is null, 'quota aperta';
  perform public.admin_quota_annuale(a, '50', 11);
  assert (select importo from public.iscrizioni_annuali where membro_id = ib and anno = aq) = 45, 'importo fermo';
  assert (select importo from public.quote_anni q where q.anno = aq and q.gruppo_id = (select gruppo_id from public.membri where id = ib)) = 50, 'annualità aggiornata';
  begin perform public.quota_annuale_pagato(b, aq, oggi + 1); assert false, 'data futura';
  exception when others then if sqlerrm not like '%data%' then raise; end if; end;
  begin perform public.quota_annuale_pagato(c, aq, oggi); assert false, 'non aperta';
  exception when others then if sqlerrm not like '%non hai aperto%' then raise; end if; end;
  perform public.quota_annuale_pagato(b, aq, oggi);
  assert (public.stato_quote(b)->'annuale'->'mie'->0->>'pagato')::date = oggi, 'pagata';

  -- non rinnova: toglie il pagato, il codice resta; tornando a pagare prende l'importo di oggi
  perform public.quota_annuale_scegli(c, aq, 'non_rinnova');
  perform public.quota_annuale_scegli(b, aq, 'non_rinnova');
  j := public.quota_annuale_scegli(b, aq, 'paga');
  assert j->>'codice' = codice and j->>'pagato' is null and (j->>'importo')::numeric = 50, 'stesso codice, importo nuovo';

  -- elenco: il direttivo (anche organizzatore) vede tutte le iscrizioni e i soci
  update public.membri set ruolo = 'organizzatore' where token_hash = public._hash(c);
  j := public.stato_quote(c)->'annuale';
  assert json_array_length(j->'elenco') = 2 and json_array_length(j->'soci') = 3, 'elenco organizzatore';
  begin perform public.admin_quota_annuale(c, '60', 11); assert false, 'organizzatore importo';
  exception when others then if sqlerrm not like '%amministratore%' then raise; end if; end;

  -- storico: un anno passato resta; togliendo l'importo l'anno aperto con iscrizioni resta
  insert into public.quote_anni (gruppo_id, anno, importo, aperta) select gruppo_id, aq - 1, 40, public._apertura_quota(aq - 1, 11) from public.membri where id = ib;
  perform public.quota_annuale_scegli(b, aq - 1, 'paga');
  perform public.quota_annuale_pagato(b, aq - 1, oggi - 300);
  assert json_array_length(public.stato_quote(b)->'annuale'->'mie') = 2 and json_array_length(public.stato_quote(b)->'annuale'->'anni') = 2, 'storico';
  perform public.admin_quota_annuale(a, '', 11);
  assert (public.stato_quote(b)->'annuale'->>'anno')::int = aq and (public.stato_quote(b)->'annuale'->>'importo') is null, 'anno con iscrizioni resta';

  -- quote spente: niente quota annuale e niente scritture
  perform public.admin_quote(a, false);
  assert json_typeof(public.stato_quote(b)->'annuale') = 'null', 'spente: niente annuale';
  begin perform public.quota_annuale_pagato(b, aq, oggi); assert false, 'pagato a quote spente';
  exception when others then if sqlerrm not like '%spente%' then raise; end if; end;
  perform public.admin_quote(a, true);

  delete from public.gruppi where nome in ('Quote Roma', 'Altro Gruppo');  -- le prove dopo (statistiche) contano i membri
end $$;

do $$
begin
  assert not has_function_privilege('anon', 'public._codice_quota()', 'execute'), 'codice anon';
  assert not has_function_privilege('anon', 'public._gara_quota(public.membri, uuid)', 'execute'), 'gara anon';
  assert has_function_privilege('anon', 'public.stato_quote(text)', 'execute'), 'stato anon';
  assert has_function_privilege('anon', 'public.admin_quote(text, boolean)', 'execute'), 'interruttore anon';
  assert has_function_privilege('anon', 'public.scegli_iscrizione(text, uuid, text)', 'execute'), 'scegli anon';
  assert has_function_privilege('anon', 'public.segna_pagato(text, uuid, date)', 'execute'), 'pagato anon';
  assert not has_function_privilege('anon', 'public._quota_aperta(uuid)', 'execute'), 'apertura anon';
  assert has_function_privilege('anon', 'public.admin_quota_annuale(text, text, integer)', 'execute'), 'quota annuale anon';
  assert has_function_privilege('anon', 'public.quota_annuale_scegli(text, integer, text)', 'execute'), 'scegli annuale anon';
  assert has_function_privilege('anon', 'public.quota_annuale_pagato(text, integer, date)', 'execute'), 'pagato annuale anon';
  raise notice 'permessi quote ok';
end $$;
