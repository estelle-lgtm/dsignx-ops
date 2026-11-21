'use strict';
// Tiny in-memory stand-in for the parts of Firestore the Xero sync uses.
function get(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function deepMerge(a, b) {
  const out = Object.assign({}, a);
  Object.keys(b).forEach((k) => {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  });
  return out;
}
function makeDb() {
  const S = {}; let auto = 0;
  const snap = (path) => ({ exists: path in S, id: path.split('/').pop(), ref: docRef(path), data: () => (path in S ? JSON.parse(JSON.stringify(S[path])) : undefined), get: (k) => get(S[path], k) });
  function docRef(path) {
    return {
      id: path.split('/').pop(), path,
      get: async () => snap(path),
      set: async (d, o) => { S[path] = o && o.merge && S[path] ? deepMerge(S[path], d) : JSON.parse(JSON.stringify(d)); },
      delete: async () => { delete S[path]; },
    };
  }
  function query(coll, filters, lim) {
    return {
      where: (f, op, v) => query(coll, filters.concat([[f, op, v]]), lim),
      limit: (n) => query(coll, filters, n),
      get: async () => {
        let docs = Object.keys(S).filter((p) => p.startsWith(coll + '/') && p.split('/').length === 2).map(snap);
        docs = docs.filter((d) => filters.every(([f, op, v]) => { const x = get(S[d.ref.path], f); return op === 'in' ? v.includes(x) : x === v; }));
        if (lim) docs = docs.slice(0, lim);
        return { empty: !docs.length, docs, size: docs.length };
      },
      add: async (d) => { const id = 'auto' + (++auto); S[coll + '/' + id] = JSON.parse(JSON.stringify(d)); return docRef(coll + '/' + id); },
    };
  }
  return {
    S,
    doc: docRef,
    collection: (c) => query(c, [], 0),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => { r.set(d, o); } }),
    batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), commit: async () => { for (const f of ops) await f(); } }; },
  };
}
module.exports = { makeDb };
