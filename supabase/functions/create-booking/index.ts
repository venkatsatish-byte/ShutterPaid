// Public: book a time. POST JSON:
// { slug, event_type_id, start (ISO), name, email, phone?, address?, notes?, tz?, accept_policy: true,
//   pay_advance?: boolean, website?: '' (honeypot) }
// The start time is re-checked against the photographer's rules, the price and any advance come
// from the event type (never from the browser), and create_booking() inserts it under a lock so
// overlaps and the daily limit hold even for simultaneous requests.
// Secrets for the confirmation email: RESEND_API_KEY, REMINDER_FROM_EMAIL, APP_URL.
import '../_shared/slots.js';
import '../_shared/booking.js';
import '../_shared/markdown.js';
import '../_shared/slots-api.js';
import '../_shared/booking-api.js';
import '../_shared/booking-email.js';
import { json, requireEnv } from '../_shared/http.ts';
import { adminDb, advancePaymentsAvailable, photographerContact, profileBySlug, PUBLIC_CORS, slotContext } from '../_shared/booking-db.ts';
import { sendEmail } from '../_shared/email.ts';

// deno-lint-ignore no-explicit-any
const G = globalThis as any;
const { parseBookingInput, checkSlot, bookingRow, dayBounds, bookingError, ApiError } = G.SPBookingApi;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: PUBLIC_CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, PUBLIC_CORS);
  try {
    const body = await req.json().catch(() => ({}));
    const db = adminDb();
    const slug = String(body.slug ?? '').toLowerCase();
    const profileRow = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) ? await profileBySlug(db, slug) : null;
    if (!profileRow || !profileRow.accepting) throw new ApiError(404, 'This photographer isn\'t taking bookings right now.');

    const start = Date.parse(body.start);
    if (isNaN(start)) throw new ApiError(400, 'Choose a time.');
    const ctx = await slotContext(db, profileRow, String(body.event_type_id ?? ''), start);
    if (!ctx.eventTypeRow || !ctx.eventTypeRow.active) throw new ApiError(404, 'That event type isn\'t available.');
    const input = parseBookingInput(body, ctx.eventTypeRow);

    const full = { ...ctx, profileRow, now: Date.now(), advancePaymentsAvailable: advancePaymentsAvailable(profileRow) };
    const slot = checkSlot(input.start, full);
    const row = bookingRow(input, full, slot);
    const day = dayBounds(slot.start, profileRow.time_zone);
    const { data, error } = await db.rpc('create_booking', {
      p_row: row,
      p_day_start: new Date(day.start).toISOString(),
      p_day_end: new Date(day.end).toISOString(),
      p_max_per_day: profileRow.max_per_day,
    });
    if (error) throw bookingError(error) ?? error;
    const created = Array.isArray(data) ? data[0] : data;
    const manageUrl = `${requireEnv('APP_URL').replace(/\/$/, '')}/book.html#manage=${created.manage_token}`;

    if (row.status === 'confirmed') {
      const et = ctx.eventTypeRow;
      const contact = await photographerContact(db, profileRow.user_id);
      const photographerName = profileRow.display_name || contact.name || 'Your photographer';
      const mail = G.SPBookingEmail.confirmation({
        customerName: input.name,
        photographerName,
        eventName: row.event_name,
        start: row.start_at,
        end: row.end_at,
        timeZone: input.timeZone || profileRow.time_zone,
        location: [G.SPBooking.LOCATION_TYPES[et.location_type], et.location_details || input.address].filter(Boolean).join(' · '),
        price: row.price,
        currency: row.currency,
        advancePaid: 0,
        instructions: et.instructions,
        policy: et.cancellation_policy || profileRow.cancellation_policy,
        manageUrl,
      });
      await sendEmail({ to: input.email, ...mail, fromName: photographerName, replyTo: contact.replyTo, idempotencyKey: `booking-confirmed-${created.id}` })
        .catch((e) => console.error('Confirmation email failed', e));
    }

    return json({ id: created.id, token: created.manage_token, status: row.status, manageUrl }, 201, PUBLIC_CORS);
  } catch (err) {
    if (err instanceof ApiError) {
      const e = err as { status: number; message: string; fields?: Record<string, string> };
      return json({ error: e.message, fields: e.fields }, e.status, PUBLIC_CORS);
    }
    console.error('create-booking failed', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500, PUBLIC_CORS);
  }
});
