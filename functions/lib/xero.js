'use strict';
/*
 * Xero sync — pure mapping helpers (no network, no Firebase), so they can be unit-tested.
 * The app leads: customers, quotes, invoices, credit notes and receipts are pushed to Xero.
 * Xero feeds back: payments (e.g. bank reconciliation), contact changes and invoice status.
 */
const crypto = require('crypto');

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
function str(v) { return String(v == null ? '' : v).trim(); }
function day(v) { return String(v || '').slice(0, 10); }
function addDays(iso, days) {
  const d = new Date(day(iso) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}
function discPct(li) { return Math.min(100, Math.max(0, Number(li && li.discount) || 0)); }
function lineNet(li) { return round2((Number(li.qty) || 0) * (Number(li.unitPrice) || 0) * (1 - discPct(li) / 100)); }

// Stable fingerprint of what we send, so an unchanged record is never pushed twice.
function hashOf(obj) { return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 20); }

// Xero dates come back as "/Date(1699999999000+0000)/" or ISO strings.
function xeroDate(v) {
  const m = /\/Date\((-?\d+)/.exec(String(v || ''));
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  return day(v);
}

function hasInvoiceDoc(o) { return !!(o && o.invoiceNumber && o.invoiceGeneratedAt && (o.invoiceLineItems || []).length); }
function hasQuoteDoc(o) { return !!(o && o.quoteNumber && o.quoteGeneratedAt && (o.lineItems || []).length); }
function vatVendor(cfg) { return !!str(cfg && cfg.businessVatNumber); }
function firstName(n) { return str(n).split(/\s+/)[0] || ''; }
function repsOf(o) {
  return [o.designerName, o.technicianName, o.technician2Name].filter(Boolean).map(firstName)
    .filter((n, i, a) => n && a.indexOf(n) === i).join(' & ');
}

/* ---------------- contacts ---------------- */
function addr(type, a) {
  a = a || {};
  const out = { AddressType: type, AddressLine1: str(a.line1), AddressLine2: str(a.line2), City: str(a.city), Region: str(a.region), PostalCode: str(a.postalCode), Country: str(a.country) };
  return (out.AddressLine1 || out.AddressLine2 || out.City || out.PostalCode) ? out : null;
}
function contactPayload(c) {
  const p = { Name: str(c.name) };
  if (str(c.firstName)) p.FirstName = str(c.firstName);
  if (str(c.lastName)) p.LastName = str(c.lastName);
  if (str(c.email)) p.EmailAddress = str(c.email);
  if (str(c.phone)) p.Phones = [{ PhoneType: 'MOBILE', PhoneNumber: str(c.phone) }];
  const po = addr('POBOX', c.postalAddress);
  const st = c.deliverySame === false ? addr('STREET', c.deliveryAddress) : (po ? Object.assign({}, po, { AddressType: 'STREET' }) : null);
  const addrs = [po, st].filter(Boolean);
  if (addrs.length) p.Addresses = addrs;
  if (c.type === 'business') {
    if (str(c.vatNumber)) p.TaxNumber = str(c.vatNumber);
    if (str(c.regNumber)) p.CompanyNumber = str(c.regNumber);
    if (str(c.website)) p.Website = str(c.website);
    const ppl = (c.contacts || []).filter((x) => str(x.firstName) || str(x.lastName) || str(x.email)).slice(0, 5)
      .map((x) => ({ FirstName: str(x.firstName), LastName: str(x.lastName), EmailAddress: str(x.email), IncludeInEmails: !!str(x.email) }));
    if (ppl.length) p.ContactPersons = ppl;
  }
  return p;
}
// Xero contact → the customer fields the app keeps (used when a contact changes in Xero).
function customerFromContact(x) {
  const phone = ((x.Phones || []).find((p) => p.PhoneType === 'MOBILE' && str(p.PhoneNumber))
    || (x.Phones || []).find((p) => str(p.PhoneNumber)) || {});
  const num = [phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].map(str).filter(Boolean).join(' ');
  const a = (t) => {
    const r = (x.Addresses || []).find((y) => y.AddressType === t) || {};
    return { line1: str(r.AddressLine1), line2: str(r.AddressLine2), city: str(r.City), region: str(r.Region), postalCode: str(r.PostalCode), country: str(r.Country) };
  };
  const out = { name: str(x.Name), email: str(x.EmailAddress), phone: num, firstName: str(x.FirstName), lastName: str(x.LastName), postalAddress: a('POBOX') };
  const st = a('STREET');
  if (st.line1 || st.city || st.postalCode) { out.deliveryAddress = st; out.deliverySame = JSON.stringify(st) === JSON.stringify(out.postalAddress); }
  if (str(x.TaxNumber)) out.vatNumber = str(x.TaxNumber);
  if (str(x.CompanyNumber)) out.regNumber = str(x.CompanyNumber);
  if (str(x.Website)) out.website = str(x.Website);
  return out;
}

/* ---------------- documents ---------------- */
// ctx: {contactId, accountCode, taxVat, taxNoVat, tracking:{name, options:[...]}, currency}
function lines(items, vatOn, ctx, reps) {
  const trackingOk = ctx.tracking && ctx.tracking.name && reps && (ctx.tracking.options || []).some((o) => o.toLowerCase() === reps.toLowerCase());
  return (items || []).map((li) => {
    const l = {
      Description: [str(li.description), str(li.note)].filter(Boolean).join('\n') || '-',
      Quantity: round4(li.qty),
      UnitAmount: round4(li.unitPrice),
      AccountCode: ctx.accountCode || '200',
      TaxType: vatOn ? ctx.taxVat : ctx.taxNoVat,
    };
    if (discPct(li)) l.DiscountRate = round2(discPct(li));
    if (trackingOk) l.Tracking = [{ Name: ctx.tracking.name, Option: (ctx.tracking.options || []).find((o) => o.toLowerCase() === reps.toLowerCase()) }];
    return l;
  });
}
function invoicePayload(o, cfg, ctx) {
  const vatOn = !!o.invoiceVatEnabled && vatVendor(cfg);
  const date = day(o.invoiceGeneratedAt);
  const dueDays = o.invoiceDueDays != null ? Number(o.invoiceDueDays) : (cfg.invoiceDueDays != null ? Number(cfg.invoiceDueDays) : 7);
  return {
    Type: 'ACCREC',
    InvoiceNumber: o.invoiceNumber,
    Reference: (str(o.poNumber) ? 'PO ' + str(o.poNumber) : '') || str(o.title),
    Contact: { ContactID: ctx.contactId },
    Date: date,
    DueDate: addDays(date, dueDays),
    LineAmountTypes: vatOn ? 'Exclusive' : 'NoTax',
    Status: 'AUTHORISED',
    CurrencyCode: ctx.currency || 'ZAR',
    LineItems: lines(o.invoiceLineItems, vatOn, ctx, repsOf(o)),
  };
}
function quoteStatus(o) {
  if (o.status === 'lost') return 'DECLINED';
  if (o.quoteOnly) return 'SENT';
  return 'ACCEPTED';
}
function quotePayload(o, cfg, ctx) {
  const vatOn = !!o.quoteVatEnabled && vatVendor(cfg);
  const date = day(o.quoteGeneratedAt);
  return {
    QuoteNumber: o.quoteNumber,
    Reference: (str(o.poNumber) ? 'PO ' + str(o.poNumber) : '') || str(o.title),
    Title: str(o.title).slice(0, 100),
    Contact: { ContactID: ctx.contactId },
    Date: date,
    ExpiryDate: addDays(date, Number(o.quoteValidDays) || Number(cfg.quoteValidityDays) || 14),
    LineAmountTypes: vatOn ? 'Exclusive' : 'NoTax',
    Status: quoteStatus(o),
    CurrencyCode: ctx.currency || 'ZAR',
    LineItems: lines(o.lineItems, vatOn, ctx, repsOf(o)),
  };
}
function creditNotePayload(c, cfg, ctx) {
  const vatOn = !!c.vatEnabled;
  return {
    Type: 'ACCRECCREDIT',
    CreditNoteNumber: c.number,
    Reference: str(c.invoiceNumber) + (str(c.reason) ? ' — ' + str(c.reason) : ''),
    Contact: { ContactID: ctx.contactId },
    Date: day(c.date),
    LineAmountTypes: vatOn ? 'Exclusive' : 'NoTax',
    Status: c.voided ? 'VOIDED' : 'AUTHORISED',
    CurrencyCode: ctx.currency || 'ZAR',
    LineItems: lines(c.items, vatOn, ctx, ''),
  };
}
// Which configured Xero account a receipt's money went into.
function paymentAccountFor(r, cfg, source) {
  const m = r.method === 'alloc' ? ((source && source.method) || 'eft') : r.method;
  if (m === 'cash') return { id: cfg.xeroPayCash || '', label: 'cash' };
  if (m === 'card') return { id: cfg.xeroPayCard || '', label: 'card (speedpoint)' };
  return { id: cfg.xeroPayEft || '', label: 'EFT / bank' };
}
function paymentPayload(r, ctx) {
  return {
    Invoice: { InvoiceID: ctx.invoiceId },
    Account: { AccountID: ctx.accountId },
    Date: day(ctx.date || r.date),
    Amount: round2(r.amount),
    Reference: [r.number, r.method === 'alloc' ? 'from ' + (r.sourceNumber || '') : '', str(r.bankReference)].filter(Boolean).join(' ').slice(0, 255),
  };
}

// How a receipt should be treated (before anything is sent).
function receiptPlan(r, order, linkedAt, sourceReceipt) {
  if (r.kind === 'onaccount') return { action: 'skip', status: 'onaccount', note: 'Overpayment — goes to Xero when it is allocated to an invoice' };
  if (r.fromXero) return { action: 'skip', status: 'synced', note: 'Came from Xero' };
  if (r.voided) return r.xeroPaymentId ? { action: 'delete' } : { action: 'skip', status: 'void', note: 'Voided' };
  const when = r.method === 'alloc' && sourceReceipt ? sourceReceipt.date : r.date;
  const createdByApp = order && order.xeroInv && order.xeroInv.created;
  if (linkedAt && day(when) < day(linkedAt) && !createdByApp) return { action: 'skip', status: 'skipped', note: 'Before the Xero link — assumed already in Xero' };
  if (!order || !order.xeroInvoiceId) return { action: 'wait', status: 'waiting', note: 'Waiting for the invoice to reach Xero' };
  return { action: 'push' };
}

// Did anything other than our own xero* bookkeeping fields change?
function relevantChange(before, after) {
  const strip = (d) => { if (!d) return null; const o = {}; Object.keys(d).forEach((k) => { if (!/^xero/.test(k)) o[k] = d[k]; }); return JSON.stringify(o, Object.keys(o).sort()); };
  return strip(before) !== strip(after);
}

// Turns a Xero error body into one readable line.
function xeroErrorText(json, status) {
  if (!json) return 'HTTP ' + status;
  const errs = [];
  (json.Elements || []).forEach((el) => (el.ValidationErrors || []).forEach((v) => errs.push(v.Message)));
  if (errs.length) return errs.filter((v, i, a) => a.indexOf(v) === i).join('; ');
  return json.Detail || json.Message || json.Title || json.error || ('HTTP ' + status);
}

module.exports = {
  round2, hashOf, xeroDate, addDays, hasInvoiceDoc, hasQuoteDoc, lineNet,
  contactPayload, customerFromContact, invoicePayload, quotePayload, quoteStatus, creditNotePayload,
  paymentAccountFor, paymentPayload, receiptPlan, relevantChange, xeroErrorText, repsOf,
};
