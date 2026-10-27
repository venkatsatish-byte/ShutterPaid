-- ShutterPaid phase 1: accounts and cloud sync.
-- Tables: profiles (one row per user, holds settings), invoices, reminder_log.
-- Row Level Security limits every row to its owner.

-- ---------- Helpers ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- profiles ----------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null default '',
  owner_name    text not null default '' check (char_length(owner_name) <= 200),
  business_name text not null default '' check (char_length(business_name) <= 200),
  currency      text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  soon_days     integer not null default 3 check (soon_days between 0 and 30),
  payment_link  text not null default '' check (char_length(payment_link) <= 2000),
  signature     text not null default '' check (char_length(signature) <= 2000),
  -- IANA zone such as 'Europe/London'. Empty means not set yet; the scheduler treats it as UTC.
  time_zone     text not null default '' check (char_length(time_zone) <= 64),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create a profile automatically for every new user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- invoices ----------
create table public.invoices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_name  text not null check (char_length(client_name) between 1 and 200),
  client_email text not null default '' check (char_length(client_email) <= 320),
  shoot_type   text not null default 'Other' check (char_length(shoot_type) <= 60),
  number       text not null default '' check (char_length(number) <= 60),
  amount       numeric(12, 2) not null default 0 check (amount >= 0),
  currency     text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  shoot_date   date,
  due_date     date not null,
  notes        text not null default '' check (char_length(notes) <= 5000),
  paid         boolean not null default false,
  paid_date    date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index invoices_user_due_idx on public.invoices (user_id, due_date);

create trigger invoices_updated_at
  before update on public.invoices
  for each row execute function public.set_updated_at();

-- ---------- reminder_log ----------
create table public.reminder_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  sent_at    timestamptz not null default now(),
  -- The calendar day the reminder was sent, in the photographer's time zone (shown in the app).
  sent_on    date not null default current_date,
  tone       text not null check (tone in ('friendly', 'firm', 'final')),
  channel    text not null check (channel in ('email', 'copy', 'auto')),
  created_at timestamptz not null default now()
);

create index reminder_log_invoice_idx on public.reminder_log (invoice_id, sent_at);
create index reminder_log_user_idx on public.reminder_log (user_id);

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.invoices enable row level security;
alter table public.reminder_log enable row level security;

-- (select auth.uid()) is evaluated once per query instead of once per row.
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: insert own" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "invoices: read own" on public.invoices
  for select to authenticated using (user_id = (select auth.uid()));
create policy "invoices: insert own" on public.invoices
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "invoices: update own" on public.invoices
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "invoices: delete own" on public.invoices
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "reminder_log: read own" on public.reminder_log
  for select to authenticated using (user_id = (select auth.uid()));
create policy "reminder_log: insert own" on public.reminder_log
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.invoices i where i.id = invoice_id and i.user_id = (select auth.uid()))
  );
create policy "reminder_log: update own" on public.reminder_log
  for update to authenticated using (user_id = (select auth.uid())) with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.invoices i where i.id = invoice_id and i.user_id = (select auth.uid()))
  );
create policy "reminder_log: delete own" on public.reminder_log
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------- Privileges ----------
-- Signed-out visitors get nothing. Signed-in users may only write the settings columns of their
-- profile, so later server-managed columns (plan, billing) can't be changed from the browser.
-- (id is in the update list only because upserts name it in ON CONFLICT DO UPDATE; RLS keeps it fixed.)
revoke all on public.profiles, public.invoices, public.reminder_log from anon;
revoke insert, update on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant insert (id, owner_name, business_name, currency, soon_days, payment_link, signature, time_zone)
  on public.profiles to authenticated;
grant update (id, owner_name, business_name, currency, soon_days, payment_link, signature, time_zone)
  on public.profiles to authenticated;
grant select, insert, update, delete on public.invoices, public.reminder_log to authenticated;
