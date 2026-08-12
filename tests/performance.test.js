'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const incidentUtils = require('../shared/incident-utils.js');

const projectRoot = path.resolve(__dirname, '..');
const pageMonitorSource = fs.readFileSync(path.join(projectRoot, 'detectors/page-monitor.js'), 'utf8');

test('detector batching stays inside the 100 ms queue target', () => {
  const delay = Number(pageMonitorSource.match(/flushDelayMilliseconds = (\d+)/)?.[1]);
  const queueLimit = Number(pageMonitorSource.match(/maxQueuedIncidents = (\d+)/)?.[1]);
  assert.equal(delay, 60);
  assert.equal(queueLimit, 100);
  assert.ok(delay < 100);
});

test('incident normalization remains lightweight under burst load', () => {
  const settings = incidentUtils.normalizeSettings({ includeQueryParameters: true });
  const started = performance.now();
  for (let index = 0; index < 1000; index += 1) {
    incidentUtils.normalizeIncident({
      kind: 'javascript_error',
      title: `ReferenceError ${index}`,
      severity: 'high',
      page: { url: `https://example.com/app?view=${index}&token=secret` },
      evidence: { message: `ReferenceError ${index}`, line: index },
      stack: `ReferenceError\n at https://example.com/app.js:${index}:1`
    }, settings);
  }
  const elapsedMilliseconds = performance.now() - started;
  assert.ok(elapsedMilliseconds < 500, `normalization took ${elapsedMilliseconds.toFixed(2)} ms`);
});
