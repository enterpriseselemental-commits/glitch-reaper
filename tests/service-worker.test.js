'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function createHarness() {
  const storage = {};
  const listeners = { message: [], installed: [], startup: [], command: [] };
  const remoteIncidents = new Map();
  let ingestFailureStatus = 0;
  let dataCollectionGranted = true;
  const runtime = {
    lastError: null,
    getManifest: () => ({ name: 'Glitch Reaper', version: '2.1.7' }),
    getURL: (value) => `chrome-extension://test/${value}`,
    getPlatformInfo: (callback) => queueMicrotask(() => callback({ os: 'win', arch: 'x86-64' })),
    onMessage: { addListener: (listener) => listeners.message.push(listener) },
    onInstalled: { addListener: (listener) => listeners.installed.push(listener) },
    onStartup: { addListener: (listener) => listeners.startup.push(listener) }
  };
  const local = {
    get(keys, callback) {
      const result = {};
      const selected = keys == null ? Object.keys(storage) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      for (const key of selected) if (Object.hasOwn(storage, key)) result[key] = structuredClone(storage[key]);
      queueMicrotask(() => callback(result));
    },
    set(values, callback) {
      for (const [key, value] of Object.entries(values)) storage[key] = structuredClone(value);
      queueMicrotask(() => callback?.());
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      queueMicrotask(() => callback?.());
    },
    getBytesInUse(_keys, callback) {
      queueMicrotask(() => callback(Buffer.byteLength(JSON.stringify(storage))));
    },
    setAccessLevel(_options, callback) {
      queueMicrotask(() => callback?.());
    }
  };
  const chrome = {
    runtime,
    storage: { local },
    tabs: {
      query: (_query, callback) => queueMicrotask(() => callback([{ id: 9, url: 'https://example.com/app' }])),
      sendMessage: (_id, _message, callback) => queueMicrotask(() => callback({ opened: true })),
      create: (_options, callback) => queueMicrotask(() => callback?.({ id: 10 }))
    },
    commands: { onCommand: { addListener: (listener) => listeners.command.push(listener) } },
    permissions: {
      getAll(callback) {
        const dataCollection = dataCollectionGranted
          ? ['personallyIdentifyingInfo', 'browsingActivity', 'websiteContent', 'technicalAndInteraction']
          : [];
        queueMicrotask(() => callback({ permissions: ['storage', 'activeTab'], origins: [], data_collection: dataCollection }));
      }
    }
  };
  async function fetchMock(url, options) {
    const name = String(url).split('/').pop();
    const body = JSON.parse(options.body || '{}');
    if (name === 'gr_ping') return response({ ok: true, role: body.p_role });
    if (name === 'gr_ingest_incidents') {
      if (ingestFailureStatus) return response({ message: 'Temporary datastore failure' }, ingestFailureStatus);
      for (const incident of body.p_incidents || []) remoteIncidents.set(incident.id, structuredClone(incident));
      return response({ ok: true, ingested: (body.p_incidents || []).length });
    }
    if (name === 'gr_list_incidents') return response(Array.from(remoteIncidents.values()));
    if (name === 'gr_update_incident_status') {
      const incident = remoteIncidents.get(body.p_incident_id);
      if (incident) incident.status = body.p_status;
      return response({ ok: true });
    }
    if (name === 'gr_delete_incident') {
      remoteIncidents.delete(body.p_incident_id);
      return response({ ok: true });
    }
    return response({ message: 'Unknown RPC' }, 404);
  }
  function response(payload, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload)
    };
  }
  const context = vm.createContext({
    chrome,
    console,
    crypto: webcrypto,
    URL,
    URLSearchParams,
    Date,
    Math,
    Promise,
    Object,
    Array,
    Set,
    Map,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Error,
    TypeError,
    structuredClone,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: fetchMock
  });
  const root = path.resolve(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(root, 'shared/incident-utils.js'), 'utf8'), context, { filename: 'shared/incident-utils.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8'), context, { filename: 'service-worker.js' });

  function send(message) {
    return new Promise((resolve, reject) => {
      const listener = listeners.message[0];
      const keepAlive = listener(message, {}, (result) => {
        if (!result?.ok) {
          reject(new Error(result?.error || 'Request failed'));
          return;
        }
        resolve(result.result);
      });
      assert.equal(keepAlive, true);
    });
  }

  return {
    storage,
    remoteIncidents,
    send,
    context,
    setIngestFailure(status = 0) {
      ingestFailureStatus = status;
    },
    setDataCollectionGranted(granted) {
      dataCollectionGranted = Boolean(granted);
    }
  };
}

