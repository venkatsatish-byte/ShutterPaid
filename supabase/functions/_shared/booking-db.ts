// Database helpers for the public booking functions (service role). Customers never query the
// tables themselves; these load exactly what a request needs.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { requireEnv } from './http.ts';

export function adminDb(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const PUBLIC_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Cache-Control': 'no-store',
};

// Advances can be paid online only once the photographer's payouts are set up (bookings phase 4).
// Until then customers always book without paying now.
// deno-lint-ignore no-explicit-any
export function advancePaymentsAvailable(_profileRow: any): boolean {
  return false;
}

function must<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data;
}

// Everything needed to check a slot for one photographer and event type around an instant.
export async function slotContext(db: SupabaseClient, profileRow: { user_id: string }, eventTypeId: string, around: number) {
  const uid = profileRow.user_id;
  const from = new Date(around - 2 * 86400000).toISOString();
  const to = new Date(around + 2 * 86400000).toISOString();
  const [et, hours, blocked, bookings] = await Promise.all([
    db.from('event_types').select('*').eq('id', eventTypeId).eq('user_id', uid).maybeSingle(),
    db.from('availability_rules').select('weekday,start_time,end_time').eq('user_id', uid),
    db.from('blocked_dates').select('start_date,end_date').eq('user_id', uid),
    db.from('bookings').select('id,start_at,block_start,block_end,status,expires_at')
      .eq('photographer_id', uid).in('status', ['confirmed', 'pending_payment']).lt('block_start', to).gt('block_end', from),
  ]);
  return {
    eventTypeRow: must(et),
    hourRows: must(hours),
    blockedRows: must(blocked),
    bookingRows: must(bookings),
  };
}

export async function profileBySlug(db: SupabaseClient, slug: string) {
  return must(await db.from('booking_profiles').select('*').eq('slug', slug).maybeSingle());
}

// The photographer's name and reply address for emails.
export async function photographerContact(db: SupabaseClient, userId: string) {
  const p = must(await db.from('profiles').select('email,reply_to,owner_name,business_name').eq('id', userId).maybeSingle());
  return { replyTo: p?.reply_to || p?.email || '', name: p?.business_name || p?.owner_name || '' };
}
