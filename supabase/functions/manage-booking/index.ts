// Public, with the customer's secret manage token (from the confirmation page and email).
// GET  ?token=<uuid>                                   -> booking, instructions, payment status, rules
// POST { token, action: 'cancel', reason? }            -> cancels if the photographer's rules allow
// POST { token, action: 'reschedule', start: ISO }     -> moves it to another open time
import '../_shared/slots.js';
import '../_shared/booking.js';
import '../_shared/markdown.js';
import '../_shared/slots-api.js';
import '../_shared/booking-api.js';
import { json } from '../_shared/http.ts';
import { adminDb, PUBLIC_CORS, slotContext } from '../_shared/booking-db.ts';

// deno-lint-ignore no-explicit-any
const { manageView, parseManageAction, changeRules, checkSlot, dayBounds, bookingError, isUuid, ApiError } = (globalThis as any).SPBookingApi;

const BOOKING_COLUMNS = 'id,photographer_id,event_type_id,event_name,price,currency,customer_name,customer_email,customer_phone,' +
  'event_address,notes,start_at,end_at,status,expires_at,cancel_reason,manage_token';

// deno-lint-ignore no-explicit-any
async function load(db: any, token: string) {
  const { data: b, error } = await db.from('bookings').select(BOOKING_COLUMNS).eq('manage_token', token).maybeSingle();
  if (error) throw error;
  if (!b) throw new ApiError(404, 'We couldn\'t find this booking. Please use the link from your confirmation email.');
  const [profile, et, payments, others] = await Promise.all([
    db.from('booking_profiles').select('*').eq('user_id', b.photographer_id).maybeSingle(),
    b.event_type_id ? db.from('event_types').select('*').eq('id', b.event_type_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    db.from('payments').select('status,amount,amount_refunded').eq('booking_id', b.id),
    db.from('bookings').select('id,event_name,start_at,end_at,status,manage_token')
      .eq('photographer_id', b.photographer_id).eq('customer_email', b.customer_email).gt('end_at', new Date().toISOString()).limit(20),
  ]);
  for (const r of [profile, et, payments, others]) if (r.error) throw r.error;
  return { b, profileRow: profile.data, eventTypeRow: et.data, paymentRows: payments.data, otherRows: others.data };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: PUBLIC_CORS });
  try {
    const db = adminDb();
    if (req.method === 'GET') {
      const token = new URL(req.url).searchParams.get('token') ?? '';
      if (!isUuid(token)) throw new ApiError(400, 'This link is incomplete.');
      const c = await load(db, token);
      return json(manageView(c.b, { ...c, now: Date.now() }), 200, PUBLIC_CORS);
    }
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, PUBLIC_CORS);

    const action = parseManageAction(await req.json().catch(() => ({})));
    const c = await load(db, action.token);
    const rules = changeRules(c.b, c.profileRow, Date.now());

    if (action.action === 'cancel') {
      if (!rules.canCancel) throw new ApiError(409, rules.reason || 'This booking can\'t be cancelled online. Please contact the photographer.');
      const { error } = await db.from('bookings')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: action.reason ? 'Customer: ' + action.reason : 'Cancelled by customer' })
        .eq('id', c.b.id).eq('status', 'confirmed');
      if (error) throw error;
    } else {
      if (!rules.canReschedule) throw new ApiError(409, rules.reason || 'This booking can\'t be rescheduled online. Please contact the photographer.');
      if (!c.eventTypeRow || !c.eventTypeRow.active) throw new ApiError(409, 'This event type can no longer be booked online. Please contact the photographer.');
      const ctx = await slotContext(db, c.profileRow, c.b.event_type_id, action.start);
      const slot = checkSlot(action.start, { ...ctx, profileRow: c.profileRow, now: Date.now(), excludeBookingId: c.b.id });
      const day = dayBounds(slot.start, c.profileRow.time_zone);
      const { error } = await db.rpc('reschedule_booking', {
        p_id: c.b.id,
        p_start: new Date(slot.start).toISOString(),
        p_end: new Date(slot.end).toISOString(),
        p_day_start: new Date(day.start).toISOString(),
        p_day_end: new Date(day.end).toISOString(),
        p_max_per_day: c.profileRow.max_per_day,
      });
      if (error) throw bookingError(error) ?? error;
    }
    const fresh = await load(db, action.token);
    return json(manageView(fresh.b, { ...fresh, now: Date.now() }), 200, PUBLIC_CORS);
  } catch (err) {
    if (err instanceof ApiError) {
      const e = err as { status: number; message: string };
      return json({ error: e.message }, e.status, PUBLIC_CORS);
    }
    console.error('manage-booking failed', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500, PUBLIC_CORS);
  }
});
