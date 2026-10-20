-- Prova del superamministratore (docs/supabase_superadmin.sql). In fondo "permessi superadmin ok".
\set ON_ERROR_STOP on
do $$
declare a text := repeat('s', 40); b text := repeat('t', 40); x text := repeat('u', 40); j json; g1 uuid; g2 uuid;
begin
  j := public.crea_gruppo(a, 'Gruppo Uno', 'Anna'); g1 := (j->>'gruppo')::uuid;
  j := public.crea_gruppo(b, 'Gruppo Due', 'Bruno'); g2 := (j->>'gruppo')::uuid;
  perform public.entra_gruppo(x, (select codice from public.gruppi where id = g1), 'Luca', true);
  -- non ancora superamministratore
  begin perform public.super_gruppi(x); assert false, 'super senza permesso';
  exception when others then if sqlerrm not like '%superamministratore%' then raise; end if; end;
  insert into public.superadmin (token_hash, nota) values (public._hash(x), 'Luca');
  j := public.super_gruppi(x);
  assert json_array_length(j) = 2, 'vede tutti i gruppi';
  assert (select (e->>'qui')::boolean from json_array_elements(j) e where e->>'nome' = 'Gruppo Uno'), 'sa dove si trova';
  -- si sposta nel gruppo Due come amministratore: esce dal gruppo Uno
  perform public.super_vai(x, g2, 'Luca');
  assert (public.stato_gruppo(x)->'io'->>'ruolo') = 'admin', 'admin nel nuovo gruppo';
  assert (public.stato_gruppo(x)->'gruppo'->>'nome') = 'Gruppo Due', 'nel gruppo Due';
  assert not exists (select 1 from public.membri where gruppo_id = g1 and nome = 'Luca'), 'uscito dal gruppo Uno';
  assert exists (select 1 from public.gruppi where id = g1), 'il gruppo Uno resta con Anna';
  perform public.admin_classifiche(x, true);
  -- ultimo membro di un gruppo: spostandosi il gruppo vuoto sparisce
  perform public.esci_gruppo(b);
  j := public.crea_gruppo(repeat('v', 40), 'Gruppo Tre', 'Carla');
  perform public.super_vai(x, (j->>'gruppo')::uuid, 'Luca');
  assert not exists (select 1 from public.gruppi where id = g2), 'gruppo vuoto cancellato';
  -- chi non è super non si sposta
  begin perform public.super_vai(a, g1, 'Anna'); assert false, 'non super si sposta';
  exception when others then if sqlerrm not like '%superamministratore%' then raise; end if; end;
  perform public.esci_gruppo(x); perform public.esci_gruppo(a); perform public.esci_gruppo(repeat('v', 40));
  delete from public.superadmin;
  raise notice 'ok';
end $$;

set role anon;
do $$ begin
  begin perform 1 from public.superadmin; assert false, 'anon legge superadmin'; exception when insufficient_privilege then null; end;
  begin perform public._super(repeat('a', 40)); assert false, 'anon chiama _super'; exception when insufficient_privilege then null; end;
  raise notice 'permessi superadmin ok';
end $$;
reset role;
