'use strict';
/*
 * DsignX Ops — server-side helpers with no Firebase dependencies, so they can be
 * unit-tested on their own (see functions/test/core.test.js).
 */
const crypto = require('crypto');

/* ---------------- invite codes ---------------- */

// Same format the app shows: 8 letters/digits as ABCD-2345.
function normalizeCode(c) {
  c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c;
}

// The app stores PBKDF2-SHA256(code, salt, iter) as base64 on the team record.
function hashCode(code, saltB64, iterations) {
  return crypto.pbkdf2Sync(code, Buffer.from(saltB64, 'base64'), iterations, 32, 'sha256').toString('base64');
}

function codeMatches(code, member) {
  if (!code || !member || !member.inviteHash || !member.inviteSalt) return false;
  const h = Buffer.from(hashCode(code, member.inviteSalt, member.inviteIter || 100000));
  const want = Buffer.from(String(member.inviteHash));
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

// today as YYYY-MM-DD in South African time, to compare with inviteExpires.
function todayInJoburg(now) {
  return new Date((now || Date.now()) + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ---------------- Bird (WhatsApp) ---------------- */

function birdHost(apiKey) {
  const m = /^bk_([a-z]+\d+)_/.exec(String(apiKey || ''));
  return `https://${m ? m[1] : 'us1'}.platform.bird.com`;
}

const BIRD_TOOLS = ['whatsapp_list', 'whatsapp_send', 'whatsapp_get', 'whatsapp_mark_read', 'whatsapp_media'];

// Turns an app tool call into an HTTP request for the Bird API.
function birdRequest(tool, input, opts) {
  input = input || {};
  const host = birdHost(opts.apiKey);
  const headers = { Authorization: `Bearer ${opts.apiKey}`, Accept: 'application/json' };
  if (tool === 'whatsapp_list') {
    const q = new URLSearchParams();
    ['limit', 'from', 'to', 'direction', 'starting_after', 'created_after', 'created_before', 'bsuid'].forEach((k) => {
      if (input[k] !== undefined && input[k] !== null && input[k] !== '') q.set(k, String(input[k]));
    });
    return { method: 'GET', url: `${host}/v1/whatsapp/messages?${q}`, headers };
  }
  if (tool === 'whatsapp_get') {
    if (!input.message_id) throw badInput('message_id is required');
    return { method: 'GET', url: `${host}/v1/whatsapp/messages/${encodeURIComponent(input.message_id)}`, headers };
  }
  if (tool === 'whatsapp_media') {
    // Photos and documents customers send. Bird answers with a redirect to a storage URL
    // that is valid for 15 minutes and needs no key, so the key never reaches the browser.
    if (!input.message_id || !input.media_id) throw badInput('message_id and media_id are required');
    if (!/^[A-Za-z0-9_.-]+$/.test(String(input.message_id)) || !/^[A-Za-z0-9_.-]+$/.test(String(input.media_id))) throw badInput('Invalid media reference');
    return { method: 'GET', url: `${host}/v1/whatsapp/messages/${encodeURIComponent(input.message_id)}/media/${encodeURIComponent(input.media_id)}`, headers, media: true, inline: !!input.inline };
  }
  if (tool === 'whatsapp_mark_read') {
    if (!input.message_id) throw badInput('message_id is required');
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
    if (input.idempotency_key) h['Idempotency-Key'] = String(input.idempotency_key).slice(0, 255);
    return { method: 'POST', url: `${host}/v1/whatsapp/messages/${encodeURIComponent(input.message_id)}/read`, headers: h, body: JSON.stringify({}) };
  }
  if (tool === 'whatsapp_send') {
    if (!input.to) throw badInput('to is required');
    const kinds = ['text', 'document', 'image', 'template'].filter((k) => input[k]);
    if (kinds.length !== 1) throw badInput('send exactly one of text, document, image or template');
    if (kinds[0] === 'template' && !/^dsignx_[a-z0-9_]+$/.test(String(input.template.slug || ''))) throw badInput('Only DsignX templates can be sent');
    // Always send from the business number configured on the server.
    const body = { from: opts.from, to: String(input.to) };
    body[kinds[0]] = compact(input[kinds[0]]);
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
    if (input.idempotency_key) h['Idempotency-Key'] = String(input.idempotency_key).slice(0, 255);
    return { method: 'POST', url: `${host}/v1/whatsapp/messages`, headers: h, body: JSON.stringify(body) };
  }
  throw badInput(`Unknown Bird tool: ${tool}`);
}

/* ---------------- Cloudinary ---------------- */

const CLOUDINARY_TOOLS = ['upload-asset', 'search-assets', 'delete-asset'];

// CLOUDINARY_URL looks like cloudinary://API_KEY:API_SECRET@CLOUD_NAME
// Tolerates what often sneaks in when a secret is pasted into a terminal:
// a leading "CLOUDINARY_URL=", quotes, spaces/new lines and bracketed-paste codes (ESC[200~ … ~).
function cleanSecret(v) {
  return String(v || '')
    .replace(/\u001b\[[0-9;]*[~A-Za-z]?/g, '')
    .replace(/\[20[01]~/g, '')
    .replace(/^\s*[A-Z_]+=/, '')
    .replace(/["'\s]/g, '')
    .replace(/~+$/, '');
}

function parseCloudinaryUrl(u) {
  const m = /cloudinary:\/\/([^:@\s]+):([^@\s]+)@([A-Za-z0-9_-]+)/.exec(cleanSecret(u));
  if (!m) return null;
  if (/^<.*>$/.test(m[2]) || /your_api_secret/i.test(m[2])) return null;
  return { apiKey: m[1], apiSecret: m[2], cloudName: m[3] };
}

function cleanBirdKey(v) {
  const m = /bk_[a-z]+\d+_[A-Za-z0-9]+/.exec(cleanSecret(v));
  return m ? m[0] : '';
}

// Signature for the Upload API: sha1 of the sorted params plus the API secret.
function cloudinarySignature(params, apiSecret) {
  const str = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(str + apiSecret).digest('hex');
}

function cloudinaryRequest(tool, input, cred, now) {
  input = input || {};
  const base = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cred.cloudName)}`;
  const basic = 'Basic ' + Buffer.from(`${cred.apiKey}:${cred.apiSecret}`).toString('base64');
  if (tool === 'upload-asset') {
    const up = input.upload_request || {};
    const rt = ['image', 'raw', 'video', 'auto'].includes(input.resource_type) ? input.resource_type : 'auto';
    if (!up.file || !/^data:[\w.+-]+\/[\w.+-]+;base64,/.test(String(up.file))) throw badInput('file must be a base64 data URI');
    const publicId = String(up.public_id || '');
    if (!/^dsignx-(docs|artwork)\//.test(publicId)) throw badInput('public_id must start with dsignx-docs/ or dsignx-artwork/');
    const tags = Array.isArray(up.tags) ? up.tags.join(',') : (up.tags || '');
    const params = {
      public_id: publicId,
      tags: tags || undefined,
      overwrite: up.overwrite === undefined ? undefined : String(!!up.overwrite),
      timestamp: String(Math.floor((now || Date.now()) / 1000)),
    };
    const signature = cloudinarySignature(params, cred.apiSecret);
    const form = new URLSearchParams();
    Object.keys(params).forEach((k) => { if (params[k] !== undefined) form.set(k, params[k]); });
    form.set('file', up.file);
    form.set('api_key', cred.apiKey);
    form.set('signature', signature);
    return { method: 'POST', url: `${base}/${rt}/upload`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() };
  }
  if (tool === 'search-assets') {
    const r = input.request || {};
    const body = { expression: String(r.expression || ''), max_results: Math.min(Number(r.max_results) || 50, 500) };
    if (!/tags=dsignx-/.test(body.expression)) throw badInput('Only DsignX Ops files can be searched');
    if (r.fields) body.fields = r.fields;
    return { method: 'POST', url: `${base}/resources/search`, headers: { Authorization: basic, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  if (tool === 'delete-asset') {
    const r = input.request || {};
    if (!/^[0-9a-f]{32}$/.test(String(r.asset_id || ''))) throw badInput('asset_id must be a 32-character hex id');
    const form = new URLSearchParams();
    form.append('asset_ids[]', r.asset_id);
    if (r.invalidate) form.set('invalidate', 'true');
    return { method: 'DELETE', url: `${base}/resources?${form}`, headers: { Authorization: basic } };
  }
  throw badInput(`Unknown Cloudinary tool: ${tool}`);
}

/* ---------------- shared ---------------- */

// Drops null/empty fields (e.g. a document with no caption) — Bird rejects null values.
function compact(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (v === null || v === undefined || v === '') return;
    out[k] = (typeof v === 'object') ? compact(v) : v;
  });
  return out;
}

function badInput(message) {
  const e = new Error(message);
  e.kind = 'bad_input';
  return e;
}

// Runs a prepared request and returns parsed JSON, or throws an Error whose
// message carries the provider's error code (e.g. "E15044: ...").
async function send(fetchImpl, req) {
  let res;
  try {
    res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
  } catch (e) {
    const err = new Error('Could not reach the service: ' + (e && e.message));
    err.kind = 'unavailable';
    throw err;
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (!res.ok) {
    const be = (json && json.error) || {};
    const details = Array.isArray(be.details) && be.details.length
      ? ' (' + be.details.map((d) => (d.param ? d.param + ': ' : '') + (d.message || '')).join('; ') + ')'
      : '';
    const msg = be.code
      ? `${be.code}: ${be.message || be.name || 'error'}${details}`
      : (typeof be === 'object' && be.message) ? be.message : `HTTP ${res.status}`;
    const err = new Error(msg);
    err.kind = res.status === 401 || res.status === 403 ? 'auth' : (res.status >= 500 || res.status === 429 ? 'unavailable' : 'tool');
    err.status = res.status;
    throw err;
  }
  return json;
}

const MEDIA_INLINE_MAX = 7 * 1024 * 1024; // callable responses are capped at ~10 MB once base64-encoded

// Fetches a received WhatsApp file. Returns {url} (short-lived link) or, with inline, {data, mime, size}.
async function fetchMedia(fetchImpl, req) {
  let res;
  try {
    res = await fetchImpl(req.url, { method: 'GET', headers: req.headers, redirect: 'manual' });
  } catch (e) {
    const err = new Error('Could not reach the service: ' + (e && e.message)); err.kind = 'unavailable'; throw err;
  }
  if (res.status === 410) {
    const err = new Error('media_expired: WhatsApp files are only kept for 30 days after they arrive.'); err.kind = 'tool'; err.status = 410; throw err;
  }
  let bytesRes = null, url = null;
  if (res.status >= 300 && res.status < 400) {
    url = res.headers.get('location');
    if (!url) { const err = new Error('No file link came back from Bird.'); err.kind = 'unavailable'; throw err; }
    if (!req.inline) return { url, expires_in: 900 };
    // The storage link must be fetched WITHOUT the Bird key.
    try { bytesRes = await fetchImpl(url, { method: 'GET' }); } catch (e) { const err = new Error('Could not download the file: ' + (e && e.message)); err.kind = 'unavailable'; throw err; }
  } else if (res.ok) {
    bytesRes = res;
  } else {
    return send(async () => res, req); // reuses the error mapping
  }
  if (!bytesRes.ok) { const err = new Error(`HTTP ${bytesRes.status} downloading the file`); err.kind = bytesRes.status >= 500 ? 'unavailable' : 'tool'; throw err; }
  const mime = (bytesRes.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  const buf = Buffer.from(await bytesRes.arrayBuffer());
  if (buf.length > MEDIA_INLINE_MAX) {
    if (url) return { url, expires_in: 900, too_large: true, size: buf.length };
    const err = new Error('too_large: the file is bigger than 7 MB'); err.kind = 'tool'; throw err;
  }
  return { data: buf.toString('base64'), mime, size: buf.length };
}

module.exports = {
  fetchMedia,
  normalizeCode, hashCode, codeMatches, todayInJoburg,
  birdHost, birdRequest, BIRD_TOOLS,
  cleanSecret, cleanBirdKey, parseCloudinaryUrl, cloudinarySignature, cloudinaryRequest, CLOUDINARY_TOOLS,
  badInput, send,
};
