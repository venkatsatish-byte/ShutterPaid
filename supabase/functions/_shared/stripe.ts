import Stripe from 'npm:stripe@16.12.0';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { requireEnv } from './http.ts';

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