test('runs the local and cloud incident workflow', async () => {
  const harness = createHarness();
  const initial = await harness.send({ type: 'GET_SETTINGS' });
  assert.equal(initial.settings.detectionEnabled, false);
  assert.ok(initial.settings.profileId.startsWith('profile_'));

  const saved = await harness.send({
    type: 'SAVE_SETTINGS',
    settings: {
      profileName: 'Kai',
      profileRole: 'Developer',
      onboardingComplete: true,
      detectionEnabled: true,
      allowedHosts: ['example.com'],
      projectName: 'ETDX Site',
      datastoreMode: 'supabase',
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'publishable-key',
      projectId: 'project-id',
      ingestToken: 'ingest-token',
      adminToken: 'admin-token',
      autoSync: false
    }
  });
  assert.equal(saved.settings.profileName, 'Kai');
  assert.equal(saved.settings.datastoreMode, 'supabase');

  const registration = await harness.send({
    type: 'REGISTER_PROFILE',
    profile: {
      browser: { name: 'Chrome', version: '150' },
      operatingSystem: 'Windows',
      language: 'en-AU',
      timezone: 'Australia/Melbourne',
      screen: { width: 1920, height: 1080, colorDepth: 24, devicePixelRatio: 1 }
    }
  });
  assert.equal(registration.profile.profileName, 'Kai');

  const now = Date.now();
  const capture = await harness.send({
    type: 'CAPTURE_INCIDENTS',
    incidents: [
      {
        id: 'incident_error_1',
        kind: 'javascript_error',
        title: 'ReferenceError: total is not defined',
        description: 'An uncaught JavaScript error occurred.',
        severity: 'high',
        detectedAt: now,
        firstSeen: now,
        lastSeen: now,
        page: { url: 'https://example.com/app?token=secret' },
        evidence: { message: 'ReferenceError: total is not defined', line: 10 },
        stack: 'ReferenceError\n at https://example.com/app.js:10:3'
      },
      {
        id: 'incident_error_2',
        kind: 'javascript_error',
        title: 'ReferenceError: total is not defined',
        description: 'An uncaught JavaScript error occurred.',
        severity: 'high',
        detectedAt: now + 1,
        firstSeen: now + 1,
        lastSeen: now + 1,
        page: { url: 'https://example.com/app' },
        evidence: { message: 'ReferenceError: total is not defined', line: 10 },
        stack: 'ReferenceError\n at https://example.com/app.js:10:3'
      },
      {
        id: 'incident_blocked',
        kind: 'console_error',
        title: 'Blocked',
        page: { url: 'https://blocked.test/' }
      }
    ]
  });
  assert.equal(capture.stored, 1);
  assert.equal(capture.merged, 1);

  let data = await harness.send({ type: 'QUERY_DATA' });
  assert.equal(data.bugs.length, 1);
  assert.equal(data.bugs[0].occurrences, 2);
  assert.equal(data.bugs[0].page.url, 'https://example.com/app');
  assert.equal(Object.hasOwn(data.bugs[0], 'recentEvents'), false);

  const sync = await harness.send({ type: 'SYNC_NOW' });
  assert.equal(sync.synced, 1);
  assert.equal(harness.remoteIncidents.size, 1);

  const fixed = await harness.send({ type: 'UPDATE_BUG', id: data.bugs[0].id, changes: { status: 'fixed' } });
  assert.equal(fixed.bug.status, 'fixed');
  assert.equal(harness.remoteIncidents.get(data.bugs[0].id).status, 'fixed');

  const reopened = await harness.send({ type: 'UPDATE_BUG', id: data.bugs[0].id, changes: { status: 'found' } });
  assert.equal(reopened.bug.status, 'found');
  assert.equal(harness.remoteIncidents.get(data.bugs[0].id).status, 'found');

  const manual = await harness.send({
    type: 'CREATE_BUG',
    bug: {
      title: 'Layout overlaps on mobile',
      description: 'The settings panel overlaps the close button.',
      severity: 'medium',
      page: { url: 'https://example.com/app' }
    }
  });
  assert.equal(manual.bug.source, 'manual');
  await harness.send({ type: 'SYNC_NOW' });
  assert.equal(harness.remoteIncidents.has(manual.bug.id), true);
  await harness.send({ type: 'DELETE_BUG', id: manual.bug.id });
  assert.equal(harness.remoteIncidents.has(manual.bug.id), false);

  const exported = await harness.send({ type: 'EXPORT_REPORT' });
  assert.equal(exported.report.schemaVersion, 3);
  assert.equal(exported.report.security.sanitized, true);
  assert.equal(exported.report.security.credentialsExcluded, true);
  assert.equal(exported.report.data.incidents.length, 1);
  assert.equal(JSON.stringify(exported.report).includes('admin-token'), false);

  const imported = await harness.send({ type: 'IMPORT_REPORT', report: exported.report });
  assert.equal(imported.importedIncidents, 0);

  await harness.send({ type: 'CLEAR_DATA', scope: 'all' });
  data = await harness.send({ type: 'QUERY_DATA' });
  assert.equal(data.bugs.length, 1);
  assert.equal(data.bugs[0].id, 'incident_error_1');
});


