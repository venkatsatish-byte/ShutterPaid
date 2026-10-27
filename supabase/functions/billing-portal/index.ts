// Opens the Stripe Customer Portal (change plan, update card, cancel, invoices). Returns { url }.
// Secrets: STRIPE_SECRET_KEY, APP_URL.
import { CORS, json, requireEnv } from '../_shared/http.ts';
import { adminClient, requestUser, stripeClient } from '../_shared/stripe.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, CORS);
  try {
    const admin = adminClient();
    const user = await requestUser(req, admin);
    if (!user) return json({ error: 'Please sign in again.' }, 401, CORS);
    const { data: profile, error } = await admin.from('profiles').select('stripe_customer_id').eq('id', user.id).single();
    if (error) throw error;
    if (!profile.stripe_customer_id) return json({ error: 'No billing account yet. Upgrade to Pro first.' }, 404, CORS);
    const session = await stripeClient().billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${requireEnv('APP_URL').replace(/\/$/, '')}/app.html`,
    });
    return json({ url: session.url }, 200, CORS);
  } catch (err) {
    console.error('billing-portal failed', err);
    return json({ error: 'Could not open billing. Please try again.' }, 500, CORS);
  }
});
