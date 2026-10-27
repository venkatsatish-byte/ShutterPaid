// Sends due automatic reminders. Called hourly by pg_cron (see supabase/migrations/*_schedule_reminders.sql).
// Auth: "Authorization: Bearer <CRON_SECRET>". Add ?dry=1 to see what would be sent without sending.
//
// Secrets: CRON_SECRET, RESEND_API_KEY, REMINDER_FROM_EMAIL (e.g. reminders@mail.yourdomain.com,
// on a domain verified in Resend), APP_URL (e.g. https://yourdomain.com).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import '../_shared/schedule.js';
import '../_shared/reminders.js';
import { json, requireEnv, safeEqual } from '../_shared/http.ts';

// deno-lint-ignore no-explicit-any
const { runReminders } = (globalThis as any).SPReminders;

const PAGE = 1000;
const RESEND_MIN_INTERVAL_MS = 550; // Resend's default limit is 2 requests per second.
const DEADLINE_MS = 110_000; // leave headroom under the function time limit; the rest goes next hour

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  const auth = req.headers.get('Authorization') ?? '';
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return json({ error: 'unauthorized' }, 401);

  try {
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const db = createClient(supabaseUrl, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const resendKey = requireEnv('RESEND_API_KEY');
    const dryRun = new URL(req.url).searchParams.get('dry') === '1';

    const report = await runReminders(
      {
        dryRun,
        deadlineMs: DEADLINE_MS,
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),

        async candidates() {
          const invoices = [];
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await db
              .from('invoices')
              .select('id,user_id,client_name,client_email,shoot_type,number,amount,currency,due_date,paid,auto_remind,reminder_schedule,reminders_stopped_at,unsubscribe_token')
              .eq('auto_remind', true).eq('paid', false).is('reminders_stopped_at', null).neq('client_email', '')
              .order('id').range(from, from + PAGE - 1);
            if (error) throw error;
            invoices.push(...data);
            if (data.length < PAGE) break;
          }
          const userIds = [...new Set(invoices.map((i) => i.user_id))];
          const profiles = new Map();
          for (let i = 0; i < userIds.length; i += 200) {
            const { data, error } = await db.from('profiles').select('*').in('id', userIds.slice(i, i + 200));
            if (error) throw error;
            data.forEach((p) => profiles.set(p.id, p));
          }
          return invoices.filter((i) => profiles.has(i.user_id)).map((i) => {
            const p = profiles.get(i.user_id);
            return {
              token: i.unsubscribe_token,
              invoice: {
                id: i.id, clientName: i.client_name, clientEmail: i.client_email, shootType: i.shoot_type,
                number: i.number, amount: Number(i.amount), currency: i.currency, dueDate: i.due_date,
                paid: i.paid, autoRemind: i.auto_remind, reminderSchedule: i.reminder_schedule,
                remindersStoppedAt: i.reminders_stopped_at,
              },
              profile: {
                email: p.email, ownerName: p.owner_name, businessName: p.business_name, currency: p.currency,
                paymentLink: p.payment_link, signature: p.signature, timeZone: p.time_zone,
                reminderSchedule: p.reminder_schedule, sendHour: p.send_hour, replyTo: p.reply_to,
                pro: p.plan === 'pro' && (!p.current_period_end || Date.parse(p.current_period_end) > Date.now() - 3 * 86400_000),
              },
            };
          });
        },

        async sentKeys(ids: string[]) {
          const map = new Map<string, Set<string>>();
          for (let i = 0; i < ids.length; i += 200) {
            const { data, error } = await db
              .from('reminder_log')
              .select('invoice_id,scheduled_for,step_offset,status,attempts')
              .eq('channel', 'auto').in('invoice_id', ids.slice(i, i + 200));
            if (error) throw error;
            for (const r of data) {
              const done = r.status === 'sent' || r.attempts >= 3;
              if (!done) continue;
              if (!map.has(r.invoice_id)) map.set(r.invoice_id, new Set());
              map.get(r.invoice_id)!.add(`${r.scheduled_for}|${r.step_offset}`);
            }
          }
          return map;
        },

        async claim(a: { invoiceId: string; scheduledFor: string; stepOffset: number; tone: string; localDate: string; toEmail: string }) {
          const { data, error } = await db.rpc('claim_auto_reminder', {
            p_invoice_id: a.invoiceId, p_scheduled_for: a.scheduledFor, p_step_offset: a.stepOffset,
            p_tone: a.tone, p_local_date: a.localDate, p_to_email: a.toEmail,
          });
          if (error) throw error;
          return data;
        },

        async send(email: Record<string, unknown> & { idempotencyKey: string }) {
          const { idempotencyKey, replyTo, ...rest } = email;
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${resendKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({ ...rest, reply_to: replyTo }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`Resend ${res.status}: ${body.message ?? res.statusText}`);
          return body.id;
        },

        async markSent(id: string, providerId: string | null) {
          const { error } = await db.from('reminder_log').update({ status: 'sent', provider_id: providerId, error: null }).eq('id', id);
          if (error) throw error;
        },

        async markFailed(id: string, message: string) {
          const { error } = await db.from('reminder_log').update({ status: 'failed', error: message }).eq('id', id);
          if (error) console.error('Could not record failure', id, error);
        },
      },
      {
        appUrl: requireEnv('APP_URL'),
        functionsUrl: `${supabaseUrl}/functions/v1`,
        fromEmail: requireEnv('REMINDER_FROM_EMAIL'),
        minIntervalMs: RESEND_MIN_INTERVAL_MS,
      },
    );

    console.log(JSON.stringify({ event: 'send-reminders', dryRun, ...report }));
    return json(report);
  } catch (err) {
    console.error('send-reminders failed', err);
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
