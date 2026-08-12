'use strict';

const elementIds = [
  'closeButton', 'openFullSettingsButton', 'searchBar', 'searchInput', 'filterButton', 'filterMenu', 'bugsPanel', 'bugList', 'settingsPanel', 'settingsForm',
  'detectionEnabled', 'blurSensitiveData', 'maxIncidents', 'projectName', 'profileName', 'profileRole', 'allowedHosts',
  'connectButton', 'excludedHosts', 'retentionDays', 'longTaskMs', 'detectConsoleErrors', 'detectNetworkErrors',
  'detectResourceErrors', 'detectPerformanceFreezes', 'detectMemoryLeaks', 'memorySampleSeconds', 'memoryWindowSeconds',
  'memoryGrowthMb', 'capturePageTitle', 'includeQueryParameters', 'datastoreMode', 'supabaseFields', 'supabaseUrl',
  'supabaseKey', 'projectId', 'ingestToken', 'adminToken', 'autoSync', 'testDatastoreButton', 'syncButton', 'syncStatus',
  'storageText', 'storageFill', 'saveButton', 'tutorialButton', 'exportButton', 'importButton', 'clearLocalButton',
  'clearAllButton', 'detailPanel', 'detailTitle', 'detailType', 'detailTimer', 'detailDescription', 'detailMeta', 'fixButton',
  'exportBugButton', 'deleteBugButton', 'toast', 'importInput', 'tutorialOverlay', 'tourProjectName',
  'tourProfileName', 'tourWebsite', 'tourDatastoreMode', 'tourDetectionEnabled', 'tutorialDots', 'tutorialBack',
  'tutorialNext', 'tutorialStatus', 'confirmOverlay', 'confirmTitle', 'confirmText', 'confirmCancel', 'confirmAccept'
];
const ui = Object.fromEntries(elementIds.map((id) => [id, document.getElementById(id)]));
const dashboardState = {
  data: null,
  view: document.body.dataset.surface === 'options' ? 'settings' : 'bugs',
  filter: 'all',
  search: '',
  selectedBugId: '',
  tutorialStep: 0,
  confirmAction: null
};

function requestBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'Glitch Reaper request failed.'));
        return;
      }
      resolve(response.result);
    });
  });
}

const cloudDataPermissions = Object.freeze([
  'personallyIdentifyingInfo',
  'browsingActivity',
  'websiteContent',
  'technicalAndInteraction'
]);

function hasCompleteCloudConfig(settings) {
  return settings.datastoreMode === 'supabase'
    && Boolean(settings.supabaseUrl && settings.supabaseKey && settings.projectId && settings.ingestToken);
}

function callPermissionsApi(method, argument) {
  const browserPermissions = globalThis.browser?.permissions;
  if (browserPermissions?.[method]) {
    return argument === undefined ? browserPermissions[method]() : browserPermissions[method](argument);
  }
  const chromePermissions = globalThis.chrome?.permissions;
  if (!chromePermissions?.[method]) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const callback = (result) => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve(result);
    };
    if (argument === undefined) chromePermissions[method](callback);
    else chromePermissions[method](argument, callback);
  });
}

// firefox requires explicit consent before optional cloud data leaves the browser
async function ensureCloudDataConsent(settings) {
  if (!hasCompleteCloudConfig(settings)) return;
  const granted = await callPermissionsApi('getAll');
  if (!granted || !Object.prototype.hasOwnProperty.call(granted, 'data_collection')) return;
  const approved = new Set(granted.data_collection || []);
  const missing = cloudDataPermissions.filter((permission) => !approved.has(permission));
  if (missing.length === 0) return;
  const allowed = await callPermissionsApi('request', { data_collection: missing });
  if (!allowed) throw new Error('Cloud sync permission was not granted.');
}

function createElement(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 3500);
}

function captureSettingsViewport() {
  const activeElement = document.activeElement instanceof HTMLElement && ui.settingsForm.contains(document.activeElement)
    ? document.activeElement
    : null;
  return {
    scrollTop: ui.settingsForm.scrollTop,
    activeId: activeElement?.id || ''
  };
}

