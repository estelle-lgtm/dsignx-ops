/*
 * DsignX Ops — platform layer.
 *
 * Connects the app to Firebase (Authentication, Firestore, Cloud Functions) and
 * exposes window.DSX, which app.js uses for:
 *   DSX.auth        sign in / create account / sign out / password reset
 *   DSX.db          Firestore documents and collections (get/set/update/delete/onSnapshot)
 *   DSX.mcp         WhatsApp (Bird) and file hosting (Cloudinary) through the `connector` function
 *   DSX.assets      artwork uploads (stored on Cloudinary)
 *   DSX.downloads   saving generated files (PDFs, CSVs) to this device
 *
 * If js/firebase-config.js is not filled in, DSX.configured is false and the app
 * runs in demo mode with sample data.
 */
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const CFG = window.DSX_CONFIG || {};
const fb = CFG.firebase || {};

function notConfigured(reason) {
  window.DSX = { configured: false, error: reason };
}

if (!fb.apiKey || !fb.projectId || !fb.appId) {
  notConfigured('Firebase isn’t configured yet (fill in js/firebase-config.js).');
} else {
  try {
    const [appMod, authMod, fsMod, fnMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-functions.js`),
    ]);
    setup(appMod, authMod, fsMod, fnMod);
  } catch (e) {
    console.error(e);
    notConfigured('Couldn’t load Firebase. Check your internet connection and reload the page.');
  }
}

function setup(appMod, authMod, fsMod, fnMod) {
  const app = appMod.initializeApp(fb);
  const auth = authMod.getAuth(app);
  // Signed in for this browser tab only; closing the tab signs out.
  const persistenceReady = authMod.setPersistence(auth, authMod.browserSessionPersistence).catch(() => {});
  const fs = fsMod.initializeFirestore(app, { ignoreUndefinedProperties: true });
  const functions = fnMod.getFunctions(app, CFG.functionsRegion || 'europe-west1');
  const callable = (name, timeout) => fnMod.httpsCallable(functions, name, { timeout: timeout || 70000 });
  const connectorFn = callable('connector', 90000);

  /* ---------- auth ---------- */
  const authApi = {
    onChange(cb) {
      persistenceReady.then(() => authMod.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email } : null)));
    },
    signIn: (email, pw) => persistenceReady.then(() => authMod.signInWithEmailAndPassword(auth, email, pw)),
    create: (email, pw) => persistenceReady.then(() => authMod.createUserWithEmailAndPassword(auth, email, pw)),
    signOut: () => authMod.signOut(auth),
    reset: (email) => authMod.sendPasswordResetEmail(auth, email),
    updatePassword: (pw) => (auth.currentUser ? authMod.updatePassword(auth.currentUser, pw) : Promise.reject({ code: 'auth/requires-recent-login' })),
    emailVerified: () => !!(auth.currentUser && auth.currentUser.emailVerified),
    sendVerification: () => (auth.currentUser ? authMod.sendEmailVerification(auth.currentUser) : Promise.reject({ code: 'auth/no-current-user' })),
    // Re-reads the account (and a fresh token) after the person clicks the email link.
    refresh: async () => {
      if (!auth.currentUser) return false;
      await auth.currentUser.reload();
      await auth.currentUser.getIdToken(true);
      return !!auth.currentUser.emailVerified;
    },
  };

  /* ---------- Firestore, in the shape app.js expects ---------- */
  const wrapDoc = (s) => ({ exists: s.exists(), id: s.id, data: () => s.data() });
  const quiet = (err) => (e) => { if (err) err(e); else console.warn('[DsignX Ops] listener error', e && e.code); };

  function docRef(path) {
    const r = fsMod.doc(fs, path);
    return {
      id: r.id,
      get: () => fsMod.getDoc(r).then(wrapDoc),
      set: (v) => fsMod.setDoc(r, v),
      merge: (v) => fsMod.setDoc(r, v, { merge: true }),
      update: (v) => fsMod.updateDoc(r, v),
      delete: () => fsMod.deleteDoc(r),
      onSnapshot: (cb, err) => fsMod.onSnapshot(r, (s) => cb(wrapDoc(s)), quiet(err)),
    };
  }
  function coll(path, constraints) {
    constraints = constraints || [];
    const c = fsMod.collection(fs, path);
    const q = constraints.length ? fsMod.query(c, ...constraints) : c;
    return {
      doc: (id) => docRef(`${path}/${id}`),
      add: (v) => fsMod.addDoc(c, v).then((r) => ({ id: r.id })),
      orderBy: (f, d) => coll(path, constraints.concat([fsMod.orderBy(f, d || 'asc')])),
      where: (f, op, v) => coll(path, constraints.concat([fsMod.where(f, op, v)])),
      limit: (n) => coll(path, constraints.concat([fsMod.limit(n)])),
      get: () => fsMod.getDocs(q).then((qs) => ({ docs: qs.docs.map(wrapDoc) })),
      onSnapshot: (cb, err) => fsMod.onSnapshot(q, (qs) => cb({ docs: qs.docs.map(wrapDoc) }), quiet(err)),
    };
  }
  const db = { doc: docRef, collection: (p) => coll(p) };

  // Writes many documents in batches of 400 (Firestore allows 500 per batch).
  async function importDocs(writes, onProgress) {
    let done = 0;
    for (let i = 0; i < writes.length; i += 400) {
      const batch = fsMod.writeBatch(fs);
      writes.slice(i, i + 400).forEach((w) => batch.set(fsMod.doc(fs, w.path), w.data));
      await batch.commit();
      done = Math.min(writes.length, i + 400);
      if (onProgress) onProgress(done);
    }
    return done;
  }

  // Hands out the next number(s) of a counter in config/business, safely across devices.
  async function reserveNumbers(field, count) {
    const ref = fsMod.doc(fs, 'config/business');
    return fsMod.runTransaction(fs, async (tx) => {
      const s = await tx.get(ref);
      const cur = Number((s.exists() && s.data()[field]) || 1);
      tx.set(ref, { [field]: cur + (count || 1) }, { merge: true });
      return cur;
    });
  }

  // Patches fields on many existing documents, 400 per batch.
  async function updateDocs(list) {
    for (let i = 0; i < list.length; i += 400) {
      const batch = fsMod.writeBatch(fs);
      list.slice(i, i + 400).forEach((w) => batch.update(fsMod.doc(fs, w.path), w.data));
      await batch.commit();
    }
  }

  // The first owner: allowed once, for the owner email named in firestore.rules.
  async function ownerClaimable() {
    const email = String((auth.currentUser && auth.currentUser.email) || '').toLowerCase();
    if (!email || email !== String(CFG.ownerEmail || '').toLowerCase()) return false;
    const s = await fsMod.getDoc(fsMod.doc(fs, 'meta/owner'));
    return !s.exists();
  }
  async function claimOwner() {
    const u = auth.currentUser;
    if (!u) throw new Error('Not signed in');
    const batch = fsMod.writeBatch(fs);
    const now = new Date().toISOString();
    batch.set(fsMod.doc(fs, `links/${u.uid}`), { role: 'owner', memberId: null, linkedAt: now });
    batch.set(fsMod.doc(fs, 'meta/owner'), { uid: u.uid, email: u.email, at: now });
    await batch.commit();
  }

  /* ---------- connectors (Bird + Cloudinary via the `connector` function) ---------- */
  function toMcpError(e, server) {
    const code = String((e && e.code) || '').replace(/^functions\//, '');
    const details = (e && e.details) || {};
    const message = (e && e.message) || 'Unknown error';
    const map = {
      unauthenticated: 'needs_reauth',
      'permission-denied': 'blocked_by_policy',
      'failed-precondition': 'server_not_connected',
      unavailable: 'server_unavailable',
      'deadline-exceeded': 'server_unavailable',
      internal: 'server_unavailable',
    };
    const out = { code: details.code || map[code] || 'tool_error', message, server: details.server || server };
    if (out.code === 'server_unavailable') out.retryable = true;
    return out;
  }
  function callTool(server, tool, input) {
    return connectorFn({ server, tool, input: input || {} })
      .then((r) => ({ payload: r.data, content: [] }))
      .catch((e) => { throw toMcpError(e, server); });
  }
  const watches = new Set();
  function watchTool(server, tool, input, handler, opts) {
    const w = { server, tool, run: null, timer: null, stopped: false };
    w.run = () => {
      if (w.stopped) return;
      callTool(server, tool, input).then(
        (result) => { if (!w.stopped) handler({ type: 'data', result }); },
        (error) => { if (!w.stopped) handler({ type: 'error', error }); }
      );
    };
    const every = Math.max(30000, (opts && opts.refetchInterval) || 0);
    if (opts && opts.refetchInterval) {
      w.timer = setInterval(() => { if (!document.hidden) w.run(); }, every);
    }
    watches.add(w);
    setTimeout(w.run, 0);
    return () => { w.stopped = true; clearInterval(w.timer); watches.delete(w); };
  }
  function invalidate(server, tool) {
    watches.forEach((w) => { if ((!server || w.server === server) && (!tool || w.tool === tool)) w.run(); });
    return Promise.resolve();
  }
  function listTools() {
    return callTool('_status', 'status', {}).then((r) => {
      const st = r.payload || {};
      return {
        servers: [
          { server: 'Bird', authStatus: 'connected', tools: st.bird ? [{ name: 'whatsapp_send' }, { name: 'whatsapp_list' }] : [] },
          { server: 'Cloudinary', authStatus: 'connected', tools: st.cloudinary ? [{ name: 'upload-asset' }] : [] },
        ],
      };
    });
  }
  const mcp = { callTool, watchTool, invalidate, listTools };

  /* ---------- artwork uploads (Cloudinary) ---------- */
  const readDataUrl = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('Could not read file'));
    fr.readAsDataURL(blob);
  });
  const assets = {
    async upload(file) {
      if (file.size > 9 * 1024 * 1024) throw { code: 'too_large', message: 'Files must be under 9 MB' };
      const isImage = (file.type || '').indexOf('image/') === 0;
      const uri = await readDataUrl(file);
      const slug = 'dsignx-artwork/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + (isImage ? '' : '.pdf');
      const r = await callTool('Cloudinary', 'upload-asset', {
        resource_type: isImage ? 'image' : 'raw',
        upload_request: { file: uri, public_id: slug, tags: ['dsignx-artwork'], overwrite: false },
      });
      const p = r.payload || {};
      return { id: p.secure_url, url: p.secure_url, sizeBytes: p.bytes, contentType: file.type };
    },
  };

  /* ---------- downloads ---------- */
  const downloads = {
    save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return Promise.resolve();
    },
  };

  window.DSX = {
    configured: true,
    auth: authApi,
    db,
    mcp,
    assets,
    downloads,
    importDocs,
    updateDocs,
    reserveNumbers,
    ownerClaimable,
    claimOwner,
    call: (name, data) => callable(name)(data).then((r) => r.data),
  };
}
