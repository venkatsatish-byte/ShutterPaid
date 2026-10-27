// The automatic reminder run, with all I/O injected so it can be tested without Supabase or Resend.
// Used by supabase/functions/send-reminders (Deno) and tests/reminders.test.js (Node).
// Requires SPSchedule (schedule.js) to be loaded first.
(function (root, factory) {
  const api = factory(root.SPSchedule || (typeof require === 'function' ? require('./schedule.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SPReminders = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S) {
  'use strict';

  /**
   * deps:
   *   candidates()                 -> [{ invoice, profile, token }] invoices with auto-reminders on
   *   sentKeys(invoiceIds)         -> Map(invoiceId -> Set(stepKey)) of steps that are done: sent, or
   *                                   given up on after 3 attempts. In-flight/failed rows are left to claim().
   *   claim(args)                  -> log row id, or null if this step must not be sent
   *   send(email)                  -> provider message id (throws on failure)
   *   paymentLink(invoice)         -> optional: the invoice's payment URL, or null
   *   markSent(id, providerId), markFailed(id, message)
   *   sleep(ms), now: Date, deadlineMs (optional), dryRun (optional)
   * config: { appUrl, functionsUrl, fromEmail, minIntervalMs }
   */
  async function runReminders(deps, config) {
    const now = deps.now || new Date();
    const started = Date.now();
    const report = { checked: 0, sent: 0, failed: 0, skipped: {}, planned: [] };
    const skip = (why) => { report.skipped[why] = (report.skipped[why] || 0) + 1; };
    const rows = await deps.candidates();
    const keys = await deps.sentKeys(rows.map((r) => r.invoice.id));
    let lastSend = 0;

    for (const { invoice, profile, token } of rows) {
      report.checked++;
      if (deps.deadlineMs && Date.now() - started > deps.deadlineMs) { skip('out-of-time'); continue; }
      // Automatic reminders are a Pro feature (claim_auto_reminder checks this again in the database).
      if (profile.pro === false) { skip('not-pro'); continue; }
      const local = S.localNow(now, profile.timeZone);
      const sendHour = Number.isInteger(profile.sendHour) ? profile.sendHour : S.DEFAULT_SEND_HOUR;
      if (local.hour < sendHour) { skip('before-send-hour'); continue; }
      if (!profile.businessName && !profile.ownerName) { skip('no-business-name'); continue; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invoice.clientEmail || '')) { skip('bad-client-email'); continue; }

      const schedule = S.scheduleFor(invoice, profile.reminderSchedule);
      const due = S.dueStep(invoice, schedule, local.date, keys.get(invoice.id));
      if (!due) { skip('nothing-due'); continue; }

      if (deps.dryRun) {
        report.planned.push({ invoiceId: invoice.id, date: due.date, offset: due.step.offset, tone: due.step.tone });
        continue;
      }

      const id = await deps.claim({
        invoiceId: invoice.id, scheduledFor: due.date, stepOffset: due.step.offset,
        tone: due.step.tone, localDate: local.date, toEmail: invoice.clientEmail
      });
      if (!id) { skip('already-claimed'); continue; }

      const stopUrl = config.appUrl.replace(/\/$/, '') + '/stop.html?t=' + encodeURIComponent(token);
      const oneClickUrl = config.functionsUrl.replace(/\/$/, '') + '/stop-reminders?t=' + encodeURIComponent(token);
      // Add the invoice's Stripe payment link when the photographer has connected Stripe. If that
      // fails, the reminder still goes out with the general payment link from Settings.
      let payUrl = null;
      if (deps.paymentLink) {
        try { payUrl = await deps.paymentLink(invoice); } catch (e) { payUrl = null; }
      }
      const email = S.buildEmail(payUrl ? Object.assign({}, invoice, { paymentUrl: payUrl }) : invoice, profile, due.step.tone, local.date, stopUrl, 'en-US');

      // Stay under the email provider's rate limit.
      const wait = (config.minIntervalMs || 0) - (Date.now() - lastSend);
      if (wait > 0 && deps.sleep) await deps.sleep(wait);
      lastSend = Date.now();

      try {
        const providerId = await deps.send({
          idempotencyKey: 'reminder-' + id,
          from: email.fromName + ' <' + config.fromEmail + '>',
          to: invoice.clientEmail,
          replyTo: profile.replyTo || profile.email || undefined,
          subject: email.subject,
          html: email.html,
          text: email.text,
          headers: {
            'List-Unsubscribe': '<' + oneClickUrl + '>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
          }
        });
        await deps.markSent(id, providerId || null);
        report.sent++;
      } catch (err) {
        await deps.markFailed(id, String((err && err.message) || err).slice(0, 500));
        report.failed++;
      }
    }
    return report;
  }

  return { runReminders };
});
