-- Run the send-reminders Edge Function every hour.
-- Each photographer's reminders still go out once a day: the function only sends for accounts
-- where it is past their send hour in their own time zone, and every step can be sent only once.
-- Running hourly is what lets 9am mean 9am in London, Mumbai and Los Angeles alike.
--
-- Before this works, store two values in Supabase Vault (SQL Editor, once per project):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<same value as the CRON_SECRET function secret>', 'cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'send-reminders-hourly',
  '7 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
