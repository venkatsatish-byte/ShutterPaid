# 📸 ShutterPaid

> *You captured the moment. Now capture the payment.*

ShutterPaid is an invoice reminder app for photographers. It runs as a website and can also be **installed as an app** (a Progressive Web App) on a phone or computer. Once installed, it works offline.

## Features
- **Dashboard** that shows outstanding, overdue, due-soon and paid-this-month totals, plus a list of who needs a reminder today
- **Invoices** with the client, shoot type, invoice number, amount, currency, shoot date and due date. You can search and filter them, and mark them paid or unpaid.
- **Reminder emails** in three tones (Friendly, Firm and Final notice). Each one is filled in with the client's details and your payment link. Send it through your email app or copy the text for WhatsApp or SMS. Every reminder you send is logged.
- **Settings** for your name, business, currency, payment link and email signature
- **Backup**: export or import your data as JSON, or load sample data to try the app out
- **Private**: all data stays in the browser's `localStorage` on your device

## Run locally
No build step. Serve the folder with any static server:

```bash
cd ShutterPaid
npx http-server -p 8080    # or: python3 -m http.server 8080
```

Open http://localhost:8080. Service workers need `http://localhost` or HTTPS to work.

## Install as an app
- **Android / Chrome / Edge:** click **Install** in the header, or use the browser menu and choose *Install app*.
- **iPhone / iPad (Safari):** tap Share, then *Add to Home Screen*.

## Deploy
Upload the folder to any static host that serves over HTTPS, such as GitHub Pages, Netlify, Vercel or Cloudflare Pages.

## Structure
```
index.html             Marketing landing page
app.html               The app (dashboard, invoices, settings)
css/styles.css         Shared styles (automatic light and dark mode)
js/app.js              App logic and localStorage persistence
js/pwa.js              Service worker registration and install button
sw.js                  Offline cache
manifest.webmanifest   PWA manifest
icons/                 App icons (SVG + PNG + maskable)
```

## Roadmap ideas
- Automatic scheduled reminders (this needs a small backend or an email service such as Resend or SendGrid)
- Cloud sync and accounts
- PDF invoice generation
- Stripe payment links created per invoice
