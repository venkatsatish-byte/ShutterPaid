-- ShutterPaid bookings, phase 1: the photographer's booking setup.
-- booking_profiles (public booking page + rules), event_types, availability_rules (weekly hours),
-- blocked_dates. Photographers read and write only their own rows. Customers never query these
-- tables directly: the public booking page reads them through Edge Functions (phase 2).
-- Bookings and payments come in the next migration.

-- ---------- booking_profiles: one per photographer ----------
create table public.booking_profiles (
  user_id             uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  -- Public address: /book/<slug>. Lowercase letters, digits and single hyphens.
  slug                text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 40),
  display_name        text not null default '' check (char_length(display_name) <= 80),
  photo_url           text not null default '' check (char_length(photo_url) <= 1000),
  bio                 text not null default '' check (char_length(bio) <= 600),
  time_zone           text not null default 'UTC' check (char_length(time_zone) between 1 and 64),
  accepting           boolean not null default false,
  -- Booking window
  min_notice_minutes  integer not null default 1440 check (min_notice_minutes between 0 and 43200),
  max_days_ahead      integer not null default 90 check (max_days_ahead between 1 and 730),
  max_per_day         integer check (max_per_day is null or max_per_day between 1 and 50),
  -- Default cancellation/refund policy; an event type can override it.
  cancellation_policy text not null default '' check (char_length(cancellation_policy) <= 4000),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index booking_profiles_slug_idx on public.booking_profiles (slug);

create trigger booking_profiles_updated_at
  before update on public.booking_profiles
  for each row execute function public.set_updated_at();

-- ---------- event_types ----------
create table public.event_types (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name                text not null check (char_length(name) between 1 and 80),
  description         text not null default '' check (char_length(description) <= 1000),
  duration_minutes    integer not null check (duration_minutes between 15 and 1440),
  buffer_before       integer not null default 0 check (buffer_before between 0 and 480),
  buffer_after        integer not null default 0 check (buffer_after between 0 and 480),
  location_type       text not null default 'studio' check (location_type in ('studio', 'customer_address', 'outdoor', 'online')),
  -- Studio address, meeting spot, or video link note shown to the customer.
  location_details    text not null default '' check (char_length(location_details) <= 500),
  price               numeric(12, 2) not null default 0 check (price >= 0),
  currency            text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  -- Advance payment. 'required' is reserved for later; customers can always book without paying.
  deposit_mode        text not null default 'none' check (deposit_mode in ('none', 'optional')),
  deposit_type        text not null default 'percent' check (deposit_type in ('fixed', 'percent')),
  deposit_value       numeric(12, 2) not null default 0 check (deposit_value >= 0),
  -- Markdown shown to the customer after booking (what to wear, bring, arrival, parking...).
  instructions        text not null default '' check (char_length(instructions) <= 8000),
  -- Overrides the profile's policy when not empty.
  cancellation_policy text not null default '' check (char_length(cancellation_policy) <= 4000),
  active              boolean not null default true,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- An advance needs a price; a percentage can't exceed 100% and a fixed amount can't exceed the price.
  constraint event_types_deposit_bounds check (
    deposit_mode = 'none'
    or (price > 0 and deposit_type = 'percent' and deposit_value > 0 and deposit_value <= 100)
    or (price > 0 and deposit_type = 'fixed' and deposit_value > 0 and deposit_value <= price)
  )
);

create index event_types_user_idx on public.event_types (user_id, sort_order);

create trigger event_types_updated_at
  before update on public.event_types
  for each row execute function public.set_updated_at();

-- ---------- availability_rules: weekly working hours ----------
-- One row per working interval; a day can have several (e.g. 09:00-12:00 and 14:00-18:00).
-- weekday: 0 = Sunday ... 6 = Saturday, in the photographer's time zone.
create table public.availability_rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  weekday    smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time   time not null,
  created_at timestamptz not null default now(),
  check (start_time < end_time)
);

create index availability_rules_user_idx on public.availability_rules (user_id, weekday);

-- ---------- blocked_dates: vacations and days off ----------
create table public.blocked_dates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  start_date date not null,
  end_date   date not null,
  note       text not null default '' check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  check (start_date <= end_date and end_date - start_date <= 366)
);

create index blocked_dates_user_idx on public.blocked_dates (user_id, start_date);

-- ---------- Row Level Security: owners only ----------
alter table public.booking_profiles enable row level security;
alter table public.event_types enable row level security;
alter table public.availability_rules enable row level security;
alter table public.blocked_dates enable row level security;

create policy "booking_profiles: own" on public.booking_profiles
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "event_types: own" on public.event_types
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "availability_rules: own" on public.availability_rules
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "blocked_dates: own" on public.blocked_dates
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.booking_profiles, public.event_types, public.availability_rules, public.blocked_dates from anon;
grant select, insert, update, delete on public.booking_profiles, public.event_types, public.availability_rules, public.blocked_dates to authenticated;

-- ---------- Is a booking address free? ----------
-- Photographers can't see each other's profiles, so the app asks this before saving a new slug.
-- (The unique index is what actually guarantees it.)
create or replace function public.booking_slug_available(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.booking_profiles
    where slug = lower(p_slug) and user_id <> auth.uid()
  );
$$;

revoke all on function public.booking_slug_available(text) from public, anon;
grant execute on function public.booking_slug_available(text) to authenticated;

-- ---------- Profile photos ----------
-- Public bucket: photos appear on the public booking page. Each photographer may only write
-- inside a folder named after their user id, e.g. booking-photos/<user id>/avatar-123.jpg.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('booking-photos', 'booking-photos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "booking-photos: owners upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'booking-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "booking-photos: owners update" on storage.objects
  for update to authenticated
  using (bucket_id = 'booking-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "booking-photos: owners delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'booking-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
