'use strict';
/*
 * Incomplete customer profiles: what is missing and which designer should fix it.
 * Keep customerGaps() in step with the same function in js/app.js.
 */

function filled(v) { return !!String(v == null ? '' : v).trim(); }
function customerGaps(c) {
  const miss = [];
  const biz = c.type === 'business';
  if (!biz && !(filled(c.firstName) && filled(c.lastName))) miss.push('first and last name');
  if (biz && !(c.contacts || []).some((p) => filled(p.firstName) || filled(p.lastName))) miss.push('contact person');
  if (!filled(c.phone)) miss.push('cellphone number');
  if (!filled(c.email)) miss.push('email address');
  const a = c.postalAddress || {};
  const parts = [];
  if (!filled(a.line1)) parts.push('street');
  if (!filled(a.city)) parts.push('town');
  if (!filled(a.postalCode)) parts.push('postal code');
  if (parts.length) miss.push('postal address (' + parts.join(', ') + ')');
  return miss;
}

function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(String(a).slice(0, 10) + 'T00:00:00Z')) / 86400000); }

/**
 * Who corrects a customer's profile: the person who created the customer.
 * Customers saved before the app recorded this fall back to the designer of their first job.
 * If that person has left (inactive) or the owner created it, the owner gets the task.
 */
function profileOwner(c, jobs, active) {
  if (c.createdById) {
    if (c.createdById !== 'owner' && active[c.createdById]) return { id: c.createdById, name: active[c.createdById].name, how: 'created' };
    return { id: 'owner', name: 'Owner', how: c.createdById === 'owner' ? 'created' : 'left' };
  }
  const first = (jobs || []).slice().sort((a, b) => String(a.createdAt || a.orderDate || '').localeCompare(String(b.createdAt || b.orderDate || '')))
    .find((o) => o.designerId);
  if (first && active[first.designerId]) return { id: first.designerId, name: active[first.designerId].name, how: 'firstjob' };
  return { id: 'owner', name: 'Owner', how: 'unknown' };
}

/** Customers with at least one job whose profile has gaps, and who should complete each. */
function planProfileTasks({ customers, orders, team, sent, today, everyDays }) {
  const every = Math.max(1, Number(everyDays) || 7);
  const active = {};
  (team || []).forEach((m) => { if (m.active !== false) active[m.id] = m; });
  const byCust = {};
  (orders || []).forEach((o) => { if (o.customerId) (byCust[o.customerId] = byCust[o.customerId] || []).push(o); });
  const out = [];
  (customers || []).forEach((c) => {
    const jobs = byCust[c.id];
    if (!jobs || !jobs.length) return;
    const missing = customerGaps(c);
    if (!missing.length) return;
    const prev = (sent || {})[c.id] || null;
    if (prev && prev.lastSentAt && daysBetween(prev.lastSentAt, today) < every) return;
    const latest = jobs.slice().sort((a, b) => String(b.orderDate || b.createdAt || '').localeCompare(String(a.orderDate || a.createdAt || '')));
    const who = profileOwner(c, jobs, active);
    out.push({ customer: c, missing, toId: who.id, toName: who.name, job: latest[0], prev });
  });
  return out;
}

function profileText(p) {
  const name = p.customer.name || 'this customer';
  const list = p.missing.join(', ');
  return {
    subject: `Complete customer profile: ${name}`,
    body: `${name}'s customer profile is incomplete. Missing: ${list}.\n` +
      `Please get the details from the customer, open the customer (button above) and fill them in, then press Finish. ` +
      `Complete profiles are needed for quotes, invoices and the Xero export.`,
    again: `Still missing: ${list}.`,
  };
}

module.exports = { customerGaps, planProfileTasks, profileText, profileOwner };
