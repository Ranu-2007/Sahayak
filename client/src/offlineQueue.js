import api from './api.js';
import { listOfflineReports, saveOfflineReport, listProviderActions, removeProviderAction, updateProviderAction, listRequesterUpdates, updateRequesterUpdate } from './offlineStore.js';
import { sortOfflineReports } from './offlinePriority.js';
let activeSync = null;
let activeRequesterSync = null;

function isUnsent(report) { return ['waiting_to_send', 'sending', 'failed', 'waiting_for_sign_in'].includes(report.syncStatus); }

async function uploadEvidence(report, serverRequestId) {
  const uploaded = new Set(report.uploadedFileIds || []);
  const files = (report.files || []).filter(item => !uploaded.has(item.clientFileId));
  if (!files.length) return uploaded;
  const form = new FormData();
  form.append('clientFileIds', JSON.stringify(files.map(item => item.clientFileId)));
  files.forEach(item => form.append('photos', item.file, item.file.name));
  await api.post(`/requests/${serverRequestId}/evidence`, form, { timeout: 60000 });
  for (const item of files) uploaded.add(item.clientFileId);
  return uploaded;
}

export async function syncOfflineReports({ onProgress } = {}) {
  if (activeSync) return activeSync;
  if (!navigator.onLine) return { synced: 0, pending: (await listOfflineReports()).filter(isUnsent).length, offline: true };
  activeSync = (async () => {
    const reports = sortOfflineReports((await listOfflineReports()).filter(isUnsent));
    let synced = 0;
    for (const report of reports) {
      const sending = { ...report, syncStatus: 'sending', lastAttemptAt: new Date().toISOString(), lastError: '' };
      await saveOfflineReport(sending);
      await onProgress?.(sending);
      try {
        let serverRequestId = report.serverRequestId;
        if (!serverRequestId) {
          const { data } = await api.post('/requests', { ...report.payload, clientReportId: report.localId, clientCreatedAt: report.createdAt, offlineSync: true }, { timeout: 30000 });
          serverRequestId = data.request?._id;
          if (!serverRequestId) throw new Error('Server did not confirm receipt of the report.');
        }
        const uploadedFileIds = await uploadEvidence(report, serverRequestId);
        const delivered = { ...report, serverRequestId, uploadedFileIds: [...uploadedFileIds], syncStatus: 'delivery_confirmed', synchronizedAt: new Date().toISOString(), lastError: '' };
        await saveOfflineReport(delivered);
        await onProgress?.(delivered);
        synced += 1;
      } catch (error) {
        const needsSignIn = [401, 403].includes(error.response?.status);
        const failed = { ...sending, syncStatus: needsSignIn ? 'waiting_for_sign_in' : navigator.onLine ? 'failed' : 'waiting_to_send', serverRequestId: report.serverRequestId || null, lastError: error.response?.data?.message || (navigator.onLine ? error.message : 'Connection lost. Report remains saved on this device.') };
        await saveOfflineReport(failed);
        await onProgress?.(failed);
        if (!navigator.onLine) break;
      }
    }
    const pending = (await listOfflineReports()).filter(isUnsent).length;
    return { synced, pending, offline: !navigator.onLine };
  })().finally(() => { activeSync = null; });
  return activeSync;
}

export async function syncProviderActions({ onProgress } = {}) {
  if (!navigator.onLine) return { synced: 0, pending: (await listProviderActions()).filter(action => action.syncStatus === 'pending').length, offline: true };
  let synced = 0;
  const actions = (await listProviderActions()).filter(action => action.syncStatus === 'pending');
  for (const action of actions) {
    try {
      await api({ method: action.method, url: action.url, data: action.data, headers: { 'X-Client-Action-Id': action.localId } });
      await removeProviderAction(action.localId);
      synced += 1;
      await onProgress?.();
    } catch (error) {
      await updateProviderAction({ ...action, syncStatus: 'failed', lastError: error.response?.data?.message || error.message || 'Synchronization failed.' });
    }
  }
  const pending = (await listProviderActions()).filter(action => action.syncStatus === 'pending').length;
  const failed = (await listProviderActions()).filter(action => action.syncStatus === 'failed').length;
  return { synced, pending, failed, offline: !navigator.onLine };
}

export async function syncRequesterUpdates({ onProgress } = {}) {
  if (activeRequesterSync) return activeRequesterSync;
  if (!navigator.onLine) return { synced: 0, offline: true };
  activeRequesterSync = (async () => {
  const updates = (await listRequesterUpdates()).filter(update => ['pending', 'waiting_for_sign_in'].includes(update.syncStatus));
  let synced = 0;
  for (const update of updates) {
    const sending = { ...update, syncStatus: 'sending', lastAttemptAt: new Date().toISOString(), lastError: '' };
    await updateRequesterUpdate(sending); await onProgress?.();
    try {
      const { data } = await api.post(`/requests/${encodeURIComponent(update.reportId)}/updates`, { body: update.body, clientUpdateId: update.clientUpdateId }, { headers: { 'X-Client-Update-Id': update.clientUpdateId } });
      await updateRequesterUpdate({ ...sending, syncStatus: 'delivery_confirmed', serverUpdateId: data.update?._id || null, synchronizedAt: new Date().toISOString(), lastError: '' });
      synced += 1;
    } catch (error) {
      const needsSignIn = [401, 403].includes(error.response?.status);
      await updateRequesterUpdate({ ...sending, syncStatus: needsSignIn ? 'waiting_for_sign_in' : navigator.onLine ? 'failed' : 'pending', lastError: error.response?.data?.message || error.message || 'Synchronization failed.' });
      if (!navigator.onLine) break;
    }
    await onProgress?.();
  }
  const all = await listRequesterUpdates();
  return { synced, pending: all.filter(update => update.syncStatus === 'pending').length, failed: all.filter(update => update.syncStatus === 'failed').length, offline: !navigator.onLine };
  })().finally(() => { activeRequesterSync = null; });
  return activeRequesterSync;
}
