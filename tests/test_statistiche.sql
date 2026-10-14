-- Prova delle statistiche su un Postgres vuoto (GitHub Actions), dopo supabase.sql, supabase_gruppo.sql e supabase_statistiche.sql.
\set ON_ERROR_STOP on
do $$
declare j json;
begin
  -- dati finti: due iscrizioni push (una con le novità spente), due gare seguite da tre telefoni
  insert into public.push_iscrizioni (endpoint, p256dh, auth, dati) values
    ('https://p/1', 'k', 'a', '{"pref":{"meteo":true}}'), ('https://p/2', 'k', 'a', '{"pref":{"novita":false}}');
  insert into public.gare_aggiunte (gara_id, nome, data, luogo, distanza, fonte) values
    ('F-42', 'Firenze Marathon', current_date + 40, 'FIRENZE', '42', 'FIDAL'), ('F-42', 'Firenze Marathon', current_date + 40, 'FIRENZE', '42', 'FIDAL'),
    ('R-21', 'Rome Half', current_date + 4, 'ROMA', '21', 'FIDAL'), ('TEST', 'Prova', current_date + 1, 'X', '10', 'manuale');

  -- aperture anonime: tre telefoni oggi, di cui uno nuovo; tipi sconosciuti ignorati, doppioni nella stessa chiamata contati una volta
  perform public.conta_apertura(array['giorno', 'settimana', 'nuovo']);
  perform public.conta_apertura(array['giorno', 'settimana']);
  perform public.conta_apertura(array['giorno', 'giorno', 'boh']);
  perform public.conta_apertura(null);
  perform public.conta_invii('{"mattino": 2, "novita": 1, "zero": 0}');
  perform public.conta_invii('{"mattino": 1}');

  -- parola d'ordine
  insert into public.statistiche_chiave (id, impronta) values (1, encode(extensions.digest('segreta', 'sha256'), 'hex'));
  begin perform public.statistiche('sbagliata'); assert false, 'parola sbagliata accettata';
  exception when others then if sqlerrm not like '%parola d''ordine errata%' then raise; end if; end;

  j := public.statistiche('segreta');
  assert (j->'attivi'->>(current_date::text))::int = 3, 'attivi oggi';
  assert (j->>'settimana')::int = 2 and (j->>'nuovi7')::int = 1, 'settimana e nuovi';
  assert (j->'invii7'->>'mattino')::int = 3 and (j->'invii7'->>'novita')::int = 1 and j->'invii7'->>'zero' is null, 'invii';
  assert (j->>'iscritti')::int = 2 and (j->'interruttori'->>'meteo')::int = 2 and (j->'interruttori'->>'novita')::int = 1, 'interruttori';
  assert (j->>'gare_totali')::int = 2 and j->'gare'->0->>'nome' = 'Firenze Marathon' and (j->'gare'->0->>'n')::int = 2, 'gare più seguite';
  assert (j->'gruppo'->>'membri')::int = 0, 'gruppo vuoto';
  raise notice 'statistiche ok';
end $$;

-- permessi: anon conta le aperture e legge le statistiche con la parola, ma non scrive gli invii né legge le tabelle
set role anon;
do $$ begin
  perform public.conta_apertura(array['giorno']);
  begin perform public.conta_invii('{"mattino": 99}'); assert false, 'anon scrive gli invii'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.aperture; assert false, 'anon legge aperture'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.statistiche_chiave; assert false, 'anon legge la chiave'; exception when insufficient_privilege then null; end;
  raise notice 'permessi statistiche ok';
end $$;
