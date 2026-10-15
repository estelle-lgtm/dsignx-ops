'use strict';
/*
 * DsignX Ops — Cloud Functions (Node.js 22).
 *
 *   redeemInvite  A new team member enters their invite code; if it matches a team
 *                 record, they get access (links/{uid}).
 *   connector     Calls Bird (WhatsApp) and Cloudinary (file links) for the app, using
 *                 API keys that stay on the server. Owner and designers only.
 *
 * Secrets (set once with the Firebase CLI, see SETUP_GUIDE.md):
 *   BIRD_API_KEY     Bird workspace API key with WhatsApp read + write.
 *   CLOUDINARY_URL   cloudinary://API_KEY:API_SECRET@CLOUD_NAME
 * Parameter:
 *   WA_FROM          The WhatsApp business number messages are sent from (E.164).
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const core = require('./lib/core');

admin.initializeApp();
const db = admin.firestore();

// Keep in sync with functionsRegion in js/firebase-config.js.
setGlobalOptions({ region: 'europe-west1', maxInstances: 5 });

const BIRD_API_KEY = defineSecret('BIRD_API_KEY');
const CLOUDINARY_URL = defineSecret('CLOUDINARY_URL');
const WA_FROM = defineString('WA_FROM', { default: '+27604934689' });

const MAX_TRIES = 5;           // wrong invite codes allowed …
const TRY_WINDOW_MS = 10 * 60 * 1000; // … per 10 minutes, per account

/* ---------------- who is calling ---------------- */

async function roleOf(uid) {
  const link = await db.doc(`links/${uid}`).get();
  if (!link.exists) return null;
  const l = link.data();
  if (l.role === 'owner') return 'owner';
  if (!l.memberId) return null;
  const m = await db.doc(`team/${l.memberId}`).get();
  if (!m.exists || m.get('active') === false) return null;
  return m.get('role') || null;
}

/* ---------------- redeemInvite ---------------- */

exports.redeemInvite = onCall(async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const uid = req.auth.uid;
  const code = core.normalizeCode(req.data && req.data.code);
  if (code.length !== 9) throw new HttpsError('invalid-argument', 'Invite codes have 8 letters and numbers, like ABCD-2345.');

  // Simple per-account rate limit.
  const triesRef = db.doc(`redeemAttempts/${uid}`);
  const now = Date.now();
  const tries = await db.runTransaction(async (tx) => {
    const s = await tx.get(triesRef);
    let t = s.exists ? s.data() : { count: 0, since: now };
    if (now - (t.since || 0) > TRY_WINDOW_MS) t = { count: 0, since: now };
    t.count += 1;
    tx.set(triesRef, t);
    return t;
  });
  if (tries.count > MAX_TRIES) throw new HttpsError('resource-exhausted', 'Too many tries. Wait 10 minutes and try again.');

  const team = await db.collection('team').get();
  const today = core.todayInJoburg(now);
  for (const doc of team.docs) {
    const m = doc.data();
    if (!m.inviteHash || m.active === false) continue;
    if (!core.codeMatches(code, m)) continue;
    if (m.inviteExpires && m.inviteExpires < today) {
      throw new HttpsError('failed-precondition', 'That code has expired. Ask the owner to send you a new one.');
    }
    // One use only: link this account and clear the code in a single transaction.
    const linkRef = db.doc(`links/${uid}`);
    await db.runTransaction(async (tx) => {
      const [teamSnap, linkSnap] = await Promise.all([tx.get(doc.ref), tx.get(linkRef)]);
      if (linkSnap.exists) throw new HttpsError('already-exists', 'This account already has access. Sign out and sign in again.');
      if (!teamSnap.exists || teamSnap.get('inviteHash') !== m.inviteHash) {
        throw new HttpsError('not-found', 'That code has already been used. Ask the owner for a new one.');
      }
      tx.set(linkRef, { memberId: doc.id, email: req.auth.token.email || null, linkedAt: new Date(now).toISOString() });
      tx.update(doc.ref, { inviteHash: null, inviteSalt: null, inviteUsedAt: new Date(now).toISOString() });
    });
    await triesRef.delete();
    logger.info('Invite redeemed', { memberId: doc.id, uid });
    return { ok: true, memberId: doc.id, role: m.role };
  }
  throw new HttpsError('not-found', 'That code isn’t valid. Check it, or ask the owner for a new one.');
});

/* ---------------- connector (Bird + Cloudinary) ---------------- */

function toHttpsError(err, server) {
  const details = { server };
  if (err.kind === 'bad_input') return new HttpsError('invalid-argument', err.message, Object.assign(details, { code: 'tool_error' }));
  if (err.kind === 'unavailable') return new HttpsError('unavailable', err.message, Object.assign(details, { code: 'server_unavailable' }));
  if (err.kind === 'auth') return new HttpsError('failed-precondition', `${server} rejected the API key: ${err.message}`, Object.assign(details, { code: 'tool_error' }));
  return new HttpsError('aborted', err.message, Object.assign(details, { code: 'tool_error' }));
}

exports.connector = onCall(
  { secrets: [BIRD_API_KEY, CLOUDINARY_URL], memory: '512MiB', timeoutSeconds: 60 },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const role = await roleOf(req.auth.uid);
    if (role !== 'owner' && role !== 'designer') {
      throw new HttpsError('permission-denied', 'Only the owner and designers can use WhatsApp and file sending.');
    }
    const { server, tool, input } = req.data || {};
    const birdKey = core.cleanBirdKey(BIRD_API_KEY.value());
    const cloud = core.parseCloudinaryUrl(CLOUDINARY_URL.value());
    if (!cloud && CLOUDINARY_URL.value()) logger.warn('CLOUDINARY_URL is set but not in the form cloudinary://KEY:SECRET@CLOUD_NAME');
    if (!birdKey && BIRD_API_KEY.value()) logger.warn('BIRD_API_KEY is set but does not look like a Bird key (bk_...)');

    if (server === '_status') {
      return { bird: !!birdKey, cloudinary: !!cloud };
    }

    if (server === 'Bird') {
      if (!core.BIRD_TOOLS.includes(tool)) throw new HttpsError('invalid-argument', `Unknown tool ${tool}`, { code: 'tool_error', server });
      if (!birdKey) throw new HttpsError('failed-precondition', 'BIRD_API_KEY is not set on the server.', { code: 'server_not_connected', server });
      try {
        const r = core.birdRequest(tool, input, { apiKey: birdKey, from: WA_FROM.value() });
        return await core.send(fetch, r);
      } catch (e) {
        logger.warn('Bird call failed', { tool, message: e.message });
        throw toHttpsError(e, server);
      }
    }

    if (server === 'Cloudinary') {
      if (!core.CLOUDINARY_TOOLS.includes(tool)) throw new HttpsError('invalid-argument', `Unknown tool ${tool}`, { code: 'tool_error', server });
      if (!cloud) throw new HttpsError('failed-precondition', 'CLOUDINARY_URL is not set on the server.', { code: 'server_not_connected', server });
      if (tool === 'delete-asset' && role !== 'owner') throw new HttpsError('permission-denied', 'Only the owner can delete files.', { code: 'blocked_by_policy', server });
      try {
        const r = core.cloudinaryRequest(tool, input, cloud);
        return await core.send(fetch, r);
      } catch (e) {
        logger.warn('Cloudinary call failed', { tool, message: e.message });
        throw toHttpsError(e, server);
      }
    }

    throw new HttpsError('invalid-argument', `Unknown service ${server}`, { code: 'tool_error', server });
  }
);
