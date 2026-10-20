-- Superamministratore (per i test di Luca): amministratore in qualunque gruppo e può spostarsi in un gruppo qualsiasi
-- senza invito. Un telefono sta sempre in un solo gruppo: spostandosi esce da quello di prima (come "Esci dal gruppo",
-- senza il controllo sull'ultimo amministratore) ed entra nel nuovo come amministratore. Ripetibile.
-- Il telefono si nomina dal workflow "Amministratore del gruppo (assistenza)": online solo l'impronta del codice.
begin;

create table if not exists public.superadmin (
  token_hash text primary key,
  nota text,
  creato timestamptz not null default now()
);
alter table public.superadmin enable row level security;
revoke all on public.superadmin from public, anon, authenticated;

create or replace function public._super(p_token text) returns boolean
language sql security definer set search_path = '' as $$
  select p_token is not null and char_length(p_token) >= 32 and exists (select 1 from public.superadmin s where s.token_hash = public._hash(p_token));
$$;

-- Tutti i gruppi, con quanti sono e se le classifiche sono accese
create or replace function public.super_gruppi(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  if not public._super(p_token) then raise exception 'solo per il superamministratore'; end if;
  return (select coalesce(json_agg(json_build_object('id', g.id, 'nome', g.nome, 'classifiche', coalesce(g.classifiche, false),
      'membri', (select count(*) from public.membri m where m.gruppo_id = g.id),
      'partecipanti', (select count(*) from public.membri m where m.gruppo_id = g.id and m.partecipa),
      'qui', exists (select 1 from public.membri m where m.gruppo_id = g.id and m.token_hash = public._hash(p_token))) order by lower(g.nome)), '[]')
    from public.gruppi g);
end $$;

-- Spostarsi in un gruppo come amministratore
create or replace function public.super_vai(p_token text, p_gruppo uuid, p_nome text) returns json
language plpgsql security definer set search_path = '' as $$
declare h text := public._hash(p_token); vecchi uuid[]; m public.membri;
begin
  if not public._super(p_token) then raise exception 'solo per il superamministratore'; end if;
  if not exists (select 1 from public.gruppi where id = p_gruppo) then raise exception 'gruppo non trovato'; end if;
  if char_length(trim(coalesce(p_nome, ''))) < 2 then raise exception 'nome non valido'; end if;
  select array_agg(gruppo_id) into vecchi from public.membri where token_hash = h and gruppo_id <> p_gruppo;
  delete from public.membri where token_hash = h and gruppo_id <> p_gruppo;
  delete from public.gruppi g where g.id = any(coalesce(vecchi, '{}')) and not exists (select 1 from public.membri x where x.gruppo_id = g.id);
  insert into public.membri (gruppo_id, token_hash, nome, ruolo, mostra_gare) values (p_gruppo, h, left(trim(p_nome), 40), 'admin', true)
  on conflict (gruppo_id, token_hash) do update set ruolo = 'admin'
  returning * into m;
  return json_build_object('gruppo', p_gruppo, 'membro', m.id);
end $$;

revoke all on function public._super(text) from public, anon, authenticated;
revoke all on function public.super_gruppi(text), public.super_vai(text, uuid, text) from public;
grant execute on function public.super_gruppi(text), public.super_vai(text, uuid, text) to anon;

commit;
