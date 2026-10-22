-- Prova del controllo salute (docs/supabase_salute.sql). In fondo "permessi salute ok".
\set ON_ERROR_STOP on
do $$
declare x text := repeat('s', 40); y text := repeat('t', 40); j json;
begin
  delete from public.superadmin;
  insert into public.superadmin (token_hash, nota) values (public._hash(x), 'Luca');
  insert into public.salute_controlli (ok, dati) values (true, '{"controlli":[]}'), (false, '{"controlli":[{"id":"push","stato":"ko"}]}');
  -- solo il superamministratore legge
  begin perform public.stato_salute(y); assert false, 'un altro telefono legge la salute';
  exception when others then if sqlerrm not like '%superamministratore%' then raise; end if; end;
  j := public.stato_salute(x, 'https://push.example/1');
  assert json_array_length(j->'controlli') = 2 and not (j->'controlli'->0->>'ok')::boolean, 'il più recente per primo: ' || j::text;
  assert not (j->>'avvisi')::boolean, 'avvisi spenti';
  -- avvisi: serve l'iscrizione push
  begin perform public.salute_avvisi_imposta(x, 'https://push.example/1', true); assert false, 'avvisi senza iscrizione';
  exception when others then if sqlerrm not like '%notifiche%' then raise; end if; end;
  perform public.salva_iscrizione('https://push.example/1', 'k', 'a', '{}');
  perform public.salute_avvisi_imposta(x, 'https://push.example/1', true);
  perform public.salute_avvisi_imposta(x, 'https://push.example/1', true); -- ripetibile
  assert (public.stato_salute(x, 'https://push.example/1')->>'avvisi')::boolean, 'avvisi accesi';
  begin perform public.salute_avvisi_imposta(y, 'https://push.example/1', false); assert false, 'un altro telefono spegne';
  exception when others then if sqlerrm not like '%superamministratore%' then raise; end if; end;
  perform public.salute_avvisi_imposta(x, 'https://push.example/1', false);
  assert (public.stato_salute(x)->>'telefoni')::int = 0, 'avvisi spenti';
  delete from public.salute_controlli; delete from public.superadmin; perform public.cancella_iscrizione('https://push.example/1');
  raise notice 'ok';
end $$;

set role anon;
do $$ begin
  begin perform 1 from public.salute_controlli; assert false, 'anon legge i controlli'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.salute_avvisi; assert false, 'anon legge gli avvisi'; exception when insufficient_privilege then null; end;
  raise notice 'permessi salute ok';
end $$;
