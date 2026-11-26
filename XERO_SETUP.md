# Xero live sync — setup

The app leads; Xero feeds back.

| What | Direction | When |
|---|---|---|
| Customers (new and changes) | App → Xero | As soon as they are saved |
| Quotes | App → Xero (Sent / Accepted / Declined) | As soon as the quote is generated or changes |
| Invoices | App → Xero, status **Awaiting Payment** | As soon as the invoice is issued or changes |
| Credit notes | App → Xero, applied to the invoice | As soon as they are issued or voided |
| Receipts (cash, card, EFT, allocated overpayments) | App → Xero as payments into the accounts you choose | As soon as they are saved; voiding deletes the payment |
| Receipts with no invoice in Xero (payments on account, deposits on jobs not invoiced yet) | App → Xero as an **overpayment** on the customer; applied to the invoice when it is issued or when you allocate it in the app | As soon as they are saved; undo/void removes it |
| Payments entered in Xero (e.g. bank reconciliation) | Xero → App as receipts | Every 15 minutes |
| Contact changes / new customers in Xero | Xero → App | Every 15 minutes |
| Invoices voided or paid in Xero | Xero → App (shown on Quotes & invoicing) | Every 15 minutes |

Xero's free "Starter" developer tier covers one organisation (1,000 API calls a day). The app stops at 900 calls a day and carries on the next day.

## 1. Create the Xero app (once)

1. Go to <https://developer.xero.com/app/manage> and sign in with your Xero login.
2. **New app** → choose **Web app**.
   - App name: `DsignX Ops`
   - Company or application URL: `https://estelle-lgtm.github.io/dsignx-ops/`
   - Redirect URI: `https://europe-west1-dsignx-ops.cloudfunctions.net/xeroCallback`
3. Open the app → **Configuration**:
   - copy the **Client id**;
   - **Generate a secret** and copy it straight away (Xero shows it once).

## 2. Put the keys on the server (Git Bash)

Never paste the secret into a chat or commit it.

1. In Notepad, paste the **client secret** and save it as `xero-secret.txt` in the **dsignx-ops-firebase_2** folder (not inside dsignx-ops).
2. Run:

```
cd "/c/Users/estelle.CORCOMM/Downloads/dsignx-ops-firebase_2/dsignx-ops"
firebase functions:secrets:set XERO_CLIENT_SECRET --data-file ../xero-secret.txt
firebase deploy --only functions
```

3. When the deploy asks for **XERO_CLIENT_ID**, paste the client id. For the other questions (XERO_SCOPES, XERO_REDIRECT_URI) just press Enter to keep the defaults.
4. Delete `xero-secret.txt`.

The first deploy of the sync takes a few minutes. If it stops with a message about the trigger **region/location**, send that message to Claude.

Then publish the app:

```
git add .
git commit -m "Xero live sync"
git push
```

## 3. Connect (in the app, as owner)

1. Ctrl+F5, then **Settings → Xero live sync → Connect to Xero**. Sign in to Xero, choose **DsignX (PTY) LTD**, allow access. You come back to the app.
2. **Where payments go in Xero:** choose the account for cash, for card (speedpoint) and for EFT (your bank account).
3. **Link & start syncing** (once). It matches customers by name and invoices, credit notes and quotes by number, then sends whatever Xero does not have yet over the next while. Receipts recorded before today are treated as already in Xero.

## Good to know

- **VAT to the cent:** the app works out VAT on the invoice total; each line sent to Xero carries its share of that VAT, so Xero's total always equals the app's. *Fix cent differences* (Settings → Xero) corrects older unpaid invoices that were a cent or two off.

- **Receipts not in Xero yet**: includes overpayments recorded before this update — send them from the same list.
- **Receipts recorded before the link** (Settings → Xero → *Check earlier receipts*): for invoices that were still drafts in Xero when you linked, the payments were never sent. Approve the drafts in Xero, press *Check earlier receipts*, untick anything you already entered in Xero yourself, and *Send*. Only receipts on approved invoices that Xero still shows as owing are offered.

- **EFT:** a receipt you save in the app (also from Bank import) becomes a payment in your bank account in Xero; in Xero's bank reconciliation choose **Match** for that bank-feed line. If instead you reconcile an EFT in Xero with *Create/Add payment*, that payment comes back to the app as a receipt. Use one of the two for each payment, not both.
- **Draft invoices in Xero** (old CSV imports) cannot take payments until approved. The app shows the error; approve the invoice in Xero and press **Retry**.
- **Errors** (e.g. Xero refuses something) are listed under Settings → Xero with a **Retry** button.
- Invoices in the Quotes & invoicing list show **Xero ✓**, **Xero ⚠ not accepted**, or **voided in Xero**.
- The CSV exports still work, and anything already sent to Xero by the sync is marked as exported, so the CSVs leave it out.
- **Disconnect** (Settings → Xero) stops the sync; nothing is deleted on either side.
