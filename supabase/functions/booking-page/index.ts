// Public: a photographer's booking page (profile and bookable event types).
// GET ?slug=venkat-photos
import '../_shared/slots.js';
import '../_shared/booking.js';
import '../_shared/slots-api.js';
import '../_shared/booking-api.js';
import { json } from '../_shared/http.ts';
import { adminDb, advancePaymentsAvailable, profileBySlug, PUBLIC_CORS } from '../_shared/booking-db.ts';

// deno-lint-ignore no-explicit-any
const { publicPage, ApiError } = (globalThis as any).SPBookingApi;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: PUBLIC_CORS });
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405, PUBLIC_CORS);
  try {
    const slug = (new URL(req.url).searchParams.get('slug') ?? '').toLowerCase();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 40) throw new ApiError(404, 'We couldn\'t find that booking page.');
    const db = adminDb();
    const profileRow = await profileBySlug(db, slug);
    if (!profileRow) throw new ApiError(404, 'We couldn\'t find that booking page.');
    const { data: types, error } = await db.from('event_types').select('*').eq('user_id', profileRow.user_id).eq('active', true);
    if (error) throw error;
    return json(publicPage(profileRow, types, { advancePaymentsAvailable: advancePaymentsAvailable(profileRow) }), 200, PUBLIC_CORS);
  } catch (err) {
    if (err instanceof ApiError) {
      const e = err as { status: number; message: string };
      return json({ error: e.message }, e.status, PUBLIC_CORS);
    }
    console.error('booking-page failed', err);
    return json({ error: 'Something went wrong. Please try again.' }, 500, PUBLIC_CORS);
  }
});
