'use strict';
/*
 * Xero sync — connection (OAuth 2), API calls and the push / pull logic.
 * Server-only state lives in xero/* documents, which the Firestore rules keep closed to browsers.
 *   xero/connection  tokens, tenant, linkedAt (go-live), lastPullAt
 *   xero/oauth       one-time state while connecting
 *   xero/meta        cached tax types, tracking options, account list
 *   xero/usage       API calls today (Xero's free tier allows 1,000 per day)
 */
const X = require('./xero');

const API = 'https://api.xero.com/api.xro/2.0';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const DAILY_LIMIT = 900; // stay under Xero's 1,000 calls/day

function makeSync({ db, admin, logger, clientId, clientSecret, scopes }) {
  const FieldValue = admin.firestore.FieldValue;
  const connRef = db.doc('xero/connection');

  /* ---------------- tokens ---------------- */
  async function tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(clientId() + ':' + clientSecret()).toString('base64') },
      body: new URLSearchParams(params).toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error('Xero sign-in failed: ' + (json.error_description || json.error || res.status)); e.kind = 'auth'; throw e; }
    return json;
  }
  async function connection() { const s = await connRef.get(); return s.exists ? s.data() : null; }
  async function accessToken(force) {
    const c = await connection();
    if (!c || !c.refreshToken) { const e = new Error('Xero is not connected'); e.kind = 'notconnected'; throw e; }
    if (!force && c.accessToken && c.expiresAt > Date.now() + 60000) return { token: c.accessToken, tenantId: c.tenantId };
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refreshToken });
    await connRef.set({ accessToken: t.access_token, refreshToken: t.refresh_token || c.refreshToken, expiresAt: Date.now() + (Number(t.expires_in) || 1800) * 1000 }, { merge: true });
    return { token: t.access_token, tenantId: c.tenantId };
  }

  /* ---------------- API ---------------- */
  async function countCall() {
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.doc('xero/usage');
    const n = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref); const d = s.exists ? s.data() : {};
      const calls = d.day === today ? (d.calls || 0) + 1 : 1;
      tx.set(ref, { day: today, calls });
      return calls;
    });
    if (n > DAILY_LIMIT) { const e = new Error('Daily Xero limit reached — syncing continues tomorrow'); e.kind = 'rate'; throw e; }
  }
  async function api(method, path, body, opts) {
    opts = opts || {};
    await countCall();
    let tok = await accessToken(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { Authorization: 'Bearer ' + tok.token, 'xero-tenant-id': tok.tenantId, Accept: 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      if (opts.since) headers['If-Modified-Since'] = new Date(opts.since).toUTCString();
      if (opts.idem) headers['Idempotency-Key'] = String(opts.idem).slice(0, 128);
      const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (res.status === 401 && attempt === 0) { tok = await accessToken(true); continue; }
      if (res.status === 304) return { notModified: true };
      const json = await res.json().catch(() => null);
      if (res.ok) return json || {};
      const e = new Error(X.xeroErrorText(json, res.status));
      e.status = res.status;
      e.kind = res.status === 429 ? 'rate' : (res.status >= 500 ? 'retry' : (res.status === 401 || res.status === 403 ? 'auth' : 'invalid'));
      throw e;
    }
  }
  async function pageAll(path, key, since) {
    const out = [];
    for (let page = 1; page < 60; page++) {
      const r = await api('GET', path + (path.includes('?') ? '&' : '?') + 'page=' + page, null, { since });
      if (r.notModified) break;
      const list = r[key] || [];
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }
  function q(v) { return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

  /* ---------------- settings cached from Xero ---------------- */
  async function meta(cfg, refresh) {
    const ref = db.doc('xero/meta');
    const s = await ref.get();
    let m = s.exists ? s.data() : null;
    if (!m || refresh || !m.at || Date.now() - m.at > 24 * 3600 * 1000) {
      const [tr, tc] = await Promise.all([api('GET', '/TaxRates'), api('GET', '/TrackingCategories')]);
      m = { at: Date.now(), taxRates: (tr.TaxRates || []).filter((t) => t.Status === 'ACTIVE').map((t) => ({ name: t.Name, type: t.TaxType, rate: Number(t.EffectiveRate) || 0, report: t.ReportTaxType || '' })),
        tracking: (tc.TrackingCategories || []).filter((t) => t.Status === 'ACTIVE').map((t) => ({ name: t.Name, options: (t.Options || []).filter((o) => o.Status === 'ACTIVE').map((o) => o.Name) })) };
      await ref.set(m);
    }
    const find = (name, fallbackFn) => (m.taxRates.find((t) => t.name.toLowerCase() === String(name || '').toLowerCase()) || m.taxRates.find(fallbackFn) || {}).type;
    const vatRate = Number(cfg.vatRate) || 15;
    const trackName = cfg.xeroTrackingName || 'Sales Rep';
    return {
      taxVat: find(cfg.xeroTaxVat || 'Standard Rate Sales', (t) => t.report === 'OUTPUT' && Math.abs(t.rate - vatRate) < 0.01) || 'OUTPUT',
      taxNoVat: find(cfg.xeroTaxNoVat || 'No VAT', (t) => t.type === 'NONE') || 'NONE',
      tracking: m.tracking.find((t) => t.name.toLowerCase() === trackName.toLowerCase()) || null,
      vatRate,
      accountCode: cfg.accountCode || '200',
      currency: cfg.currency || 'ZAR',
    };
  }
  async function cfgOf() { const s = await db.doc('config/business').get(); return s.exists ? s.data() : {}; }

  /* ---------------- status helpers ---------------- */
  function stamp(field, status, extra) {
    return Object.assign({ [field]: Object.assign({ status, at: new Date().toISOString(), error: '' }, extra || {}) });
  }
  function errStatus(e) { return e.kind === 'rate' || e.kind === 'retry' ? 'retry' : 'error'; }

  /* ---------------- contacts ---------------- */
  async function findContactByName(name) {
    const r = await api('GET', '/Contacts?where=' + encodeURIComponent('Name=="' + q(name) + '"') + '&summaryOnly=true');
    return (r.Contacts || [])[0] || null;
  }
  async function pushCustomer(ref, c, opts) {
    opts = opts || {};
    if (!X.contactPayload(c).Name) return null;
    const payload = X.contactPayload(c);
    const hash = X.hashOf(payload);
    if (c.xeroContactId && c.xero && c.xero.hash === hash && !opts.force) return c.xeroContactId;
    try {
      let id = c.xeroContactId;
      if (!id) { const found = await findContactByName(payload.Name); if (found) id = found.ContactID; }
      const body = id ? Object.assign({ ContactID: id }, payload) : payload;
      const r = await api('POST', '/Contacts', { Contacts: [body] });
      id = ((r.Contacts || [])[0] || {}).ContactID || id;
      await ref.set(Object.assign({ xeroContactId: id }, stamp('xero', 'synced', { hash })), { merge: true });
      return id;
    } catch (e) {
      await ref.set(stamp('xero', errStatus(e), { error: e.message }), { merge: true });
      throw e;
    }
  }
  async function contactIdForOrder(o) {
    if (o.customerId) {
      const ref = db.doc('customers/' + o.customerId);
      const s = await ref.get();
      if (s.exists) return pushCustomer(ref, s.data());
    }
    const name = String(o.customerName || '').trim();
    if (!name) { const e = new Error('The job has no customer'); e.kind = 'invalid'; throw e; }
    const found = await findContactByName(name);
    if (found) return found.ContactID;
    const r = await api('POST', '/Contacts', { Contacts: [{ Name: name }] });
    return r.Contacts[0].ContactID;
  }

  /* ---------------- invoices & quotes ---------------- */
  async function pushInvoice(ref, o, cfg, ctx0, force) {
    if (!X.hasInvoiceDoc(o)) return;
    try {
      const ctx = Object.assign({}, ctx0, { contactId: await contactIdForOrder(o) });
      const payload = X.invoicePayload(o, cfg, ctx);
      const hash = X.docHash(payload);
      if (!force && o.xeroInvoiceId && o.xeroInv && o.xeroInv.hash === hash) return;
      let id = o.xeroInvoiceId, created = !!(o.xeroInv && o.xeroInv.created);
      if (!id) {
        const f = await api('GET', '/Invoices?InvoiceNumbers=' + encodeURIComponent(o.invoiceNumber));
        const ex = (f.Invoices || []).find((i) => i.Type === 'ACCREC' && i.Status !== 'DELETED');
        if (ex) id = ex.InvoiceID;
      }
      const body = id ? Object.assign({ InvoiceID: id }, payload) : payload;
      const r = await api('POST', '/Invoices', { Invoices: [body] }, { idem: id ? null : 'inv-' + ref.id + '-' + hash });
      const inv = (r.Invoices || [])[0] || {};
      if (!id) created = true;
      id = inv.InvoiceID || id;
      await ref.set(Object.assign({ xeroInvoiceId: id, xeroInvoiceStatus: inv.Status || 'AUTHORISED', xeroExportedAt: o.xeroExportedAt || new Date().toISOString(), xeroExportFile: o.xeroExportFile || 'Xero (live sync)' },
        stamp('xeroInv', 'synced', { hash, created })), { merge: true });
      // receipts that were waiting for this invoice can go now
      // (if the app just created the invoice in Xero, its earlier receipts belong in Xero too)
      const again = created ? ['waiting', 'retry', 'error', 'pending', 'skipped', 'overpayment'] : ['waiting', 'retry', 'error', 'pending', 'overpayment'];
      const waiting = await db.collection('receipts').where('orderId', '==', ref.id).get();
      for (const d of waiting.docs) {
        const r2 = d.data();
        if (r2.xeroPaymentId || r2.fromXero || r2.kind === 'onaccount' || (r2.xero && !again.includes(r2.xero.status))) continue;
        await db.doc('receipts/' + d.id).set({ xero: { status: 'pending', at: new Date().toISOString() } }, { merge: true });
        try { await pushOne('receipts', d.id); } catch (e2) { /* left as retry/error for the sweep */ }
      }
    } catch (e) {
      await ref.set(stamp('xeroInv', errStatus(e), { error: e.message, hash: (o.xeroInv && o.xeroInv.hash) || '' }), { merge: true });
      if (e.kind === 'notconnected') return;
      throw e;
    }
  }
  async function pushQuote(ref, o, cfg, ctx0) {
    if (!X.hasQuoteDoc(o)) return;
    try {
      const ctx = Object.assign({}, ctx0, { contactId: await contactIdForOrder(o) });
      const payload = X.quotePayload(o, cfg, ctx);
      const hash = X.docHash(payload);
      if (o.xeroQuoteId && o.xeroQuote && o.xeroQuote.hash === hash) return;
      let id = o.xeroQuoteId;
      if (!id) {
        const f = await api('GET', '/Quotes?QuoteNumber=' + encodeURIComponent(o.quoteNumber));
        const ex = (f.Quotes || []).find((x) => x.QuoteNumber === o.quoteNumber && x.Status !== 'DELETED');
        if (ex) id = ex.QuoteID;
      }
      const body = id ? Object.assign({ QuoteID: id }, payload) : payload;
      let r;
      try { r = await api('POST', '/Quotes', { Quotes: [body] }); }
      catch (e) {
        // Xero only allows some status changes (e.g. not back from ACCEPTED); keep the content in step anyway.
        if (id && e.kind === 'invalid') { const b2 = Object.assign({}, body); delete b2.Status; r = await api('POST', '/Quotes', { Quotes: [b2] }); } else throw e;
      }
      id = ((r.Quotes || [])[0] || {}).QuoteID || id;
      await ref.set(Object.assign({ xeroQuoteId: id }, stamp('xeroQuote', 'synced', { hash })), { merge: true });
    } catch (e) {
      await ref.set(stamp('xeroQuote', errStatus(e), { error: e.message, hash: (o.xeroQuote && o.xeroQuote.hash) || '' }), { merge: true });
      if (e.kind === 'notconnected') return;
      throw e;
    }
  }

  /* ---------------- credit notes ---------------- */
  async function pushCreditNote(ref, c, cfg, ctx0) {
    try {
      const os = c.orderId ? await db.doc('orders/' + c.orderId).get() : null;
      const o = os && os.exists ? os.data() : { customerId: c.customerId, customerName: c.customerName };
      const ctx = Object.assign({}, ctx0, { contactId: await contactIdForOrder(o) });
      const payload = X.creditNotePayload(c, cfg, ctx);
      const hash = X.docHash(payload);
      if (c.xeroCreditNoteId && c.xero && c.xero.hash === hash) return;
      if (!c.xeroCreditNoteId && c.voided) { await ref.set(stamp('xero', 'void', { hash }), { merge: true }); return; }
      let id = c.xeroCreditNoteId;
      if (!id) {
        const f = await api('GET', '/CreditNotes?where=' + encodeURIComponent('CreditNoteNumber=="' + q(c.number) + '"'));
        const ex = (f.CreditNotes || [])[0];
        if (ex) id = ex.CreditNoteID;
      }
      const body = id ? Object.assign({ CreditNoteID: id }, payload) : payload;
      const r = await api('POST', '/CreditNotes', { CreditNotes: [body] });
      const cn = (r.CreditNotes || [])[0] || {};
      const isNew = !c.xeroCreditNoteId;
      id = cn.CreditNoteID || id;
      let allocated = !!(c.xero && c.xero.allocated);
      // apply the credit to its invoice
      if (!c.voided && !allocated && os && os.exists && os.data().xeroInvoiceId) {
        const inv = (await api('GET', '/Invoices/' + os.data().xeroInvoiceId)).Invoices[0];
        const amt = X.round2(Math.min(Number(cn.RemainingCredit != null ? cn.RemainingCredit : c.total) || 0, Number(inv.AmountDue) || 0));
        if (amt > 0.004) {
          await api('PUT', '/CreditNotes/' + id + '/Allocations', { Allocations: [{ Amount: amt, Date: c.date, Invoice: { InvoiceID: inv.InvoiceID } }] });
        }
        allocated = true;
      }
      await ref.set(Object.assign({ xeroCreditNoteId: id, xeroExportedAt: c.xeroExportedAt || new Date().toISOString(), xeroExportFile: c.xeroExportFile || 'Xero (live sync)' },
        stamp('xero', (!allocated && !c.voided) ? 'waiting' : 'synced', { hash, allocated, created: isNew || !!(c.xero && c.xero.created), error: (!allocated && !c.voided) ? 'Credit note is in Xero; it will be applied once the invoice reaches Xero' : '' })), { merge: true });
    } catch (e) {
      await ref.set(stamp('xero', errStatus(e), { error: e.message, hash: (c.xero && c.xero.hash) || '' }), { merge: true });
      if (e.kind === 'notconnected') return;
      throw e;
    }
  }

  /* ---------------- receipts → payments ---------------- */
  async function pushReceipt(ref, r, cfg, conn) {
    try {
      const os = r.orderId ? await db.doc('orders/' + r.orderId).get() : null;
      const order = os && os.exists ? os.data() : null;
      const src = r.method === 'alloc' && r.sourceReceiptId ? ((await db.doc('receipts/' + r.sourceReceiptId).get()).data() || null) : null;
      const plan = X.receiptPlan(r, order, conn.linkedAt, src);
      if (plan.action === 'skip') { if (!r.xero || r.xero.status !== plan.status) await ref.set(stamp('xero', plan.status, { note: plan.note }), { merge: true }); return; }
      if (plan.action === 'wait') { await ref.set(stamp('xero', 'waiting', { note: plan.note }), { merge: true }); return; }
      if (plan.action === 'delete') {
        if (r.xero && r.xero.status === 'deleted') return;
        await api('POST', '/Payments/' + r.xeroPaymentId, { Payments: [{ PaymentID: r.xeroPaymentId, Status: 'DELETED' }] });
        await ref.set(stamp('xero', 'deleted'), { merge: true });
        return;
      }
      if (plan.action === 'deleteOver') return removeOverpayment(ref, r);
      if (plan.action === 'overpay') return sendOverpayment(ref, r, cfg, order);
      if (plan.action === 'allocate') return allocateOverpayment(ref, r, order, plan.from, src);
      const acct = X.paymentAccountFor(r, cfg, src);
      if (!acct.id) { const e = new Error('Choose the Xero account for ' + acct.label + ' payments under Settings → Xero'); e.kind = 'invalid'; throw e; }
      const body = X.paymentPayload(r, { invoiceId: order.xeroInvoiceId, accountId: acct.id, date: src ? src.date : r.date });
      const res = await api('PUT', '/Payments', { Payments: [body] }, { idem: 'pay-' + ref.id });
      const p = (res.Payments || [])[0] || {};
      await ref.set(Object.assign({ xeroPaymentId: p.PaymentID || '' }, stamp('xero', 'synced')), { merge: true });
    } catch (e) {
      await ref.set(stamp('xero', errStatus(e), { error: e.message }), { merge: true });
      if (e.kind === 'notconnected') return;
      throw e;
    }
  }

  /* ---------------- overpayments: money with no invoice in Xero yet ---------------- */
  async function sendOverpayment(ref, r, cfg, order) {
    const acct = X.paymentAccountFor(r, cfg, null);
    if (!acct.id) { const e = new Error('Choose the Xero account for ' + acct.label + ' payments under Settings → Xero'); e.kind = 'invalid'; throw e; }
    let amount = X.round2(r.amount);
    if (r.kind === 'onaccount') {
      // parts already allocated before this goes to Xero went (or were taken) as ordinary payments
      const allocs = await db.collection('receipts').where('sourceReceiptId', '==', ref.id).get();
      allocs.docs.forEach((d) => { const a = d.data(); if (!a.voided && !a.xeroAllocId && (a.xeroPaymentId || (a.xero && a.xero.status === 'skipped'))) amount = X.round2(amount - (Number(a.amount) || 0)); });
    }
    if (amount <= 0) { await ref.set(stamp('xero', 'synced', { note: 'Fully allocated already' }), { merge: true }); return; }
    const who = order || { customerId: r.customerId, customerName: r.customerName };
    const contactId = await contactIdForOrder(who);
    const body = X.overpaymentPayload(r, { contactId, accountId: acct.id, amount, currency: cfg.currency || 'ZAR' });
    const res = await api('PUT', '/BankTransactions', { BankTransactions: [body] }, { idem: 'over-' + ref.id });
    const bt = (res.BankTransactions || [])[0] || {};
    if (!bt.OverpaymentID) { const e = new Error('Xero did not return the overpayment'); e.kind = 'retry'; throw e; }
    await ref.set(Object.assign({ xeroOverpaymentId: bt.OverpaymentID, xeroBankTxnId: bt.BankTransactionID || '', xeroOverAmount: amount }, stamp('xero', 'overpayment', { note: 'Overpayment in Xero' })), { merge: true });
    const now = Object.assign({}, r, { xeroOverpaymentId: bt.OverpaymentID });
    // a deposit whose invoice is already in Xero: apply it straight away
    if (r.kind !== 'onaccount' && order && order.xeroInvoiceId) await allocateOverpayment(ref, now, order, bt.OverpaymentID, null);
    // allocations of this overpayment that were waiting for it
    if (r.kind === 'onaccount') {
      const allocs = await db.collection('receipts').where('sourceReceiptId', '==', ref.id).get();
      for (const d of allocs.docs) {
        const a = d.data(); if (a.voided || a.xeroAllocId || a.xeroPaymentId || !(a.xero && a.xero.status === 'waiting')) continue;
        await d.ref.set({ xero: { status: 'pending', at: new Date().toISOString() } }, { merge: true });
        try { await pushOne('receipts', d.id); } catch (e2) { /* left for the sweep */ }
      }
    }
  }
  // Apply (part of) an overpayment to an invoice. r is either the deposit itself or an allocation receipt.
  async function allocateOverpayment(ref, r, order, overId, src) {
    const [ov, inv] = await Promise.all([api('GET', '/Overpayments/' + overId), api('GET', '/Invoices/' + order.xeroInvoiceId)]);
    const o = (ov.Overpayments || [])[0] || {}; const i = (inv.Invoices || [])[0] || {};
    const credit = Number(o.RemainingCredit) || 0, due = Number(i.AmountDue) || 0;
    if (i.Status === 'DRAFT' || i.Status === 'SUBMITTED') { const e = new Error('Invoice ' + (order.invoiceNumber || '') + ' is still a draft in Xero — approve it, then Retry'); e.kind = 'invalid'; throw e; }
    const want = X.round2(r.method === 'alloc' ? r.amount : Math.min(Number(r.xeroOverAmount) || Number(r.amount) || 0, credit));
    const amount = X.round2(Math.min(want, credit, due));
    if (amount <= 0) {
      if (r.method === 'alloc') { const e = new Error(credit <= 0 ? 'Nothing left on the overpayment in Xero' : 'Invoice ' + (order.invoiceNumber || '') + ' is already paid in Xero'); e.kind = 'invalid'; throw e; }
      await ref.set(stamp('xero', 'overpayment', { note: due <= 0 ? 'Invoice already paid in Xero — deposit left as an overpayment' : 'Nothing left to apply' }), { merge: true });
      return;
    }
    if (r.method === 'alloc' && amount < want) { const e = new Error('Xero has only ' + (credit < due ? 'R ' + credit.toFixed(2) + ' left on the overpayment' : 'R ' + due.toFixed(2) + ' still due on ' + (order.invoiceNumber || 'the invoice'))); e.kind = 'invalid'; throw e; }
    const date = [X.xeroDate(o.Date), X.xeroDate(i.Date), String((src && src.date) || r.date || '').slice(0, 10)].filter(Boolean).sort().pop();
    const res = await api('PUT', '/Overpayments/' + overId + '/Allocations', { Allocations: [{ Invoice: { InvoiceID: order.xeroInvoiceId }, Amount: amount, Date: date }] });
    const al = (res.Allocations || [])[0] || {};
    if (r.method === 'alloc') await ref.set(Object.assign({ xeroAllocId: al.AllocationID || 'yes', xeroAllocFrom: overId }, stamp('xero', 'synced')), { merge: true });
    else await ref.set(Object.assign({ xeroAlloc: { invoiceId: order.xeroInvoiceId, amount, allocationId: al.AllocationID || '' } }, stamp('xero', 'synced', { note: amount < want ? 'R ' + X.round2(want - amount).toFixed(2) + ' left as an overpayment in Xero' : '' })), { merge: true });
  }
  // A voided receipt: take its allocation / overpayment back out of Xero.
  async function removeOverpayment(ref, r) {
    if (r.xero && r.xero.status === 'deleted') return;
    if (r.xeroAllocId && r.xeroAllocFrom) {
      if (r.xeroAllocId !== 'yes') await api('DELETE', '/Overpayments/' + r.xeroAllocFrom + '/Allocations/' + r.xeroAllocId);
      await ref.set(stamp('xero', 'deleted'), { merge: true });
      return;
    }
    if (r.xeroAlloc && r.xeroAlloc.allocationId) await api('DELETE', '/Overpayments/' + r.xeroOverpaymentId + '/Allocations/' + r.xeroAlloc.allocationId);
    if (r.xeroBankTxnId) await api('POST', '/BankTransactions/' + r.xeroBankTxnId, { BankTransactions: [{ BankTransactionID: r.xeroBankTxnId, Status: 'DELETED' }] });
    await ref.set(stamp('xero', 'deleted'), { merge: true });
  }

  /* ---------------- one record ---------------- */
  async function pushOne(kind, id) {
    const conn = await connection();
    if (!conn || !conn.refreshToken || !conn.linkedAt) return;
    const cfg = await cfgOf();
    const ref = db.doc(kind + '/' + id);
    const s = await ref.get();
    if (!s.exists) return;
    const d = s.data();
    if (kind === 'customers') return pushCustomer(ref, d);
    if (kind === 'receipts') return pushReceipt(ref, d, cfg, conn);
    const ctx = await meta(cfg);
    if (kind === 'orders') { if (X.hasQuoteDoc(d)) await pushQuote(ref, d, cfg, ctx); if (X.hasInvoiceDoc(d)) await pushInvoice(ref, d, cfg, ctx); return; }
    if (kind === 'creditNotes') return pushCreditNote(ref, d, cfg, ctx);
  }

  /* ---------------- link what already exists (once, at go-live) ---------------- */
  async function linkExisting() {
    const conn = await connection();
    if (!conn || !conn.refreshToken) { const e = new Error('Connect Xero first'); e.kind = 'notconnected'; throw e; }
    const out = { contacts: 0, invoices: 0, creditNotes: 0, quotes: 0, toPush: 0 };
    const norm = (s) => String(s || '').trim().toLowerCase();
    const contacts = await pageAll('/Contacts?summaryOnly=true', 'Contacts');
    const byName = {}; contacts.forEach((c) => { if (c.ContactStatus !== 'ARCHIVED') byName[norm(c.Name)] = c.ContactID; });
    const invoices = await pageAll('/Invoices?where=' + encodeURIComponent('Type=="ACCREC"') + '&summaryOnly=true', 'Invoices');
    const invByNo = {}; invoices.forEach((i) => { if (i.Status !== 'DELETED') invByNo[i.InvoiceNumber] = i; });
    const cns = await pageAll('/CreditNotes?where=' + encodeURIComponent('Type=="ACCRECCREDIT"') + '&summaryOnly=true', 'CreditNotes');
    const cnByNo = {}; cns.forEach((c) => { if (c.Status !== 'DELETED') cnByNo[c.CreditNoteNumber] = c; });
    let quotes = []; try { quotes = await pageAll('/Quotes', 'Quotes'); } catch (e) { logger.warn('quotes list failed', { message: e.message }); }
    const qByNo = {}; quotes.forEach((x) => { if (x.Status !== 'DELETED') qByNo[x.QuoteNumber] = x; });
    const now = new Date().toISOString();
    const cfg = await cfgOf();

    let batch = db.batch(), n = 0;
    const flush = async () => { if (n) { await batch.commit(); batch = db.batch(); n = 0; } };
    const put = async (ref, data) => { batch.set(ref, data, { merge: true }); if (++n >= 400) await flush(); };

    const cs = await db.collection('customers').get();
    const custContact = {};
    for (const d of cs.docs) {
      const c = d.data();
      if (c.xeroContactId) { custContact[d.id] = c.xeroContactId; continue; }
      const id = byName[norm(c.name)];
      if (id) { out.contacts++; custContact[d.id] = id; await put(d.ref, Object.assign({ xeroContactId: id }, stamp('xero', 'pending'))); } // pending: send the app's details to the linked contact
      else { out.toPush++; await put(d.ref, stamp('xero', 'pending')); }
    }
    const ctx = await meta(cfg, true);
    const contactFor = (o) => (o.customerId && custContact[o.customerId]) || byName[norm(o.customerName)] || '';
    const hashFor = (fn, doc) => { const cid = contactFor(doc); return cid ? X.docHash(fn(Object.assign({}, ctx, { contactId: cid }))) : 'linked'; };
    const os = await db.collection('orders').get();
    for (const d of os.docs) {
      const o = d.data(); const patch = {};
      if (X.hasInvoiceDoc(o) && !o.xeroInvoiceId) {
        const ex = invByNo[o.invoiceNumber];
        if (ex) { out.invoices++; Object.assign(patch, { xeroInvoiceId: ex.InvoiceID, xeroInvoiceStatus: ex.Status, xeroAmountDue: Number(ex.AmountDue) || 0, xeroExportedAt: o.xeroExportedAt || now, xeroExportFile: o.xeroExportFile || 'Linked to Xero' }, stamp('xeroInv', 'synced', { hash: hashFor((c2) => X.invoicePayload(o, cfg, c2), o), created: false })); }
        else { out.toPush++; Object.assign(patch, stamp('xeroInv', 'pending')); }
      }
      if (X.hasQuoteDoc(o) && !o.xeroQuoteId) {
        const ex = qByNo[o.quoteNumber];
        if (ex) { out.quotes++; Object.assign(patch, { xeroQuoteId: ex.QuoteID }, stamp('xeroQuote', 'synced', { hash: hashFor((c2) => X.quotePayload(o, cfg, c2), o) })); }
        else { out.toPush++; Object.assign(patch, stamp('xeroQuote', 'pending')); }
      }
      if (Object.keys(patch).length) await put(d.ref, patch);
    }
    const cr = await db.collection('creditNotes').get();
    const orderById = {}; os.docs.forEach((d) => { orderById[d.id] = d.data(); });
    for (const d of cr.docs) {
      const c = d.data(); if (c.xeroCreditNoteId) continue;
      const ex = cnByNo[c.number];
      const co = orderById[c.orderId] || { customerId: c.customerId, customerName: c.customerName };
      if (ex) { out.creditNotes++; await put(d.ref, Object.assign({ xeroCreditNoteId: ex.CreditNoteID, xeroExportedAt: c.xeroExportedAt || now, xeroExportFile: c.xeroExportFile || 'Linked to Xero' }, stamp('xero', 'synced', { hash: hashFor((c2) => X.creditNotePayload(c, cfg, c2), co), allocated: true }))); }
      else if (!c.voided) { out.toPush++; await put(d.ref, stamp('xero', 'pending')); }
    }
    // Receipts already recorded are taken as already in Xero. If the app later creates a missing invoice
    // in Xero, that invoice's receipts are sent with it (see pushInvoice).
    const rs = await db.collection('receipts').get();
    for (const d of rs.docs) {
      const r = d.data(); if (r.xeroPaymentId || r.fromXero || (r.xero && r.xero.status)) continue;
      await put(d.ref, r.kind === 'onaccount' ? stamp('xero', 'onaccount', { note: 'Overpayment — goes to Xero when it is allocated to an invoice' }) : stamp('xero', 'skipped', { note: 'Recorded before the Xero link — assumed already in Xero' }));
    }
    await flush();
    await connRef.set({ linkedAt: conn.linkedAt || now, lastPullAt: conn.lastPullAt || now, linkResult: out }, { merge: true });
    logger.info('xero link', out);
    return out;
  }

  /* ---------------- sweep: push pending / retry, a few at a time ---------------- */
  async function sweep(limit) {
    const conn = await connection();
    if (!conn || !conn.refreshToken || !conn.linkedAt) return { pushed: 0 };
    limit = limit || 25;
    let pushed = 0, failed = 0;
    const jobs = [
      ['customers', 'xero.status'], ['orders', 'xeroQuote.status'], ['orders', 'xeroInv.status'], ['creditNotes', 'xero.status'], ['receipts', 'xero.status'],
    ];
    for (const [coll, field] of jobs) {
      if (pushed + failed >= limit) break;
      const snap = await db.collection(coll).where(field, 'in', ['pending', 'retry']).limit(limit - pushed - failed).get();
      for (const d of snap.docs) {
        try { await pushOne(coll, d.id); pushed++; }
        catch (e) { failed++; if (e.kind === 'rate' || e.kind === 'auth' || e.kind === 'notconnected') return { pushed, failed, stopped: e.message }; }
      }
    }
    return { pushed, failed };
  }

  /* ---------------- pull: what changed in Xero ---------------- */
  async function nextReceiptNumber() {
    const ref = db.doc('config/business');
    return db.runTransaction(async (tx) => {
      const s = await tx.get(ref); const n = Number((s.exists && s.data().nextReceiptNumber) || 1);
      tx.set(ref, { nextReceiptNumber: n + 1 }, { merge: true });
      return n;
    });
  }
  async function pull() {
    const conn = await connection();
    if (!conn || !conn.refreshToken || !conn.linkedAt) return { skipped: true };
    const since = conn.lastPullAt || conn.linkedAt;
    const started = new Date().toISOString();
    const cfg = await cfgOf();
    const out = { payments: 0, paymentsRemoved: 0, contacts: 0, newCustomers: 0, invoices: 0 };

    // payments made or deleted in Xero (bank reconciliation, Xero "Add payment")
    const pays = await pageAll('/Payments?where=' + encodeURIComponent('PaymentType=="ACCRECPAYMENT"'), 'Payments', since);
    for (const p of pays) {
      const invId = p.Invoice && p.Invoice.InvoiceID; if (!invId) continue;
      const mine = await db.collection('receipts').where('xeroPaymentId', '==', p.PaymentID).limit(1).get();
      if (!mine.empty) {
        const r = mine.docs[0].data();
        if (p.Status === 'DELETED' && !r.voided && !(r.xero && r.xero.status === 'deleted')) {
          await mine.docs[0].ref.set({ voided: true, voidReason: 'Payment deleted in Xero', voidedAt: started, xero: { status: 'deleted', at: started } }, { merge: true });
          out.paymentsRemoved++;
        }
        continue;
      }
      if (p.Status === 'DELETED') continue;
      const ref = String(p.Reference || '');
      const m = /DSX-R\d+/.exec(ref);
      if (m) { const byNo = await db.collection('receipts').where('number', '==', m[0]).limit(1).get(); if (!byNo.empty) { await byNo.docs[0].ref.set({ xeroPaymentId: p.PaymentID }, { merge: true }); continue; } }
      const os = await db.collection('orders').where('xeroInvoiceId', '==', invId).limit(1).get();
      if (os.empty) continue;
      const o = os.docs[0].data();
      const acctId = p.Account && p.Account.AccountID;
      const method = acctId && acctId === cfg.xeroPayCash ? 'cash' : (acctId && acctId === cfg.xeroPayCard ? 'card' : 'eft');
      const n = await nextReceiptNumber();
      await db.collection('receipts').add({
        number: 'DSX-R' + String(n).padStart(4, '0'), date: X.xeroDate(p.Date), createdAt: started, amount: X.round2(p.Amount), method,
        orderId: os.docs[0].id, jobNumber: o.jobNumber || '', jobTitle: o.title || '', invoiceNumber: o.invoiceNumber || '', kind: 'payment',
        customerId: o.customerId || null, customerName: o.customerName || '', phone: o.phone || '',
        note: ('Recorded in Xero' + (ref ? ' — ' + ref : '') + (p.Account && p.Account.Code ? ' (account ' + p.Account.Code + ')' : '')).slice(0, 300),
        receivedBy: 'Xero', receivedById: 'xero', voided: false, cashupDate: null, fromXero: true, xeroPaymentId: p.PaymentID,
        xero: { status: 'synced', at: started },
      });
      out.payments++;
    }

    // invoice status changes in Xero (voided / deleted / paid)
    const invs = await pageAll('/Invoices?where=' + encodeURIComponent('Type=="ACCREC"') + '&summaryOnly=true', 'Invoices', since);
    for (const i of invs) {
      const os = await db.collection('orders').where('xeroInvoiceId', '==', i.InvoiceID).limit(1).get();
      if (os.empty) continue;
      const cur = os.docs[0].data();
      if (cur.xeroInvoiceStatus !== i.Status || cur.xeroAmountDue !== Number(i.AmountDue)) {
        await os.docs[0].ref.set({ xeroInvoiceStatus: i.Status, xeroAmountDue: Number(i.AmountDue) || 0 }, { merge: true });
        out.invoices++;
      }
    }

    // contact changes in Xero, and new customers added in Xero
    const cons = await pageAll('/Contacts', 'Contacts', since);
    for (const x of cons) {
      if (x.ContactStatus === 'ARCHIVED') continue;
      const ex = await db.collection('customers').where('xeroContactId', '==', x.ContactID).limit(1).get();
      const fields = X.customerFromContact(x);
      if (!ex.empty) {
        const cur = ex.docs[0].data();
        const merged = Object.assign({}, cur, fields);
        const hash = X.hashOf(X.contactPayload(merged));
        if (cur.xero && cur.xero.hash === hash) continue;
        await ex.docs[0].ref.set(Object.assign({}, fields, { updatedAt: started.slice(0, 10), xero: { status: 'synced', at: started, hash, error: '' } }), { merge: true });
        out.contacts++;
      } else if (x.IsCustomer && fields.name) {
        const byName = await db.collection('customers').where('name', '==', fields.name).limit(1).get();
        if (!byName.empty) { await byName.docs[0].ref.set({ xeroContactId: x.ContactID }, { merge: true }); continue; }
        const rec = Object.assign({ type: fields.vatNumber || fields.regNumber ? 'business' : 'individual', notes: '', contacts: [], deliverySame: fields.deliverySame !== false,
          createdAt: started.slice(0, 10), updatedAt: started.slice(0, 10), createdById: 'xero', createdByName: 'Xero', xeroContactId: x.ContactID }, fields);
        rec.xero = { status: 'synced', at: started, hash: X.hashOf(X.contactPayload(rec)), error: '' };
        await db.collection('customers').add(rec);
        out.newCustomers++;
      }
    }
    await connRef.set({ lastPullAt: started, lastPullResult: out }, { merge: true });
    return out;
  }

  /* ---------------- connect / disconnect ---------------- */
  function authUrl(state, redirectUri) {
    const p = new URLSearchParams({ response_type: 'code', client_id: clientId(), redirect_uri: redirectUri, scope: scopes(), state });
    return 'https://login.xero.com/identity/connect/authorize?' + p.toString();
  }
  async function finishConnect(code, redirectUri) {
    const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const res = await fetch('https://api.xero.com/connections', { headers: { Authorization: 'Bearer ' + t.access_token, Accept: 'application/json' } });
    const tenants = await res.json().catch(() => []);
    const ten = (Array.isArray(tenants) ? tenants : []).filter((x) => x.tenantType === 'ORGANISATION');
    const pick = ten.find((x) => /dsignx/i.test(x.tenantName)) || ten[0];
    if (!pick) throw new Error('No Xero organisation was shared with the app');
    await connRef.set({ tenantId: pick.tenantId, tenantName: pick.tenantName, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (Number(t.expires_in) || 1800) * 1000,
      connectedAt: new Date().toISOString(), connectionId: pick.id || '' }, { merge: true });
    return pick.tenantName;
  }
  async function disconnect() {
    const c = await connection();
    if (c && c.refreshToken) {
      try {
        await fetch('https://identity.xero.com/connect/revocation', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(clientId() + ':' + clientSecret()).toString('base64') }, body: new URLSearchParams({ token: c.refreshToken }).toString() });
      } catch (e) { /* ignore */ }
    }
    await connRef.delete();
    await db.doc('xero/meta').delete().catch(() => {});
  }
  async function accounts() {
    const r = await api('GET', '/Accounts');
    return (r.Accounts || []).filter((a) => a.Status === 'ACTIVE' && (a.Type === 'BANK' || a.EnablePaymentsToAccount))
      .map((a) => ({ id: a.AccountID, code: a.Code || '', name: a.Name, type: a.Type, bank: a.Type === 'BANK' }));
  }
  async function status() {
    const c = await connection();
    const u = (await db.doc('xero/usage').get()).data() || {};
    if (!c || !c.refreshToken) return { connected: false };
    return { connected: true, tenantName: c.tenantName || '', connectedAt: c.connectedAt || '', linkedAt: c.linkedAt || '', lastPullAt: c.lastPullAt || '', lastPullResult: c.lastPullResult || null,
      linkResult: c.linkResult || null, callsToday: u.day === new Date().toISOString().slice(0, 10) ? (u.calls || 0) : 0 };
  }


  /* ---------------- receipts recorded before the link ---------------- */
  // Link assumed every earlier receipt was already in Xero. Invoices that were still drafts in Xero
  // (CSV imports) never got those payments. This checks each one against what Xero still shows as owing.
  async function skippedReceipts() {
    const conn = await connection();
    if (!conn || !conn.refreshToken || !conn.linkedAt) return { items: [] };
    const rs = await db.collection('receipts').where('xero.status', 'in', ['skipped', 'onaccount', 'waiting']).get();
    const recs = rs.docs.map((d) => Object.assign({ id: d.id }, d.data()))
      .filter((r) => !r.voided && !r.fromXero && !r.xeroPaymentId && !r.xeroOverpaymentId && r.method !== 'alloc' && (r.orderId || r.kind === 'onaccount'));
    const orders = {};
    const oids = Array.from(new Set(recs.map((r) => r.orderId).filter(Boolean)));
    for (let i = 0; i < oids.length; i += 100) { // read in parallel batches — hundreds of receipts must fit in the app's wait time
      const snaps = await Promise.all(oids.slice(i, i + 100).map((id) => db.doc('orders/' + id).get()));
      snaps.forEach((s, k) => { orders[oids[i + k]] = s.exists ? s.data() : null; });
    }
    // on-account receipts: what is still unallocated
    const onacc = recs.filter((r) => r.kind === 'onaccount');
    const used = {};
    for (let i = 0; i < onacc.length; i += 100) {
      const snaps = await Promise.all(onacc.slice(i, i + 100).map((r) => db.collection('receipts').where('sourceReceiptId', '==', r.id).get()));
      snaps.forEach((snap, k) => { used[onacc[i + k].id] = snap.docs.reduce((a, d) => { const x = d.data(); return a + (!x.voided && !x.xeroAllocId && (x.xeroPaymentId || (x.xero && x.xero.status === 'skipped')) ? Number(x.amount) || 0 : 0); }, 0); });
    }
    const invIds = Array.from(new Set(recs.map((r) => r.kind !== 'onaccount' && orders[r.orderId] && orders[r.orderId].xeroInvoiceId).filter(Boolean)));
    const inXero = {};
    for (let i = 0; i < invIds.length; i += 40) {
      const res = await api('GET', '/Invoices?IDs=' + invIds.slice(i, i + 40).join(',') + '&summaryOnly=true');
      (res.Invoices || []).forEach((x) => { inXero[x.InvoiceID] = x; });
    }
    const left = {}; Object.keys(inXero).forEach((k) => { left[k] = Number(inXero[k].AmountDue) || 0; });
    recs.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.number).localeCompare(String(b.number)));
    const items = recs.map((r) => {
      const o = (r.orderId && orders[r.orderId]) || {};
      const it = { id: r.id, number: r.number || '', date: r.date || '', amount: X.round2(r.amount), method: r.method || '', invoiceNumber: o.invoiceNumber || r.invoiceNumber || '', customerName: r.customerName || o.customerName || '', ok: false, why: '', as: 'payment' };
      if (r.kind === 'onaccount') {
        it.as = 'overpayment'; it.amount = X.round2((Number(r.amount) || 0) - (used[r.id] || 0)); it.invoiceNumber = 'On account';
        if (it.amount <= 0) it.why = 'Fully allocated already'; else it.ok = true;
        return it;
      }
      if (!o.xeroInvoiceId) { it.as = 'overpayment'; it.invoiceNumber = o.invoiceNumber || ('Deposit ' + (o.jobNumber || r.jobNumber || '')).trim(); it.ok = true; return it; }
      if ((r.xero || {}).status === 'waiting') { it.why = 'Waiting for the invoice'; return it; }
      const x = inXero[o.xeroInvoiceId];
      if (!x) it.why = 'Invoice not in Xero';
      else if (x.Status === 'DRAFT' || x.Status === 'SUBMITTED') it.why = 'Invoice is still a draft in Xero — approve it first';
      else if (x.Status === 'PAID') it.why = 'Already fully paid in Xero';
      else if (x.Status !== 'AUTHORISED') it.why = 'Invoice is ' + String(x.Status).toLowerCase() + ' in Xero';
      else if (it.amount > left[x.InvoiceID] + 0.005) it.why = left[x.InvoiceID] > 0 ? 'Xero shows only R ' + left[x.InvoiceID].toFixed(2) + ' still due' : 'Already paid in Xero';
      else { it.ok = true; left[x.InvoiceID] = X.round2(left[x.InvoiceID] - it.amount); }
      return it;
    });
    return { items };
  }
  async function sendSkipped(ids) {
    let queued = 0;
    const list = (ids || []).slice(0, 1000);
    for (let i = 0; i < list.length; i += 100) {
      const done = await Promise.all(list.slice(i, i + 100).map(async (id) => {
        const ref = db.doc('receipts/' + id); const s = await ref.get(); if (!s.exists) return 0;
        const r = s.data(); if (!r.xero || !['skipped', 'onaccount', 'waiting'].includes(r.xero.status) || r.xeroPaymentId || r.xeroOverpaymentId) return 0;
        await ref.set(Object.assign({ xeroSendLate: true }, stamp('xero', 'pending')), { merge: true });
        return 1;
      }));
      queued += done.reduce((a, b) => a + b, 0);
    }
    return { queued };
  }


  /* ---------------- VAT rounding: make Xero's invoice totals equal the app's ---------------- */
  async function fixRounding() {
    const conn = await connection();
    if (!conn || !conn.refreshToken || !conn.linkedAt) return { checked: 0, fixed: [], locked: [] };
    const cfg = await cfgOf(); const ctx = await meta(cfg);
    const rate = Number(cfg.vatRate) || 15, vendor = !!String(cfg.businessVatNumber || '').trim();
    const os = await db.collection('orders').get();
    const mine = os.docs.filter((d) => { const o = d.data(); return o.xeroInvoiceId && X.hasInvoiceDoc(o); });
    const byId = {}; mine.forEach((d) => { byId[d.data().xeroInvoiceId] = d; });
    const ids = Object.keys(byId); const out = { checked: 0, fixed: [], locked: [], failed: [] };
    for (let i = 0; i < ids.length; i += 40) {
      const res = await api('GET', '/Invoices?IDs=' + ids.slice(i, i + 40).join(',') + '&summaryOnly=true');
      for (const x of (res.Invoices || [])) {
        const d = byId[x.InvoiceID]; if (!d) continue; const o = d.data();
        if (x.Status !== 'AUTHORISED' && x.Status !== 'PAID') continue;
        out.checked++;
        const appTotal = X.docTotal(o.invoiceLineItems, !!o.invoiceVatEnabled && vendor, rate);
        const diff = X.round2(Number(x.Total) - appTotal);
        if (!diff || Math.abs(diff) > 0.1) continue; // only cent rounding, never real differences
        const row = { number: o.invoiceNumber, customer: o.customerName || '', app: appTotal, xero: Number(x.Total) };
        if (Number(x.AmountPaid) || Number(x.AmountCredited) || x.Status === 'PAID') { out.locked.push(row); continue; }
        try { await pushInvoice(d.ref, o, cfg, ctx, true); out.fixed.push(row); }
        catch (e) { row.error = e.message; out.failed.push(row); if (e.kind === 'rate') break; }
      }
    }
    return out;
  }

  return { api, pushOne, sweep, pull, fixRounding, skippedReceipts, sendSkipped, linkExisting, authUrl, finishConnect, disconnect, accounts, status, connection };
}

module.exports = { makeSync };
