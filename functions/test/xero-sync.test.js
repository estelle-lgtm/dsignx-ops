'use strict';
// End-to-end check of the Xero sync against a fake Xero API and an in-memory database.
const test = require('node:test');
const assert = require('node:assert');
const { makeDb } = require('./fakedb');
const { makeSync } = require('../lib/xero-sync');

function fakeXero() {
  const X = { contacts: [{ ContactID: 'XC-kroon', Name: 'Kroon Motors', ContactStatus: 'ACTIVE' }], invoices: [{ InvoiceID: 'XI-old', InvoiceNumber: 'DSX-INV0001', Type: 'ACCREC', Status: 'AUTHORISED', AmountDue: 0 }],
    creditNotes: [], quotes: [], payments: [], calls: [], nextId: 1 };
  const id = (p) => p + '-' + (X.nextId++);
  global.fetch = async (url, opts) => {
    opts = opts || {};
    const u = new URL(url); const m = opts.method || 'GET'; const body = opts.body ? (typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body) : null;
    X.calls.push(m + ' ' + u.pathname + u.search);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (u.hostname === 'identity.xero.com') return ok({ access_token: 'AT', refresh_token: 'RT2', expires_in: 1800 });
    const p = u.pathname.replace('/api.xro/2.0', '');
    const page = Number(u.searchParams.get('page') || 1);
    if (p === '/TaxRates') return ok({ TaxRates: [{ Name: 'Standard Rate Sales', TaxType: 'OUTPUT', EffectiveRate: 15, ReportTaxType: 'OUTPUT', Status: 'ACTIVE' }, { Name: 'No VAT', TaxType: 'NONE', EffectiveRate: 0, Status: 'ACTIVE' }] });
    if (p === '/TrackingCategories') return ok({ TrackingCategories: [{ Name: 'Sales Rep', Status: 'ACTIVE', Options: [{ Name: 'Shanya', Status: 'ACTIVE' }] }] });
    if (p === '/Contacts' && m === 'GET') {
      const w = u.searchParams.get('where');
      if (w) { const n = /Name=="(.*)"/.exec(w)[1]; return ok({ Contacts: X.contacts.filter((c) => c.Name === n) }); }
      return ok({ Contacts: page === 1 ? X.contacts : [] });
    }
    if (p === '/Contacts' && m === 'POST') { const c = body.Contacts[0]; if (!c.ContactID) { c.ContactID = id('XC'); X.contacts.push(Object.assign({}, c)); } return ok({ Contacts: [c] }); }
    if (p === '/Invoices' && m === 'GET') {
      const ids = u.searchParams.get('IDs');
      if (ids) return ok({ Invoices: X.invoices.filter((i) => ids.split(',').includes(i.InvoiceID)) });
      const nums = u.searchParams.get('InvoiceNumbers');
      if (nums) return ok({ Invoices: X.invoices.filter((i) => i.InvoiceNumber === nums) });
      return ok({ Invoices: page === 1 ? X.invoices : [] });
    }
    if (/^\/Invoices\/[\w-]+$/.test(p)) { const i = X.invoices.find((x) => x.InvoiceID === p.split('/')[2]); return ok({ Invoices: [i] }); }
    if (p === '/Invoices' && m === 'POST') {
      const inv = body.Invoices[0];
      if (!inv.InvoiceID) { if (X.invoices.some((i) => i.InvoiceNumber === inv.InvoiceNumber)) return { ok: false, status: 400, json: async () => ({ Elements: [{ ValidationErrors: [{ Message: 'Invoice # must be unique.' }] }] }) }; inv.InvoiceID = id('XI'); X.invoices.push(inv); }
      else Object.assign(X.invoices.find((i) => i.InvoiceID === inv.InvoiceID), inv);
      const tot = inv.LineItems.reduce((s, l) => s + l.Quantity * l.UnitAmount * (1 - (l.DiscountRate || 0) / 100), 0) * (inv.LineAmountTypes === 'Exclusive' ? 1.15 : 1);
      inv.AmountDue = Math.round(tot * 100) / 100;
      return ok({ Invoices: [Object.assign({}, inv)] });
    }
    if (p === '/CreditNotes' && m === 'GET') return ok({ CreditNotes: [] });
    if (p === '/CreditNotes' && m === 'POST') { const c = body.CreditNotes[0]; c.CreditNoteID = c.CreditNoteID || id('XCN'); X.creditNotes.push(c); return ok({ CreditNotes: [Object.assign({ RemainingCredit: 115 }, c)] }); }
    if (/^\/CreditNotes\/.+\/Allocations$/.test(p)) { X.allocations = body.Allocations; return ok({ Allocations: body.Allocations }); }
    if (p === '/Quotes' && m === 'GET') return ok({ Quotes: [] });
    if (p === '/Quotes' && m === 'POST') { const qq = body.Quotes[0]; qq.QuoteID = qq.QuoteID || id('XQ'); X.quotes.push(qq); return ok({ Quotes: [qq] }); }
    if (p === '/BankTransactions' && m === 'PUT') { const b = body.BankTransactions[0]; const ov = { OverpaymentID: id('XO'), BankTransactionID: id('XB'), RemainingCredit: b.LineItems[0].LineAmount, Date: b.Date, b }; X.overs = X.overs || {}; X.overs[ov.OverpaymentID] = ov; return ok({ BankTransactions: [{ BankTransactionID: ov.BankTransactionID, OverpaymentID: ov.OverpaymentID }] }); }
    if (/^\/BankTransactions\/.+/.test(p) && m === 'POST') { X.deletedTxn = p.split('/')[2]; return ok({ BankTransactions: [] }); }
    if (/^\/Overpayments\/[^/]+$/.test(p)) { return ok({ Overpayments: [X.overs[p.split('/')[2]]] }); }
    if (/^\/Overpayments\/[^/]+\/Allocations$/.test(p) && m === 'PUT') {
      const ov = X.overs[p.split('/')[2]]; const a = body.Allocations[0]; const inv = X.invoices.find((i) => i.InvoiceID === a.Invoice.InvoiceID);
      ov.RemainingCredit = Math.round((ov.RemainingCredit - a.Amount) * 100) / 100; inv.AmountDue = Math.round((inv.AmountDue - a.Amount) * 100) / 100;
      const al = { AllocationID: id('XA'), Amount: a.Amount, Invoice: a.Invoice }; (X.allocs = X.allocs || []).push(al); return ok({ Allocations: [al] });
    }
    if (/^\/Overpayments\/[^/]+\/Allocations\/.+/.test(p) && m === 'DELETE') { X.deletedAlloc = p.split('/')[4]; return ok({ Allocations: [] }); }
    if (p === '/Payments' && m === 'PUT') { const pay = body.Payments[0]; pay.PaymentID = id('XP'); X.payments.push(pay); return ok({ Payments: [pay] }); }
    if (p === '/Payments' && m === 'GET') return ok({ Payments: page === 1 ? X.pullPayments || [] : [] });
    if (/^\/Payments\//.test(p)) { X.deleted = p.split('/')[2]; return ok({ Payments: [] }); }
    return { ok: false, status: 404, json: async () => ({ Message: 'no route ' + p }) };
  };
  return X;
}

test('link, push, payments and pull', async () => {
  const X = fakeXero();
  const db = makeDb();
  const admin = { firestore: { FieldValue: {} } };
  const logger = { info() {}, warn() {}, error() {} };
  const xs = makeSync({ db, admin, logger, clientId: () => 'id', clientSecret: () => 'sec', scopes: () => 's' });
  db.S['config/business'] = { businessVatNumber: '4123', vatRate: 15, invoiceDueDays: 7, xeroPayCash: 'ACC-CASH', xeroPayEft: 'ACC-BANK', nextReceiptNumber: 50 };
  db.S['xero/connection'] = { refreshToken: 'RT', tenantId: 'T1', tenantName: 'DsignX' };
  db.S['customers/c1'] = { name: 'Kroon Motors', type: 'business', email: 'a@k.co.za' };
  db.S['customers/c2'] = { name: 'New Person', type: 'individual', phone: '0820000000' };
  const inv = (n, d) => ({ invoiceNumber: n, invoiceGeneratedAt: d, invoiceVatEnabled: true, invoiceLineItems: [{ description: 'Sign', qty: 1, unitPrice: 100 }, { description: 'Fit', qty: 2, unitPrice: 50 }] });
  db.S['orders/o1'] = Object.assign({ customerId: 'c1', customerName: 'Kroon Motors', designerName: 'Shanya' }, inv('DSX-INV0001', '2026-11-01'));
  db.S['orders/o2'] = Object.assign({ customerId: 'c2', customerName: 'New Person', quoteOnly: false, quoteNumber: 'DSX-Q0009', quoteGeneratedAt: '2026-11-02', lineItems: [{ description: 'Sign', qty: 1, unitPrice: 100 }] }, inv('DSX-INV0002', '2026-11-03'));
  db.S['receipts/r1'] = { number: 'DSX-R0001', orderId: 'o1', amount: 230, method: 'cash', date: '2026-11-01', kind: 'payment' };
  db.S['receipts/r2'] = { number: 'DSX-R0002', orderId: 'o2', amount: 100, method: 'eft', date: '2026-11-04', kind: 'payment' };

  const linkRes = await xs.linkExisting();
  assert.deepStrictEqual([linkRes.contacts, linkRes.invoices], [1, 1]);
  assert.strictEqual(db.S['orders/o1'].xeroInvoiceId, 'XI-old');
  assert.strictEqual(db.S['receipts/r1'].xero.status, 'skipped'); // old receipt on an invoice Xero already had
  assert.strictEqual(db.S['orders/o2'].xeroInv.status, 'pending');

  // the sweep creates what Xero did not have: contact, quote, invoice — and that invoice's earlier receipt
  await xs.sweep(30);
  const o2 = db.S['orders/o2'];
  assert.ok(o2.xeroInvoiceId && o2.xeroInv.created && o2.xeroQuoteId, 'invoice and quote created');
  const created = X.invoices.find((i) => i.InvoiceNumber === 'DSX-INV0002');
  assert.strictEqual(created.LineItems.length, 2); assert.strictEqual(created.Status, 'AUTHORISED');
  assert.strictEqual(X.contacts.filter((c) => c.Name === 'New Person').length, 1);
  assert.strictEqual(db.S['receipts/r2'].xero.status, 'synced');
  assert.strictEqual(X.payments[0].Account.AccountID, 'ACC-BANK'); assert.strictEqual(X.payments[0].Amount, 100);
  assert.strictEqual(db.S['receipts/r1'].xero.status, 'skipped');

  // unchanged → no second push; a change → update
  const before = X.calls.length;
  await xs.pushOne('orders', 'o2');
  assert.strictEqual(X.calls.filter((c, i) => i >= before && /POST \/api.xro\/2.0\/Invoices/.test(c)).length, 0);
  db.S['orders/o2'].invoiceLineItems.push({ description: 'Extra', qty: 1, unitPrice: 10 });
  await xs.pushOne('orders', 'o2');
  assert.strictEqual(X.invoices.find((i) => i.InvoiceNumber === 'DSX-INV0002').LineItems.length, 3);

  // a new receipt after go-live goes straight to Xero; void deletes it
  db.S['receipts/r3'] = { number: 'DSX-R0003', orderId: 'o1', amount: 50, method: 'cash', date: '2099-01-01', kind: 'payment' };
  await xs.pushOne('receipts', 'r3');
  assert.strictEqual(db.S['receipts/r3'].xero.status, 'synced'); assert.strictEqual(X.payments[1].Account.AccountID, 'ACC-CASH');
  db.S['receipts/r3'].voided = true;
  await xs.pushOne('receipts', 'r3');
  assert.strictEqual(X.deleted, db.S['receipts/r3'].xeroPaymentId); assert.strictEqual(db.S['receipts/r3'].xero.status, 'deleted');

  // credit note: created and applied to its invoice
  db.S['creditNotes/cn1'] = { number: 'DSX-CN0001', orderId: 'o2', invoiceNumber: 'DSX-INV0002', date: '2099-01-02', vatEnabled: true, total: 115, items: [{ description: 'Refund', qty: 1, unitPrice: 100 }] };
  await xs.pushOne('creditNotes', 'cn1');
  assert.strictEqual(db.S['creditNotes/cn1'].xero.status, 'synced'); assert.ok(X.allocations && X.allocations[0].Amount > 0);

  // pull: a payment entered in Xero (bank reconciliation) becomes a receipt; our own payment is not doubled
  X.pullPayments = [
    { PaymentID: 'XP-bank', Status: 'AUTHORISED', Amount: 40, Date: '/Date(4102444800000+0000)/', Reference: 'FNB EFT', Invoice: { InvoiceID: 'XI-old' }, Account: { AccountID: 'ACC-BANK', Code: '090' } },
    { PaymentID: X.payments[0].PaymentID, Status: 'AUTHORISED', Amount: 100, Invoice: { InvoiceID: o2.xeroInvoiceId }, Account: { AccountID: 'ACC-BANK' } },
  ];
  X.contacts.push({ ContactID: 'XC-new', Name: 'Walk-in From Xero', IsCustomer: true, EmailAddress: 'w@x.co', ContactStatus: 'ACTIVE' });
  const kroon = X.contacts.find((c) => c.ContactID === 'XC-kroon'); kroon.EmailAddress = 'accounts@kroon.co.za';
  db.S['xero/connection'].linkedAt = '2026-11-21T00:00:00Z';
  const res = await xs.pull();
  assert.strictEqual(res.payments, 1);
  const fromXero = Object.values(db.S).filter((d) => d && d.fromXero);
  assert.strictEqual(fromXero.length, 1); assert.strictEqual(fromXero[0].number, 'DSX-R0050'); assert.strictEqual(fromXero[0].orderId, 'o1'); assert.strictEqual(fromXero[0].method, 'eft');
  assert.strictEqual(db.S['customers/c1'].email, 'accounts@kroon.co.za');
  assert.ok(Object.values(db.S).some((d) => d && d.name === 'Walk-in From Xero' && d.xeroContactId === 'XC-new'));

  // receipts recorded before the link on an invoice that was a draft: preview, then send what Xero still owes
  X.invoices.push({ InvoiceID: 'XI-draft', InvoiceNumber: 'DSX-INV0003', Type: 'ACCREC', Status: 'AUTHORISED', AmountDue: 150 });
  db.S['orders/o3'] = Object.assign({ customerId: 'c1', customerName: 'Kroon Motors', xeroInvoiceId: 'XI-draft' }, inv('DSX-INV0003', '2026-11-05'));
  db.S['receipts/r4'] = { number: 'DSX-R0004', orderId: 'o3', amount: 100, method: 'card', date: '2026-11-05', kind: 'payment', xero: { status: 'skipped' } };
  db.S['receipts/r5'] = { number: 'DSX-R0005', orderId: 'o3', amount: 100, method: 'cash', date: '2026-11-06', kind: 'payment', xero: { status: 'skipped' } };
  db.S['config/business'].xeroPayCard = 'ACC-CARD';
  const pv = await xs.skippedReceipts();
  const byNo = {}; pv.items.forEach((i) => { byNo[i.number] = i; });
  assert.strictEqual(byNo['DSX-R0004'].ok, true);
  assert.strictEqual(byNo['DSX-R0005'].ok, false); assert.match(byNo['DSX-R0005'].why, /only R 50.00/);
  assert.strictEqual(byNo['DSX-R0001'].ok, false); // XI-old already paid (AmountDue 0)
  const sent = await xs.sendSkipped(['r4']);
  assert.strictEqual(sent.queued, 1);
  await xs.sweep(30);
  assert.strictEqual(db.S['receipts/r4'].xero.status, 'synced');
  assert.strictEqual(X.payments[X.payments.length - 1].Account.AccountID, 'ACC-CARD');
  assert.strictEqual(db.S['receipts/r5'].xero.status, 'skipped');

  // VAT rounding: an unpaid invoice whose Xero total is a cent off is re-sent with the app's VAT; a paid one is only listed
  X.invoices.push({ InvoiceID: 'XI-r1', InvoiceNumber: 'DSX-INV0302', Type: 'ACCREC', Status: 'AUTHORISED', Total: 260.01, AmountPaid: 0, AmountCredited: 0 });
  X.invoices.push({ InvoiceID: 'XI-r2', InvoiceNumber: 'DSX-INV0303', Type: 'ACCREC', Status: 'PAID', Total: 260.01, AmountPaid: 260.01, AmountCredited: 0 });
  const two = [{ description: 'Vinyl', qty: 2, unitPrice: 86.96 }, { description: 'Cut', qty: 1, unitPrice: 52.17 }];
  db.S['orders/o5'] = { customerId: 'c1', customerName: 'Kroon Motors', invoiceNumber: 'DSX-INV0302', invoiceGeneratedAt: '2026-11-25', invoiceVatEnabled: true, invoiceLineItems: two, xeroInvoiceId: 'XI-r1', xeroInv: { status: 'synced', hash: 'x' } };
  db.S['orders/o6'] = { customerId: 'c1', customerName: 'Kroon Motors', invoiceNumber: 'DSX-INV0303', invoiceGeneratedAt: '2026-11-25', invoiceVatEnabled: true, invoiceLineItems: two, xeroInvoiceId: 'XI-r2', xeroInv: { status: 'synced', hash: 'x' } };
  const fr = await xs.fixRounding();
  assert.deepStrictEqual(fr.fixed.map((r) => r.number), ['DSX-INV0302']);
  assert.deepStrictEqual(fr.locked.map((r) => r.number), ['DSX-INV0303']);
  const sentLines = X.invoices.find((i) => i.InvoiceID === 'XI-r1').LineItems;
  assert.strictEqual(Math.round(sentLines.reduce((a, l) => a + l.TaxAmount, 0) * 100) / 100, 33.91);
});

test('money with no invoice goes to Xero as an overpayment and is applied later', async () => {
  const X = fakeXero();
  const db = makeDb();
  const xs = makeSync({ db, admin: { firestore: { FieldValue: {} } }, logger: { info() {}, warn() {}, error() {} }, clientId: () => 'id', clientSecret: () => 'sec', scopes: () => 's' });
  db.S['config/business'] = { businessVatNumber: '4123', vatRate: 15, invoiceDueDays: 7, xeroPayCash: 'ACC-CASH', xeroPayEft: 'ACC-BANK', xeroPayCard: 'ACC-CARD', nextReceiptNumber: 50 };
  db.S['xero/connection'] = { refreshToken: 'RT', tenantId: 'T1', tenantName: 'DsignX', linkedAt: '2026-11-21T00:00:00Z' };
  db.S['customers/c1'] = { name: 'Kroon Motors', type: 'business' };
  // 1. a deposit on a job with no invoice → overpayment
  db.S['orders/j1'] = { customerId: 'c1', customerName: 'Kroon Motors', jobNumber: 'DSX-J0400' };
  db.S['receipts/d1'] = { number: 'DSX-R0100', orderId: 'j1', amount: 100, method: 'cash', date: '2026-11-25', kind: 'prepayment', customerId: 'c1' };
  await xs.pushOne('receipts', 'd1');
  const d1 = db.S['receipts/d1'];
  assert.strictEqual(d1.xero.status, 'overpayment'); assert.ok(d1.xeroOverpaymentId);
  const bt = X.overs[d1.xeroOverpaymentId].b;
  assert.strictEqual(bt.Type, 'RECEIVE-OVERPAYMENT'); assert.strictEqual(bt.BankAccount.AccountID, 'ACC-CASH'); assert.strictEqual(bt.LineItems[0].LineAmount, 100);
  // the job is invoiced (R115) → the invoice goes to Xero and the deposit is applied to it
  Object.assign(db.S['orders/j1'], { invoiceNumber: 'DSX-INV0400', invoiceGeneratedAt: '2026-11-26', invoiceVatEnabled: true, invoiceLineItems: [{ description: 'Sign', qty: 1, unitPrice: 100 }] });
  await xs.pushOne('orders', 'j1');
  assert.strictEqual(db.S['receipts/d1'].xero.status, 'synced');
  assert.strictEqual(X.allocs[0].Amount, 100);
  assert.strictEqual(X.invoices.find((i) => i.InvoiceNumber === 'DSX-INV0400').AmountDue, 15);
  assert.strictEqual(X.payments.length, 0, 'no second payment for the deposit');

  // 2. an EFT kept on account → overpayment; allocating it later applies it to the invoice
  db.S['receipts/a1'] = { number: 'DSX-R0101', amount: 50, method: 'eft', date: '2026-11-25', kind: 'onaccount', customerId: 'c1', customerName: 'Kroon Motors' };
  await xs.pushOne('receipts', 'a1');
  const a1 = db.S['receipts/a1'];
  assert.strictEqual(a1.xero.status, 'overpayment'); assert.strictEqual(X.overs[a1.xeroOverpaymentId].b.BankAccount.AccountID, 'ACC-BANK');
  db.S['receipts/al1'] = { number: 'DSX-R0102', orderId: 'j1', amount: 15, method: 'alloc', sourceReceiptId: 'a1', date: '2026-11-26', kind: 'payment' };
  await xs.pushOne('receipts', 'al1');
  assert.strictEqual(db.S['receipts/al1'].xero.status, 'synced'); assert.ok(db.S['receipts/al1'].xeroAllocId);
  assert.strictEqual(X.overs[a1.xeroOverpaymentId].RemainingCredit, 35);
  assert.strictEqual(X.invoices.find((i) => i.InvoiceNumber === 'DSX-INV0400').AmountDue, 0);
  // undoing the allocation removes it in Xero
  db.S['receipts/al1'].voided = true;
  await xs.pushOne('receipts', 'al1');
  assert.strictEqual(X.deletedAlloc, db.S['receipts/al1'].xeroAllocId); assert.strictEqual(db.S['receipts/al1'].xero.status, 'deleted');

  // 3. an on-account receipt from before the link: listed first, sent only when chosen; earlier allocations come off
  db.S['receipts/old'] = { number: 'DSX-R0010', amount: 80, method: 'eft', date: '2026-11-10', kind: 'onaccount', customerId: 'c1', customerName: 'Kroon Motors' };
  await xs.pushOne('receipts', 'old');
  assert.strictEqual(db.S['receipts/old'].xero.status, 'onaccount'); assert.ok(!db.S['receipts/old'].xeroOverpaymentId);
  db.S['receipts/oldal'] = { number: 'DSX-R0011', orderId: 'j1', amount: 30, method: 'alloc', sourceReceiptId: 'old', date: '2026-11-12', kind: 'payment', xero: { status: 'skipped' } };
  const pv = await xs.skippedReceipts();
  const it = pv.items.find((i) => i.id === 'old');
  assert.ok(it && it.ok); assert.strictEqual(it.as, 'overpayment'); assert.strictEqual(it.amount, 50);
  await xs.sendSkipped(['old']); await xs.sweep(10);
  assert.strictEqual(db.S['receipts/old'].xero.status, 'overpayment'); assert.strictEqual(X.overs[db.S['receipts/old'].xeroOverpaymentId].b.LineItems[0].LineAmount, 50);
});
