const DB_NAME = 'sahayak-offline-v1';
const DB_VERSION = 3;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('This browser does not support local emergency report storage.'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('reports')) {
        const reports = db.createObjectStore('reports', { keyPath: 'localId' });
        reports.createIndex('createdAt', 'createdAt');
        reports.createIndex('syncStatus', 'syncStatus');
      }
      if (!db.objectStoreNames.contains('directory')) db.createObjectStore('directory', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('providerCache')) db.createObjectStore('providerCache', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('providerActions')) { const actions = db.createObjectStore('providerActions', { keyPath: 'localId' }); actions.createIndex('createdAt', 'createdAt'); actions.createIndex('syncStatus', 'syncStatus'); }
      if (!db.objectStoreNames.contains('requesterUpdates')) { const updates = db.createObjectStore('requesterUpdates', { keyPath: 'localId' }); updates.createIndex('reportId', 'reportId'); updates.createIndex('createdAt', 'createdAt'); updates.createIndex('syncStatus', 'syncStatus'); }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local report storage.'));
  });
}

async function withStore(storeName, mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try { result = action(store); } catch (error) { db.close(); reject(error); return; }
    transaction.oncomplete = () => { db.close(); resolve(result?.result); };
    transaction.onerror = () => { db.close(); reject(transaction.error || result?.error || new Error('Local storage operation failed.')); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Local storage operation was cancelled.')); };
  });
}

export const saveOfflineReport = report => withStore('reports', 'readwrite', store => store.put(report));
export const removeOfflineReport = localId => withStore('reports', 'readwrite', store => store.delete(localId));
export const getOfflineReport = localId => withStore('reports', 'readonly', store => store.get(localId));
export const listOfflineReports = () => withStore('reports', 'readonly', store => store.getAll()).then(rows => (rows || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
export const saveOfflineDirectory = value => withStore('directory', 'readwrite', store => store.put({ key: 'verified-responders', ...value }));
export const getOfflineDirectory = () => withStore('directory', 'readonly', store => store.get('verified-responders'));
export const saveProviderSnapshot = (key, value) => withStore('providerCache', 'readwrite', store => store.put({ key, value, savedAt: new Date().toISOString() }));
export const getProviderSnapshot = key => withStore('providerCache', 'readonly', store => store.get(key)).then(row => row?.value || null);
export const queueProviderAction = action => withStore('providerActions', 'readwrite', store => store.put({ ...action, localId: action.localId || crypto.randomUUID(), createdAt: action.createdAt || new Date().toISOString(), syncStatus: 'pending' }));
export const listProviderActions = () => withStore('providerActions', 'readonly', store => store.getAll()).then(rows => (rows || []).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)));
export const removeProviderAction = localId => withStore('providerActions', 'readwrite', store => store.delete(localId));
export const updateProviderAction = action => withStore('providerActions', 'readwrite', store => store.put(action));
export const queueRequesterUpdate = update => withStore('requesterUpdates', 'readwrite', store => store.put({ ...update, localId: update.localId || crypto.randomUUID(), clientUpdateId: update.clientUpdateId || crypto.randomUUID(), createdAt: update.createdAt || new Date().toISOString(), syncStatus: update.syncStatus || 'pending' }));
export const listRequesterUpdates = reportId => withStore('requesterUpdates', 'readonly', store => reportId ? store.index('reportId').getAll(reportId) : store.getAll()).then(rows => (rows || []).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)));
export const updateRequesterUpdate = update => withStore('requesterUpdates', 'readwrite', store => store.put(update));
export const removeRequesterUpdate = localId => withStore('requesterUpdates', 'readwrite', store => store.delete(localId));
