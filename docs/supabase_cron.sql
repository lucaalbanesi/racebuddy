-- RaceBuddy – innesco puntuale di tutti i job programmati (ripetibile).
-- Il cron di GitHub Actions salta o ritarda molti giri; qui pg_cron di Supabase, puntuale,
-- lancia i workflow con l'API di GitHub (workflow_dispatch). Orari in UTC (Roma = UTC+2 legale, +1 solare).
-- Il token GitHub sta nel Vault di Supabase (segreto "github_dispatch_token"), mai in questo file:
-- lo scrive il workflow "Innesco job (Supabase)" prendendolo dal GitHub Secret DISPATCH_TOKEN.

create extension if not exists pg_cron;
create extension if not exists pg_net;

drop function if exists public.racebuddy_lancia_push();

create or replace function public.racebuddy_lancia(p_workflow text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tok text;
begin
  if p_workflow !~ '^[a-z0-9_-]+\.yml$' then
    raise exception 'racebuddy_lancia: nome di workflow non valido: %', p_workflow;
  end if;
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1;
  if tok is null or tok = '' then
    raise warning 'racebuddy_lancia: manca il segreto github_dispatch_token nel Vault';
    return null;
  end if;
  return net.http_post(
    url := 'https://api.github.com/repos/lucaalbanesi/racebuddy/actions/workflows/' || p_workflow || '/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'racebuddy-pg-cron',
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 10000
  );
end;
$$;

-- Nessuno dall'app può chiamarla: solo il cron (gira come postgres).
revoke all on function public.racebuddy_lancia(text) from public, anon, authenticated;

-- Calendario dei job (stessi orari dei vecchi cron di GitHub). Si ricrea tutto da zero a ogni esecuzione.
select cron.unschedule(jobid) from cron.job where jobname like 'racebuddy-%';
-- Gare seguite (export notturno): deve finire prima delle schede gara di Claude (5:53 ora di Roma).
select cron.schedule('racebuddy-seguite',    '23 3 * * *',       $$select public.racebuddy_lancia('seguite.yml')$$);
-- Novità ufficiali delle gare: ogni ora, qualche minuto prima del giro delle notifiche.
select cron.schedule('racebuddy-novita',     '50 3-19 * * *',    $$select public.racebuddy_lancia('novita.yml')$$);
-- Notifiche push: ogni mezz'ora (mattino mezz'ora prima dell'uscita, vigilia alle 19, mattina di gara).
select cron.schedule('racebuddy-push',       '7,37 3-20 * * *',  $$select public.racebuddy_lancia('push.yml')$$);
-- Contenuti (feed): due volte al giorno.
select cron.schedule('racebuddy-contenuti',  '41 4,15 * * *',    $$select public.racebuddy_lancia('contenuti.yml')$$);
-- Calendario gare FIDAL: ogni lunedì.
select cron.schedule('racebuddy-calendario', '17 4 * * 1',       $$select public.racebuddy_lancia('calendario.yml')$$);
