/** Read the actual account store without accidentally creating a legacy/empty database. */
export async function readAccountStore(page, table, { id, userId, filter } = {}) {
  await page.waitForFunction(async ([table, expectedUser]) => {
    const user = localStorage.getItem('ws_uid');
    if (!user || (expectedUser && user !== expectedUser)) return false;
    const name = `workspace-${user}`;
    if (!(await indexedDB.databases()).some(db => db.name === name)) return false;
    return await new Promise(resolve => {
      const request = indexedDB.open(name);
      request.onupgradeneeded = () => { request.transaction.abort(); resolve(false); };
      request.onerror = () => resolve(false);
      request.onsuccess = () => { const database = request.result; const ready = database.objectStoreNames.contains(table); database.close(); resolve(ready); };
    });
  }, [table, userId ?? null], { timeout: 20000 });
  const value = await page.evaluate(async ([table, id, expectedUser]) => {
    const user = localStorage.getItem('ws_uid');
    if (!user || (expectedUser && user !== expectedUser)) throw new Error('Fixture account changed while reading local data');
    const name = `workspace-${user}`;
    if (!(await indexedDB.databases()).some(db => db.name === name)) throw new Error(`Account database not created: ${name}`);
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('Refusing to create an empty account database')); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      if (!database.objectStoreNames.contains(table)) throw new Error(`Missing ${table} account store`);
      return await new Promise((resolve, reject) => {
        const request = database.transaction(table, 'readonly').objectStore(table)[id == null ? 'getAll' : 'get'](...(id == null ? [] : [id]));
        request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error);
      });
    } finally { database.close(); }
  }, [table, id ?? null, userId ?? null]);
  return filter && Array.isArray(value) ? value.filter(filter) : value;
}
