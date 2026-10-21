-- Prova della stagione del gruppo (docs/supabase_stagione.sql) dopo gruppo, classifiche e tabelle di age-grading.
-- Si ferma al primo errore; in fondo "permessi stagione ok".
\set ON_ERROR_STOP on
do $$
declare
  a text := repeat('s', 40); b text := repeat('t', 40); c text := repeat('u', 40); d text := repeat('v', 40);
  j json; cod text; mio text; n int; gid uuid; hb text := public._hash(repeat('t', 40)); hc text := public._hash(repeat('u', 40));
  domani date := current_date + 3; ieri date := current_date - 1;
begin
  j := public.crea_gruppo(a, 'Stagione Roma', 'Luca Albanesi');
  cod := j->>'codice';
  perform public.entra_gruppo(b, cod, 'Roberto Bianchi', true);
  perform public.entra_gruppo(c, cod, 'Elena Verdi', true);

  -- supporto
  assert public._eta(null, 'SM45', '2026-05-01') = 45 and public._eta(null, 'sf35', '2026-05-01') = 35, 'età dalla categoria';
  assert public._eta(null, 'SM', '2026-05-01') = 23 and public._eta(null, 'PF', '2026-05-01') = 20, 'senior e promesse';
  assert public._eta(1966, 'SM55', '2026-05-01') = 60, 'anno di nascita prima della categoria';
  assert public._eta(null, null, '2026-05-01') is null and public._eta(null, 'M45', '2026-05-01') is null, 'età sconosciuta';
  assert public._age_grade('M', '42', 60, 12600) = 70.5, 'maratona a 60 anni in 3:30:00 = 70,5%';
  assert public._aperta(current_date + 1) and not public._aperta(current_date) and not public._aperta(ieri), 'blocco a mezzanotte';

  -- gare della società: servono classifiche accese e il direttivo
  begin perform public.gare_societa_aggiungi(a, jsonb_build_object('data', domani, 'distanza', '10', 'nome', 'Corsa dei Santi'));
    assert false, 'gara della società a classifiche spente';
  exception when others then if sqlerrm not like '%spente%' then raise; end if; end;
  perform public.admin_classifiche(a, true);
  perform public.partecipa_classifiche(a, true);
  perform public.partecipa_classifiche(b, true);
  perform public.partecipa_classifiche(c, true);
  begin perform public.gare_societa_aggiungi(b, jsonb_build_object('data', domani, 'distanza', '10', 'nome', 'Corsa dei Santi'));
    assert false, 'un membro aggiunge una gara della società';
  exception when others then if sqlerrm not like '%direttivo%' then raise; end if; end;
  gid := public.gare_societa_aggiungi(a, jsonb_build_object('data', domani, 'distanza', '10', 'nome', 'Corsa dei Santi', 'luogo', 'ROMA', 'gara_id', 'X1'));
  assert public.gare_societa_aggiungi(a, jsonb_build_object('data', domani, 'distanza', '10', 'nome', 'Corsa dei Santi 2026')) = gid, 'stessa gara: aggiornata';
  perform public.gare_societa_aggiungi(a, jsonb_build_object('data', '2026-03-15', 'distanza', '42', 'nome', 'Maratona di Roma'));
  begin perform public.gare_societa_aggiungi(a, '{"data":"2026-03-15","distanza":"5","nome":"x"}'); assert false, 'distanza non valida';
  exception when others then if sqlerrm not like '%non valida%' then raise; end if; end;
  j := public.stato_stagione(b);
  assert json_array_length(j->'gare_societa') = 2, 'il membro vede le gare della società: ' || j::text;
  begin perform public.gare_societa_togli(b, gid); assert false, 'il membro toglie';
  exception when others then if sqlerrm not like '%direttivo%' then raise; end if; end;

  -- obiettivo: fino alla mezzanotte della vigilia; gli altri lo vedono solo a gara iniziata
  perform public.fissa_obiettivo(b, jsonb_build_object('data', domani, 'distanza', '10', 'tempo', '42:30'));
  perform public.fissa_obiettivo(b, jsonb_build_object('data', domani, 'distanza', '10', 'tempo', '0:42:10'));
  assert (select secondi from public.obiettivi_gara o join public.membri x on x.id = o.membro_id where x.token_hash = hb) = 2530, 'obiettivo aggiornato';
  begin perform public.fissa_obiettivo(b, jsonb_build_object('data', ieri, 'distanza', '10', 'tempo', '42:30')); assert false, 'obiettivo dopo il via';
  exception when others then if sqlerrm not like '%bloccato%' then raise; end if; end;
  begin perform public.fissa_obiettivo(b, jsonb_build_object('data', domani, 'distanza', '10', 'tempo', '9:00')); assert false, 'obiettivo impossibile';
  exception when others then if sqlerrm not like '%non valido%' then raise; end if; end;
  assert json_array_length(public.stato_stagione(b)->'obiettivi') = 1, 'il mio obiettivo lo vedo';
  assert json_array_length(public.stato_stagione(a)->'obiettivi') = 0, 'quello degli altri no, prima del via';
  insert into public.obiettivi_gara (membro_id, data, distanza, secondi) select id, ieri, '21', 6300 from public.membri where token_hash = hb;
  assert json_array_length(public.stato_stagione(a)->'obiettivi') = 1, 'dopo il via sì';
  perform public.fissa_obiettivo(b, jsonb_build_object('data', domani, 'distanza', '10', 'tempo', ''));
  assert json_array_length(public.stato_stagione(b)->'obiettivi') = 1, 'tempo vuoto toglie l''obiettivo aperto';

  -- Borsa pronta: sì/no fino alla vigilia
  perform public.segna_borsa(b, jsonb_build_object('data', domani, 'distanza', '10', 'pronta', true));
  perform public.segna_borsa(b, jsonb_build_object('data', domani, 'distanza', '10', 'pronta', true));
  assert json_array_length(public.stato_stagione(b)->'borse') = 1 and json_array_length(public.stato_stagione(a)->'borse') = 0, 'borsa: mia sì, altrui no';
  perform public.segna_borsa(b, jsonb_build_object('data', domani, 'distanza', '10', 'pronta', false));
  assert json_array_length(public.stato_stagione(b)->'borse') = 0, 'borsa tolta';
  begin perform public.segna_borsa(b, jsonb_build_object('data', ieri, 'distanza', '10', 'pronta', true)); assert false, 'borsa dopo il via';
  exception when others then if sqlerrm not like '%bloccata%' then raise; end if; end;

  -- età: anno e sesso facoltativi; nello stato solo la percentuale
  begin perform public.dati_eta(b, 1850, 'M'); assert false, 'anno impossibile';
  exception when others then if sqlerrm not like '%non valido%' then raise; end if; end;
  perform public.dati_eta(b, 1966, 'M');
  j := public.stato_stagione(b);
  assert (j->'io'->>'anno_nascita')::int = 1966 and j->'io'->>'sesso' = 'M', 'i miei dati';
  assert public.stato_stagione(a)::text not like '%1966%', 'l''anno degli altri non esce';
  j := public._registra_certificati(hb, 'Roberto Bianchi', jsonb_build_array(jsonb_build_object('data', current_date - 2, 'distanza', '42', 'secondi', 12600,
    'fonte', 'fidal', 'categoria', 'SM55')));
  j := public._registra_certificati(hc, 'Elena Verdi', jsonb_build_array(jsonb_build_object('data', current_date - 2, 'distanza', '21', 'secondi', 6080,
    'fonte', 'gpl', 'categoria', 'SF55')));
  j := public.stato_stagione(a);
  assert json_array_length(j->'eta') = 2, 'due percentuali: ' || (j->'eta')::text;
  assert (select (e->>'ag')::numeric from json_array_elements(j->'eta') e where e->>'sesso' = 'M') = 70.5, 'Roberto 70,5% dall''anno';
  assert (select (e->>'circa')::boolean from json_array_elements(j->'eta') e where e->>'sesso' = 'F'), 'Elena dalla categoria: circa';

  -- inviti personali: info e ingresso con il codice personale
  mio := public.mio_invito(a);
  assert public.mio_invito(a) = mio and mio <> cod and char_length(mio) = 8, 'codice personale stabile';
  j := public.info_invito(mio);
  assert j->>'nome' = 'Stagione Roma' and j->>'admin' = 'Luca Albanesi', 'invito personale: ' || j::text;
  assert public.info_invito('ZZZZZZZZ') is null, 'codice inesistente';
  j := public.entra_gruppo(d, lower(mio), 'Sara Nuova', true);
  assert (select x.nome from public.membri m join public.membri x on x.id = m.invitato_da where m.token_hash = public._hash(d)) = 'Luca Albanesi', 'invitata da Luca';
  assert j->>'invitato_da' is not null, 'nuovo socio segnalato';
  j := public.entra_gruppo(d, cod, 'Sara Nuova', true);
  assert j->>'invitato_da' is null and (select invitato_da from public.membri where token_hash = public._hash(d)) is not null, 'rientrare non cambia chi ha invitato';
  assert json_array_length(public.stato_stagione(a)->'inviti') = 0, 'conta solo se partecipa';
  assert json_array_length(public.stato_stagione(a)->'partecipanti') = 3, 'tre partecipanti';
  perform public.partecipa_classifiche(d, true);
  assert json_array_length(public.stato_stagione(a)->'inviti') = 1, 'nuovo socio che partecipa';

  -- chi smette di partecipare: via obiettivi e borse
  perform public.segna_borsa(b, jsonb_build_object('data', domani, 'distanza', '10', 'pronta', true));
  perform public.partecipa_classifiche(b, false);
  assert not exists (select 1 from public.obiettivi_gara o join public.membri x on x.id = o.membro_id where x.token_hash = hb), 'obiettivi tolti';
  assert not exists (select 1 from public.borse_pronte o join public.membri x on x.id = o.membro_id where x.token_hash = hb), 'borse tolte';
  begin perform public.fissa_obiettivo(b, jsonb_build_object('data', domani, 'distanza', '10', 'tempo', '42:30')); assert false, 'obiettivo senza partecipare';
  exception when others then if sqlerrm not like '%non partecipi%' then raise; end if; end;
  assert json_array_length(public.stato_stagione(b)->'obiettivi') = 0 and json_array_length(public.stato_stagione(b)->'eta') = 0, 'non partecipa: niente';

  -- direttivo toglie
  perform public.gare_societa_togli(a, gid);
  assert json_array_length(public.stato_stagione(a)->'gare_societa') = 1, 'gara tolta';

  -- pulizia: le prove successive (statistiche) partono da un database senza membri
  delete from public.gruppi where nome = 'Stagione Roma';
  assert not exists (select 1 from public.inviti_personali), 'inviti tolti con il gruppo';
end $$;

-- permessi: le tabelle non si leggono da fuori, le funzioni di supporto non si chiamano
set role anon;
do $$
begin
  begin perform 1 from public.obiettivi_gara limit 1; raise exception 'tabella leggibile';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.age_grade limit 1; raise exception 'age_grade leggibile';
  exception when insufficient_privilege then null; end;
  begin perform public._age_grade('M', '10', 40, 2400); raise exception 'supporto chiamabile';
  exception when insufficient_privilege then null; end;
  perform public.info_invito('ZZZZZZZZ');
  raise notice 'permessi stagione ok';
end $$;
reset role;
