'use strict';
// Run with: npm test   (inside the functions folder; needs no network or Firebase)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const core = require('../lib/core');

test('invite code hash matches the browser (WebCrypto PBKDF2)', async () => {
  const salt = crypto.randomBytes(16).toString('base64');
  const code = 'ABCD-2345';
  const key = await crypto.webcrypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(salt, 'base64'), iterations: 1000 }, key, 256);
  const browserHash = Buffer.from(bits).toString('base64');
  const member = { inviteHash: browserHash, inviteSalt: salt, inviteIter: 1000 };
  assert.strictEqual(core.codeMatches(code, member), true);
  assert.strictEqual(core.codeMatches('ABCD-2346', member), false);
  assert.strictEqual(core.normalizeCode('abcd 2345'), 'ABCD-2345');
});

test('Bird host follows the key region', () => {
  assert.strictEqual(core.birdHost('bk_eu1_xxx'), 'https://eu1.platform.bird.com');
  assert.strictEqual(core.birdHost('bk_us1_xxx'), 'https://us1.platform.bird.com');
});

test('Bird send always uses the server number and passes idempotency', () => {
  const r = core.birdRequest('whatsapp_send', { from: '+1999', to: '+27731112222', text: { body: 'Hi' }, idempotency_key: 'k1' }, { apiKey: 'bk_us1_x', from: '+27604934689' });
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, 'https://us1.platform.bird.com/v1/whatsapp/messages');
  assert.deepStrictEqual(JSON.parse(r.body), { from: '+27604934689', to: '+27731112222', text: { body: 'Hi' } });
  assert.strictEqual(r.headers['Idempotency-Key'], 'k1');
  assert.throws(() => core.birdRequest('whatsapp_send', { to: '+1', text: {}, image: {} }, { apiKey: 'k', from: '+1' }));
});

test('Bird send drops empty caption', () => {
  const r = core.birdRequest('whatsapp_send', { to: '+27731112222', document: { url: 'https://x/a.pdf', filename: 'a.pdf', caption: null } }, { apiKey: 'bk_us1_x', from: '+27604934689' });
  assert.deepStrictEqual(JSON.parse(r.body).document, { url: 'https://x/a.pdf', filename: 'a.pdf' });
});

test('Bird template send passes named parameters', () => {
  const t = { slug: 'dsignx_follow_up', language: 'en', components: [{ type: 'body', parameters: [{ type: 'text', name: 'customer_name', text: 'Riaan' }] }] };
  const r = core.birdRequest('whatsapp_send', { to: '+27731112222', template: t }, { apiKey: 'bk_us1_x', from: '+27604934689' });
  assert.deepStrictEqual(JSON.parse(r.body).template, t);
  assert.throws(() => core.birdRequest('whatsapp_send', { to: '+1', template: { slug: 'bird_otp' } }, { apiKey: 'k', from: '+1' }));
});

test('Bird list builds query string', () => {
  const r = core.birdRequest('whatsapp_list', { from: '+27731112222', direction: 'inbound', limit: 30 }, { apiKey: 'bk_us1_x' });
  assert.strictEqual(r.url, 'https://us1.platform.bird.com/v1/whatsapp/messages?limit=30&from=%2B27731112222&direction=inbound');
});

test('Cloudinary upload is signed correctly', () => {
  const cred = core.parseCloudinaryUrl('cloudinary://123:abc@demo');
  assert.deepStrictEqual(cred, { apiKey: '123', apiSecret: 'abc', cloudName: 'demo' });
  const r = core.cloudinaryRequest('upload-asset', { resource_type: 'raw', upload_request: { file: 'data:application/pdf;base64,AAAA', public_id: 'dsignx-docs/q1.pdf', tags: ['dsignx-ops'], overwrite: false } }, cred, 1700000000000);
  const form = new URLSearchParams(r.body);
  const expected = crypto.createHash('sha1').update('overwrite=false&public_id=dsignx-docs/q1.pdf&tags=dsignx-ops&timestamp=1700000000abc').digest('hex');
  assert.strictEqual(form.get('signature'), expected);
  assert.strictEqual(r.url, 'https://api.cloudinary.com/v1_1/demo/raw/upload');
  assert.throws(() => core.cloudinaryRequest('upload-asset', { upload_request: { file: 'data:application/pdf;base64,AA', public_id: 'other/x' } }, cred));
});

test('Cloudinary search and delete are restricted', () => {
  const cred = { apiKey: 'k', apiSecret: 's', cloudName: 'c' };
  assert.throws(() => core.cloudinaryRequest('search-assets', { request: { expression: 'resource_type:image' } }, cred));
  const d = core.cloudinaryRequest('delete-asset', { request: { asset_id: '5b40e47a2f26d1c8a021726f4398c834' } }, cred);
  assert.strictEqual(d.method, 'DELETE');
  assert.strictEqual(new URL(d.url).searchParams.get('asset_ids[]'), '5b40e47a2f26d1c8a021726f4398c834');
});

