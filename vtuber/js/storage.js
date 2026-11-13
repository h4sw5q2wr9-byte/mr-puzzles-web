// Keeps the avatar on this device (IndexedDB) so it opens instantly and works on a weak connection.
// Entry: {buf: ArrayBuffer, meta: {kind: 'bundled' | 'custom', version?}}. Older app versions stored the
// bare ArrayBuffer; those read back as kind 'legacy'.
const DB = 'mr-puzzles', STORE = 'models', KEY = 'last';
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function saveModel(buf, meta = { kind: 'custom' }) {
  const db = await open();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put({ buf, meta }, KEY); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
export async function loadModel() {
  try {
    const db = await open();
    const v = await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).get(KEY); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
    if (!v) return null;
    if (v instanceof ArrayBuffer) return { buf: v, meta: { kind: 'legacy' } };
    return v;
  } catch { return null; }
}
export async function clearModel() {
  try {
    const db = await open();
    await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(KEY); tx.oncomplete = res; tx.onerror = res; });
  } catch {}
}
