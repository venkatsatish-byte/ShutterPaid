-- ShutterPaid bookings, phase 3: public booking page support.
-- - Customer change rules on the booking profile (cancel / reschedule, and how late).
-- - create_booking() and reschedule_booking(): the only way bookings are written for customers
--   (called by Edge Functions with the service role). They serialise per photographer so the
--   "max bookings per day" limit can't be exceeded by simultaneous requests; overlaps are still
--   stopped by the bookings_no_overlap constraint.
-- - Invoices follow cancellations and reschedules.

-- ---------- Customer change rules ----------
alter table public.booking_profiles
  add column allow_customer_cancel     boolean not null default true,
  add column allow_customer_reschedule boolean not null default true,
  -- Customers can cancel or reschedule online until this many hours before the start.
  add column change_cutoff_hours       integer not null default 24 check (change_cutoff_hours between 0 and 720);

-- ---------- Creating a booking ----------
-- p_row: the booking's columns as JSON (prices and advances already computed by the server).
-- p_day_start/p_day_end: the photographer's calendar day of the booking, in UTC, for the daily limit.
-- Raises SLOT_TAKEN or DAY_FULL; returns the new id and manage token.
create or replace function public.create_booking(p_row jsonb, p_day_start timestamptz, p_day_end timestamptz, p_max_per_day integer)
returns table (id uuid, manage_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photographer uuid := (p_row->>'photographer_id')::uuid;
begin
  perform pg_advisory_xact_lock(hashtext('shutterpaid-bookings:' || v_photographer::text));
  perform public.release_expired_holds();

  if p_max_per_day is not null and (
    select count(*) from public.bookings b
    where b.photographer_id = v_photographer and b.status in ('pending_payment', 'confirmed')
      and b.start_at >= p_day_start and b.start_at < p_day_end
  ) >= p_max_per_day then
    raise exception 'DAY_FULL';
  end if;

  begin
    return query
    insert into public.bookings (photographer_id, event_type_id, event_name, price, currency, buffer_before, buffer_after,
                                 customer_name, customer_email, customer_phone, customer_time_zone, event_address, notes,
                                 start_at, end_at, status, deposit_choice, deposit_amount, expires_at, source)
    values (v_photographer, (p_row->>'event_type_id')::uuid, p_row->>'event_name', (p_row->>'price')::numeric,
            p_row->>'currency', (p_row->>'buffer_before')::int, (p_row->>'buffer_after')::int,
            p_row->>'customer_name', p_row->>'customer_email', coalesce(p_row->>'customer_phone', ''),
            coalesce(p_row->>'customer_time_zone', ''), coalesce(p_row->>'event_address', ''), coalesce(p_row->>'notes', ''),
            (p_row->>'start_at')::timestamptz, (p_row->>'end_at')::timestamptz, p_row->>'status',
            coalesce(p_row->>'deposit_choice', 'none'), coalesce((p_row->>'deposit_amount')::numeric, 0),
            (p_row->>'expires_at')::timestamptz, 'online')
    returning public.bookings.id, public.bookings.manage_token;
  exception when exclusion_violation then
    raise exception 'SLOT_TAKEN';
  end;
end;
$$;

revoke all on function public.create_booking(jsonb, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.create_booking(jsonb, timestamptz, timestamptz, integer) to service_role;

-- ---------- Rescheduling ----------
create or replace function public.reschedule_booking(p_id uuid, p_start timestamptz, p_end timestamptz,
                                                     p_day_start timestamptz, p_day_end timestamptz, p_max_per_day integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photographer uuid;
begin
  select photographer_id into v_photographer from public.bookings where id = p_id;
  if v_photographer is null then
    raise exception 'NOT_FOUND';
  end if;
  perform pg_advisory_xact_lock(hashtext('shutterpaid-bookings:' || v_photographer::text));
  perform public.release_expired_holds();

  if p_max_per_day is not null and (
    select count(*) from public.bookings b
    where b.photographer_id = v_photographer and b.id <> p_id and b.status in ('pending_payment', 'confirmed')
      and b.start_at >= p_day_start and b.start_at < p_day_end
  ) >= p_max_per_day then
    raise exception 'DAY_FULL';
  end if;

  begin
    update public.bookings set start_at = p_start, end_at = p_end where id = p_id and status = 'confirmed';
    if not found then
      raise exception 'NOT_CHANGEABLE';
    end if;
  exception when exclusion_violation then
    raise exception 'SLOT_TAKEN';
  end;
end;
$$;

revoke all on function public.reschedule_booking(uuid, timestamptz, timestamptz, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.reschedule_booking(uuid, timestamptz, timestamptz, timestamptz, timestamptz, integer) to service_role;

-- ---------- Invoices follow the booking ----------
-- Confirmed/completed: create the invoice once, keep "paid in advance" and the dates current.
-- Cancelled: remove the invoice if nothing was paid; if an advance was kept, the invoice becomes
-- a paid invoice for that advance (a later refund brings it back to nothing and removes it).
-- Never blocks the booking.
create or replace function public.sync_booking_invoice(p_booking_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  inv public.invoices%rowtype;
  v_tz text;
  v_day date;
  v_paid numeric(12, 2);
  v_invoice uuid;
begin
  select * into b from public.bookings where id = p_booking_id;
  if not found then
    return null;
  end if;
  -- Signed-in users may only sync their own bookings (server calls have no user id).
  if auth.uid() is not null and b.photographer_id <> auth.uid() then
    return null;
  end if;

  select coalesce(sum(amount - amount_refunded), 0) into v_paid
  from public.payments where booking_id = b.id and status in ('paid', 'partially_refunded');
  v_paid := least(v_paid, b.price);
  select coalesce(nullif(time_zone, ''), 'UTC') into v_tz from public.booking_profiles where user_id = b.photographer_id;
  v_day := (b.start_at at time zone coalesce(v_tz, 'UTC'))::date;
  if b.invoice_id is not null then
    select * into inv from public.invoices where id = b.invoice_id;
  end if;

  if b.status = 'cancelled' then
    if inv.id is null or inv.paid and coalesce(inv.notes, '') not like '%Booking cancelled%' then
      return inv.id;
    end if;
    if v_paid = 0 then
      delete from public.invoices where id = inv.id;
      return null;
    end if;
    update public.invoices
      set amount = v_paid, amount_paid = v_paid, paid = true, paid_date = coalesce(paid_date, (now() at time zone coalesce(v_tz, 'UTC'))::date),
          notes = case when notes like '%Booking cancelled%' then notes else trim(notes || E'\nBooking cancelled; advance kept.') end
      where id = inv.id;
    return inv.id;
  end if;

  if b.status not in ('confirmed', 'completed') then
    return inv.id;
  end if;

  if inv.id is not null then
    update public.invoices
      set amount_paid = v_paid,
          shoot_date = case when paid then shoot_date else v_day end,
          due_date = case when paid then due_date else v_day end
      where id = inv.id
        and (amount_paid is distinct from v_paid or (not paid and (shoot_date is distinct from v_day or due_date is distinct from v_day)));
    return inv.id;
  end if;

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

-- Run it on reschedules too, not only status changes.
drop trigger bookings_after_change on public.bookings;

create or replace function public.bookings_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status or old.start_at is distinct from new.start_at then
    perform public.sync_booking_invoice(new.id);
  end if;
  return null;
end;
$$;

create trigger bookings_after_change
  after insert or update of status, start_at on public.bookings
  for each row execute function public.bookings_after_change();
