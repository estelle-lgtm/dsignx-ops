'use strict';
/*
 * Payment reminders: works out which unpaid invoices are overdue and who should follow them up.
 * Pure functions (no Firebase) so they can be unit-tested; index.js reads and writes Firestore.
 */

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function lineNet(li) {
  const d = Math.min(100, Math.max(0, Number(li && li.discount) || 0));
  return round2((Number(li.qty) || 0) * (Number(li.unitPrice) || 0) * (1 - d / 100));
}
function hasInvoiceDoc(o) { return !!(o.invoiceNumber && o.invoiceGeneratedAt && (o.invoiceLineItems || []).length); }
function invoiceTotal(o, cfg) {
  const sub = (o.invoiceLineItems || []).reduce((s, li) => s + lineNet(li), 0);
  const vatOn = !!o.invoiceVatEnabled && !!String(cfg.businessVatNumber || '').trim();
  return round2(sub + (vatOn ? sub * (Number(cfg.vatRate) || 0) / 100 : 0));
}
function addDays(iso, days) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(String(a).slice(0, 10) + 'T00:00:00Z')) / 86400000); }
function dueDateOf(o, cfg) {
  const days = o.invoiceDueDays != null ? Number(o.invoiceDueDays) : (cfg.invoiceDueDays != null ? Number(cfg.invoiceDueDays) : 7);
  return addDays(o.invoiceGeneratedAt, days);
}
function money(v) { return 'R ' + round2(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fullDate(iso) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = String(iso).slice(0, 10).split('-');
  return Number(p[2]) + ' ' + M[Number(p[1]) - 1] + ' ' + p[0];
}

/**
 * Which overdue invoices need a reminder today.
 * @returns [{order, toId, toName, total, paid, credited, balance, due, daysOverdue, prev}]
 */
function planReminders({ orders, receipts, credits, team, cfg, sent, today, everyDays }) {
  const every = Math.max(1, Number(everyDays) || 7);
  const paidBy = {}, creditBy = {};
  (receipts || []).forEach((r) => { if (!r.voided && r.orderId) paidBy[r.orderId] = (paidBy[r.orderId] || 0) + (Number(r.amount) || 0); });
  (credits || []).forEach((c) => { if (!c.voided && c.orderId) creditBy[c.orderId] = (creditBy[c.orderId] || 0) + (Number(c.total) || 0); });
  const active = {};
  (team || []).forEach((m) => { if (m.active !== false) active[m.id] = m; });
  const out = [];
  (orders || []).forEach((o) => {
    if (o.quoteOnly || !hasInvoiceDoc(o)) return;
    const total = invoiceTotal(o, cfg), paid = round2(paidBy[o.id] || 0), credited = round2(creditBy[o.id] || 0);
    const balance = round2(total - paid - credited);
    if (!(balance > 0.004)) return;
    const due = dueDateOf(o, cfg);
    const daysOverdue = daysBetween(due, today);
    if (daysOverdue < 1) return;
    const prev = (sent || {})[o.id] || null;
    if (prev && prev.lastSentAt && daysBetween(prev.lastSentAt, today) < every) return;
    const des = o.designerId && active[o.designerId];
    out.push({ order: o, toId: des ? des.id : 'owner', toName: des ? des.name : 'Owner', total, paid, credited, balance, due, daysOverdue, prev });
  });
  return out;
}

function reminderText(p) {
  const o = p.order;
  const inv = o.invoiceNumber, cust = o.customerName || 'the customer';
  const job = [o.jobNumber, o.title].filter(Boolean).join(' — ');
  return {
    subject: `Payment overdue: ${inv} — ${cust}`,
    body: `Invoice ${inv} for ${cust}${job ? ` (job ${job})` : ''} is ${p.daysOverdue} day${p.daysOverdue === 1 ? '' : 's'} overdue.\n` +
      `Outstanding: ${money(p.balance)} of ${money(p.total)}. Due date was ${fullDate(p.due)}.\n` +
      `Please follow up with the customer, note what they said here, and press Finish once it is sorted.`,
    again: `Still unpaid: ${money(p.balance)} outstanding, ${p.daysOverdue} days overdue. Please follow up again.`,
  };
}

module.exports = { planReminders, reminderText, invoiceTotal, dueDateOf, money, round2 };
