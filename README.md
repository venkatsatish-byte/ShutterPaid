# 📸 ShutterPaid

> *You captured the moment. Now capture the payment.*

ShutterPaid is an invoice reminder app for photographers. It runs as a website and can also be **installed as an app** (a Progressive Web App) on a phone or computer. It works offline.

## Features
- **Dashboard** that shows outstanding, overdue, due-soon and paid-this-month totals, plus a list of who needs a reminder today
- **Invoices** with the client, shoot type, invoice number, amount, currency, shoot date and due date. You can search and filter them, and mark them paid or unpaid.
- **Reminder emails** in three tones (Friendly, Firm and Final notice). Each one is filled in with the client's details and your payment link. Send it through your email app or copy the text for WhatsApp or SMS. Every reminder you send is logged.
- **Accounts and cloud sync** (optional): sign in with an email link/code or Google to sync invoices and settings across devices. Changes are saved on the device first and upload when you're online.
- **Local-only mode**: without signing in, everything stays in the browser's `localStorage`, exactly as before.
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

### 3. Deploy (Vercel or Netlify)
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
- Server secrets for later phases (Resend, Stripe) are set with `npx supabase secrets set NAME=value` and are only read by Edge Functions.

## How sync works
- Signed out: data lives under `shutterpaid:data:v1` in `localStorage`, as before.
- Signed in: data is cached per account under `shutterpaid:cache:<user id>`. Every change is written there first and added to an outbox (`shutterpaid:outbox:<user id>`). The outbox uploads when online, then the app pulls the latest data from the account. The status pill in the header shows *Synced*, *Syncing…* or *Offline*.
- On first sign-in, if this device has data from before, the app offers to add it to the account. Invoices are matched by id and by number + client + amount + due date, so nothing is duplicated, even when the same data is uploaded from two devices. A copy of the original device data is kept under `shutterpaid:data:v1:uploaded`.
- Signing out with unsynced changes keeps them on the device until you sign in again. Otherwise the account's cached copy is removed from the device.

## App updates
The service worker pre-caches the app for offline use. When a new version is deployed, users see **"A new version of ShutterPaid is available"** with a **Refresh** button. Pages and `js/config.js` are fetched network-first; everything else comes from the versioned cache. If you deploy without the build step, bump `CACHE` in `sw.js` by hand on every release.

## Tests
```bash
npm test             # unit tests for dates, due status, upload de-duplication and sync merging (no install needed)
npm i -D playwright && npx playwright install chromium
npm run test:e2e     # browser tests: local-only mode, sign-in, upload, offline queue, RLS-style isolation, update prompt
```
The browser tests use an in-page fake of Supabase (`tests/e2e/fake-supabase.js`), so they need no real project.

## Install as an app
- **Android / Chrome / Edge:** click **Install** in the header, or use the browser menu and choose *Install app*.
- **iPhone / iPad (Safari):** tap Share, then *Add to Home Screen*.

## Structure
```
index.html             Marketing landing page
app.html               The app (dashboard, invoices, settings, sign-in)
css/styles.css         Shared styles (automatic light and dark mode)
js/core.js             Pure logic (dates, status, sync helpers), shared with the tests
js/cloud.js            Supabase auth and the offline sync queue
js/app.js              App UI and local cache
js/pwa.js              Service worker registration, update prompt, install button
js/config.js           Generated at deploy from env vars (not committed)
sw.js                  Offline cache
supabase/migrations/   Database schema and Row Level Security
scripts/build.mjs      Deploy step: writes js/config.js, versions the service worker
tests/                 Unit tests (node:test) and browser tests (Playwright)
manifest.webmanifest   PWA manifest
icons/                 App icons (SVG + PNG + maskable)
```

## Roadmap
- Automatic scheduled reminders sent through Resend
- Pro plan with Stripe subscriptions
- PDF invoice generation
- Stripe payment links created per invoice
