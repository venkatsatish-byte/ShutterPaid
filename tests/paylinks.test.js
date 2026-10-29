// Tests for per-invoice Stripe payment link rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../supabase/functions/_shared/paylinks.js');

const inv = (o) => Object.assign({ id: 'i1', user_id: 'u1', amount: 1200.5, currency: 'USD', shoot_type: 'Wedding', number: 'INV-1001', paid: false }, o);
const connected = { stripe_connect_account_id: 'acct_1', connect_charges_enabled: true };

test('amounts convert to Stripe minor units', () => {
  assert.equal(P.minorUnits(1200.5, 'USD'), 120050);
  assert.equal(P.minorUnits(19.99, 'eur'), 1999);
  assert.equal(P.minorUnits(5000, 'JPY'), 5000);
  assert.equal(P.minorUnits(0.1 + 0.2, 'USD'), 30);
});

test('a link is reused only while amount and currency match', () => {
  const linked = inv({ payment_url: 'https://buy.stripe.com/x', payment_link_id: 'plink_1', payment_link_amount: '1200.50', payment_link_currency: 'usd' });
  assert.equal(P.linkIsCurrent(linked), true);
  assert.equal(P.linkIsCurrent(Object.assign({}, linked, { amount: 1300 })), false);
  assert.equal(P.linkIsCurrent(Object.assign({}, linked, { currency: 'EUR' })), false);
  assert.equal(P.linkIsCurrent(inv()), false);
});

test('cannotLink explains when no link can be made', () => {
  assert.equal(P.cannotLink(inv(), connected), null);
  assert.equal(P.cannotLink(inv(), {}), 'not-connected');
  assert.equal(P.cannotLink(inv(), { stripe_connect_account_id: 'acct_1', connect_charges_enabled: false }), 'not-connected');
  assert.equal(P.cannotLink(inv({ paid: true }), connected), 'paid');
  assert.equal(P.cannotLink(inv({ amount: 0 }), connected), 'no-amount');
  assert.equal(P.cannotLink(inv({ amount: 0.2 }), connected), 'amount-too-small');
});

test('Stripe parameters', () => {
  assert.deepEqual(P.priceParams(inv()), { currency: 'usd', unit_amount: 120050, product_data: { name: 'Wedding photography · INV-1001', metadata: { invoice_id: 'i1' } } });
  assert.equal(P.productName(inv({ shoot_type: '', number: '' })), 'Photography');
  const l = P.linkParams(inv(), 'price_1', 'Rivera Photo');
  assert.deepEqual(l.line_items, [{ price: 'price_1', quantity: 1 }]);
  assert.equal(l.restrictions.completed_sessions.limit, 1);
  assert.deepEqual(l.metadata, { invoice_id: 'i1', user_id: 'u1' });
  assert.match(l.after_completion.hosted_confirmation.custom_message, /Rivera Photo has been notified/);
});

test('payment links charge the balance after an advance', () => {
  const withAdvance = inv({ amount: 300, amount_paid: 75 });
  assert.equal(P.balance(withAdvance), 225);
  assert.equal(P.priceParams(withAdvance).unit_amount, 22500);
  assert.equal(P.linkIsCurrent(Object.assign({}, withAdvance, { payment_url: 'u', payment_link_id: 'p', payment_link_amount: 225, payment_link_currency: 'USD' })), true);
  // The advance changed (e.g. refunded): the old link no longer matches.
  assert.equal(P.linkIsCurrent(Object.assign({}, withAdvance, { amount_paid: 50, payment_url: 'u', payment_link_id: 'p', payment_link_amount: 225, payment_link_currency: 'USD' })), false);
  assert.equal(P.cannotLink(inv({ amount: 300, amount_paid: 300 }), connected), 'no-amount');
});
