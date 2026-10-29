// Sends an email through Resend. Returns false (and logs) when email isn't configured, so a booking
// never fails just because an email couldn't be sent.
export async function sendEmail(msg: {
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName: string;
  replyTo?: string;
  idempotencyKey?: string;
  attachments?: { filename: string; content: string; content_type?: string }[];
}): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('REMINDER_FROM_EMAIL');
  if (!key || !from) {
    console.warn('Email not configured (RESEND_API_KEY / REMINDER_FROM_EMAIL); skipped:', msg.subject);
    return false;
  }
  const name = msg.fromName.replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'ShutterPaid';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(msg.idempotencyKey ? { 'Idempotency-Key': msg.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: `${name} <${from}>`,
      to: msg.to,
      reply_to: msg.replyTo || undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments,
    }),
  });
  if (!res.ok) {
    console.error('Email failed', res.status, await res.text().catch(() => ''));
    return false;
  }
  return true;
}
