-- ShutterPaid phase 3: Free and Pro plans, Stripe billing, limits enforced in the database.
--   Free: up to 5 active (unpaid) invoices, manual reminders, cloud sync.
--   Pro:  unlimited invoices and automatic reminders. 14-day free trial, once per account.

-- ---------- Plan on the profile (written only by the stripe-webhook function) ----------
alter table public.profiles
  add column plan text not null default 'free' check (plan in ('free', 'pro')),
  -- Stripe subscription status: trialing, active, past_due, canceled, unpaid, incomplete, ...
  add column plan_status text not null default '',
  add column plan_interval text not null default '' check (plan_interval in ('', 'month', 'year')),
  add column current_period_end timestamptz,
  add column trial_ends_at timestamptz,
  add column cancel_at_period_end boolean not null default false,
  add column trial_used boolean not null default false,
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text;

-- Browsers can read their own plan (select is already granted) but can't change it: phase 1 only
-- granted insert/update on the settings columns, so these new columns are server-only.

-- Pro if the plan says so and the paid period hasn't long passed. The grace window covers Stripe's
-- retries; the date check stops a missed cancellation webhook from granting Pro forever.
create or replace function public.is_pro(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select p.plan = 'pro' and (p.current_period_end is null or p.current_period_end > now() - interval '3 days')
    from public.profiles p where p.id = p_user
  ), false);
$$;

revoke all on function public.is_pro(uuid) from public, anon;
grant execute on function public.is_pro(uuid) to authenticated, service_role;

-- ---------- Limits ----------
-- Errors use fixed messages the app recognises: FREE_PLAN_LIMIT and PRO_REQUIRED.
create or replace function public.enforce_plan_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active integer;
  v_becomes_active boolean;
  v_turns_on_auto boolean;
begin
  v_becomes_active := not new.paid and (tg_op = 'INSERT' or old.paid);
  v_turns_on_auto := new.auto_remind and (tg_op = 'INSERT' or not old.auto_remind);
  if not (v_becomes_active or v_turns_on_auto) then
    return new; -- edits that don't add an active invoice or switch auto-reminders on are always fine
  end if;
  if public.is_pro(new.user_id) then
    return new;
  end if;

  if v_turns_on_auto then
    raise exception 'PRO_REQUIRED' using hint = 'Automatic reminders are part of ShutterPaid Pro.';
  end if;

  -- Serialise this user's writes so two devices can't both add the 5th invoice at once.
  perform pg_advisory_xact_lock(hashtext('shutterpaid-invoices:' || new.user_id::text));
  select count(*) into v_active
  from public.invoices
  where user_id = new.user_id and not paid and id <> new.id;
  if v_active >= 5 then
    raise exception 'FREE_PLAN_LIMIT' using hint = 'The Free plan includes 5 active invoices.';
  end if;
  return new;
end;
$$;

create trigger invoices_plan_limits
  before insert or update of paid, auto_remind on public.invoices
  for each row execute function public.enforce_plan_limits();

-- ---------- Automatic reminders are Pro-only ----------
-- Same function as phase 2 with one extra check: the account must be Pro when the email goes out
-- (so a lapsed subscription stops reminders even if auto_remind is still on).
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
  if not public.is_pro(v_inv.user_id) then
    return null;
  end if;

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

revoke all on function public.claim_auto_reminder(uuid, date, integer, text, date, text) from public, anon, authenticated;
grant execute on function public.claim_auto_reminder(uuid, date, integer, text, date, text) to service_role;
