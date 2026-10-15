-- RaceBuddy – innesco affidabile delle notifiche push (ripetibile).
-- Il cron di GitHub Actions salta o ritarda molti giri; qui pg_cron di Supabase, puntuale,
-- lancia ogni mezz'ora il workflow "Notifiche push" con l'API di GitHub (workflow_dispatch).
-- Il token GitHub sta nel Vault di Supabase (segreto "github_dispatch_token"), mai in questo file:
-- lo scrive il workflow "Innesco notifiche (Supabase)" prendendolo dal GitHub Secret DISPATCH_TOKEN.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.racebuddy_lancia_push()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tok text;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1;
  if tok is null or tok = '' then
    raise warning 'racebuddy_lancia_push: manca il segreto github_dispatch_token nel Vault';
    return null;
  end if;
  return net.http_post(
    url := 'https://api.github.com/repos/lucaalbanesi/racebuddy/actions/workflows/push.yml/dispatches',
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
revoke all on function public.racebuddy_lancia_push() from public, anon, authenticated;

-- Stessa fascia del vecchio cron di GitHub: minuti 7 e 37, dalle 3 alle 20 UTC
-- (5:07–22:37 ora legale di Roma, 4:07–21:37 ora solare). Lo script decide poi cosa inviare.
select cron.unschedule(jobid) from cron.job where jobname = 'racebuddy-push';
select cron.schedule('racebuddy-push', '7,37 3-20 * * *', 'select public.racebuddy_lancia_push()');
