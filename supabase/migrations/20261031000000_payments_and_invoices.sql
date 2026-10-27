-- ShutterPaid phase 5: invoice PDFs and Stripe payment links per invoice.
-- Photographers connect their own Stripe account (Stripe Connect, Standard). ShutterPaid creates a
-- one-time payment link per invoice on that account; when the client pays, the invoice is marked
-- paid automatically, which also stops its reminders.

-- ---------- profiles ----------
alter table public.profiles
  -- Shown on PDF invoices (address, tax number, etc.). Editable by the user.
  add column business_address text not null default '' check (char_length(business_address) <= 500),
  -- Server-only: the photographer's connected Stripe account.
  add column stripe_connect_account_id text unique,
  add column connect_charges_enabled boolean not null default false;

grant insert (business_address) on public.profiles to authenticated;
grant update (business_address) on public.profiles to authenticated;

-- ---------- invoices ----------
alter table public.invoices
  -- Server-only: the current payment link and what it charges, so a changed amount gets a new link.
  add column payment_url text,
  add column payment_link_id text,
  add column payment_link_amount numeric(12, 2),
  add column payment_link_currency text,
  -- How the invoice was paid: '' (marked by hand) or 'stripe' (paid through the payment link).
  add column paid_via text not null default '' check (paid_via in ('', 'stripe'));

create unique index invoices_payment_link_idx on public.invoices (payment_link_id) where payment_link_id is not null;

-- Browsers may read the link and how it was paid, but never write them.
grant select (payment_url, paid_via) on public.invoices to authenticated;
