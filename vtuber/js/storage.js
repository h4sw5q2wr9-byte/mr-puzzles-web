// Remembers the last loaded .vrm on this device (IndexedDB), so it loads automatically next time.
const DB = 'mr-puzzles', STORE = 'models', KEY = 'last';
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function saveModel(buf) {
  const db = await open();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(buf, KEY); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
export async function loadModel() {
  try {
    const db = await open();
    return await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).get(KEY); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  } catch { return null; }
}
