-- RaceBuddy – nomi dei membri sempre in maiuscolo (novembre 2026).
-- Ripetibile. Va dopo docs/supabase_gruppo.sql (e dopo gli altri file che toccano membri: l'ordine non conta, è un trigger).
--
-- Perché: nelle classifiche "Mario Rossi", "mario rossi" e "MARIO ROSSI" sembravano persone diverse e l'ordine
-- alfabetico era mischiato. Il trigger vale per ogni funzione che scrive il nome (crea_gruppo, entra_gruppo,
-- aggiorna_profilo, super_vai, unioni…), anche quelle future: nessuna va ritoccata.
-- L'app fa lo stesso sul telefono (L.nomePersona in app/logic.js).

create or replace function public._nome_maiuscolo() returns trigger
language plpgsql as $$
begin
  new.nome := upper(regexp_replace(trim(new.nome), '\s+', ' ', 'g'));
  return new;
end $$;

drop trigger if exists nome_maiuscolo on public.membri;
create trigger nome_maiuscolo before insert or update of nome on public.membri
  for each row execute function public._nome_maiuscolo();

-- I nomi già salvati
update public.membri set nome = nome where nome is distinct from upper(regexp_replace(trim(nome), '\s+', ' ', 'g'));
