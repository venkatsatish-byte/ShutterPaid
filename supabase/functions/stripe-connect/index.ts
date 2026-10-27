// Connects a photographer's own Stripe account (Stripe Connect, Standard) so ShutterPaid can create
// payment links that pay them directly. Called from the app with the user's session.
// Body: { "action": "start" } -> { url } to Stripe onboarding
//       { "action": "status" } -> { connected, chargesEnabled }
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
    const body = await req.json().catch(() => ({}));
    const stripe = stripeClient();
    const { data: profile, error } = await admin.from('profiles')
      .select('business_name,owner_name,stripe_connect_account_id').eq('id', user.id).single();
    if (error) throw error;

    if (body.action === 'status') {
      if (!profile.stripe_connect_account_id) return json({ connected: false, chargesEnabled: false }, 200, CORS);
      const account = await stripe.accounts.retrieve(profile.stripe_connect_account_id);
      await admin.from('profiles').update({ connect_charges_enabled: account.charges_enabled }).eq('id', user.id);
      return json({ connected: true, chargesEnabled: account.charges_enabled, detailsSubmitted: account.details_submitted }, 200, CORS);
    }

    // start: create the connected account once, then send the user to Stripe's onboarding.
    let accountId = profile.stripe_connect_account_id as string | null;
    if (!accountId) {
      const account = await stripe.accounts.create(
        {
          type: 'standard',
          email: user.email,
          business_profile: { name: profile.business_name || profile.owner_name || undefined, product_description: 'Photography services' },
          metadata: { user_id: user.id },
        },
        { idempotencyKey: `connect-${user.id}` },
      );
      const { data: saved } = await admin.from('profiles').update({ stripe_connect_account_id: account.id })
        .eq('id', user.id).is('stripe_connect_account_id', null).select('stripe_connect_account_id').maybeSingle();
      accountId = saved ? account.id : (await admin.from('profiles').select('stripe_connect_account_id').eq('id', user.id).single()).data!.stripe_connect_account_id;
    }
    const app = requireEnv('APP_URL').replace(/\/$/, '');
    const link = await stripe.accountLinks.create({
      account: accountId!,
      type: 'account_onboarding',
      refresh_url: `${app}/app.html?connect=refresh`,
      return_url: `${app}/app.html?connect=return`,
    });
    return json({ url: link.url }, 200, CORS);
  } catch (err) {
    console.error('stripe-connect failed', err);
    return json({ error: 'Could not connect Stripe right now. Please try again.' }, 500, CORS);
  }
});