test('pasted secrets are cleaned up', () => {
  const want = { apiKey: '123', apiSecret: 'abc', cloudName: 'fkg0566i' };
  assert.deepStrictEqual(core.parseCloudinaryUrl('CLOUDINARY_URL=cloudinary://123:abc@fkg0566i'), want);
  assert.deepStrictEqual(core.parseCloudinaryUrl('\u001b[200~cloudinary://123:abc@fkg0566i~\n'), want);
  assert.deepStrictEqual(core.parseCloudinaryUrl('"cloudinary://123:abc@fkg0566i"'), want);
  assert.strictEqual(core.parseCloudinaryUrl('cloudinary://123:<your_api_secret>@fkg0566i'), null);
  assert.strictEqual(core.cleanBirdKey('\u001b[200~bk_us1_AbC123~'), 'bk_us1_AbC123');
});

test('provider errors keep their code', async () => {
  const fakeFetch = async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ error: { code: 'E15044', message: 'Outside the customer service window' } }) });
  await assert.rejects(core.send(fakeFetch, { url: 'x', method: 'GET' }), /E15044: Outside the customer service window/);
  const f2 = async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ error: { code: 'E01001', message: 'Request has 1 validation error.', details: [{ param: 'document.caption', message: 'must be a string' }] } }) });
  await assert.rejects(core.send(f2, { url: 'x', method: 'GET' }), /document\.caption: must be a string/);
});

test('WhatsApp media: link mode returns the storage link, never the key', async () => {
  const r = core.birdRequest('whatsapp_media', { message_id: 'wam_1', media_id: 'waf_2' }, { apiKey: 'bk_us1_x' });
  assert.strictEqual(r.url, 'https://us1.platform.bird.com/v1/whatsapp/messages/wam_1/media/waf_2');
  const calls = [];
  const fake = async (url, opts) => { calls.push([url, opts]); return { status: 302, ok: false, headers: new Map([['location', 'https://store.example/f?sig=1']]) }; };
  const out = await core.fetchMedia(fake, r);
  assert.deepStrictEqual(out, { url: 'https://store.example/f?sig=1', expires_in: 900 });
  assert.strictEqual(calls[0][1].redirect, 'manual');
});

