// Receives Stripe webhooks and keeps each profile's plan in sync with its subscription.
// Every event is handled by re-reading the subscription from Stripe, so events that arrive late,
// twice or out of order all end in the same, current state.
// Events: checkout.session.completed, customer.subscription.created/updated/deleted,
//         invoice.payment_failed, invoice.paid.
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
import Stripe from 'npm:stripe@16.12.0';
import '../_shared/billing.js';
import { json, requireEnv } from '../_shared/http.ts';
import { adminClient, stripeClient } from '../_shared/stripe.ts';

// deno-lint-ignore no-explicit-any
const { profileFromSubscription, shouldApply } = (globalThis as any).SPBilling;
const crypto = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const stripe = stripeClient();
  const signature = req.headers.get('Stripe-Signature') ?? '';
  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, requireEnv('STRIPE_WEBHOOK_SECRET'), undefined, crypto);
  } catch (err) {
    console.warn('Bad webhook signature', (err as Error).message);
    return json({ error: 'invalid signature' }, 400);
  }

  try {
    const admin = adminClient();
    let subscriptionId: string | null = null;
    let userHint: string | null = null;
    const obj = event.data.object as unknown as Record<string, unknown>;

    switch (event.type) {
      case 'checkout.session.completed':
        subscriptionId = (obj.subscription as string) ?? null;
        userHint = (obj.client_reference_id as string) ?? null;
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        subscriptionId = obj.id as string;
        break;
      case 'invoice.payment_failed':
      case 'invoice.paid':
        subscriptionId = (obj.subscription as string) ?? null;
        break;
      default:
        return json({ received: true, ignored: event.type });
    }
    if (!subscriptionId) return json({ received: true, note: 'no subscription' });

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const userId = (sub.metadata?.user_id as string) || userHint;

    // Find the profile by user id (set at checkout) or, failing that, by Stripe customer.
    let query = admin.from('profiles').select('id, plan, trial_used, stripe_subscription_id, stripe_customer_id');
    query = userId ? query.eq('id', userId) : query.eq('stripe_customer_id', customerId);
    const { data: profile, error } = await query.maybeSingle();
    if (error) throw error;
    if (!profile) {
      console.error('No profile for subscription', sub.id, customerId);
      return json({ received: true, note: 'no matching profile' });
    }
    if (!shouldApply(profile, sub)) return json({ received: true, note: 'stale subscription' });

    const update = {
      ...profileFromSubscription(sub),
      stripe_customer_id: customerId,
      trial_used: profile.trial_used || !!sub.trial_end,
    };
    const { error: upErr } = await admin.from('profiles').update(update).eq('id', profile.id);
    if (upErr) throw upErr;
    console.log(JSON.stringify({ event: event.type, user: profile.id, plan: update.plan, status: update.plan_status }));
    return json({ received: true });
  } catch (err) {
    // A 500 makes Stripe retry later, which is what we want for temporary failures.
    console.error('stripe-webhook failed', event.type, err);
    return json({ error: 'webhook handling failed' }, 500);
  }
});