function restoreSettingsViewport(viewport) {
  if (!viewport) return;
  requestAnimationFrame(() => {
    const maxScroll = Math.max(0, ui.settingsForm.scrollHeight - ui.settingsForm.clientHeight);
    const scrollTop = Math.min(viewport.scrollTop, maxScroll);
    ui.settingsForm.scrollTop = scrollTop;
    const activeElement = viewport.activeId ? document.getElementById(viewport.activeId) : null;
    if (activeElement && ui.settingsForm.contains(activeElement)) activeElement.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      ui.settingsForm.scrollTop = scrollTop;
    });
  });
}

async function keepSettingsViewport(task, viewport = captureSettingsViewport()) {
  try {
    return await task();
  } finally {
    restoreSettingsViewport(viewport);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(2)} MB`;
}

function formatDuration(start, end = Date.now()) {
  const seconds = Math.max(0, Math.floor((Number(end || Date.now()) - Number(start || Date.now())) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [hours, minutes, remaining].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatDate(timestamp) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(timestamp));
  } catch (_error) {
    return '';
  }
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return '';
  }
}

function safeFileName(value) {
  return String(value || 'glitch-reaper').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'glitch-reaper';
}

function downloadReport(report, name) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFileName(name)}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getSelectedBug() {
  return dashboardState.data?.bugs?.find((bug) => bug.id === dashboardState.selectedBugId) || null;
}

function bugMatchesFilter(bug) {
  if (dashboardState.filter === 'found' && bug.status !== 'found') return false;
  if (dashboardState.filter === 'fixed' && bug.status !== 'fixed') return false;
  if (dashboardState.filter === 'automatic' && bug.source !== 'automatic') return false;
  if (dashboardState.filter === 'high' && bug.severity !== 'high') return false;
  const query = dashboardState.search.trim().toLowerCase();
  if (!query) return true;
  return [bug.title, bug.description, bug.kind, bug.severity, bug.status, getHostname(bug.page?.url)]
    .some((value) => String(value || '').toLowerCase().includes(query));
}

function getVisibleBugs() {
  return (dashboardState.data?.bugs || []).filter(bugMatchesFilter).sort((left, right) => {
    if (left.status !== right.status) return left.status === 'found' ? -1 : 1;
    const priority = { high: 3, medium: 2, low: 1 };
    if (priority[left.severity] !== priority[right.severity]) return priority[right.severity] - priority[left.severity];
    return right.lastSeen - left.lastSeen;
  });
}

function selectBug(id) {
  dashboardState.selectedBugId = id;
  renderBugs();
  renderDetail();
}

function renderBugRow(bug) {
  const row = createElement('article', `bug-row ${bug.status === 'fixed' ? 'fixed' : ''} ${bug.id === dashboardState.selectedBugId ? 'selected' : ''}`);
  const copy = createElement('div', 'bug-row-copy');
  const title = createElement('h2', 'bug-row-title sensitive-copy', bug.title);
  const meta = createElement('p', 'bug-row-meta');
  const severity = createElement('span', `severity-${bug.severity}`, bug.severity);
  meta.append(severity, createElement('span', '', bug.source), createElement('span', '', `×${bug.occurrences}`), createElement('span', '', bug.status));
  copy.append(title, meta);
  const button = createElement('button', 'row-select', 'SELECT');
  button.type = 'button';
  button.addEventListener('click', () => selectBug(bug.id));
  row.append(copy, button);
  return row;
}

function renderEmptyBugs() {
  const empty = createElement('div', 'empty-state');
  empty.append(
    createElement('strong', '', 'NO BUGS DETECTED'),
    createElement('p', '', 'Connect a website, enable Bug Detection and reload the page. Glitch Reaper only stores evidence when a detector finds a problem.'),
    createElement('p', '', 'Press Ctrl+Shift+G on the website to submit a visual or logic bug manually.')
  );
  return empty;
}

function renderBugs() {
  ui.bugList.replaceChildren();
  const bugs = getVisibleBugs();
  if (bugs.length === 0) {
    ui.bugList.append(renderEmptyBugs());
    return;
  }
  for (const bug of bugs) ui.bugList.append(renderBugRow(bug));
}

function renderDetail() {
  const bug = getSelectedBug();
  ui.detailPanel.classList.toggle('sensitive-blur', Boolean(dashboardState.data?.settings?.blurSensitiveData));
  if (!bug) {
    ui.detailTitle.textContent = 'Bug Name';
    ui.detailType.textContent = 'Type';
    ui.detailTimer.textContent = '00:00:00';
    ui.detailDescription.textContent = 'Select a bug from the list to view its report.';
    ui.detailMeta.textContent = '';
    ui.fixButton.textContent = 'SELECT';
    for (const button of [ui.fixButton, ui.exportBugButton, ui.deleteBugButton]) button.disabled = true;
    return;
  }
  ui.detailTitle.textContent = bug.title;
  ui.detailType.textContent = `${bug.severity.toUpperCase()} • ${bug.kind.replaceAll('_', ' ')}`;
  ui.detailTimer.textContent = formatDuration(bug.firstSeen, bug.status === 'fixed' ? bug.fixedAt || bug.lastSeen : Date.now());
  ui.detailDescription.textContent = bug.description || 'No description was supplied.';
  const host = getHostname(bug.page?.url) || 'unknown page';
  ui.detailMeta.textContent = `${host} • ${bug.occurrences} occurrence${bug.occurrences === 1 ? '' : 's'} • ${bug.sync?.state || 'local'} • ${formatDate(bug.lastSeen)}`;
  ui.fixButton.textContent = bug.status === 'fixed' ? 'REOPEN' : 'FIX BUG';
  const cloudReadOnly = dashboardState.data.settings.datastoreMode === 'supabase' && !dashboardState.data.settings.adminToken;
  ui.fixButton.disabled = cloudReadOnly;
  ui.deleteBugButton.disabled = cloudReadOnly;
  ui.exportBugButton.disabled = false;
  if (cloudReadOnly) ui.detailMeta.textContent += ' • read only';
}

function renderStorage() {
  if (!dashboardState.data) return;
  const bytes = dashboardState.data.storage.bytesUsed;
  const limit = 10 * 1024 * 1024;
  const percent = Math.min(100, Math.max(0, bytes / limit * 100));
  ui.storageText.textContent = `${dashboardState.data.storage.incidentCount} bugs • ${dashboardState.data.storage.pendingCount} pending sync • ${formatBytes(bytes)} local cache`;
  ui.storageFill.style.width = `${percent}%`;
  const sync = dashboardState.data.sync || {};
  if (dashboardState.data.settings.datastoreMode === 'local') {
    ui.syncStatus.textContent = 'Local Browser mode. Reports stay on this device until exported.';
  } else if (sync.warning || sync.lastError) {
    ui.syncStatus.textContent = `Sync error: ${sync.warning || sync.lastError}`;
  } else if (sync.lastSyncAt) {
    ui.syncStatus.textContent = `Last synced ${formatDate(sync.lastSyncAt)}. ${dashboardState.data.storage.pendingCount} pending.`;
  } else {
    ui.syncStatus.textContent = 'Cloud datastore configured but not synced yet.';
  }
}

function writeSettings(settings) {
  ui.detectionEnabled.checked = settings.detectionEnabled;
  ui.blurSensitiveData.checked = settings.blurSensitiveData;
  ui.maxIncidents.value = settings.maxIncidents;
  ui.projectName.value = settings.projectName;
  ui.profileName.value = settings.profileName;
  ui.profileRole.value = settings.profileRole;
  ui.allowedHosts.value = settings.allowedHosts.join('\n');
  ui.excludedHosts.value = settings.excludedHosts.join('\n');
  ui.retentionDays.value = settings.retentionDays;
  ui.longTaskMs.value = settings.longTaskMs;
  ui.detectConsoleErrors.checked = settings.detectConsoleErrors;
  ui.detectNetworkErrors.checked = settings.detectNetworkErrors;
  ui.detectResourceErrors.checked = settings.detectResourceErrors;
  ui.detectPerformanceFreezes.checked = settings.detectPerformanceFreezes;
  ui.detectMemoryLeaks.checked = settings.detectMemoryLeaks;
  ui.memorySampleSeconds.value = settings.memorySampleSeconds;
  ui.memoryWindowSeconds.value = settings.memoryWindowSeconds;
  ui.memoryGrowthMb.value = settings.memoryGrowthMb;
  ui.capturePageTitle.value = String(settings.capturePageTitle);
  ui.includeQueryParameters.checked = settings.includeQueryParameters;
  ui.datastoreMode.value = settings.datastoreMode;
  ui.supabaseUrl.value = settings.supabaseUrl;
  ui.supabaseKey.value = settings.supabaseKey;
  ui.projectId.value = settings.projectId;
  ui.ingestToken.value = settings.ingestToken;
  ui.adminToken.value = settings.adminToken;
  ui.autoSync.checked = settings.autoSync;
  renderDatastoreFields();
}

function readHostLines(value) {
  return String(value || '').split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

function readSettings() {
  return {
    detectionEnabled: ui.detectionEnabled.checked,
    blurSensitiveData: ui.blurSensitiveData.checked,
    maxIncidents: Number(ui.maxIncidents.value),
    projectName: ui.projectName.value.trim(),
    profileName: ui.profileName.value.trim(),
    profileRole: ui.profileRole.value,
    allowedHosts: readHostLines(ui.allowedHosts.value),
    excludedHosts: readHostLines(ui.excludedHosts.value),
    retentionDays: Number(ui.retentionDays.value),
    longTaskMs: Number(ui.longTaskMs.value),
    detectConsoleErrors: ui.detectConsoleErrors.checked,
    detectNetworkErrors: ui.detectNetworkErrors.checked,
    detectResourceErrors: ui.detectResourceErrors.checked,
    detectPerformanceFreezes: ui.detectPerformanceFreezes.checked,
    detectMemoryLeaks: ui.detectMemoryLeaks.checked,
    memorySampleSeconds: Number(ui.memorySampleSeconds.value),
    memoryWindowSeconds: Number(ui.memoryWindowSeconds.value),
    memoryGrowthMb: Number(ui.memoryGrowthMb.value),
    capturePageTitle: ui.capturePageTitle.value === 'true',
    includeQueryParameters: ui.includeQueryParameters.checked,
    datastoreMode: ui.datastoreMode.value,
    supabaseUrl: ui.supabaseUrl.value.trim(),
    supabaseKey: ui.supabaseKey.value.trim(),
    projectId: ui.projectId.value.trim(),
    ingestToken: ui.ingestToken.value.trim(),
    adminToken: ui.adminToken.value.trim(),
    autoSync: ui.autoSync.checked
  };
}

function validateSettings(settings) {
  if (!settings.projectName) throw new Error('Enter a project name.');
  if (!settings.profileName) throw new Error('Enter a browser profile name.');
  if (settings.detectionEnabled && settings.allowedHosts.length === 0) throw new Error('Connect at least one website before enabling detection.');
}

async function saveSettings(extra = {}, message = 'Settings saved.', options = {}) {
  const settings = { ...readSettings(), ...extra };
  validateSettings(settings);
  await ensureCloudDataConsent(settings);
  const result = await requestBackground({ type: 'SAVE_SETTINGS', settings });
  dashboardState.data.settings = result.settings;
  if (options.rewriteForm !== false) writeSettings(result.settings);
  renderDetail();
  showToast(message);
  return result.settings;
}

function filterSettings() {
  const query = dashboardState.search.trim().toLowerCase();
  for (const item of ui.settingsForm.querySelectorAll('[data-search-label]')) {
    item.hidden = Boolean(query) && !item.dataset.searchLabel.toLowerCase().includes(query) && !item.textContent.toLowerCase().includes(query);
  }
}

function renderDatastoreFields() {
  ui.supabaseFields.hidden = ui.datastoreMode.value !== 'supabase';
}

function renderView() {
  const bugsView = dashboardState.view === 'bugs';
  document.querySelector('.workspace').classList.toggle('settings-view', !bugsView);
  ui.bugsPanel.hidden = !bugsView;
  ui.settingsPanel.hidden = bugsView;
  ui.filterButton.hidden = !bugsView;
  ui.searchBar.classList.toggle('settings-search', !bugsView);
  ui.searchInput.placeholder = bugsView ? '[ Search Bugs ]' : '[ Search Settings ]';
  for (const button of document.querySelectorAll('[data-view]')) {
    const selected = button.dataset.view === dashboardState.view;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  if (bugsView) renderBugs(); else filterSettings();
}

async function refresh() {
  const data = await requestBackground({ type: 'QUERY_DATA' });
  dashboardState.data = data;
  if (dashboardState.selectedBugId && !data.bugs.some((bug) => bug.id === dashboardState.selectedBugId)) dashboardState.selectedBugId = '';
  writeSettings(data.settings);
  renderStorage();
  renderView();
  renderDetail();
  if (!data.settings.onboardingComplete) openTutorial();
}

async function openReporter() {
  const result = await requestBackground({ type: 'OPEN_REPORTER_ACTIVE' });
  showToast(result.opened ? 'Bug reporter opened on the website.' : result.reason);
}

async function toggleSelectedBug() {
  const bug = getSelectedBug();
  if (!bug) {
    await openReporter();
    return;
  }
  const result = await requestBackground({ type: 'UPDATE_BUG', id: bug.id, changes: { status: bug.status === 'fixed' ? 'found' : 'fixed' } });
  await refresh();
  showToast(result.remoteWarning ? `Saved locally. Cloud warning: ${result.remoteWarning}` : bug.status === 'fixed' ? 'Bug reopened.' : 'Bug marked fixed.');
}

async function exportAll() {
  const result = await requestBackground({ type: 'EXPORT_REPORT' });
  downloadReport(result.report, dashboardState.data.settings.projectName);
  showToast('Report exported.');
}

async function exportSelectedBug() {
  const bug = getSelectedBug();
  if (!bug) return;
  const result = await requestBackground({ type: 'EXPORT_REPORT', bugId: bug.id });
  downloadReport(result.report, `${dashboardState.data.settings.projectName}-${bug.title}`);
  showToast('Bug exported.');
}

function requestConfirmation(text, action) {
  dashboardState.confirmAction = action;
  ui.confirmText.textContent = text;
  ui.confirmOverlay.hidden = false;
}

function closeConfirmation() {
  dashboardState.confirmAction = null;
  ui.confirmOverlay.hidden = true;
}

function requestDeleteSelectedBug() {
  const bug = getSelectedBug();
  if (!bug) return;
  requestConfirmation(`Delete “${bug.title}”? This also deletes the cloud copy when an admin token is configured.`, async () => {
    await requestBackground({ type: 'DELETE_BUG', id: bug.id });
    dashboardState.selectedBugId = '';
    await refresh();
    showToast('Bug deleted.');
  });
}

function populateTutorial() {
  const settings = dashboardState.data?.settings;
  ui.tourProjectName.value = settings?.projectName || 'Glitch Reaper Project';
  ui.tourProfileName.value = settings?.profileName || 'Tester';
  ui.tourWebsite.value = settings?.allowedHosts?.[0] || '';
  ui.tourDatastoreMode.value = settings?.datastoreMode || 'local';
  ui.tourDetectionEnabled.checked = settings?.detectionEnabled ?? true;
}

function renderTutorial() {
  for (const step of document.querySelectorAll('[data-step]')) step.classList.toggle('active', Number(step.dataset.step) === dashboardState.tutorialStep);
  ui.tutorialBack.disabled = dashboardState.tutorialStep === 0;
  ui.tutorialNext.textContent = dashboardState.tutorialStep === 2 ? 'FINISH' : 'NEXT';
  ui.tutorialDots.replaceChildren();
  for (let index = 0; index < 3; index += 1) ui.tutorialDots.append(createElement('span', index === dashboardState.tutorialStep ? 'active' : ''));
  ui.tutorialStatus.textContent = '';
}

function openTutorial() {
  populateTutorial();
  dashboardState.tutorialStep = 0;
  renderTutorial();
  ui.tutorialOverlay.hidden = false;
}

function closeTutorial() {
  ui.tutorialOverlay.hidden = true;
}

function validateTutorialStep(step = dashboardState.tutorialStep) {
  if (step === 0) {
    if (!ui.tourProjectName.value.trim()) throw new Error('Enter a project name.');
    if (!ui.tourProfileName.value.trim()) throw new Error('Enter a profile name.');
  }
  if (step === 2 && ui.tourDetectionEnabled.checked) {
    const website = ui.tourWebsite.value.trim();
    const existingHosts = dashboardState.data?.settings?.allowedHosts || [];
    if (!website && existingHosts.length === 0) throw new Error('Enter a website domain before enabling detection.');
  }
}

async function finishTutorial() {
  const projectName = ui.tourProjectName.value.trim();
  const profileName = ui.tourProfileName.value.trim();
  const website = ui.tourWebsite.value.trim();
  validateTutorialStep(0);
  validateTutorialStep(2);
  const hosts = website ? Array.from(new Set([...dashboardState.data.settings.allowedHosts, website])) : dashboardState.data.settings.allowedHosts;
  const result = await requestBackground({
    type: 'SAVE_SETTINGS',
    settings: {
      projectName,
      profileName,
      allowedHosts: hosts,
      datastoreMode: ui.tourDatastoreMode.value,
      detectionEnabled: ui.tourDetectionEnabled.checked,
      onboardingComplete: true
    }
  });
  dashboardState.data.settings = result.settings;
  writeSettings(result.settings);
  closeTutorial();
  showToast(result.settings.datastoreMode === 'supabase' ? 'Add the Supabase credentials in Settings.' : 'Glitch Reaper is ready.');
}

function setView(view) {
  dashboardState.view = view;
  dashboardState.search = '';
  ui.searchInput.value = '';
  ui.filterMenu.hidden = true;
  renderView();
}

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
for (const button of ui.filterMenu.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    dashboardState.filter = button.dataset.filter;
    for (const option of ui.filterMenu.querySelectorAll('[data-filter]')) option.classList.toggle('active', option === button);
    ui.filterMenu.hidden = true;
    renderBugs();
  });
}

ui.searchInput.addEventListener('input', () => {
  dashboardState.search = ui.searchInput.value;
  if (dashboardState.view === 'bugs') renderBugs(); else filterSettings();
});
ui.filterButton.addEventListener('click', () => {
  if (dashboardState.view === 'bugs') ui.filterMenu.hidden = !ui.filterMenu.hidden;
});
ui.datastoreMode.addEventListener('change', () => {
  const viewport = captureSettingsViewport();
  renderDatastoreFields();
  restoreSettingsViewport(viewport);
});

ui.openFullSettingsButton.addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

ui.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await keepSettingsViewport(async () => {
      await saveSettings();
      await refresh();
    });
  } catch (error) {
    showToast(error.message);
  }
});
const switchViewports = new WeakMap();
const settingsSwitches = [...ui.settingsForm.querySelectorAll('.switch-input')];
for (const field of settingsSwitches) {
  const rememberViewport = () => {
    switchViewports.set(field, { ...captureSettingsViewport(), activeId: field.id });
  };
  field.addEventListener('pointerdown', rememberViewport);
  field.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') rememberViewport();
  });
}

for (const field of settingsSwitches) {
  field.addEventListener('change', async () => {
    const viewport = switchViewports.get(field) || { ...captureSettingsViewport(), activeId: field.id };
    switchViewports.delete(field);
    if (field !== ui.detectionEnabled && field !== ui.blurSensitiveData) {
      restoreSettingsViewport(viewport);
      return;
    }
    const previous = !field.checked;
    try {
      await keepSettingsViewport(
        () => saveSettings({}, field === ui.detectionEnabled ? 'Bug detection updated.' : 'Privacy display updated.', { rewriteForm: false }),
        viewport
      );
    } catch (error) {
      field.checked = previous;
      restoreSettingsViewport(viewport);
      showToast(error.message);
    }
  });
}
ui.connectButton.addEventListener('click', async () => {
  try {
    const result = await requestBackground({ type: 'CONNECT_ACTIVE_HOST' });
    dashboardState.data.settings = result.settings;
    writeSettings(result.settings);
    showToast(`Connected ${result.host}. Reload that website after enabling detection.`);
  } catch (error) {
    showToast(error.message);
  }
});
ui.testDatastoreButton.addEventListener('click', async () => {
  try {
    await saveSettings({}, 'Datastore settings saved.');
    const result = await requestBackground({ type: 'TEST_DATASTORE' });
    showToast(`Datastore connected with ${result.role} access.`);
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});
ui.syncButton.addEventListener('click', async () => {
  try {
    await saveSettings({}, 'Datastore settings saved.');
    const result = await requestBackground({ type: 'SYNC_NOW' });
    showToast(`${result.synced} bug${result.synced === 1 ? '' : 's'} synced.`);
    await refresh();
  } catch (error) {
    showToast(error.message);
  }
});
ui.fixButton.addEventListener('click', () => toggleSelectedBug().catch((error) => showToast(error.message)));
ui.exportBugButton.addEventListener('click', () => exportSelectedBug().catch((error) => showToast(error.message)));
ui.deleteBugButton.addEventListener('click', requestDeleteSelectedBug);
ui.exportButton.addEventListener('click', () => exportAll().catch((error) => showToast(error.message)));
ui.importButton.addEventListener('click', () => ui.importInput.click());
ui.tutorialButton.addEventListener('click', openTutorial);
ui.importInput.addEventListener('change', async () => {
  const file = ui.importInput.files?.[0];
  if (!file) return;
  try {
    const report = JSON.parse(await file.text());
    const result = await requestBackground({ type: 'IMPORT_REPORT', report });
    await refresh();
    showToast(`Imported ${result.importedIncidents} bugs.`);
  } catch (error) {
    showToast(`Import failed: ${error.message}`);
  } finally {
    ui.importInput.value = '';
  }
});
ui.clearLocalButton.addEventListener('click', () => {
  requestConfirmation('Clear every locally cached bug? Cloud copies are not deleted.', async () => {
    await requestBackground({ type: 'CLEAR_DATA', scope: 'incidents' });
    dashboardState.selectedBugId = '';
    await refresh();
    showToast('Local bug cache cleared.');
  });
});
ui.clearAllButton.addEventListener('click', () => {
  requestConfirmation('Reset the local bug cache, sync status and imported profiles? Cloud copies are not deleted.', async () => {
    await requestBackground({ type: 'CLEAR_DATA', scope: 'all' });
    dashboardState.selectedBugId = '';
    await refresh();
    showToast('Local cache reset.');
  });
});
ui.confirmCancel.addEventListener('click', closeConfirmation);
ui.confirmAccept.addEventListener('click', async () => {
  const action = dashboardState.confirmAction;
  closeConfirmation();
  if (!action) return;
  try {
    await action();
  } catch (error) {
    showToast(error.message);
  }
});
ui.tutorialBack.addEventListener('click', () => {
  if (dashboardState.tutorialStep > 0) {
    dashboardState.tutorialStep -= 1;
    renderTutorial();
  }
});
ui.tutorialNext.addEventListener('click', async () => {
  try {
    validateTutorialStep();
    if (dashboardState.tutorialStep < 2) {
      dashboardState.tutorialStep += 1;
      renderTutorial();
      return;
    }
    await finishTutorial();
  } catch (error) {
    ui.tutorialStatus.textContent = error.message;
  }
});
ui.closeButton.addEventListener('click', () => {
  window.close();
  if (chrome.tabs?.getCurrent && chrome.tabs?.remove) {
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id) chrome.tabs.remove(tab.id);
    });
  }
});
document.addEventListener('click', (event) => {
  if (!ui.filterMenu.hidden && !ui.filterMenu.contains(event.target) && !ui.filterButton.contains(event.target)) ui.filterMenu.hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!ui.confirmOverlay.hidden) closeConfirmation();
  else if (!ui.tutorialOverlay.hidden && dashboardState.data?.settings.onboardingComplete) closeTutorial();
  else if (!ui.filterMenu.hidden) ui.filterMenu.hidden = true;
});

setInterval(renderDetail, 1000);
refresh().then(() => {
  if (new URLSearchParams(location.search).get('tour') === '1') openTutorial();
}).catch((error) => showToast(error.message));
