# DsignX Ops

DsignX Ops is the operations app for **DsignX**, a signage, printing and sublimation business in Kroonstad, South Africa. It tracks every job from the first WhatsApp message through quoting, production, invoicing and commission.

**How it runs:**
- **Front end:** plain HTML, CSS and JavaScript, hosted free on **GitHub Pages**. There is no build step.
- **Data and logins:** **Firebase Authentication** and **Cloud Firestore**.
- **Server code:** two **Cloud Functions** that keep the Bird and Cloudinary API keys off the browser.

## Features

**Dashboard**
- Open jobs, jobs due this week, value quoted but not yet invoiced, and customer count.
- An upcoming-deadline list.

**Job board**
- Columns: New → Quoted → In progress → Ready → Delivered → Invoiced.
- Assign a designer and a technician to each job.
- Artwork and proof attachments.

**WhatsApp inbox (Bird)**
- Customers waiting for a reply.
- Turn a message into an order in one click.
- A chat thread per job.
- Warns before sending outside WhatsApp's 24-hour reply window.

**Customers**
- Individual and business customers, with unique contact names.
- Postal and delivery addresses.
- Business customers also get up to 5 extra contact people, website, registration number and VAT number.

**Quotes and tax invoices**
- Line items with optional 15% VAT.
- Automatic numbering (DSX-Q0001, DSX-INV0001).
- Branded A4 PDFs made with jsPDF.
- Sent on WhatsApp as real attachments, hosted on Cloudinary and deleted after 30 days.

**Reports**
- Commission report on a sliding scale of monthly sales excluding VAT, earned on assigned jobs.
- Monthly or custom date ranges, with CSV export.

**Team and access**
- Invite-only access with one-time invite codes.
- Email and password sign-in.
- Signs out after 30 minutes of inactivity or when the tab closes.

**Settings**
- Letterhead and banking details.
- Quote and invoice defaults.
- The customer order link.
- Xero exports for invoices and contacts.
- Import from a backup file.

| Monthly sales (excl. VAT) | Commission |
|---|---|
| R0 – R49,999 | 1.125% |
| R50,000 – R64,999 | 2.25% |
| R65,000 – R79,999 | 3.38% |
| R80,000 – R99,999 | 4.50% |
| R100,000 – R149,999 | 5.63% |
| R150,000 and more | 6.75% |

### Roles

| | Owner | Designer | Technician |
|---|:-:|:-:|:-:|
| Job board | ✓ | ✓ | ✓ (no prices) |
| Dashboard, customers, quotes and invoices, reports | ✓ | ✓ | – |
| WhatsApp inbox and sending files | ✓ | ✓ | – |
| Team (invite, revoke, change roles) | ✓ | view | – |
| Settings, import, deleting old files | ✓ | – | – |

The app enforces these roles on screen. The server enforces them too, in `firestore.rules` and in the Cloud Functions.

## Project structure

```
dsignx-ops/
├── index.html               Page shell: fonts, styles, jsPDF, config and the app
├── css/styles.css           All styling
├── js/
│   ├── firebase-config.js   Your Firebase project settings (public, not secret)
│   ├── platform.js          Firebase wiring: sign-in, database, functions, uploads
│   ├── app.js               The application: screens, jobs, quotes, PDFs, reports
│   └── logos.js             DsignX logos as data URLs (used on screen and in PDFs)
├── assets/                  Logo images (one is also the browser tab icon)
├── functions/               Cloud Functions (Node.js 22)
│   ├── index.js             redeemInvite and connector (Bird + Cloudinary)
│   ├── lib/core.js          Request building, signing and invite checks
│   ├── test/core.test.js    Unit tests: npm test
│   └── package.json
├── firestore.rules          Who may read and write what
├── firestore.indexes.json
├── firebase.json            Firebase CLI configuration
├── SETUP_GUIDE.md           Step-by-step setup for beginners
├── .nojekyll                Serve files as-is on GitHub Pages
└── .gitignore
```

## Setup

Follow **[SETUP_GUIDE.md](SETUP_GUIDE.md)**. It covers creating the Firebase project, adding the Bird and Cloudinary keys, deploying the rules and functions, publishing on GitHub Pages, and importing your existing data.

Here is the short version, if you've done this before:

```bash
npm install -g firebase-tools
firebase login
firebase use --add                       # pick your Firebase project
(cd functions && npm install && npm test)
firebase functions:secrets:set BIRD_API_KEY
firebase functions:secrets:set CLOUDINARY_URL
firebase deploy --only firestore:rules,firestore:indexes,functions
```

Then:
1. Fill in `js/firebase-config.js`.
2. Push to GitHub and turn on Pages (branch `main`, folder `/ (root)`).
3. Add `YOUR-USERNAME.github.io` under Firebase Authentication → Settings → **Authorized domains**.

## Running locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. `localhost` is allowed by Firebase Authentication by default.

If `js/firebase-config.js` is empty, the app runs in **demo mode**:
- It shows sample data.
- Nothing is saved.
- No messages are sent.

## Security notes

- `js/firebase-config.js` only identifies the Firebase project; it is meant to be public. Access is controlled by sign-in and `firestore.rules`.
- The Bird and Cloudinary keys are stored as Firebase **secrets** and are only used inside Cloud Functions. Never put them in the front-end files.
- Only the email address in `firestore.rules` (`ownerEmail()`) can complete first-time owner setup, only after verifying it, and only once.
- Invite codes work once, expire after 7 days, and are checked on the server.
- **Never commit backup files** (`*backup*.json`). They contain customer details and banking information. `.gitignore` excludes them.
- Artwork and PDFs on Cloudinary are reachable by anyone who has the exact link. The links are long and random. Quote and invoice PDFs are deleted after 30 days.

## Third-party services

- [Firebase](https://firebase.google.com): Authentication, Firestore and Cloud Functions. Needs the pay-as-you-go **Blaze** plan; normal use for a small team stays within the free allowance.
- [Bird](https://bird.com): WhatsApp Business messaging, billed per message by Bird.
- [Cloudinary](https://cloudinary.com): public links for files sent on WhatsApp. The free plan is enough.
- [jsPDF 4.2.1](https://github.com/parallax/jsPDF) (MIT): PDF generation, loaded from cdnjs.
- Google Fonts: Barlow Condensed, Inter and IBM Plex Mono.

## Licence

© DsignX (Pty) Ltd. All rights reserved. The DsignX name and logos may not be reused.
