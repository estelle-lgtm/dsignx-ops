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
