// Plan rules shared by the billing Edge Functions and the tests (no I/O here).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPBilling = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TRIAL_DAYS = 14;
  // Stripe statuses that keep Pro features on. past_due keeps them while Stripe retries the card.
  const PRO_STATUSES = ['trialing', 'active', 'past_due'];

  const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);

  // Profile columns for a Stripe subscription object.
  function profileFromSubscription(sub) {
    const item = sub.items && sub.items.data && sub.items.data[0];
    const price = item && item.price;
    const interval = price && price.recurring ? price.recurring.interval : '';
    // Newer Stripe API versions moved the period end onto the subscription item.
    const periodEnd = sub.current_period_end || (item && item.current_period_end) || null;
    return {
      plan: PRO_STATUSES.includes(sub.status) ? 'pro' : 'free',
      plan_status: sub.status,
      plan_interval: interval === 'month' || interval === 'year' ? interval : '',
      current_period_end: iso(periodEnd),
      trial_ends_at: iso(sub.trial_end),
      cancel_at_period_end: !!(sub.cancel_at_period_end || sub.cancel_at),
      stripe_subscription_id: sub.id
    };
  }

  // Should this subscription update the profile? Ignore stale events about an older subscription
  // once the customer has a newer one, unless the older one is the one still granting Pro.
  function shouldApply(profile, sub) {
    if (!profile.stripe_subscription_id || profile.stripe_subscription_id === sub.id) return true;
    if (PRO_STATUSES.includes(sub.status)) return true;
    return profile.plan !== 'pro';
  }

  // Parameters for a Checkout Session. The trial is offered once per account and needs no card;
  // without a card by the end of the trial, the subscription cancels and the account returns to Free.
  function checkoutParams(opts) {
    const p = {
      mode: 'subscription',
      customer: opts.customerId,
      client_reference_id: opts.userId,
      line_items: [{ price: opts.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: opts.appUrl.replace(/\/$/, '') + '/app.html?checkout=success',
      cancel_url: opts.appUrl.replace(/\/$/, '') + '/app.html?checkout=cancel',
      subscription_data: { metadata: { user_id: opts.userId } }
    };
    if (!opts.trialUsed) {
      p.subscription_data.trial_period_days = TRIAL_DAYS;
      p.subscription_data.trial_settings = { end_behavior: { missing_payment_method: 'cancel' } };
      p.payment_method_collection = 'if_required';
    }
    return p;
  }

  return { TRIAL_DAYS, PRO_STATUSES, profileFromSubscription, shouldApply, checkoutParams };
});