test('blocks cloud requests when firefox data permission is unavailable', async () => {
  const harness = createHarness();
  await harness.send({
    type: 'SAVE_SETTINGS',
    settings: {
      profileName: 'Developer',
      onboardingComplete: true,
      datastoreMode: 'supabase',
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'publishable-key',
      projectId: 'project-id',
      ingestToken: 'ingest-token',
      autoSync: false
    }
  });
  harness.setDataCollectionGranted(false);
  await assert.rejects(
    harness.send({ type: 'TEST_DATASTORE' }),
    /Cloud sync permission is not granted/
  );
});

test('keeps cloud reports queued when the datastore is unavailable', async () => {
  const harness = createHarness();
  await harness.send({
    type: 'SAVE_SETTINGS',
    settings: {
      onboardingComplete: true,
      detectionEnabled: true,
      allowedHosts: ['example.com'],
      datastoreMode: 'supabase',
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'publishable-key',
      projectId: 'project-id',
      ingestToken: 'ingest-token',
      adminToken: 'admin-token',
      autoSync: false
    }
  });
  const created = await harness.send({
    type: 'CREATE_BUG',
    bug: {
      title: 'Offline report',
      page: { url: 'https://example.com/app' }
    }
  });
  harness.setIngestFailure(503);
  await assert.rejects(
    harness.send({ type: 'SYNC_NOW' }),
    /Temporary datastore failure/
  );
  let data = await harness.send({ type: 'QUERY_DATA' });
  assert.equal(data.bugs.find((bug) => bug.id === created.bug.id).sync.state, 'failed');

  harness.setIngestFailure(0);
  const retry = await harness.send({ type: 'SYNC_NOW' });
  assert.equal(retry.synced, 1);
  data = await harness.send({ type: 'QUERY_DATA' });
  assert.equal(data.bugs.find((bug) => bug.id === created.bug.id).sync.state, 'synced');
});


test('prunes expired incidents and keeps the newest records inside the limit', () => {
  const harness = createHarness();
  const now = Date.now();
  const settings = harness.context.GlitchReaperCore.normalizeSettings({
    retentionDays: 7,
    maxIncidents: 25
  });
  const records = Array.from({ length: 30 }, (_, index) => harness.context.GlitchReaperCore.normalizeIncident({
    id: `incident_${index}`,
    title: `Incident ${index}`,
    firstSeen: now - index * 1000,
    lastSeen: now - index * 1000
  }, settings));
  records.push(harness.context.GlitchReaperCore.normalizeIncident({
    id: 'incident_expired',
    title: 'Expired',
    firstSeen: now - 10 * 86400000,
    lastSeen: now - 10 * 86400000
  }, settings));
  const pruned = harness.context.pruneIncidents(records, settings);
  assert.equal(pruned.length, 25);
  assert.equal(pruned.some((incident) => incident.id === 'incident_expired'), false);
  assert.equal(pruned[0].id, 'incident_24');
  assert.equal(pruned.at(-1).id, 'incident_0');
});


test('keeps newer unsynced local changes when cloud data is stale', () => {
  const harness = createHarness();
  const settings = harness.context.GlitchReaperCore.normalizeSettings({ maxIncidents: 25 });
  const now = Date.now();
  const local = harness.context.GlitchReaperCore.normalizeIncident({
    id: 'incident_status',
    title: 'Status test',
    status: 'fixed',
    lastSeen: now,
    fixedAt: now,
    sync: { state: 'failed' }
  }, settings);
  const remote = harness.context.GlitchReaperCore.normalizeIncident({
    id: 'incident_status',
    title: 'Status test',
    status: 'found',
    lastSeen: now - 1000,
    sync: { state: 'synced' }
  }, settings);
  const merged = harness.context.mergeRemoteCache([local], [remote], settings);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'fixed');
  assert.equal(merged[0].sync.state, 'failed');
});
