// Rules for per-invoice Stripe payment links (no I/O). Used by the payment-link,
// stripe-connect-webhook and send-reminders functions, and by the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPPayLinks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Currencies Stripe charges in whole units (no cents).
  const ZERO_DECIMAL = ['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];

  // Payment links charge what's still owed: the amount minus any advance already paid.
  function balance(inv) {
    return Math.max(0, Math.round((Number(inv.amount || 0) - (Number(inv.amount_paid) || 0)) * 100) / 100);
  }

  function minorUnits(amount, currency) {
    const factor = ZERO_DECIMAL.includes(String(currency).toUpperCase()) ? 1 : 100;
    return Math.round(Number(amount) * factor);
  }

  // A link can be used if it exists and still charges the invoice's current amount and currency.
  function linkIsCurrent(inv) {
    return !!(inv.payment_url && inv.payment_link_id &&
      Number(inv.payment_link_amount) === balance(inv) &&
      String(inv.payment_link_currency || '').toUpperCase() === String(inv.currency || '').toUpperCase());
  }

  // Why a link can't be made for this invoice, or null if it can.
  function cannotLink(inv, profile) {
    if (!profile.stripe_connect_account_id || !profile.connect_charges_enabled) return 'not-connected';
    if (inv.paid) return 'paid';
    if (!(balance(inv) > 0)) return 'no-amount';
    if (minorUnits(balance(inv), inv.currency) < 50) return 'amount-too-small';
    return null;
  }

  function productName(inv) {
    const what = (inv.shoot_type ? inv.shoot_type + ' photography' : 'Photography') + (inv.number ? ' · ' + inv.number : '');
    return what.slice(0, 250);
  }

  function priceParams(inv) {
    return {
      currency: String(inv.currency || 'USD').toLowerCase(),
      unit_amount: minorUnits(balance(inv), inv.currency),
      product_data: { name: productName(inv), metadata: { invoice_id: inv.id } }
    };
  }

  function linkParams(inv, priceId, businessName) {
    return {
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { invoice_id: inv.id, user_id: inv.user_id },
      // One successful payment per link, so a client can't pay the same invoice twice.
      restrictions: { completed_sessions: { limit: 1 } },
      after_completion: {
        type: 'hosted_confirmation',
        hosted_confirmation: { custom_message: ('Thank you! ' + (businessName || 'Your photographer') + ' has been notified of your payment.').slice(0, 500) }
      }
    };
  }

  return { ZERO_DECIMAL, balance, minorUnits, linkIsCurrent, cannotLink, productName, priceParams, linkParams };
});
