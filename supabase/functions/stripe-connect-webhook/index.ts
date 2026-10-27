// Webhook for events on photographers' connected Stripe accounts (a separate "Connect" endpoint).
// - checkout.session.completed / async_payment_succeeded from a ShutterPaid payment link: marks the
//   invoice paid (which stops its reminders). Safe to receive twice.
// - account.updated: keeps "can accept payments" in sync.
// Secrets: STRIPE_SECRET_KEY, STRIPE_CONNECT_WEBHOOK_SECRET.
import Stripe from 'npm:stripe@16.12.0';
import '../_shared/schedule.js';
import { json, requireEnv } from '../_shared/http.ts';
import { adminClient, stripeClient } from '../_shared/stripe.ts';

// deno-lint-ignore no-explicit-any
const S = (globalThis as any).SPSchedule;
const crypto = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const stripe = stripeClient();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(), req.headers.get('Stripe-Signature') ?? '', requireEnv('STRIPE_CONNECT_WEBHOOK_SECRET'), undefined, crypto,
    );
  } catch (err) {
    console.warn('Bad webhook signature', (err as Error).message);
    return json({ error: 'invalid signature' }, 400);
  }

  try {
    const admin = adminClient();
    const account = event.account;
    if (!account) return json({ received: true, note: 'not a connected-account event' });

    if (event.type === 'account.updated') {
      const acct = event.data.object as Stripe.Account;
      await admin.from('profiles').update({ connect_charges_enabled: acct.charges_enabled }).eq('stripe_connect_account_id', account);
      return json({ received: true });
    }

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session;
      const linkId = typeof session.payment_link === 'string' ? session.payment_link : session.payment_link?.id;
      if (!linkId || session.payment_status !== 'paid') return json({ received: true, note: 'not a paid payment-link session' });

      const { data: inv } = await admin.from('invoices').select('id,user_id,paid').eq('payment_link_id', linkId).maybeSingle();
      if (!inv) return json({ received: true, note: 'no invoice for this link' });
      const { data: profile } = await admin.from('profiles').select('time_zone,stripe_connect_account_id').eq('id', inv.user_id).single();
      // The event must come from the account that owns the invoice.
      if (!profile || profile.stripe_connect_account_id !== account) return json({ received: true, note: 'account mismatch' });
      if (!inv.paid) {
        const paidOn = S.localNow(new Date(session.created * 1000), profile.time_zone).date;
        const { error } = await admin.from('invoices').update({ paid: true, paid_date: paidOn, paid_via: 'stripe' }).eq('id', inv.id).eq('paid', false);
        if (error) throw error;
        console.log(JSON.stringify({ event: 'invoice-paid-online', invoice: inv.id }));
      }
      return json({ received: true });
    }
    return json({ received: true, ignored: event.type });
  } catch (err) {
    console.error('stripe-connect-webhook failed', event.type, err);
    return json({ error: 'webhook handling failed' }, 500);
  }
});
