import Stripe from 'npm:stripe@16.12.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { requireEnv } from './http.ts';
import './paylinks.js';

export function stripeClient(): Stripe {
  return new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function adminClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// The signed-in user making this request, or null.
export async function requestUser(req: Request, admin: SupabaseClient) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

// The user's Stripe customer, created on first use and remembered on the profile.
export async function ensureCustomer(stripe: Stripe, admin: SupabaseClient, user: { id: string; email?: string }) {
  const { data: profile, error } = await admin.from('profiles').select('*').eq('id', user.id).single();
  if (error) throw error;
  if (profile.stripe_customer_id) return { profile, customerId: profile.stripe_customer_id as string };
  const customer = await stripe.customers.create(
    {
      email: user.email,
      name: profile.business_name || profile.owner_name || undefined,
      metadata: { user_id: user.id },
    },
    { idempotencyKey: `customer-${user.id}` },
  );
  // Only set it if still empty, so two concurrent requests can't leave two customers linked.
  const { data: updated } = await admin.from('profiles').update({ stripe_customer_id: customer.id })
    .eq('id', user.id).is('stripe_customer_id', null).select('stripe_customer_id').maybeSingle();
  if (updated) return { profile, customerId: customer.id };
  const { data: again } = await admin.from('profiles').select('stripe_customer_id').eq('id', user.id).single();
  return { profile, customerId: again!.stripe_customer_id as string };
}

// ---------- Per-invoice payment links on the photographer's connected account ----------
// deno-lint-ignore no-explicit-any
const PayLinks = (globalThis as any).SPPayLinks;

const INVOICE_LINK_COLUMNS =
  'id,user_id,amount,currency,shoot_type,number,paid,payment_url,payment_link_id,payment_link_amount,payment_link_currency';

// Returns the invoice's current payment link, creating one (and retiring an outdated one) if needed.
// { url: null, reason } when no link can be made, e.g. Stripe isn't connected.
export async function ensurePaymentLink(stripe: Stripe, admin: SupabaseClient, invoiceId: string) {
  const { data: inv, error } = await admin.from('invoices').select(INVOICE_LINK_COLUMNS).eq('id', invoiceId).single();
  if (error) throw error;
  if (PayLinks.linkIsCurrent(inv) && !inv.paid) return { url: inv.payment_url as string };
  const { data: profile, error: pErr } = await admin.from('profiles')
    .select('business_name,owner_name,stripe_connect_account_id,connect_charges_enabled').eq('id', inv.user_id).single();
  if (pErr) throw pErr;
  const reason = PayLinks.cannotLink(inv, profile);
  if (reason) return { url: null, reason };

  const opts = { stripeAccount: profile.stripe_connect_account_id as string };
  // Same invoice, amount and previous link => same key, so concurrent callers get the same link.
  const key = `${inv.id}-${PayLinks.minorUnits(inv.amount, inv.currency)}-${inv.currency}-${inv.payment_link_id ?? 'first'}`;
  const price = await stripe.prices.create(PayLinks.priceParams(inv), { ...opts, idempotencyKey: `price-${key}` });
  const link = await stripe.paymentLinks.create(
    PayLinks.linkParams(inv, price.id, profile.business_name || profile.owner_name),
    { ...opts, idempotencyKey: `plink-${key}` },
  );
  if (inv.payment_link_id && inv.payment_link_id !== link.id) {
    await stripe.paymentLinks.update(inv.payment_link_id, { active: false }, opts).catch((e: Error) => console.warn('Could not retire old link', e.message));
  }
  const { error: uErr } = await admin.from('invoices').update({
    payment_url: link.url,
    payment_link_id: link.id,
    payment_link_amount: inv.amount,
    payment_link_currency: inv.currency,
  }).eq('id', inv.id);
  if (uErr) throw uErr;
  return { url: link.url };
}

// Turn off an invoice's payment link (it was paid some other way, or deleted).
export async function retirePaymentLink(stripe: Stripe, admin: SupabaseClient, invoiceId: string) {
  const { data: inv } = await admin.from('invoices').select('user_id,payment_link_id').eq('id', invoiceId).maybeSingle();
  if (!inv?.payment_link_id) return;
  const { data: profile } = await admin.from('profiles').select('stripe_connect_account_id').eq('id', inv.user_id).single();
  if (!profile?.stripe_connect_account_id) return;
  await stripe.paymentLinks.update(inv.payment_link_id, { active: false }, { stripeAccount: profile.stripe_connect_account_id });
  await admin.from('invoices').update({ payment_url: null, payment_link_id: null, payment_link_amount: null, payment_link_currency: null }).eq('id', invoiceId);
}
