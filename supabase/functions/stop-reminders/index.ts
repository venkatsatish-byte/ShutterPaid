// Lets a client stop automatic reminders for one invoice. Public (no login):
// - POST from stop.html with JSON { token }
// - RFC 8058 one-click POST from the email client's "Unsubscribe" button, token in ?t=
// The token is a random UUID stored on the invoice and never sent to the photographer's browser.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { json, requireEnv } from '../_shared/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const appOrigin = new URL(requireEnv('APP_URL')).origin;
  const cors = {
    'Access-Control-Allow-Origin': appOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    Vary: 'Origin',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);

  let token = new URL(req.url).searchParams.get('t') ?? '';
  if (!token && (req.headers.get('content-type') ?? '').includes('application/json')) {
    const body = await req.json().catch(() => ({}));
    token = typeof body.token === 'string' ? body.token : '';
  }
  if (!UUID.test(token)) return json({ error: 'invalid link' }, 400, cors);

  const db = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.rpc('stop_reminders', { p_token: token });
  if (error) {
    console.error('stop_reminders failed', error);
    return json({ error: 'try again later' }, 500, cors);
  }
  if (!data) return json({ error: 'link not found' }, 404, cors);
  return json({ ok: true, business: data }, 200, cors);
});
