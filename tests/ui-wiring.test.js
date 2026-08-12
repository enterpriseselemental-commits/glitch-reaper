'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const dashboardHtml = fs.readFileSync(path.join(projectRoot, 'dashboard/dashboard.html'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(projectRoot, 'dashboard/settings.html'), 'utf8');
const dashboardScript = fs.readFileSync(path.join(projectRoot, 'dashboard/dashboard.js'), 'utf8');
const reporterHtml = fs.readFileSync(path.join(projectRoot, 'manual-report/manual-report.html'), 'utf8');
const reporterScript = fs.readFileSync(path.join(projectRoot, 'manual-report/manual-report.js'), 'utf8');

function idsIn(html) {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
}

test('dashboard settings and controls exist in both surfaces', () => {
  const dashboardIds = idsIn(dashboardHtml);
  const settingsIds = idsIn(settingsHtml);
  const requiredIds = [
    'detectionEnabled', 'blurSensitiveData', 'maxIncidents', 'projectName', 'profileName', 'profileRole',
    'allowedHosts', 'connectButton', 'excludedHosts', 'retentionDays', 'longTaskMs', 'detectConsoleErrors',
    'detectNetworkErrors', 'detectResourceErrors', 'detectPerformanceFreezes', 'detectMemoryLeaks',
    'memorySampleSeconds', 'memoryWindowSeconds', 'memoryGrowthMb', 'capturePageTitle',
    'includeQueryParameters', 'datastoreMode', 'supabaseUrl', 'supabaseKey', 'projectId', 'ingestToken',
    'adminToken', 'autoSync', 'testDatastoreButton', 'syncButton', 'saveButton', 'tutorialButton',
    'exportButton', 'importButton', 'clearLocalButton', 'clearAllButton', 'openFullSettingsButton'
  ];
  for (const id of requiredIds) {
    assert.equal(dashboardIds.has(id), true, `dashboard is missing ${id}`);
    assert.equal(settingsIds.has(id), true, `settings page is missing ${id}`);
  }
});

test('all explicit dashboard buttons are wired', () => {
  const buttonIds = [
    'closeButton', 'openFullSettingsButton', 'filterButton', 'connectButton', 'testDatastoreButton',
    'syncButton', 'fixButton', 'exportBugButton', 'deleteBugButton', 'tutorialButton', 'exportButton',
    'importButton', 'clearLocalButton', 'clearAllButton', 'confirmCancel', 'confirmAccept',
    'tutorialBack', 'tutorialNext'
  ];
  for (const id of buttonIds) {
    assert.match(dashboardScript, new RegExp(`ui\\.${id}\\.addEventListener`), `${id} is not wired`);
  }
  assert.match(dashboardScript, /ui\.settingsForm\.addEventListener\('submit'/);
});

test('manual reporter controls are wired', () => {
  const reporterIds = idsIn(reporterHtml);
  for (const id of ['reportForm', 'titleInput', 'descriptionInput', 'closeButton', 'cancelButton']) {
    assert.equal(reporterIds.has(id), true, `manual reporter is missing ${id}`);
  }
  assert.match(reporterScript, /form\.addEventListener\('submit'/);
  assert.match(reporterScript, /closeButton\.addEventListener\('click'/);
  assert.match(reporterScript, /cancelButton\.addEventListener\('click'/);
});

test('onboarding keeps website setup with bug detection', () => {
  for (const html of [dashboardHtml, settingsHtml]) {
    const firstStep = html.match(/<div class="tutorial-step active" data-step="0">([\s\S]*?)<\/div>/)?.[1] || '';
    const detectionStep = html.match(/<div class="tutorial-step" data-step="2">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.doesNotMatch(firstStep, /id="tourWebsite"/);
    assert.match(detectionStep, /id="tourWebsite"/);
    assert.match(detectionStep, /id="tourDetectionEnabled"/);
    assert.match(detectionStep, /BUG DETECTION/);
  }
  assert.match(dashboardScript, /function validateTutorialStep\(step = dashboardState\.tutorialStep\)/);
});
