-- ShutterPaid phase 2: automatic reminders.

-- ---------- profiles: default schedule and sending preferences ----------
alter table public.profiles
  add column reminder_schedule jsonb not null default
    '[{"offset":-3,"tone":"friendly"},{"offset":0,"tone":"friendly"},{"offset":7,"tone":"firm"},{"offset":21,"tone":"final"}]'::jsonb
    check (jsonb_typeof(reminder_schedule) = 'array' and jsonb_array_length(reminder_schedule) <= 8),
  -- Local hour (0-23, in time_zone) after which the day's reminders go out.
  add column send_hour integer not null default 9 check (send_hour between 0 and 23),
  -- Where client replies go. Empty means the account email.
  add column reply_to text not null default '' check (char_length(reply_to) <= 320);

grant insert (reminder_schedule, send_hour, reply_to) on public.profiles to authenticated;
grant update (reminder_schedule, send_hour, reply_to) on public.profiles to authenticated;

-- ---------- invoices: per-invoice switch and optional custom schedule ----------
alter table public.invoices
  add column auto_remind boolean not null default false,
  -- null means "use my default schedule from Settings".
  add column reminder_schedule jsonb
    check (reminder_schedule is null or (jsonb_typeof(reminder_schedule) = 'array' and jsonb_array_length(reminder_schedule) <= 8)),
  -- Set when the client clicks "Stop reminders". Only the server writes it.
  add column reminders_stopped_at timestamptz,
  -- Secret used in the client's stop link. Only the server reads it.
  add column unsubscribe_token uuid not null default gen_random_uuid();

create unique index invoices_unsubscribe_token_idx on public.invoices (unsubscribe_token);
create index invoices_auto_idx on public.invoices (user_id) where auto_remind and not paid and reminders_stopped_at is null;

-- Photographers can edit everything except the two server-managed columns. Column-level grants
-- replace the table-level ones from phase 1. The token is also hidden from the browser, so the
-- only way to stop reminders with it is the link in the client's email.
revoke select, insert, update on public.invoices from authenticated;
grant select (id, user_id, client_name, client_email, shoot_type, number, amount, currency, shoot_date, due_date,
              notes, paid, paid_date, created_at, updated_at, auto_remind, reminder_schedule, reminders_stopped_at)
  on public.invoices to authenticated;
grant insert (id, user_id, client_name, client_email, shoot_type, number, amount, currency, shoot_date, due_date,
              notes, paid, paid_date, auto_remind, reminder_schedule)
  on public.invoices to authenticated;
grant update (id, user_id, client_name, client_email, shoot_type, number, amount, currency, shoot_date, due_date,
              notes, paid, paid_date, auto_remind, reminder_schedule)
  on public.invoices to authenticated;

-- ---------- reminder_log: delivery details for automatic sends ----------
alter table public.reminder_log
  add column status text not null default 'sent' check (status in ('sending', 'sent', 'failed')),
  -- For automatic sends: which schedule step this was (date it was due to go out + offset).
  add column scheduled_for date,
  add column step_offset integer,
  add column to_email text not null default '',
  add column provider_id text,
  add column error text,
  add column attempts integer not null default 0;

-- The idempotency guarantee: one row, and so at most one email, per invoice per schedule step.
create unique index reminder_log_auto_step_idx
  on public.reminder_log (invoice_id, scheduled_for, step_offset)
  where channel = 'auto';

-- The browser may log manual reminders only. Automatic rows are written by the server.
drop policy "reminder_log: insert own" on public.reminder_log;
create policy "reminder_log: insert own" on public.reminder_log
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and channel <> 'auto'
    and exists (select 1 from public.invoices i where i.id = invoice_id and i.user_id = (select auth.uid()))
  );
drop policy "reminder_log: update own" on public.reminder_log;
create policy "reminder_log: update own" on public.reminder_log
  for update to authenticated using (user_id = (select auth.uid()) and channel <> 'auto') with check (
    user_id = (select auth.uid())
    and channel <> 'auto'
    and exists (select 1 from public.invoices i where i.id = invoice_id and i.user_id = (select auth.uid()))
  );

-- ---------- Claiming a send ----------
-- Called by the send-reminders Edge Function before it emails anyone. In one transaction it
-- re-checks the invoice (still unpaid, auto on, not stopped) and creates or takes over the log row
-- for this step. It returns the row id to use as Resend's idempotency key, or null if the email
-- must not be sent: already sent, another run is sending it right now, or it failed 3 times.
-- A row stuck in 'sending' for 15 minutes (the function crashed mid-send) can be retried; Resend's
-- idempotency key makes that retry a no-op if the first attempt actually went out.
create or replace function public.claim_auto_reminder(
  p_invoice_id uuid,
  p_scheduled_for date,
  p_step_offset integer,
  p_tone text,
  p_local_date date,
  p_to_email text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invoices%rowtype;
  v_row public.reminder_log%rowtype;
begin
  select * into v_inv from public.invoices where id = p_invoice_id for update;
  if not found or v_inv.paid or not v_inv.auto_remind or v_inv.reminders_stopped_at is not null then
    return null;
  end if;

  -- Never more than one automatic email per invoice per day, whatever the schedule says.
  if exists (
    select 1 from public.reminder_log
    where invoice_id = p_invoice_id and channel = 'auto' and sent_on = p_local_date
      and not (scheduled_for = p_scheduled_for and step_offset = p_step_offset)
  ) then
    return null;
  end if;

  insert into public.reminder_log (user_id, invoice_id, sent_on, tone, channel, status, scheduled_for, step_offset, to_email, attempts)
  values (v_inv.user_id, p_invoice_id, p_local_date, p_tone, 'auto', 'sending', p_scheduled_for, p_step_offset, p_to_email, 1)
  on conflict (invoice_id, scheduled_for, step_offset) where channel = 'auto' do nothing
  returning * into v_row;
  if found then
    return v_row.id;
  end if;

  select * into v_row from public.reminder_log
  where invoice_id = p_invoice_id and channel = 'auto' and scheduled_for = p_scheduled_for and step_offset = p_step_offset
  for update;
  if (v_row.status = 'failed' and v_row.attempts < 3)
     or (v_row.status = 'sending' and v_row.sent_at < now() - interval '15 minutes' and v_row.attempts < 3) then
    update public.reminder_log
      set status = 'sending', attempts = attempts + 1, sent_at = now(), sent_on = p_local_date, error = null
      where id = v_row.id;
    return v_row.id;
  end if;
  return null;
end;
$$;

-- Only the service role (Edge Functions) may claim sends.
revoke all on function public.claim_auto_reminder(uuid, date, integer, text, date, text) from public, anon, authenticated;
grant execute on function public.claim_auto_reminder(uuid, date, integer, text, date, text) to service_role;

-- ---------- Stopping reminders from the client's email ----------
-- Returns the business name for the confirmation page, or null if the token is unknown.
create or replace function public.stop_reminders(p_token uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_business text;
begin
  update public.invoices i
    set reminders_stopped_at = coalesce(i.reminders_stopped_at, now())
    where i.unsubscribe_token = p_token
    returning (select coalesce(nullif(p.business_name, ''), nullif(p.owner_name, ''), 'your photographer')
               from public.profiles p where p.id = i.user_id)
    into v_business;
  return v_business;
end;
$$;

revoke all on function public.stop_reminders(uuid) from public, anon, authenticated;
grant execute on function public.stop_reminders(uuid) to service_role;
