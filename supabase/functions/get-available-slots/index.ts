// Public: open time slots for one of a photographer's event types.
// GET ?slug=venkat-photos&event_type_id=<uuid>&from=2026-11-02&to=2026-11-30&tz=Europe/London
// from/to are calendar days in the customer's time zone (tz); at most 62 days per request.
// Returns days -> slots with the customer's local time and the photographer's local time.
// Customers never touch the tables: this reads them with the service role and returns only what
// the booking page needs.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import '../_shared/slots.js';
import '../_shared/booking.js';
import '../_shared/slots-api.js';
import { json, requireEnv } from '../_shared/http.ts';

// deno-lint-ignore no-explicit-any
const { parseParams, searchWindow, buildResponse, ApiError } = (globalThis as any).SPSlotsApi;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Cache-Control': 'no-store',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, CORS);
  try {
    const params = parseParams(Object.fromEntries(new URL(req.url).searchParams));
    const db = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: profileRow, error: pErr } = await db.from('booking_profiles').select('*').eq('slug', params.slug).maybeSingle();
    if (pErr) throw pErr;
    if (!profileRow) throw new ApiError(404, 'We couldn\'t find that booking page.');
    const uid = profileRow.user_id;
    const win = searchWindow(params);

    const [et, hours, blocked, bookings] = await Promise.all([
      db.from('event_types').select('*').eq('id', params.eventTypeId).eq('user_id', uid).maybeSingle(),
      db.from('availability_rules').select('weekday,start_time,end_time').eq('user_id', uid),
      db.from('blocked_dates').select('start_date,end_date').eq('user_id', uid),
      db.from('bookings').select('id,start_at,block_start,block_end,status,expires_at')
        .eq('photographer_id', uid).in('status', ['confirmed', 'pending_payment'])
        .lt('block_start', new Date(win.loadTo).toISOString()).gt('block_end', new Date(win.loadFrom).toISOString()),
    ]);
    for (const r of [et, hours, blocked, bookings]) if (r.error) throw r.error;

    // Rescheduling: the customer's own booking (found by its manage token) doesn't block new times.
    let excludeBookingId: string | null = null;
    if (params.token) {
      const own = await db.from('bookings').select('id').eq('manage_token', params.token).eq('photographer_id', uid).maybeSingle();
      if (own.error) throw own.error;
      excludeBookingId = own.data?.id ?? null;
    }
    const body = buildResponse(params, {
      profileRow, eventTypeRow: et.data, hourRows: hours.data, blockedRows: blocked.data, bookingRows: bookings.data, now: Date.now(), excludeBookingId,
    });
    return json(body, 200, CORS);
  } catch (err) {
    if (err instanceof ApiError) {
      const e = err as { status: number; message: string };
      return json({ error: e.message }, e.status, CORS);
    }
    console.error('get-available-slots failed', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500, CORS);
  }
});
