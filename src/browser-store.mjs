export async function browserStore(name = 'swarmkit-economy-v1') {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return {
    async read() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readonly');
        const request = tx.objectStore('state').get('economy');
        request.onsuccess = () => resolve(request.result ?? { revision: 0, value: null });
        request.onerror = () => reject(request.error);
      });
    },
    async write(value, revision) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite');
        const table = tx.objectStore('state');
        const read = table.get('economy');
        let conflict = false;
        read.onsuccess = () => {
          if ((read.result?.revision ?? 0) !== revision) { conflict = true; tx.abort(); return; }
          table.put({ revision: revision + 1, value }, 'economy');
        };
        tx.oncomplete = () => resolve(revision + 1);
        tx.onabort = () => reject(new Error(conflict ? 'Another tab updated this market. Reload its latest state.' : 'Local storage transaction failed'));
        tx.onerror = () => reject(tx.error);
      });
    },
    lock(action) {
      if (!navigator.locks) throw new Error('This browser needs Web Locks support for safe market updates. Use a current browser over HTTPS or localhost.');
      return navigator.locks.request(name, action);
    },
  };
}
