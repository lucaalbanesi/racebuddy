-- Bonifica nomi (novembre 2026): rimette in MAIUSCOLO ogni nome dei membri (come il trigger di docs/supabase_nomi.sql)
-- e restituisce il controllo: membri, nomi ancora non maiuscoli, nomi doppi nello stesso gruppo (da unire in Gestione → Profili doppi).
-- Ripetibile.
update public.membri set nome = upper(regexp_replace(trim(nome), '\s+', ' ', 'g'))
 where nome is distinct from upper(regexp_replace(trim(nome), '\s+', ' ', 'g'));
select (select count(*) from public.membri) as membri,
       (select count(*) from public.membri where nome <> upper(nome)) as non_maiuscoli,
       (select coalesce(json_agg(json_build_object('gruppo', g.nome, 'nome', d.nome, 'profili', d.n)), '[]'::json)
          from (select gruppo_id, min(nome) as nome, count(*) as n from public.membri
                 group by gruppo_id, public._norm_nome(nome) having count(*) > 1) d
          join public.gruppi g on g.id = d.gruppo_id) as doppi;
