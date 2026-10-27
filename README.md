# 📸 ShutterPaid

> *You captured the moment. Now capture the payment.*

ShutterPaid is an invoice reminder app for photographers. It runs as a website and can also be **installed as an app** (a Progressive Web App) on a phone or computer. It works offline.

## Features
- **Dashboard** that shows outstanding, overdue, due-soon and paid-this-month totals, plus a list of who needs a reminder today
- **Invoices** with the client, shoot type, invoice number, amount, currency, shoot date and due date. You can search and filter them, and mark them paid or unpaid.
- **Reminder emails** in three tones (Friendly, Firm and Final notice). Each one is filled in with the client's details and your payment link. Send it through your email app or copy the text for WhatsApp or SMS. Every reminder you send is logged.
- **Automatic reminders** (signed in): turn them on per invoice and ShutterPaid emails the client on a schedule, by default friendly 3 days before the due date, friendly on the due date, firm 7 days after and final 21 days after. Edit the default in Settings or set a custom schedule per invoice. Emails go out at your chosen hour in your time zone, from your name, with replies going to you. Reminders stop when the invoice is marked paid, and every email has a link the client can use to stop them. Each invoice shows its reminder history and the next scheduled reminder.
- **Accounts and cloud sync** (optional): sign in with an email link/code or Google to sync invoices and settings across devices. Changes are saved on the device first and upload when you're online.
- **Local-only mode**: without signing in, everything stays in the browser's `localStorage`, exactly as before.
- **Plans**: Free (up to 5 active invoices, manual reminders, sync) and Pro ($9/month or $90/year: unlimited invoices and automatic reminders) with a 14-day free trial that needs no card. Upgrade with Stripe Checkout; change plan, update the card or cancel in the Stripe Customer Portal ("Manage billing"). Limits are enforced in the database, not just the app. Local-only mode (no account) has no limits.
- **Settings** for your name, business, currency, payment link and email signature
- **Backup**: export or import your data as JSON, or load sample data to try the app out

## Run locally
No build step. Serve the folder with any static server:

```bash
cd ShutterPaid
npx http-server -p 8080    # or: python3 -m http.server 8080
```

Open http://localhost:8080. Service workers need `http://localhost` or HTTPS to work.

