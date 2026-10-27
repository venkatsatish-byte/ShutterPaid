-- ShutterPaid phase 4: "Join the beta" email list from the landing page.
-- Visitors can add an email but nobody can read the list through the API; view it in the
-- Supabase dashboard (Table Editor) or export it from there.

create table public.beta_signups (
  id         uuid primary key default gen_random_uuid(),
  email      text not null check (char_length(email) between 3 and 320 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  source     text not null default 'landing' check (char_length(source) <= 40),
  created_at timestamptz not null default now()
);

-- One row per address, whatever the capitalisation.
create unique index beta_signups_email_idx on public.beta_signups (lower(email));

alter table public.beta_signups enable row level security;

create policy "beta_signups: anyone can join" on public.beta_signups
  for insert to anon, authenticated with check (true);

revoke all on public.beta_signups from anon, authenticated;
grant insert (email, source) on public.beta_signups to anon, authenticated;
