// Starts a Stripe Checkout for ShutterPaid Pro. Called from the app with the user's session.
// Body: { "interval": "month" | "year" }. Returns { url } to redirect to.
// Secrets: STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY, APP_URL.
import '../_shared/billing.js';
import { CORS, json, requireEnv } from '../_shared/http.ts';
import { adminClient, ensureCustomer, requestUser, stripeClient } from '../_shared/stripe.ts';

// deno-lint-ignore no-explicit-any
const { checkoutParams } = (globalThis as any).SPBilling;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, CORS);
  try {
    const admin = adminClient();
    const user = await requestUser(req, admin);
    if (!user) return json({ error: 'Please sign in again.' }, 401, CORS);

    const body = await req.json().catch(() => ({}));
    const interval = body.interval === 'year' ? 'year' : 'month';
    const stripe = stripeClient();
    const { profile, customerId } = await ensureCustomer(stripe, admin, user);
    const appUrl = requireEnv('APP_URL');

    // Already subscribed: send them to the billing portal instead of a second subscription.
    if (profile.plan === 'pro' && profile.stripe_subscription_id) {
      const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${appUrl.replace(/\/$/, '')}/app.html` });
      return json({ url: portal.url, portal: true }, 200, CORS);
    }

    const session = await stripe.checkout.sessions.create(checkoutParams({
      customerId,
      userId: user.id,
      priceId: requireEnv(interval === 'year' ? 'STRIPE_PRICE_YEARLY' : 'STRIPE_PRICE_MONTHLY'),
      appUrl,
      trialUsed: !!profile.trial_used,
    }));
    return json({ url: session.url }, 200, CORS);
  } catch (err) {
    console.error('create-checkout failed', err);
    return json({ error: 'Could not start checkout. Please try again.' }, 500, CORS);
  }
});
