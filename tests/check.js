'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const scriptFiles = [];

function collectScripts(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'tests') collectScripts(fullPath);
    } else if (entry.name.endsWith('.js')) {
      scriptFiles.push(fullPath);
    }
  }
}

function assertLowercaseComments(source, filePath) {
  for (const match of source.matchAll(/^\s*\/\/\s*(.+)$/gm)) {
    assert.equal(/[A-Z]/.test(match[1]), false, `${filePath} contains a comment with uppercase letters`);
  }
}

collectScripts(projectRoot);

for (const filePath of scriptFiles) {
  childProcess.execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
  assertLowercaseComments(fs.readFileSync(filePath, 'utf8'), filePath);
}

for (const manifestName of ['manifest.json', 'manifest.firefox.json']) {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, manifestName), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Glitch Reaper');
  assert.equal(manifest.version, '2.1.7');
  const referencedFiles = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
    ...(manifest.web_accessible_resources || []).flatMap((entry) => entry.resources || [])
  ].filter(Boolean);
  for (const file of referencedFiles) {
    assert.equal(fs.existsSync(path.join(projectRoot, file)), true, `${manifestName} references missing file ${file}`);
  }
}


const firefoxManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.firefox.json'), 'utf8'));
const firefoxGecko = firefoxManifest.browser_specific_settings?.gecko;
assert.match(firefoxGecko?.id || '', /^\{[0-9a-f-]{36}\}$/i);
assert.equal(firefoxGecko?.strict_min_version, '140.0');
assert.deepEqual(firefoxGecko?.data_collection_permissions?.required, ['none']);
assert.deepEqual(firefoxGecko?.data_collection_permissions?.optional, [
  'personallyIdentifyingInfo',
  'browsingActivity',
  'websiteContent',
  'technicalAndInteraction'
]);
assert.equal(fs.existsSync(path.join(projectRoot, 'supabase/schema.sql')), true, 'supabase/schema.sql is missing');

const dashboardHtml = fs.readFileSync(path.join(projectRoot, 'dashboard/dashboard.html'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(projectRoot, 'dashboard/settings.html'), 'utf8');
for (const html of [dashboardHtml, settingsHtml]) {
  const firstStep = html.match(/<div class="tutorial-step active" data-step="0">([\s\S]*?)<\/div>/)?.[1] || '';
  const detectionStep = html.match(/<div class="tutorial-step" data-step="2">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.doesNotMatch(firstStep, /tourWebsite/);
  assert.match(detectionStep, /id="tourWebsite"/);
  assert.match(detectionStep, /id="tourDetectionEnabled"/);
  assert.match(html, /Supabase Cloud syncs reports to a shared project database\./);
}

for (const fileName of ['README.md', 'ARCHITECTURE.md', 'PRIVACY.md']) {
  const filePath = path.join(projectRoot, fileName);
  assert.equal(fs.existsSync(filePath), true, `${fileName} is missing`);
  assert.ok(fs.readFileSync(filePath, 'utf8').trim().length > 100, `${fileName} is unexpectedly empty`);
}

const pageMonitorSource = fs.readFileSync(path.join(projectRoot, 'detectors/page-monitor.js'), 'utf8');
const serviceWorkerSource = fs.readFileSync(path.join(projectRoot, 'service-worker.js'), 'utf8');
assert.doesNotMatch(serviceWorkerSource, /\bready\.catch/, 'startup handlers must use the initialization promise');
assert.equal(/addEventListener\(\s*['"](?:click|input|change|submit|keydown)['"]/.test(pageMonitorSource), false, 'page monitor must not record normal user actions');

const pageRuntimeSource = fs.readFileSync(path.join(projectRoot, 'detectors/page-runtime.js'), 'utf8');
assert.match(pageRuntimeSource, /options\.once \|\| options\.signal/, 'listener tracking must ignore auto-removed listeners');
assert.match(pageRuntimeSource, /performanceEnabled/, 'spa route handling must include performance monitoring');
assert.match(pageMonitorSource, /event\.source === reporterFrame\?\.contentWindow/, 'reporter close messages must come from the reporter frame');
const dashboardSource = fs.readFileSync(path.join(projectRoot, 'dashboard/dashboard.js'), 'utf8');
assert.match(dashboardSource, /ensureCloudDataConsent/, 'dashboard must request firefox cloud-data consent');
assert.match(serviceWorkerSource, /canTransmitCloudData/, 'worker must gate remote calls on firefox cloud-data consent');

console.log(`Validated ${scriptFiles.length} extension scripts and both manifests.`);
