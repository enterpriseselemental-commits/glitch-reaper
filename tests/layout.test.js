'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const dashboardCss = fs.readFileSync(path.join(projectRoot, 'dashboard/dashboard.css'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(projectRoot, 'dashboard/dashboard.html'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(projectRoot, 'dashboard/settings.html'), 'utf8');
const dashboardScript = fs.readFileSync(path.join(projectRoot, 'dashboard/dashboard.js'), 'utf8');

function rules(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...dashboardCss.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'g'))];
  assert.ok(matches.length, `missing css rule for ${selector}`);
  return matches.map((match) => match[1]);
}

function firstRule(selector) {
  return rules(selector)[0];
}

function lastRule(selector) {
  return rules(selector).at(-1);
}

test('popup uses a bounded grid layout that leaves room for scrolling', () => {
  assert.match(firstRule('html,\nbody'), /width:\s*780px/);
  assert.match(firstRule('html,\nbody'), /height:\s*580px/);
  assert.match(firstRule('.app-shell'), /grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(firstRule('.workspace'), /min-height:\s*0/);
  assert.match(firstRule('.left-column'), /grid-template-rows:\s*38px minmax\(0, 1fr\)/);
});

test('settings panel has an independent visible scroll region', () => {
  const panel = firstRule('.panel-scroll');
  assert.match(panel, /min-height:\s*0/);
  assert.match(panel, /overflow-y:\s*scroll/);
  assert.match(panel, /overscroll-behavior:\s*contain/);
  assert.match(panel, /scrollbar-gutter:\s*stable/);
  const actions = lastRule('.settings-actions');
  assert.match(actions, /position:\s*sticky/);
  assert.match(actions, /bottom:\s*0/);
});

test('search header is square, full width and adapts between views', () => {
  const search = firstRule('.search-bar');
  assert.match(search, /width:\s*100%/);
  assert.match(search, /border-radius:\s*0/);
  assert.match(firstRule('.filter-button'), /border-radius:\s*0/);
  assert.match(dashboardHtml, /id="searchBar"/);
  assert.match(settingsHtml, /id="searchBar"/);
  assert.match(dashboardScript, /ui\.filterButton\.hidden = !bugsView/);
  assert.match(dashboardScript, /ui\.searchBar\.classList\.toggle\('settings-search', !bugsView\)/);
});

test('full settings uses the same scrolling layout instead of a fixed canvas', () => {
  assert.match(firstRule('body[data-surface="options"]'), /overflow:\s*auto/);
  const optionsShell = firstRule('body[data-surface="options"] .app-shell');
  assert.match(optionsShell, /height:\s*100vh/);
  assert.match(optionsShell, /min-height:\s*640px/);
});

test('settings changes preserve the current scroll position', () => {
  assert.match(dashboardScript, /function captureSettingsViewport\(\)/);
  assert.match(dashboardScript, /function restoreSettingsViewport\(viewport\)/);
  assert.match(dashboardScript, /function keepSettingsViewport\(task, viewport = captureSettingsViewport\(\)\)/);
  assert.match(dashboardScript, /const switchViewports = new WeakMap\(\)/);
  assert.match(dashboardScript, /field\.addEventListener\('pointerdown', rememberViewport\)/);
  assert.match(dashboardScript, /await keepSettingsViewport\(/);
  assert.match(dashboardScript, /ui\.datastoreMode\.addEventListener\('change', \(\) =>/);
});

test('selected navigation and close control use clean vector strokes', () => {
  const activeDock = firstRule('.dock-button.active');
  assert.match(activeDock, /border-color:\s*#f5f5f5/);
  assert.match(activeDock, /box-shadow:/);
  assert.match(dashboardHtml, /class="close-icon"/);
  assert.match(settingsHtml, /class="close-icon"/);
  assert.match(dashboardHtml, /<svg viewBox="0 0 24 24"/);
  assert.match(dashboardScript, /button\.setAttribute\('aria-pressed', String\(selected\)\)/);
});
