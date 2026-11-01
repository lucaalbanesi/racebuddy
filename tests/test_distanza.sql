-- Prova della distanza ufficiale e dei tempi dal direttivo (docs/supabase_distanza.sql), dopo gruppo, classifiche,
-- age grade e stagione. Si ferma al primo errore; in fondo "permessi distanza ok".
\set ON_ERROR_STOP on
do $$
declare
  a text := repeat('d', 40); b text := repeat('e', 40); c text := repeat('f', 40); e text := repeat('g', 40);
  ha text := public._hash(repeat('d', 40)); hb text := public._hash(repeat('e', 40)); hc text := public._hash(repeat('f', 40));
  j json; cod text; gid uuid; futura uuid; vecchia uuid; ib uuid; ic uuid; ie uuid; oggi date := (now() at time zone 'Europe/Rome')::date;
begin
  j := public.crea_gruppo(a, 'Distanze Roma', 'Luca Albanesi');
  cod := j->>'codice';
  perform public.entra_gruppo(b, cod, 'Roberto Bianchi', true);
  perform public.entra_gruppo(c, cod, 'Elena Verdi', true);
  perform public.entra_gruppo(e, cod, 'Carla Neri', true);
  perform public.admin_classifiche(a, true);
  perform public.partecipa_classifiche(a, true); perform public.partecipa_classifiche(b, true);
  perform public.partecipa_classifiche(c, true); perform public.partecipa_classifiche(e, true);
  select id into ib from public.membri where token_hash = hb;
  select id into ic from public.membri where token_hash = hc;
  select id into ie from public.membri where token_hash = public._hash(e);

  assert public._km_ris(9.95, '10') is null and public._km_ris(9.85, '10') = 9.85 and public._km_ris(21.1, '21') is null, 'esatta entro 50 m';

  -- obiettivo con i km: si salvano (gara di domani)
  perform public.fissa_obiettivo(b, jsonb_build_object('data', oggi + 1, 'distanza', '10', 'tempo', '0:39:10', 'km_reali', '9.5'));
  assert (select km from public.obiettivi_gara where membro_id = ib and data = oggi + 1) = 9.5, 'km dell''obiettivo';
  perform public.fissa_obiettivo(b, jsonb_build_object('data', oggi + 1, 'distanza', '10', 'tempo', '0:40:00'));
  assert (select km from public.obiettivi_gara where membro_id = ib and data = oggi + 1) is null, 'obiettivo sulla classica';
  assert exists (select 1 from json_array_elements(public.stato_stagione(b)->'obiettivi') x where x->>'data' = (oggi + 1)::text and x->>'km' is null), 'km in stato_stagione';

  -- la gara di oggi, arrivata dalle classifiche a 9,5 km (fuori misura)
  gid := public.gare_societa_aggiungi(a, jsonb_build_object('data', oggi, 'distanza', '10', 'nome', 'Corsa dei Santi'));
  futura := public.gare_societa_aggiungi(a, jsonb_build_object('data', oggi + 5, 'distanza', '10', 'nome', 'Futura'));
  vecchia := public.gare_societa_aggiungi(a, jsonb_build_object('data', oggi - 40, 'distanza', '10', 'nome', 'Vecchia'));
  perform public._registra_certificati(hb, 'Roberto Bianchi', jsonb_build_array(jsonb_build_object('data', oggi, 'distanza', '10', 'secondi', 2810, 'fonte', 'gpl', 'km_reali', 9.5, 'societa', 'A.S.D. Distanze Roma')));
  assert (select km_reali from public.risultati_gruppo where membro_id = ib and data = oggi) = 9.5, 'fuori misura dalla fonte';

  -- correzione: solo direttivo, gara corsa, entro 30 giorni, fonte obbligatoria, km coerenti
  begin perform public.correggi_distanza(b, gid, '{"km": 9.95, "fonte": "https://x.it/r.pdf"}'); assert false, 'membro';
  exception when others then if sqlerrm not like '%direttivo%' then raise; end if; end;
  begin perform public.correggi_distanza(a, futura, '{"km": 9.95, "fonte": "https://x.it/r.pdf"}'); assert false, 'gara futura';
  exception when others then if sqlerrm not like '%non è ancora corsa%' then raise; end if; end;
  begin perform public.correggi_distanza(a, vecchia, '{"km": 9.95, "fonte": "https://x.it/r.pdf"}'); assert false, 'oltre 30 giorni';
  exception when others then if sqlerrm not like '%30 giorni%' then raise; end if; end;
  begin perform public.correggi_distanza(a, gid, '{"km": 9.95}'); assert false, 'senza fonte';
  exception when others then if sqlerrm not like '%fonte%' then raise; end if; end;
  begin perform public.correggi_distanza(a, gid, '{"km": 19, "fonte": "https://x.it/r.pdf"}'); assert false, 'km di un''altra classica';
  exception when others then if sqlerrm not like '%km non validi%' then raise; end if; end;

  j := public.correggi_distanza(a, gid, '{"km": "9,95", "fonte": "https://x.it/regolamento.pdf", "nota": "Regolamento definitivo"}');
  assert (j->>'esatta')::boolean and (j->>'risultati')::int = 1, 'diventa esatta';
  assert (select km_reali from public.risultati_gruppo where membro_id = ib and data = oggi) is null, 'risultato esatto';
  assert (select km_uff from public.gare_societa where id = gid) = 9.95, 'km ufficiali';
  begin perform public.correggi_distanza(a, gid, '{"km": 9.95, "fonte": "https://x.it/r.pdf"}'); assert false, 'stessa distanza';
  exception when others then if sqlerrm not like '%già questa%' then raise; end if; end;

  -- un tempo che arriva dopo (dalla fonte con 9,5) prende la distanza ufficiale
  perform public._registra_certificati(hc, 'Elena Verdi', jsonb_build_array(jsonb_build_object('data', oggi, 'distanza', '10', 'secondi', 3270, 'fonte', 'gpl', 'km_reali', 9.5)));
  assert (select km_reali from public.risultati_gruppo where membro_id = ic and data = oggi) is null, 'trigger sui nuovi';
  assert exists (select 1 from json_array_elements(public.stato_stagione(a)->'gare_societa') x
    where x->>'id' = gid::text and (x->>'km_uff')::numeric = 9.95 and json_array_length(x->'correzioni') = 1 and x->'correzioni'->0->>'da' = 'Luca Albanesi'), 'storico in stato_stagione';

  -- di nuovo, a 9,85: fuori misura con i km ufficiali; poi annulla → torna 9,95
  perform public.correggi_distanza(a, gid, '{"km": 9.85, "fonte": "https://x.it/comunicato"}');
  assert (select km_reali from public.risultati_gruppo where membro_id = ib and data = oggi) = 9.85, 'fuori misura ufficiale';
  perform public.annulla_distanza(a, gid);
  assert (select km_uff from public.gare_societa where id = gid) = 9.95, 'torna la correzione di prima';
  assert (select km_reali from public.risultati_gruppo where membro_id = ib and data = oggi) is null, 'torna esatta';
  perform public.annulla_distanza(a, gid);
  assert (select km_uff from public.gare_societa where id = gid) is null, 'torna la distanza del calendario';
  assert (select km_reali from public.risultati_gruppo where membro_id = ib and data = oggi) = 9.5, 'tornano i km della fonte';
  begin perform public.annulla_distanza(a, gid); assert false, 'niente da annullare';
  exception when others then if sqlerrm not like '%nessuna correzione%' then raise; end if; end;
  perform public.correggi_distanza(a, gid, '{"km": 9.95, "fonte": "https://x.it/regolamento.pdf"}');

  -- tempi dal direttivo
  begin perform public._soci_gara(hb, gid); assert false, 'soci: membro';
  exception when others then if sqlerrm not like '%direttivo%' then raise; end if; end;
  j := public._soci_gara(ha, gid);
  assert (j->'gara'->>'km')::numeric = 9.95 and json_array_length(j->'soci') = 4, 'soci della gara';
  assert j->'societa'->>0 = 'A.S.D. Distanze Roma', 'società dei tempi certificati da sé';
  assert exists (select 1 from json_array_elements(j->'soci') x where x->>'id' = ib::text and x->>'stato' = 'certificato' and (x->>'da_solo')::boolean), 'già caricato da sé';
  perform public.segna_esito(e, jsonb_build_object('data', oggi, 'distanza', '10', 'esito', 'ritirato'));
  j := public._registra_dal_direttivo(ha, gid, jsonb_build_array(
    jsonb_build_object('membro_id', ib, 'secondi', 2700, 'fonte', 'gpl'),                       -- ha già il suo: saltato
    jsonb_build_object('membro_id', ie, 'secondi', 2900, 'fonte', 'gpl'),                       -- ritirato: saltato
    jsonb_build_object('membro_id', (select id from public.membri where token_hash = ha), 'secondi', 2453, 'fonte', 'gpl', 'km_reali', 9.5, 'categoria', 'SM35'),
    jsonb_build_object('membro_id', gen_random_uuid(), 'secondi', 2453, 'fonte', 'gpl'),       -- non del gruppo
    jsonb_build_object('membro_id', ic, 'secondi', 20, 'fonte', 'gpl')));                       -- non plausibile (e già certificato)
  assert (j->>'caricati')::int = 1 and (j->>'saltati')::int = 4, 'caricati e saltati: ' || j::text;
  assert (select secondi from public.risultati_gruppo where membro_id = ib and data = oggi) = 2810, 'vince il tempo dell''atleta';
  assert (select km_reali is null and stato = 'certificato' and nota = 'Caricato dal direttivo' and deciso_da is not null
    from public.risultati_gruppo r join public.membri x on x.id = r.membro_id where x.token_hash = ha and r.data = oggi), 'certificato dal direttivo, km ufficiali';
  begin perform public._registra_dal_direttivo(hb, gid, '[]'); assert false, 'registra: membro';
  exception when others then if sqlerrm not like '%direttivo%' then raise; end if; end;

  -- esiti per le notifiche
  j := public._esiti_push(array[ha, hb]);
  assert json_array_length(j) = 2, 'esiti dei due telefoni';
  assert exists (select 1 from json_array_elements(j) x where x->>'membro' = ha and (x->>'da_altri')::boolean is false), 'il proprio non è "da altri"';
  -- caricato da un altro admin: da altri
  perform public.admin_ruolo(a, ic, 'admin');
  delete from public.risultati_gruppo where membro_id = (select id from public.membri where token_hash = ha) and data = oggi;
  perform public._registra_dal_direttivo(hc, gid, jsonb_build_array(jsonb_build_object('membro_id', (select id from public.membri where token_hash = ha), 'secondi', 2453, 'fonte', 'gpl')));
  assert exists (select 1 from json_array_elements(public._esiti_push(array[ha])) x where (x->>'da_altri')::boolean and x->>'stato' = 'certificato'), 'da altri';
end $$;

-- permessi: le funzioni del job e della funzione "tempi" solo con la chiave segreta
do $$
begin
  assert not has_function_privilege('anon', 'public._soci_gara(text, uuid)', 'execute'), 'soci_gara anon';
  assert not has_function_privilege('anon', 'public._registra_dal_direttivo(text, uuid, jsonb)', 'execute'), 'registra anon';
  assert not has_function_privilege('anon', 'public._esiti_push(text[])', 'execute'), 'esiti anon';
  assert has_function_privilege('service_role', 'public._esiti_push(text[])', 'execute'), 'esiti service';
  assert has_function_privilege('anon', 'public.correggi_distanza(text, uuid, jsonb)', 'execute'), 'correggi anon';
  assert has_function_privilege('anon', 'public.annulla_distanza(text, uuid)', 'execute'), 'annulla anon';
  raise notice 'permessi distanza ok';
end $$;
