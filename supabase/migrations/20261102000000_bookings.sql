-- ShutterPaid bookings, phase 2: bookings, payments, double-booking protection, and invoices for
-- confirmed bookings. Customers never query these tables directly: public access (slots, booking,
-- managing a booking) goes through Edge Functions using the service role.

create extension if not exists btree_gist;

-- ---------- bookings ----------
create table public.bookings (
  id               uuid primary key default gen_random_uuid(),
  photographer_id  uuid not null references auth.users (id) on delete cascade,
  event_type_id    uuid references public.event_types (id) on delete set null,
  -- Snapshot of the event type at booking time, so later edits don't change existing bookings.
  event_name       text not null check (char_length(event_name) between 1 and 80),
  price            numeric(12, 2) not null default 0 check (price >= 0),
  currency         text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  buffer_before    integer not null default 0 check (buffer_before between 0 and 480),
  buffer_after     integer not null default 0 check (buffer_after between 0 and 480),
  -- Customer
  customer_name    text not null check (char_length(customer_name) between 1 and 120),
  customer_email   text not null check (char_length(customer_email) between 3 and 320),
  customer_phone   text not null default '' check (char_length(customer_phone) <= 40),
  customer_time_zone text not null default '' check (char_length(customer_time_zone) <= 64),
  event_address    text not null default '' check (char_length(event_address) <= 500),
  notes            text not null default '' check (char_length(notes) <= 2000),
  -- When (UTC). block_start/block_end add the buffers and are what can't overlap (set by trigger).
  start_at         timestamptz not null,
  end_at           timestamptz not null,
  block_start      timestamptz not null,
  block_end        timestamptz not null,
  status           text not null default 'confirmed'
                   check (status in ('pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show')),
  -- What the customer chose at checkout: pay an advance now, or nothing now.
  deposit_choice   text not null default 'none' check (deposit_choice in ('none', 'paid')),
  -- Advance amount computed on the server from the event type (never from the browser).
  deposit_amount   numeric(12, 2) not null default 0 check (deposit_amount >= 0),
  -- While in Stripe Checkout the slot is held until this time; a scheduled job releases it.
  expires_at       timestamptz,
  -- Secret for the customer's "manage my booking" link. Never readable from the photographer's browser.
  manage_token     uuid not null default gen_random_uuid(),
  source           text not null default 'online' check (source in ('online', 'manual')),
  cancelled_at     timestamptz,
  cancel_reason    text not null default '' check (char_length(cancel_reason) <= 500),
  invoice_id       uuid references public.invoices (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (end_at > start_at),
  check (status <> 'pending_payment' or expires_at is not null),
  -- No two active bookings of the same photographer may overlap, buffers included. The database
  -- enforces this, so two customers racing for the same slot can't both win.
  constraint bookings_no_overlap exclude using gist (
    photographer_id with =,
    tstzrange(block_start, block_end, '[)') with &&
  ) where (status in ('pending_payment', 'confirmed'))
);

create unique index bookings_manage_token_idx on public.bookings (manage_token);
create index bookings_photographer_start_idx on public.bookings (photographer_id, start_at);
create index bookings_expiring_idx on public.bookings (expires_at) where status = 'pending_payment';

create or replace function public.bookings_set_block()
returns trigger
language plpgsql
as $$
begin
  new.block_start := new.start_at - make_interval(mins => new.buffer_before);
  new.block_end := new.end_at + make_interval(mins => new.buffer_after);
  new.updated_at := now();
  return new;
end;
$$;

create trigger bookings_set_block
  before insert or update on public.bookings
  for each row execute function public.bookings_set_block();

-- ---------- payments (advances) ----------
create table public.payments (
  id                         uuid primary key default gen_random_uuid(),
  booking_id                 uuid not null references public.bookings (id) on delete cascade,
  photographer_id            uuid not null references auth.users (id) on delete cascade,
  amount                     numeric(12, 2) not null check (amount > 0),
  currency                   text not null check (currency ~ '^[A-Z]{3}$'),
  status                     text not null default 'pending'
                             check (status in ('pending', 'paid', 'partially_refunded', 'refunded', 'failed', 'expired')),
  amount_refunded            numeric(12, 2) not null default 0 check (amount_refunded >= 0),
  application_fee            numeric(12, 2) not null default 0 check (application_fee >= 0),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id   text unique,
  paid_at                    timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  check (amount_refunded <= amount)
);

create index payments_booking_idx on public.payments (booking_id);

create trigger payments_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- ---------- invoices: link to bookings and record advances ----------
alter table public.invoices
  add column booking_id uuid,
  -- Paid in advance (e.g. a booking deposit). Reminders, PDFs and payment links use the balance.
  add column amount_paid numeric(12, 2) not null default 0 check (amount_paid >= 0);

create unique index invoices_booking_idx on public.invoices (booking_id) where booking_id is not null;

-- Browsers read these but only the server writes them.
grant select (booking_id, amount_paid) on public.invoices to authenticated;

-- ---------- Row Level Security ----------
alter table public.bookings enable row level security;
alter table public.payments enable row level security;

create policy "bookings: own" on public.bookings
  for select to authenticated using (photographer_id = (select auth.uid()));
create policy "bookings: own insert" on public.bookings
  for insert to authenticated with check (photographer_id = (select auth.uid()));
create policy "bookings: own update" on public.bookings
  for update to authenticated using (photographer_id = (select auth.uid())) with check (photographer_id = (select auth.uid()));
create policy "payments: own" on public.payments
  for select to authenticated using (photographer_id = (select auth.uid()));

revoke all on public.bookings, public.payments from anon, authenticated;
-- Photographers can see everything about their bookings except the customer's secret link token,
-- and can change status and details (later phases: confirm, reschedule, cancel, manual bookings).
-- Prices, advances, holds and invoice links are written by the server only.
grant select (id, photographer_id, event_type_id, event_name, price, currency, buffer_before, buffer_after,
              customer_name, customer_email, customer_phone, customer_time_zone, event_address, notes,
              start_at, end_at, block_start, block_end, status, deposit_choice, deposit_amount, expires_at,
              source, cancelled_at, cancel_reason, invoice_id, created_at, updated_at)
  on public.bookings to authenticated;
grant insert (id, photographer_id, event_type_id, event_name, price, currency, buffer_before, buffer_after,
              customer_name, customer_email, customer_phone, customer_time_zone, event_address, notes,
              start_at, end_at, status, source)
  on public.bookings to authenticated;
grant update (customer_name, customer_email, customer_phone, event_address, notes, start_at, end_at,
              status, cancelled_at, cancel_reason)
  on public.bookings to authenticated;
grant select on public.payments to authenticated;

-- A photographer's own manual bookings can't be "pending payment" (that's only for online checkout).
create policy "bookings: no manual holds" on public.bookings
  as restrictive for insert to authenticated with check (status <> 'pending_payment');

-- ---------- Confirmed bookings become invoices ----------
-- Creates the booking's invoice once it's confirmed, and keeps "paid in advance" in step with the
-- booking's paid advances. Never blocks the booking: if the invoice can't be created (for example
-- the Free plan's active-invoice limit), the booking stays confirmed without one and the
-- photographer can create it later from the app.
create or replace function public.sync_booking_invoice(p_booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_tz text;
  v_day date;
  v_paid numeric(12, 2);
  v_invoice uuid;
begin
  select * into b from public.bookings where id = p_booking_id;
  if not found or b.status not in ('confirmed', 'completed') then
    return null;
  end if;
  -- Signed-in users may only sync their own bookings (server calls have no user id).
  if auth.uid() is not null and b.photographer_id <> auth.uid() then
    return null;
  end if;

  select coalesce(sum(amount - amount_refunded), 0) into v_paid
  from public.payments where booking_id = b.id and status in ('paid', 'partially_refunded');
  v_paid := least(v_paid, b.price);

  if b.invoice_id is not null then
    update public.invoices set amount_paid = v_paid where id = b.invoice_id and amount_paid is distinct from v_paid;
    return b.invoice_id;
  end if;

  select coalesce(nullif(time_zone, ''), 'UTC') into v_tz from public.booking_profiles where user_id = b.photographer_id;
  v_day := (b.start_at at time zone coalesce(v_tz, 'UTC'))::date;

  begin
    insert into public.invoices (user_id, client_name, client_email, shoot_type, number, amount, currency,
                                 shoot_date, due_date, notes, booking_id, amount_paid)
    values (b.photographer_id, left(b.customer_name, 200), left(b.customer_email, 320), left(b.event_name, 60),
            'BK-' || upper(substr(replace(b.id::text, '-', ''), 1, 6)), b.price, b.currency,
            v_day, v_day, 'Booked online.', b.id, v_paid)
    on conflict (booking_id) where booking_id is not null do nothing
    returning id into v_invoice;
  exception when others then
    raise log 'sync_booking_invoice: no invoice for booking %: %', b.id, sqlerrm;
    return null;
  end;

  if v_invoice is null then
    select id into v_invoice from public.invoices where booking_id = b.id;
  end if;
  update public.bookings set invoice_id = v_invoice where id = b.id and invoice_id is null;
  return v_invoice;
end;
$$;

revoke all on function public.sync_booking_invoice(uuid) from public, anon;
grant execute on function public.sync_booking_invoice(uuid) to authenticated, service_role;

create or replace function public.bookings_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('confirmed', 'completed') and (tg_op = 'INSERT' or old.status is distinct from new.status or new.invoice_id is null) then
    perform public.sync_booking_invoice(new.id);
  end if;
  return null;
end;
$$;

create trigger bookings_after_change
  after insert or update of status on public.bookings
  for each row execute function public.bookings_after_change();

create or replace function public.payments_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_booking_invoice(new.booking_id);
  return null;
end;
$$;

create trigger payments_after_change
  after insert or update of status, amount_refunded on public.payments
  for each row execute function public.payments_after_change();

-- ---------- Releasing expired holds ----------
-- Online bookings waiting for Stripe Checkout hold their slot for 10 minutes. This frees the ones
-- whose time ran out (the Stripe webhook also releases them when Checkout expires).
create or replace function public.release_expired_holds()
returns integer
language sql
security definer
set search_path = ''
as $$
  with released as (
    update public.bookings
      set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Payment not completed in time'
      where status = 'pending_payment' and expires_at < now()
      returning id
  ), payments as (
    update public.payments set status = 'expired'
      where status = 'pending' and booking_id in (select id from released)
  )
  select count(*)::integer from released;
$$;

revoke all on function public.release_expired_holds() from public, anon, authenticated;
grant execute on function public.release_expired_holds() to service_role;
