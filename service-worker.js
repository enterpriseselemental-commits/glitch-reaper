// manages persistent extension state, incident processing and cloud sync

'use strict';

if (typeof GlitchReaperCore === 'undefined' && typeof importScripts === 'function') {
  importScripts('shared/incident-utils.js');
}

const incidentUtils = GlitchReaperCore;

// keep writes and cloud sync jobs ordered so reports cannot overwrite each other
const storageKeys = Object.freeze({
  settings: 'gr_settings',
  incidents: 'gr_incidents',
  profiles: 'gr_profiles',
  sync: 'gr_sync'
});
const legacyStorageKeys = Object.freeze(['gr_events', 'gr_errors', 'gr_bugs']);
const allStorageKeys = Object.freeze(Object.values(storageKeys));
let writeQueue = Promise.resolve();
let syncQueue = Promise.resolve();

function runtimeError() {
  return chrome.runtime.lastError ? new Error(chrome.runtime.lastError.message) : null;
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = runtimeError();
      if (error) {
        reject(error);
        return;
      }
      resolve(result || {});
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = runtimeError();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    if (!chrome.storage.local.remove) {
      resolve();
      return;
    }
    chrome.storage.local.remove(keys, () => {
      const error = runtimeError();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function storageBytes() {
  return new Promise((resolve) => {
    if (!chrome.storage.local.getBytesInUse) {
      resolve(0);
      return;
    }
    chrome.storage.local.getBytesInUse(null, (bytes) => resolve(Number(bytes || 0)));
  });
}

function platformInfo() {
  return new Promise((resolve) => {
    if (!chrome.runtime.getPlatformInfo) {
      resolve({ os: '', arch: '' });
      return;
    }
    chrome.runtime.getPlatformInfo((info) => resolve(info || { os: '', arch: '' }));
  });
}

function serialise(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function pruneIncidents(records, settings) {
  const normalized = incidentUtils.normalizeSettings(settings);
  const cutoff = Date.now() - normalized.retentionDays * incidentUtils.dayMilliseconds;
  return asArray(records)
    .map((incident) => incidentUtils.normalizeIncident(incident, normalized))
    .filter((incident) => incident.lastSeen >= cutoff)
    .sort((left, right) => left.lastSeen - right.lastSeen)
    .slice(-normalized.maxIncidents);
}

function pruneProfiles(records) {
  const cutoff = Date.now() - 90 * incidentUtils.dayMilliseconds;
  return Object.fromEntries(Object.entries(asObject(records))
    .map(([id, profile]) => [id, incidentUtils.normalizeProfile(profile, id)])
    .filter(([, profile]) => profile.lastSeen >= cutoff)
    .sort((left, right) => left[1].lastSeen - right[1].lastSeen)
    .slice(-100));
}

function normalizeSyncState(value) {
  const source = asObject(value);
  return {
    lastSyncAt: Number(source.lastSyncAt || 0),
    lastError: incidentUtils.scrubText(source.lastError || '', 500),
    lastRemoteCount: Number(source.lastRemoteCount || 0)
  };
}

async function restrictStorageAccess() {
  if (!chrome.storage.local.setAccessLevel) {
    return;
  }
  await new Promise((resolve) => {
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }, () => resolve());
  });
}

// migrate legacy report records into the current incident schema
function migrateLegacyBug(bug, settings) {
  return incidentUtils.normalizeIncident({
    id: bug?.id,
    kind: 'manual_bug',
    title: bug?.title || 'Imported bug',
    description: bug?.description || '',
    severity: bug?.severity,
    status: bug?.status,
    source: 'manual',
    detectedAt: bug?.createdAt,
    firstSeen: bug?.createdAt,
    lastSeen: bug?.updatedAt || bug?.createdAt,
    fixedAt: bug?.fixedAt,
    occurrences: 1,
    profileId: bug?.profile?.profileId || '',
    page: bug?.page,
    evidence: {
      migratedFromVersion: 2,
      recentErrors: asArray(bug?.recentErrors).slice(-10)
    },
    sync: { state: 'local' }
  }, settings);
}

async function initialise() {
  const stored = await storageGet([...allStorageKeys, ...legacyStorageKeys]);
  const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
  if (!settings.profileId) {
    settings.profileId = incidentUtils.makeId('profile');
  }
  const incidents = pruneIncidents([
    ...asArray(stored[storageKeys.incidents]),
    ...asArray(stored.gr_bugs).map((bug) => migrateLegacyBug(bug, settings))
  ], settings);
  await storageSet({
    [storageKeys.settings]: settings,
    [storageKeys.incidents]: incidents,
    [storageKeys.profiles]: pruneProfiles(stored[storageKeys.profiles]),
    [storageKeys.sync]: normalizeSyncState(stored[storageKeys.sync])
  });
  await storageRemove(legacyStorageKeys);
  await restrictStorageAccess();
  return settings;
}

const initializationPromise = initialise();

async function getSettings() {
  await initializationPromise;
  const stored = await storageGet(storageKeys.settings);
  return incidentUtils.normalizeSettings(stored[storageKeys.settings]);
}

async function saveSettings(input) {
  await initializationPromise;
  return serialise(async () => {
    const stored = await storageGet(allStorageKeys);
    const current = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
    const next = incidentUtils.normalizeSettings({ ...current, ...(input || {}), profileId: current.profileId });
    const profiles = pruneProfiles(stored[storageKeys.profiles]);
    if (profiles[next.profileId]) {
      profiles[next.profileId] = incidentUtils.normalizeProfile({
        ...profiles[next.profileId],
        profileName: next.profileName,
        profileRole: next.profileRole,
        lastSeen: Date.now()
      }, next.profileId);
    }
    await storageSet({
      [storageKeys.settings]: next,
      [storageKeys.incidents]: pruneIncidents(stored[storageKeys.incidents], next),
      [storageKeys.profiles]: profiles
    });
    return next;
  });
}

async function registerProfile(input) {
  await initializationPromise;
  return serialise(async () => {
    const stored = await storageGet([storageKeys.settings, storageKeys.profiles]);
    const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
    const profiles = pruneProfiles(stored[storageKeys.profiles]);
    const existing = profiles[settings.profileId] || {};
    const platform = await platformInfo();
    const profile = incidentUtils.normalizeProfile({
      ...existing,
      ...(input || {}),
      profileId: settings.profileId,
      profileName: settings.profileName,
      profileRole: settings.profileRole,
      firstSeen: existing.firstSeen || Date.now(),
      lastSeen: Date.now(),
      operatingSystem: input?.operatingSystem || existing.operatingSystem || platform.os,
      architecture: input?.architecture || existing.architecture || platform.arch,
      extensionVersion: chrome.runtime.getManifest().version
    }, settings.profileId);
    profiles[settings.profileId] = profile;
    await storageSet({ [storageKeys.profiles]: profiles });
    return { profileId: settings.profileId, settings, profile };
  });
}

// reopen fixed reports when the same failure is detected again
function reopenIfRecurring(existing, incoming) {
  if (existing.status !== 'fixed') {
    return existing;
  }
  if (!existing.fixedAt || incoming.lastSeen <= existing.fixedAt) {
    return existing;
  }
  return { ...existing, status: 'found', fixedAt: null };
}

// merge matching detector reports instead of creating repeated bug cards
async function captureIncidents(input) {
  await initializationPromise;
  return serialise(async () => {
    const stored = await storageGet([storageKeys.settings, storageKeys.incidents]);
    const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
    if (!settings.detectionEnabled || settings.allowedHosts.length === 0) {
      return { stored: 0, merged: 0 };
    }
    const incidents = pruneIncidents(stored[storageKeys.incidents], settings);
    let storedCount = 0;
    let mergedCount = 0;
    for (const raw of asArray(input).slice(0, 100)) {
      const incoming = incidentUtils.normalizeIncident({
        ...raw,
        profileId: raw?.profileId || settings.profileId,
        sync: incidentUtils.isRemoteConfigured(settings) ? { state: 'pending' } : { state: 'local' }
      }, settings);
      if (!incidentUtils.isUrlAllowed(incoming.page.url, settings)) {
        continue;
      }
      const index = incidents.findIndex((incident) => incident.fingerprint === incoming.fingerprint);
      if (index >= 0) {
        const existing = reopenIfRecurring(incidents[index], incoming);
        incidents[index] = incidentUtils.mergeIncident(existing, incoming, settings);
        mergedCount += 1;
      } else {
        incidents.push(incoming);
        storedCount += 1;
      }
    }
    await storageSet({ [storageKeys.incidents]: pruneIncidents(incidents, settings) });
    return { stored: storedCount, merged: mergedCount };
  });
}

// manual reports stay separate because each entry may describe a different visible issue
async function createManualIncident(input) {
  await initializationPromise;
  return serialise(async () => {
    const stored = await storageGet([storageKeys.settings, storageKeys.incidents]);
    const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
    const incidents = pruneIncidents(stored[storageKeys.incidents], settings);
    const incident = incidentUtils.normalizeManualIncident({
      ...(input || {}),
      profileId: settings.profileId,
      sync: incidentUtils.isRemoteConfigured(settings) ? { state: 'pending' } : { state: 'local' }
    }, settings);
    incidents.push(incident);
    await storageSet({ [storageKeys.incidents]: pruneIncidents(incidents, settings) });
    return { bug: incident, incident };
  });
}

// call the restricted supabase function and stop requests that hang
const cloudDataPermissions = Object.freeze([
  'personallyIdentifyingInfo',
  'browsingActivity',
  'websiteContent',
  'technicalAndInteraction'
]);

async function getGrantedPermissions() {
  if (globalThis.browser?.permissions?.getAll) return globalThis.browser.permissions.getAll();
  if (!globalThis.chrome?.permissions?.getAll) return null;
  return new Promise((resolve, reject) => {
    chrome.permissions.getAll((permissions) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(permissions);
    });
  });
}

async function canTransmitCloudData() {
  try {
    const granted = await getGrantedPermissions();
    if (!granted || !Object.prototype.hasOwnProperty.call(granted, 'data_collection')) return true;
    const approved = new Set(granted.data_collection || []);
    return cloudDataPermissions.every((permission) => approved.has(permission));
  } catch (_error) {
    return false;
  }
}

// block remote calls when firefox cloud-data permission is unavailable
async function rpc(settings, functionName, body, timeoutMs = 12000) {
  if (!(await canTransmitCloudData())) throw new Error('Cloud sync permission is not granted.');
  const normalized = incidentUtils.normalizeSettings(settings);
  if (!normalized.supabaseUrl || !normalized.supabaseKey) {
    throw new Error('Supabase URL and publishable key are required.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalized.supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: {
        apikey: normalized.supabaseKey,
        Authorization: `Bearer ${normalized.supabaseKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        payload = text;
      }
    }
    if (!response.ok) {
      const message = payload?.message || payload?.hint || payload?.error || `Datastore request failed with HTTP ${response.status}.`;
      throw new Error(incidentUtils.scrubText(message, 500));
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Datastore request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function updateSyncState(changes) {
  return serialise(async () => {
    const stored = await storageGet(storageKeys.sync);
    const next = { ...normalizeSyncState(stored[storageKeys.sync]), ...(changes || {}) };
    await storageSet({ [storageKeys.sync]: next });
    return next;
  });
}

// upload small batches and leave failed reports queued for the next retry
async function syncPendingIncidents() {
  const run = syncQueue.then(async () => {
    await initializationPromise;
    const stored = await storageGet([storageKeys.settings, storageKeys.incidents]);
    const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
    if (!incidentUtils.isRemoteConfigured(settings)) {
      return { synced: 0, skipped: true };
    }
    const incidents = pruneIncidents(stored[storageKeys.incidents], settings);
    const pending = incidents.filter((incident) => incident.sync.state !== 'synced').slice(0, 50);
    if (pending.length === 0) {
      await updateSyncState({ lastSyncAt: Date.now(), lastError: '' });
      return { synced: 0, skipped: false };
    }
    try {
      const payload = pending.map((incident) => ({
        ...incident,
        sync: undefined
      }));
      await rpc(settings, 'gr_ingest_incidents', {
        p_project_id: settings.projectId,
        p_ingest_token: settings.ingestToken,
        p_incidents: payload
      });
      const ids = new Set(pending.map((incident) => incident.id));
      await serialise(async () => {
        const latest = await storageGet([storageKeys.settings, storageKeys.incidents]);
        const latestSettings = incidentUtils.normalizeSettings(latest[storageKeys.settings]);
        const next = pruneIncidents(latest[storageKeys.incidents], latestSettings).map((incident) => ids.has(incident.id)
          ? incidentUtils.normalizeIncident({ ...incident, sync: { state: 'synced', lastAttempt: Date.now(), error: '' } }, latestSettings)
          : incident);
        await storageSet({ [storageKeys.incidents]: next });
      });
      await updateSyncState({ lastSyncAt: Date.now(), lastError: '' });
      return { synced: pending.length, skipped: false };
    } catch (error) {
      const message = incidentUtils.scrubText(error.message || String(error), 500);
      const ids = new Set(pending.map((incident) => incident.id));
      await serialise(async () => {
        const latest = await storageGet([storageKeys.settings, storageKeys.incidents]);
        const latestSettings = incidentUtils.normalizeSettings(latest[storageKeys.settings]);
        const next = pruneIncidents(latest[storageKeys.incidents], latestSettings).map((incident) => ids.has(incident.id)
          ? incidentUtils.normalizeIncident({ ...incident, sync: { state: 'failed', lastAttempt: Date.now(), error: message } }, latestSettings)
          : incident);
        await storageSet({ [storageKeys.incidents]: next });
      });
      await updateSyncState({ lastError: message });
      throw error;
    }
  });
  syncQueue = run.catch(() => undefined);
  return run;
}

async function fetchRemoteIncidents(settings) {
  if (!incidentUtils.isRemoteConfigured(settings, true)) {
    return [];
  }
  const result = await rpc(settings, 'gr_list_incidents', {
    p_project_id: settings.projectId,
    p_admin_token: settings.adminToken,
    p_limit: settings.maxIncidents
  });
  const list = Array.isArray(result) ? result : Array.isArray(result?.incidents) ? result.incidents : [];
  return list.map((incident) => incidentUtils.normalizeIncident({ ...incident, sync: { state: 'synced' } }, settings));
}

// merge cloud reports without replacing pending local changes
function mergeRemoteCache(localIncidents, remoteIncidents, settings) {
  const byId = new Map(localIncidents.map((incident) => [incident.id, incident]));
  for (const remote of remoteIncidents) {
    const local = byId.get(remote.id);
    const localNeedsSync = local && ['pending', 'failed'].includes(local.sync.state);
    if (!local || (!localNeedsSync && remote.lastSeen >= local.lastSeen)) {
      byId.set(remote.id, remote);
    }
  }
  return pruneIncidents(Array.from(byId.values()), settings);
}

async function updateIncident(id, changes) {
  await initializationPromise;
  const accessSettings = await getSettings();
  if (accessSettings.datastoreMode === 'supabase' && incidentUtils.isRemoteConfigured(accessSettings) && !incidentUtils.isRemoteConfigured(accessSettings, true)) {
    throw new Error('An admin token is required to change cloud bug status.');
  }
  const localResult = await serialise(async () => {
    const stored = await storageGet([storageKeys.settings, storageKeys.incidents]);
    const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
    const incidents = pruneIncidents(stored[storageKeys.incidents], settings);
    const index = incidents.findIndex((incident) => incident.id === id);
    if (index < 0) {
      throw new Error('Bug report not found.');
    }
    const current = incidents[index];
    const status = changes?.status === 'fixed' ? 'fixed' : changes?.status === 'found' ? 'found' : current.status;
    const incident = incidentUtils.normalizeIncident({
      ...current,
      title: changes?.title ?? current.title,
      description: changes?.description ?? current.description,
      severity: changes?.severity ?? current.severity,
      status,
      fixedAt: status === 'fixed' ? current.fixedAt || Date.now() : null,
      lastSeen: Date.now(),
      sync: incidentUtils.isRemoteConfigured(settings) ? { state: 'pending' } : current.sync
    }, settings);
    incidents[index] = incident;
    await storageSet({ [storageKeys.incidents]: incidents });
    return { settings, incident };
  });
  let remoteWarning = '';
  if (incidentUtils.isRemoteConfigured(localResult.settings, true)) {
    try {
      await rpc(localResult.settings, 'gr_update_incident_status', {
        p_project_id: localResult.settings.projectId,
        p_admin_token: localResult.settings.adminToken,
        p_incident_id: id,
        p_status: localResult.incident.status
      });
      await serialise(async () => {
        const stored = await storageGet([storageKeys.settings, storageKeys.incidents]);
        const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
        const incidents = pruneIncidents(stored[storageKeys.incidents], settings).map((incident) => incident.id === id
          ? incidentUtils.normalizeIncident({ ...incident, sync: { state: 'synced', lastAttempt: Date.now(), error: '' } }, settings)
          : incident);
        await storageSet({ [storageKeys.incidents]: incidents });
      });
    } catch (error) {
      remoteWarning = error.message;
    }
  }
  return { bug: localResult.incident, incident: localResult.incident, remoteWarning };
}

async function deleteIncident(id) {
  await initializationPromise;
  const settings = await getSettings();
  if (settings.datastoreMode === 'supabase' && incidentUtils.isRemoteConfigured(settings) && !incidentUtils.isRemoteConfigured(settings, true)) {
    throw new Error('An admin token is required to delete cloud bugs.');
  }
  if (incidentUtils.isRemoteConfigured(settings, true)) {
    await rpc(settings, 'gr_delete_incident', {
      p_project_id: settings.projectId,
      p_admin_token: settings.adminToken,
      p_incident_id: id
    });
  }
  await serialise(async () => {
    const stored = await storageGet([storageKeys.settings, storageKeys.incidents]);
    const currentSettings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
    const incidents = pruneIncidents(stored[storageKeys.incidents], currentSettings).filter((incident) => incident.id !== id);
    await storageSet({ [storageKeys.incidents]: incidents });
  });
  return { deleted: true };
}

async function testDatastore() {
  await initializationPromise;
  const settings = await getSettings();
  if (!incidentUtils.isRemoteConfigured(settings)) {
    throw new Error('Complete the Supabase URL, key, project ID and ingest token first.');
  }
  const token = settings.adminToken || settings.ingestToken;
  const role = settings.adminToken ? 'admin' : 'ingest';
  const result = await rpc(settings, 'gr_ping', {
    p_project_id: settings.projectId,
    p_token: token,
    p_role: role
  });
  return { connected: Boolean(result?.ok ?? result), role };
}

async function queryData() {
  await initializationPromise;
  let syncWarning = '';
  const initial = await storageGet([storageKeys.settings, storageKeys.incidents]);
  const initialSettings = incidentUtils.normalizeSettings(initial[storageKeys.settings]);
  if (initialSettings.autoSync && incidentUtils.isRemoteConfigured(initialSettings)) {
    try {
      await syncPendingIncidents();
    } catch (error) {
      syncWarning = error.message;
    }
  }
  let stored = await storageGet(allStorageKeys);
  const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
  let incidents = pruneIncidents(stored[storageKeys.incidents], settings);
  if (incidentUtils.isRemoteConfigured(settings, true)) {
    try {
      const remote = await fetchRemoteIncidents(settings);
      incidents = mergeRemoteCache(incidents, remote, settings);
      await storageSet({ [storageKeys.incidents]: incidents });
      await updateSyncState({ lastSyncAt: Date.now(), lastError: '', lastRemoteCount: remote.length });
      stored = await storageGet(allStorageKeys);
    } catch (error) {
      syncWarning = syncWarning || error.message;
      await updateSyncState({ lastError: error.message });
    }
  }
  const profiles = Object.values(pruneProfiles(stored[storageKeys.profiles])).sort((left, right) => right.lastSeen - left.lastSeen);
  const bytesUsed = await storageBytes();
  const sync = normalizeSyncState(stored[storageKeys.sync]);
  const pendingCount = incidents.filter((incident) => incident.sync.state !== 'synced' && incident.sync.state !== 'local').length;
  return {
    settings,
    incidents: incidents.slice().reverse(),
    bugs: incidents.slice().reverse(),
    profiles,
    storage: {
      bytesUsed,
      incidentCount: incidents.length,
      pendingCount
    },
    sync: { ...sync, warning: syncWarning }
  };
}

// exported files include report evidence but leave datastore credentials out
async function exportReport(singleIncidentId = '') {
  const data = await queryData();
  const incidents = singleIncidentId ? data.incidents.filter((incident) => incident.id === singleIncidentId) : data.incidents;
  return {
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    generator: {
      name: chrome.runtime.getManifest().name,
      version: chrome.runtime.getManifest().version,
      projectName: data.settings.projectName
    },
    security: {
      sanitized: true,
      credentialsExcluded: true
    },
    data: {
      incidents,
      profiles: data.profiles
    }
  };
}

async function importReport(report) {
  await initializationPromise;
  const validation = incidentUtils.validateReport(report);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }
  return serialise(async () => {
    const stored = await storageGet(allStorageKeys);
    const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
    const existing = pruneIncidents(stored[storageKeys.incidents], settings);
    const byId = new Map(existing.map((incident) => [incident.id, incident]));
    let importedIncidents = 0;
    for (const raw of report.data.incidents.slice(0, 2000)) {
      const incident = incidentUtils.normalizeIncident({ ...raw, sync: { state: 'local' } }, settings);
      if (!byId.has(incident.id)) {
        byId.set(incident.id, incident);
        importedIncidents += 1;
      }
    }
    const profiles = pruneProfiles(stored[storageKeys.profiles]);
    let importedProfiles = 0;
    for (const raw of report.data.profiles.slice(0, 200)) {
      const profile = incidentUtils.normalizeProfile(raw);
      if (profile.profileId && !profiles[profile.profileId]) {
        profiles[profile.profileId] = profile;
        importedProfiles += 1;
      }
    }
    await storageSet({
      [storageKeys.incidents]: pruneIncidents(Array.from(byId.values()), settings),
      [storageKeys.profiles]: pruneProfiles(profiles)
    });
    return { importedIncidents, importedBugs: importedIncidents, importedProfiles };
  });
}

// keep the current browser profile when the full local cache is reset
async function clearData(scope) {
  await initializationPromise;
  return serialise(async () => {
    const stored = await storageGet([storageKeys.settings, storageKeys.profiles]);
    const settings = incidentUtils.normalizeSettings(stored[storageKeys.settings]);
    if (scope === 'all') {
      const profiles = pruneProfiles(stored[storageKeys.profiles]);
      const current = profiles[settings.profileId];
      await storageSet({
        [storageKeys.incidents]: [],
        [storageKeys.profiles]: current ? { [settings.profileId]: current } : {},
        [storageKeys.sync]: normalizeSyncState()
      });
      return { cleared: 'all' };
    }
    await storageSet({ [storageKeys.incidents]: [] });
    return { cleared: 'incidents' };
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

function activeTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] || null));
  });
}

async function openReporter() {
  const tab = await activeTab();
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
    return { opened: false, reason: 'Open a connected website first.' };
  }
  const response = await sendTabMessage(tab.id, { type: 'OPEN_REPORTER' });
  return response || { opened: false, reason: 'Reload the website, then try again.' };
}

async function connectActiveHost() {
  const tab = await activeTab();
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    throw new Error('Open the website you want to monitor first.');
  }
  const host = new URL(tab.url).hostname;
  const current = await getSettings();
  const settings = await saveSettings({ allowedHosts: [...current.allowedHosts, host] });
  return { host, settings };
}

async function handleMessage(message) {
  switch (message?.type) {
    case 'GET_SETTINGS':
      return { settings: await getSettings() };
    case 'SAVE_SETTINGS':
      return { settings: await saveSettings(message.settings) };
    case 'REGISTER_PROFILE':
      return registerProfile(message.profile);
    case 'CAPTURE_INCIDENTS': {
      const result = await captureIncidents(message.incidents);
      const settings = await getSettings();
      if (settings.autoSync && incidentUtils.isRemoteConfigured(settings)) {
        syncPendingIncidents().catch(() => undefined);
      }
      return result;
    }
    case 'CREATE_BUG': {
      const result = await createManualIncident(message.bug);
      const settings = await getSettings();
      if (settings.autoSync && incidentUtils.isRemoteConfigured(settings)) {
        syncPendingIncidents().catch(() => undefined);
      }
      return result;
    }
    case 'UPDATE_BUG':
      return updateIncident(message.id, message.changes);
    case 'DELETE_BUG':
      return deleteIncident(message.id);
    case 'QUERY_DATA':
      return queryData();
    case 'EXPORT_REPORT':
      return { report: await exportReport(message.bugId || message.incidentId || '') };
    case 'IMPORT_REPORT':
      return importReport(message.report);
    case 'CLEAR_DATA':
      return clearData(message.scope);
    case 'OPEN_REPORTER_ACTIVE':
      return openReporter();
    case 'CONNECT_ACTIVE_HOST':
      return connectActiveHost();
    case 'TEST_DATASTORE':
      return testDatastore();
    case 'SYNC_NOW':
      return syncPendingIncidents();
    default:
      throw new Error('Unknown Glitch Reaper request.');
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.runtime.onInstalled?.addListener(() => {
  initializationPromise.catch(() => undefined);
});

chrome.runtime.onStartup?.addListener(() => {
  initializationPromise.catch(() => undefined);
});

chrome.commands?.onCommand?.addListener((command) => {
  if (command === 'report-bug') {
    openReporter().catch(() => undefined);
  }
});
