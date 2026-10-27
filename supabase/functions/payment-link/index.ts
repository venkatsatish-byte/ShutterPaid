// Gets (creating if needed) the Stripe payment link for one of the user's invoices, or retires it.
// Body: { "invoiceId": "...", "action": "ensure" | "retire" } -> { url } or { url: null, reason }
// Secrets: STRIPE_SECRET_KEY.
import { CORS, json } from '../_shared/http.ts';
import { adminClient, ensurePaymentLink, requestUser, retirePaymentLink, stripeClient } from '../_shared/stripe.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, CORS);
  try {
    const admin = adminClient();
    const user = await requestUser(req, admin);
    if (!user) return json({ error: 'Please sign in again.' }, 401, CORS);
    const body = await req.json().catch(() => ({}));
    if (!UUID.test(body.invoiceId ?? '')) return json({ error: 'invalid invoice' }, 400, CORS);

    // Only the invoice's owner may act on it.
    const { data: inv } = await admin.from('invoices').select('user_id').eq('id', body.invoiceId).maybeSingle();
    if (!inv || inv.user_id !== user.id) return json({ error: 'Invoice not found. Sync and try again.' }, 404, CORS);

    const stripe = stripeClient();
    if (body.action === 'retire') {
      await retirePaymentLink(stripe, admin, body.invoiceId);
      return json({ url: null, reason: 'retired' }, 200, CORS);
    }
    return json(await ensurePaymentLink(stripe, admin, body.invoiceId), 200, CORS);
  } catch (err) {
    console.error('payment-link failed', err);
    return json({ error: 'Could not create a payment link right now.' }, 500, CORS);
  }
});
