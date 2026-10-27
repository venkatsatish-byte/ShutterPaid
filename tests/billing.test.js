// Tests for the Stripe plan rules used by the billing Edge Functions.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../supabase/functions/_shared/billing.js');

const sub = (o) => Object.assign({
  id: 'sub_1', status: 'active', current_period_end: 1775000000, trial_end: null, cancel_at_period_end: false,
  items: { data: [{ price: { recurring: { interval: 'month' } } }] }
}, o);

test('profileFromSubscription maps statuses to plans', () => {
  assert.equal(B.profileFromSubscription(sub()).plan, 'pro');
  assert.equal(B.profileFromSubscription(sub({ status: 'trialing', trial_end: 1774000000 })).trial_ends_at, new Date(1774000000 * 1000).toISOString());
  assert.equal(B.profileFromSubscription(sub({ status: 'past_due' })).plan, 'pro');
  for (const s of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
    assert.equal(B.profileFromSubscription(sub({ status: s })).plan, 'free', s);
  }
  const yearly = B.profileFromSubscription(sub({ items: { data: [{ price: { recurring: { interval: 'year' } } }] } }));
  assert.equal(yearly.plan_interval, 'year');
  assert.equal(B.profileFromSubscription(sub({ cancel_at_period_end: true })).cancel_at_period_end, true);
  // Newer API versions put the period end on the item.
  const itemEnd = sub({ current_period_end: undefined, items: { data: [{ current_period_end: 1776000000, price: { recurring: { interval: 'month' } } }] } });
  assert.equal(B.profileFromSubscription(itemEnd).current_period_end, new Date(1776000000 * 1000).toISOString());
});

test('shouldApply ignores stale events about an old subscription', () => {
  assert.equal(B.shouldApply({ stripe_subscription_id: null, plan: 'free' }, sub()), true);
  assert.equal(B.shouldApply({ stripe_subscription_id: 'sub_1', plan: 'pro' }, sub({ status: 'canceled' })), true);
  // An old canceled subscription must not downgrade a user who now has a newer active one.
  assert.equal(B.shouldApply({ stripe_subscription_id: 'sub_2', plan: 'pro' }, sub({ status: 'canceled' })), false);
  assert.equal(B.shouldApply({ stripe_subscription_id: 'sub_2', plan: 'pro' }, sub({ status: 'active' })), true);
});

test('checkoutParams offers the 14-day no-card trial only once', () => {
  const base = { customerId: 'cus_1', userId: 'u1', priceId: 'price_m', appUrl: 'https://app.example/' };
  const first = B.checkoutParams(Object.assign({ trialUsed: false }, base));
  assert.equal(first.subscription_data.trial_period_days, 14);
  assert.equal(first.payment_method_collection, 'if_required');
  assert.equal(first.subscription_data.trial_settings.end_behavior.missing_payment_method, 'cancel');
  assert.equal(first.success_url, 'https://app.example/app.html?checkout=success');
  assert.equal(first.subscription_data.metadata.user_id, 'u1');
  assert.equal(first.client_reference_id, 'u1');
  const again = B.checkoutParams(Object.assign({ trialUsed: true }, base));
  assert.equal(again.subscription_data.trial_period_days, undefined);
  assert.equal(again.payment_method_collection, undefined);
});