Without `js/config.js` the app runs in local-only mode. To try accounts locally, copy `.env.example` to `.env`, fill in your Supabase URL and anon key, and run `node scripts/build.mjs` to generate `js/config.js` (it's git-ignored).

## Setup: accounts and cloud sync (Supabase)

### 1. Create the Supabase project
1. Create a project at [supabase.com](https://supabase.com).
2. Apply the migration in `supabase/migrations/`. Either paste it into **SQL Editor** and run it, or use the CLI:
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
   This creates `profiles`, `invoices` and `reminder_log` with Row Level Security, so each user can only read and write their own rows.
3. Copy **Project Settings → API → Project URL** and the **anon / publishable key**. These go in `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The anon key is designed to be public; RLS protects the data. **Never** put the `service_role` key in the website.

### 2. Configure sign-in
In **Authentication → URL Configuration**:
- **Site URL**: `https://your-domain.com/app.html`
- **Redirect URLs**: add `https://your-domain.com/app.html`, `http://localhost:8080/app.html`, and your Vercel/Netlify preview URL pattern if you use previews (for example `https://*-yourteam.vercel.app/app.html`).

**Email (magic link + code).** In **Authentication → Emails → Templates → Magic Link**, include the one-time code as well as the link, so people using the installed app on iPhone (which can't receive the link) can type the code:
```html
<h2>Sign in to ShutterPaid</h2>
<p><a href="{{ .ConfirmationURL }}">Sign in</a></p>
<p>Or enter this code in the app: <strong>{{ .Token }}</strong></p>
```
Supabase's built-in email sender is rate-limited and meant for testing. Before launch, set **Authentication → Emails → SMTP Settings** to use Resend's SMTP (`smtp.resend.com`, port 465, user `resend`, password = a Resend API key) with a verified sender domain.

**Google.** In Google Cloud Console, create an OAuth client (type *Web application*). Add `https://<your-project-ref>.supabase.co/auth/v1/callback` as an authorised redirect URI. Then paste the client ID and secret into **Authentication → Providers → Google** in Supabase and enable it.

### 3. Automatic reminders (Resend + Edge Functions)
1. **Resend.** Create an account at [resend.com](https://resend.com), add a sending domain (a subdomain such as `mail.your-domain.com` keeps your main domain's reputation separate), and add the DNS records Resend shows (SPF, DKIM and, ideally, DMARC). Create an API key with sending access.
2. **Function secrets.** Copy the server-only part of `.env.example` to `supabase/.env.functions` (git-ignored), fill it in, then:
   ```bash
   npx supabase secrets set --env-file supabase/.env.functions
   ```
3. **Deploy the functions** (their `verify_jwt = false` setting is in `supabase/config.toml`):
   ```bash
   npx supabase functions deploy send-reminders
   npx supabase functions deploy stop-reminders
   ```
4. **Apply the migrations** (`npx supabase db push`, or run the new files in the SQL Editor in order). The schedule migration enables `pg_cron` and `pg_net` and runs `send-reminders` every hour.
5. **Give the cron job its URL and secret** (once, in the SQL Editor; values never touch the repo):
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
   select vault.create_secret('<your CRON_SECRET>', 'cron_secret');
   ```
6. **Check it** without sending anything:
   ```bash
   curl -X POST 'https://<project-ref>.supabase.co/functions/v1/send-reminders?dry=1' -H "Authorization: Bearer <CRON_SECRET>"
   ```
   The response lists what would be sent and why other invoices were skipped. Run history is under **Integrations → Cron** in the dashboard, and function logs are under **Edge Functions → send-reminders → Logs**.

**How sending stays safe**
- *Once per step.* `reminder_log` has a unique index on (invoice, scheduled date, step). Before emailing, the function calls `claim_auto_reminder`, which re-checks the invoice (unpaid, auto on, not stopped) and creates that row in the same transaction. Two runs at once, or a retry, can't both claim it. The row id is also sent to Resend as the `Idempotency-Key`, so a retry after a crash can't produce a second email.
- *Once per day per invoice*, whatever the schedule says, and no catch-up bursts: if several steps are overdue (for example, auto-reminders turned on for an old invoice), only the latest is sent. A step missed because of an outage still goes out up to 3 days late.
- *Failures* are recorded on the log row (shown in the app's history) and retried on the next hourly run, up to 3 attempts.
- *Local time.* The job runs hourly so each photographer's reminders go out after their send hour in their own time zone (set in Settings → Automatic reminders).
- *Stopping.* Each invoice has a secret token that the browser can't read. The email footer links to `stop.html?t=…`, and mail apps' built-in unsubscribe button uses the RFC 8058 one-click header. Both call `stop-reminders`. Only the server can set or clear "stopped".
- *Before sending*, the function checks there's a business or owner name (every email names the business) and a valid client email.

### 4. Payments (Stripe)
Do all of this in **test mode** first, then repeat it in live mode at launch.
1. **Product and prices.** In Stripe → Product catalog, create a product "ShutterPaid Pro" with two recurring prices: $9 per month and $90 per year. Copy both price IDs (`price_…`).
2. **Customer Portal.** In Settings → Billing → Customer portal, allow customers to update payment methods, view invoices, cancel (at period end) and switch plans between the two Pro prices. Save.
3. **Webhook.** In Developers → Webhooks, add an endpoint at `https://<project-ref>.supabase.co/functions/v1/stripe-webhook` for these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its signing secret (`whsec_…`).
4. **Secrets and deploy.** Add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY` to `supabase/.env.functions`, then:
   ```bash
   npx supabase secrets set --env-file supabase/.env.functions
   npx supabase db push
   npx supabase functions deploy create-checkout
   npx supabase functions deploy billing-portal
   npx supabase functions deploy stripe-webhook
   ```
5. **Try it.** Sign in, press *Start 14-day free trial*, and finish checkout (in test mode you can use card `4242 4242 4242 4242`, any future date and any CVC, or skip the card for the trial). Back in the app, Settings → Plan & billing should show the Pro trial within a few seconds. To test the end of a trial or a failed payment, use Stripe's test clocks or cancel the subscription in the dashboard.

**How plans work**
- The plan lives on `profiles` (`plan`, `plan_status`, `current_period_end`, `trial_used`, Stripe ids). Only the `stripe-webhook` function writes it; the browser can read but not change it.
- The webhook re-reads the subscription from Stripe on every event, so retries and out-of-order events end in the correct state. `trialing`, `active` and `past_due` (while Stripe retries the card) count as Pro. A Pro period that ended more than 3 days ago counts as Free, in case a cancellation event was missed.
- The database enforces the Free limits: a trigger refuses a 6th unpaid invoice (also when marking a paid one unpaid) and refuses switching auto-reminders on. A per-user lock stops two devices racing past the limit. `claim_auto_reminder` and `send-reminders` also skip non-Pro accounts.
- Changes the server refuses because of the plan stay on the device and upload after an upgrade or when an invoice is paid or deleted. Downgrading never deletes anything: extra invoices stay, and automatic reminders pause until Pro is back.
- The trial is offered once per account and needs no card; if no card is added by the end, Stripe cancels the subscription and the account returns to Free.
- Display prices are in `index.html` and `js/app.js` (`PRICES`). If you change prices in Stripe, update them there too.

### 5. Deploy (Vercel or Netlify)
Both configs are included (`vercel.json`, `netlify.toml`). They run `node scripts/build.mjs`, which:
- writes `js/config.js` from the `SUPABASE_URL` and `SUPABASE_ANON_KEY` environment variables, and
- stamps the service worker cache name with the commit, so every deploy reaches users.

Steps:
1. Import the repo into Vercel or Netlify. Leave the framework as "Other" or none.
2. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` under the project's **Environment Variables**.
3. Add your custom domain and follow the host's DNS instructions (usually an `A`/`ALIAS` record for the apex and a `CNAME` for `www`).
4. Update the Supabase Site URL and redirect URLs to the final domain.

GitHub Pages still works, but only in local-only mode (it has no build step to write `js/config.js`).

## Secrets
- Never commit `.env` or `js/config.js` (both are git-ignored). `.env.example` lists every variable.
- Browser-safe values (Supabase URL and anon key) are set as host environment variables.
- Server secrets (Resend, cron and Stripe) are set with `npx supabase secrets set` and are only read by Edge Functions. The cron job reads its URL and secret from Supabase Vault.

## How sync works
- Signed out: data lives under `shutterpaid:data:v1` in `localStorage`, as before.
- Signed in: data is cached per account under `shutterpaid:cache:<user id>`. Every change is written there first and added to an outbox (`shutterpaid:outbox:<user id>`). The outbox uploads when online, then the app pulls the latest data from the account. The status pill in the header shows *Synced*, *Syncing…* or *Offline*.
- On first sign-in, if this device has data from before, the app offers to add it to the account. Invoices are matched by id and by number + client + amount + due date, so nothing is duplicated, even when the same data is uploaded from two devices. A copy of the original device data is kept under `shutterpaid:data:v1:uploaded`.
- Signing out with unsynced changes keeps them on the device until you sign in again. Otherwise the account's cached copy is removed from the device.

## App updates
The service worker pre-caches the app for offline use. When a new version is deployed, users see **"A new version of ShutterPaid is available"** with a **Refresh** button. Pages and `js/config.js` are fetched network-first; everything else comes from the versioned cache. If you deploy without the build step, bump `CACHE` in `sw.js` by hand on every release.

## Tests
```bash
npm test             # unit tests: dates, due status, sync merging, the reminder scheduler and the send run (no install needed)
npm i -D playwright && npx playwright install chromium
npm run test:e2e     # browser tests: local-only mode, sign-in, upload, offline queue, update prompt, reminders, stop page, plans and upgrade
```
The browser tests use an in-page fake of Supabase (`tests/e2e/fake-supabase.js`), so they need no real project.

`js/schedule.js` (schedule rules and email copy) is shared by the app and the Edge Function. The function's copy lives in `supabase/functions/_shared/schedule.js`; after editing the original, run `npm run sync-shared`. A unit test fails if the two differ.

## Install as an app
- **Android / Chrome / Edge:** click **Install** in the header, or use the browser menu and choose *Install app*.
- **iPhone / iPad (Safari):** tap Share, then *Add to Home Screen*.

## Structure
```
index.html             Marketing landing page
app.html               The app (dashboard, invoices, settings, sign-in)
css/styles.css         Shared styles (automatic light and dark mode)
js/core.js             Pure logic (dates, status, sync helpers), shared with the tests
js/schedule.js         Reminder schedule rules and email copy (shared with the Edge Function)
js/cloud.js            Supabase auth and the offline sync queue
js/app.js              App UI and local cache
js/pwa.js              Service worker registration, update prompt, install button
js/config.js           Generated at deploy from env vars (not committed)
stop.html              Page where clients stop reminders for an invoice
sw.js                  Offline cache
supabase/migrations/   Database schema, Row Level Security, reminder claiming, hourly cron
supabase/functions/    Edge Functions: send-reminders, stop-reminders, create-checkout, billing-portal, stripe-webhook
scripts/build.mjs      Deploy step: writes js/config.js, versions the service worker
tests/                 Unit tests (node:test) and browser tests (Playwright)
manifest.webmanifest   PWA manifest
icons/                 App icons (SVG + PNG + maskable)
```

## Roadmap
- PDF invoice generation
- Stripe payment links created per invoice
