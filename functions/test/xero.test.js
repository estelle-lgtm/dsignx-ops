'use strict';
const test = require('node:test');
const assert = require('node:assert');
const X = require('../lib/xero');

const cfg = { businessVatNumber: '4123', invoiceDueDays: 7, quoteValidityDays: 14, vatRate: 15 };
const ctx = { contactId: 'C1', accountCode: '200', taxVat: 'OUTPUT', taxNoVat: 'NONE', currency: 'ZAR', tracking: { name: 'Sales Rep', options: ['Shanya & Victor', 'Jessica'] } };

test('invoice payload: one invoice, all lines, discount, tracking, approved', () => {
  const o = { invoiceNumber: 'DSX-INV0148', invoiceGeneratedAt: '2026-11-05T10:00:00Z', invoiceVatEnabled: true, poNumber: '', title: 'Boskoppie', designerName: 'Shanya Smith', technicianName: 'Victor M',
    invoiceLineItems: [{ description: 'Chromadek', qty: 1, unitPrice: 386, discount: 5 }, { description: 'Chromadek', qty: 2, unitPrice: 321, discount: 5, note: 'double' }] };
  const p = X.invoicePayload(o, cfg, ctx);
  assert.strictEqual(p.Type, 'ACCREC'); assert.strictEqual(p.Status, 'AUTHORISED'); assert.strictEqual(p.LineItems.length, 2);
  assert.strictEqual(p.Date, '2026-11-05'); assert.strictEqual(p.DueDate, '2026-11-12'); assert.strictEqual(p.LineAmountTypes, 'Exclusive');
  assert.strictEqual(p.LineItems[0].DiscountRate, 5); assert.strictEqual(p.LineItems[0].TaxType, 'OUTPUT');
  assert.deepStrictEqual(p.LineItems[0].Tracking, [{ Name: 'Sales Rep', Option: 'Shanya & Victor' }]);
  assert.strictEqual(p.LineItems[1].Description, 'Chromadek\ndouble');
  assert.strictEqual(p.Contact.ContactID, 'C1'); assert.strictEqual(p.Reference, 'Boskoppie');
});
test('no VAT number → NoTax; unknown tracking option left out', () => {
  const p = X.invoicePayload({ invoiceNumber: 'I1', invoiceGeneratedAt: '2026-11-01', invoiceVatEnabled: true, designerName: 'Alfred', invoiceLineItems: [{ description: 'x', qty: 1, unitPrice: 10 }] }, {}, ctx);
  assert.strictEqual(p.LineAmountTypes, 'NoTax'); assert.strictEqual(p.LineItems[0].TaxType, 'NONE'); assert.strictEqual(p.LineItems[0].Tracking, undefined);
});
test('quote status and credit note', () => {
  assert.strictEqual(X.quoteStatus({ quoteOnly: true }), 'SENT');
  assert.strictEqual(X.quoteStatus({ quoteOnly: false }), 'ACCEPTED');
  assert.strictEqual(X.quoteStatus({ status: 'lost' }), 'DECLINED');
  const c = X.creditNotePayload({ number: 'DSX-CN0001', invoiceNumber: 'DSX-INV0001', reason: 'Damaged', date: '2026-11-20', vatEnabled: true, items: [{ description: 'Refund', qty: 1, unitPrice: 100 }] }, cfg, ctx);
  assert.strictEqual(c.Type, 'ACCRECCREDIT'); assert.strictEqual(c.CreditNoteNumber, 'DSX-CN0001'); assert.strictEqual(c.Status, 'AUTHORISED');
  assert.strictEqual(X.creditNotePayload({ number: 'x', voided: true, items: [] }, cfg, ctx).Status, 'VOIDED');
});
test('contact payload and back', () => {
  const c = { name: 'Kroon Motors', type: 'business', email: 'a@k.co.za', phone: '0731112222', vatNumber: '4999', postalAddress: { line1: '1 Main', city: 'Kroonstad', postalCode: '9499' }, deliverySame: true,
    contacts: [{ firstName: 'Jan', lastName: 'K', email: 'jan@k.co.za' }] };
  const p = X.contactPayload(c);
  assert.strictEqual(p.Name, 'Kroon Motors'); assert.strictEqual(p.Phones[0].PhoneType, 'MOBILE'); assert.strictEqual(p.Addresses.length, 2); assert.strictEqual(p.TaxNumber, '4999');
  assert.strictEqual(p.ContactPersons[0].IncludeInEmails, true);
  const back = X.customerFromContact(Object.assign({ ContactID: 'C', Phones: p.Phones }, p));
  assert.strictEqual(back.email, 'a@k.co.za'); assert.strictEqual(back.postalAddress.city, 'Kroonstad'); assert.strictEqual(back.phone, '0731112222');
});
test('receipt plan', () => {
  const linked = '2026-11-21T08:00:00Z';
  assert.strictEqual(X.receiptPlan({ kind: 'onaccount' }, null, linked).action, 'skip');
  assert.strictEqual(X.receiptPlan({ date: '2026-11-10', method: 'cash' }, { xeroInvoiceId: 'I' }, linked).status, 'skipped');
  assert.strictEqual(X.receiptPlan({ date: '2026-11-10', method: 'cash' }, { xeroInvoiceId: 'I', xeroInv: { created: true } }, linked).action, 'push');
  assert.strictEqual(X.receiptPlan({ date: '2026-11-22', method: 'eft' }, { }, linked).action, 'wait');
  assert.strictEqual(X.receiptPlan({ date: '2026-11-22', method: 'eft' }, { xeroInvoiceId: 'I' }, linked).action, 'push');
  assert.strictEqual(X.receiptPlan({ voided: true, xeroPaymentId: 'P' }, {}, linked).action, 'delete');
  assert.strictEqual(X.paymentAccountFor({ method: 'alloc' }, { xeroPayEft: 'B' }, { method: 'eft' }).id, 'B');
  assert.strictEqual(X.paymentAccountFor({ method: 'card' }, { xeroPayCard: 'S' }).id, 'S');
});
test('only real changes trigger a push; Xero dates', () => {
  assert.strictEqual(X.relevantChange({ a: 1, xeroInv: { s: 1 } }, { a: 1, xeroInv: { s: 2 }, xeroInvoiceId: 'x' }), false);
  assert.strictEqual(X.relevantChange({ a: 1 }, { a: 2 }), true);
  assert.strictEqual(X.xeroDate('/Date(1763164800000+0000)/'), '2025-11-15');
  assert.strictEqual(X.xeroErrorText({ Elements: [{ ValidationErrors: [{ Message: 'Invoice # must be unique.' }] }] }, 400), 'Invoice # must be unique.');
});