test('WhatsApp media: inline mode downloads without the Bird key', async () => {
  const r = core.birdRequest('whatsapp_media', { message_id: 'wam_1', media_id: 'waf_2', inline: true }, { apiKey: 'bk_us1_x' });
  const calls = [];
  const fake = async (url, opts) => {
    calls.push([url, opts]);
    if (calls.length === 1) return { status: 302, ok: false, headers: new Map([['location', 'https://store.example/f']]) };
    return { status: 200, ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const out = await core.fetchMedia(fake, r);
  assert.deepStrictEqual(out, { data: 'AQID', mime: 'image/jpeg', size: 3 });
  assert.strictEqual(calls[1][1].headers, undefined);
});

test('WhatsApp media: expired files give a clear error', async () => {
  const r = core.birdRequest('whatsapp_media', { message_id: 'wam_1', media_id: 'waf_2' }, { apiKey: 'bk_us1_x' });
  await assert.rejects(core.fetchMedia(async () => ({ status: 410, ok: false, headers: new Map() }), r), /media_expired/);
  assert.throws(() => core.birdRequest('whatsapp_media', { message_id: '../x', media_id: 'a' }, { apiKey: 'bk_us1_x' }), /Invalid/);
});

const rem = require('../lib/reminders');
test('payment reminders: overdue unpaid invoices go to the designer, every 7 days', () => {
  const cfg = { businessVatNumber: '4230321509', vatRate: 15, invoiceDueDays: 7 };
  const inv = (id, extra) => Object.assign({ id, invoiceNumber: 'INV' + id, invoiceGeneratedAt: '2026-10-01', invoiceLineItems: [{ qty: 1, unitPrice: 1000 }], invoiceVatEnabled: true, designerId: 't1' }, extra);
  const orders = [inv('a'), inv('b'), inv('c', { invoiceGeneratedAt: '2026-10-20' }), inv('d', { designerId: 'gone' }), inv('e')];
  const receipts = [{ orderId: 'b', amount: 1150 }, { orderId: 'e', amount: 100, voided: true }];
  const credits = [{ orderId: 'e', total: 150 }];
  const team = [{ id: 't1', name: 'Shanya' }];
  const plan = rem.planReminders({ orders, receipts, credits, team, cfg, sent: { e: { lastSentAt: '2026-10-20' } }, today: '2026-10-23', everyDays: 7 });
  assert.deepStrictEqual(plan.map((p) => [p.order.id, p.toId, p.balance, p.daysOverdue]), [['a', 't1', 1150, 15], ['d', 'owner', 1150, 15]]);
  const again = rem.planReminders({ orders: [inv('e')], receipts: [], credits, team, cfg, sent: { e: { lastSentAt: '2026-10-16' } }, today: '2026-10-23', everyDays: 7 });
  assert.strictEqual(again.length, 1); assert.strictEqual(again[0].balance, 1000);
  assert.match(rem.reminderText(plan[0]).body, /15 days overdue/);
});

const prof = require('../lib/profiles');
test('customer profiles: gaps and who fixes them', () => {
  assert.deepStrictEqual(prof.customerGaps({ type: 'individual', firstName: 'Riaan', lastName: 'P', phone: '073', email: 'a@b.co', postalAddress: { line1: '1 St', city: 'Kroonstad', postalCode: '9499' } }), []);
  assert.deepStrictEqual(prof.customerGaps({ type: 'business', name: 'Kroon Motors', phone: '073', postalAddress: { city: 'Kroonstad' } }), ['contact person', 'email address', 'postal address (street, postal code)']);
  const customers = [{ id: 'c1', name: 'Anna', type: 'individual' }, { id: 'c2', name: 'No jobs' }, { id: 'c3', name: 'Recent', type: 'individual' }];
  const orders = [{ customerId: 'c1', designerId: 't1', createdAt: '2026-10-01' }, { customerId: 'c1', designerId: 't2', createdAt: '2026-10-20' }, { customerId: 'c3', createdAt: '2026-10-20' }];
  const team = [{ id: 't1', name: 'Shanya' }, { id: 't2', name: 'Jessica' }];
  const plan = prof.planProfileTasks({ customers, orders, team, sent: { c3: { lastSentAt: '2026-11-04' } }, today: '2026-11-06', everyDays: 7 });
  // no creator recorded (older customer): designer of the first job
  assert.deepStrictEqual(plan.map((p) => [p.customer.id, p.toId]), [['c1', 't1']]);
  // the person who created the customer gets it, even if someone else did the latest job
  const plan2 = prof.planProfileTasks({ customers: [{ id: 'c1', name: 'Anna', createdById: 't2', createdByName: 'Jessica' }, { id: 'c4', name: 'Left', createdById: 't9' }, { id: 'c5', name: 'Mine', createdById: 'owner' }],
    orders: [{ customerId: 'c1', designerId: 't1', createdAt: '2026-10-25' }, { customerId: 'c4', designerId: 't1' }, { customerId: 'c5', designerId: 't1' }], team, sent: {}, today: '2026-11-06' });
  assert.deepStrictEqual(plan2.map((p) => [p.customer.id, p.toId]), [['c1', 't2'], ['c4', 'owner'], ['c5', 'owner']]);
  assert.match(prof.profileText(plan[0]).body, /Missing: first and last name, cellphone number/);
});

test('email_send: statements by email go out from the server address, PDF only', () => {
  const opts = { apiKey: 'bk_eu1_abc123', from: '+27600000000', emailFrom: 'accounts@dsignx.co.za', emailName: 'DsignX' };
  const r = core.birdRequest('email_send', { to: 'jan@kroon.co.za', subject: 'Statement', html: '<p>x</p>', reply_to: 'info@dsignx.co.za',
    attachments: [{ filename: 'DsignX-Statement.pdf', content: 'JVBERi0xLjQK' }], idempotency_key: 'stmt-c1-2026-11-11' }, opts);
  assert.strictEqual(r.url, 'https://eu1.platform.bird.com/v1/email/messages');
  const b = JSON.parse(r.body);
  assert.deepStrictEqual(b.from, { email: 'accounts@dsignx.co.za', name: 'DsignX' });
  assert.deepStrictEqual(b.to, ['jan@kroon.co.za']);
  assert.strictEqual(b.category, 'transactional');
  assert.strictEqual(b.attachments[0].content_type, 'application/pdf');
  assert.strictEqual(r.headers['Idempotency-Key'], 'stmt-c1-2026-11-11');
  assert.throws(() => core.birdRequest('email_send', { to: 'not-an-email', subject: 's', text: 't' }, opts));
  assert.throws(() => core.birdRequest('email_send', { to: 'a@b.co', subject: 's', text: 't', attachments: [{ filename: 'x.exe', content: 'AA==' }] }, opts));
  assert.throws(() => core.birdRequest('email_send', { to: 'a@b.co', subject: 's', text: 't' }, Object.assign({}, opts, { emailFrom: '' })));
});
