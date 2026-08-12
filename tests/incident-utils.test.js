'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const incidentUtils = require('../shared/incident-utils.js');

test('normalizes detector settings and host rules', () => {
  const settings = incidentUtils.normalizeSettings({
    profileName: 'Kai',
    detectionEnabled: true,
    allowedHosts: ['https://Example.com/path', '*.Preview.Example.com', 'example.com'],
    excludedHosts: 'private.example.com',
    retentionDays: 999,
    maxIncidents: 1,
    memorySampleSeconds: 2,
    memoryWindowSeconds: 10,
    memoryGrowthMb: 1
  });
  assert.equal(settings.profileName, 'Kai');
  assert.deepEqual(settings.allowedHosts, ['example.com', '*.preview.example.com']);
  assert.deepEqual(settings.excludedHosts, ['private.example.com']);
  assert.equal(settings.retentionDays, 90);
  assert.equal(settings.maxIncidents, 25);
  assert.equal(settings.memorySampleSeconds, 10);
  assert.equal(settings.memoryWindowSeconds, 60);
  assert.equal(settings.memoryGrowthMb, 16);
});

test('checks the explicit website allowlist', () => {
  const settings = incidentUtils.normalizeSettings({
    detectionEnabled: true,
    allowedHosts: ['*.example.com'],
    excludedHosts: ['private.example.com']
  });
  assert.equal(incidentUtils.isUrlAllowed('https://example.com/a', settings), true);
  assert.equal(incidentUtils.isUrlAllowed('https://app.example.com/a', settings), true);
  assert.equal(incidentUtils.isUrlAllowed('https://private.example.com/a', settings), false);
  assert.equal(incidentUtils.isUrlAllowed('https://other.test/a', settings), false);
});

test('sanitizes URLs, stacks and sensitive text', () => {
  const raw = 'https://user:pass@example.com/path?view=table&token=secret&email=kai@example.com#private';
  assert.equal(incidentUtils.sanitizeUrl(raw, false), 'https://example.com/path');
  const safe = incidentUtils.sanitizeUrl(raw, true);
  assert.match(safe, /view=table/);
  assert.match(safe, /token=%5Bredacted%5D/);
  assert.doesNotMatch(safe, /secret|kai%40example/i);
  const stack = incidentUtils.sanitizeStack(`Error\n at https://example.com/app?token=secret`);
  assert.doesNotMatch(stack, /secret/);
  assert.doesNotMatch(incidentUtils.scrubText('password=hunter2'), /hunter2/);
});

test('normalizes automatic incidents and produces stable fingerprints', () => {
  const settings = incidentUtils.normalizeSettings({ includeQueryParameters: false });
  const first = incidentUtils.normalizeIncident({
    kind: 'javascript_error',
    title: 'ReferenceError: total is not defined',
    severity: 'high',
    page: { url: 'https://example.com/app?token=x' },
    evidence: { message: 'ReferenceError: total is not defined', line: 10 },
    stack: 'ReferenceError\n at https://example.com/app.js:10:3'
  }, settings);
  const second = incidentUtils.normalizeIncident({
    kind: 'javascript_error',
    title: 'ReferenceError: total is not defined',
    severity: 'high',
    page: { url: 'https://example.com/app?token=y' },
    evidence: { message: 'ReferenceError: total is not defined', line: 10 },
    stack: 'ReferenceError\n at https://example.com/app.js:10:3'
  }, settings);
  assert.equal(first.page.url, 'https://example.com/app');
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.source, 'automatic');
});

test('merges duplicate incidents by fingerprint', () => {
  const settings = incidentUtils.normalizeSettings();
  const first = incidentUtils.normalizeIncident({ kind: 'console_error', title: 'Save failed', occurrences: 2 }, settings);
  const second = incidentUtils.normalizeIncident({ kind: 'console_error', title: 'Save failed', occurrences: 1 }, settings);
  const merged = incidentUtils.mergeIncident(first, second, settings);
  assert.equal(merged.occurrences, 3);
  assert.equal(merged.kind, 'console_error');
  assert.equal(Object.hasOwn(merged, 'steps'), false);
  assert.equal(Object.hasOwn(merged, 'recentEvents'), false);
});

test('keeps the requested storage state on manual reports', () => {
  const local = incidentUtils.normalizeManualIncident({
    title: 'Button overlap',
    description: 'The footer covers the button.',
    page: { url: 'https://example.com/app' },
    sync: { state: 'local' }
  });
  const pending = incidentUtils.normalizeManualIncident({
    title: 'Button overlap',
    page: { url: 'https://example.com/app' },
    sync: { state: 'pending' }
  });
  assert.equal(local.source, 'manual');
  assert.equal(local.sync.state, 'local');
  assert.equal(pending.sync.state, 'pending');
});

test('detects common browser families', () => {
  const edge = incidentUtils.detectBrowser('Mozilla/5.0 Windows NT 10.0 Edg/150.0.0.0');
  const firefox = incidentUtils.detectBrowser('Mozilla/5.0 Linux Firefox/142.0');
  assert.equal(edge.name, 'Microsoft Edge');
  assert.equal(edge.operatingSystem, 'Windows');
  assert.equal(firefox.name, 'Firefox');
});

test('validates schema version three reports', () => {
  const report = { schemaVersion: 3, data: { incidents: [], profiles: [] } };
  assert.deepEqual(incidentUtils.validateReport(report), { valid: true, reason: '' });
  assert.equal(incidentUtils.validateReport({ schemaVersion: 2 }).valid, false);
});

test('requires complete settings for cloud storage', () => {
  const incomplete = incidentUtils.normalizeSettings({ datastoreMode: 'supabase', supabaseUrl: 'https://test.supabase.co' });
  const complete = incidentUtils.normalizeSettings({
    datastoreMode: 'supabase',
    supabaseUrl: 'https://test.supabase.co',
    supabaseKey: 'publishable',
    projectId: 'project-id',
    ingestToken: 'ingest-token',
    adminToken: 'admin-token'
  });
  assert.equal(incidentUtils.isRemoteConfigured(incomplete), false);
  assert.equal(incidentUtils.isRemoteConfigured(complete), true);
  assert.equal(incidentUtils.isRemoteConfigured(complete, true), true);
});
