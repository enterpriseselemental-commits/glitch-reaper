(function initialiseGlitchReaperCore(root) {
  'use strict';

  // keep validation and sanitizing rules consistent across every extension context
  const dayMilliseconds = 86400000;
  const defaultSettings = Object.freeze({
    profileId: '',
    profileName: 'Tester',
    profileRole: 'Tester',
    projectName: 'Glitch Reaper Project',
    blurSensitiveData: false,
    detectionEnabled: false,
    onboardingComplete: false,
    allowedHosts: [],
    excludedHosts: [],
    retentionDays: 14,
    maxIncidents: 250,
    capturePageTitle: false,
    includeQueryParameters: false,
    detectConsoleErrors: true,
    detectNetworkErrors: true,
    detectResourceErrors: true,
    detectPerformanceFreezes: true,
    detectMemoryLeaks: true,
    longTaskMs: 750,
    memorySampleSeconds: 15,
    memoryWindowSeconds: 90,
    memoryGrowthMb: 32,
    datastoreMode: 'local',
    supabaseUrl: '',
    supabaseKey: '',
    projectId: '',
    ingestToken: '',
    adminToken: '',
    autoSync: true
  });
  const severityValues = Object.freeze(['high', 'medium', 'low']);
  const statusValues = Object.freeze(['found', 'fixed']);
  const datastoreModes = Object.freeze(['local', 'supabase']);
  const sensitiveQueryKeyPattern = /(token|auth|password|passwd|secret|session|cookie|key|code|email|phone|mobile|address|name|user|account|card|cvv|pin)/i;
  const sensitiveTextPatterns = Object.freeze([
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]'],
    [/\b(?:\+?61|0)[2-478](?:[ -]?\d){8}\b/g, '[phone redacted]'],
    [/\b(?:\d[ -]*?){13,19}\b/g, '[number redacted]'],
    [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[credential redacted]'],
    [/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|pin)\s*[:=]\s*[^\s,;]+/gi, '[credential redacted]']
  ]);

  // normalize external values before they reach storage or the ui
  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
  }

  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function validTimestamp(value, fallback = Date.now()) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function truncate(value, maximumLength) {
    const text = String(value ?? '');
    return text.length <= maximumLength ? text : `${text.slice(0, Math.max(0, maximumLength - 1))}…`;
  }

  // remove common contact details and credentials from free text
  function scrubText(value, maximumLength = 500) {
    let text = truncate(value, maximumLength);
    for (const [pattern, replacement] of sensitiveTextPatterns) {
      text = text.replace(pattern, replacement);
    }
    return text;
  }

  // host rules accept plain domains, full urls, and wildcard subdomains
  function normalizeHostRule(value) {
    let rule = String(value ?? '').trim().toLowerCase();
    if (!rule) {
      return '';
    }
    try {
      if (rule.includes('://')) {
        rule = new URL(rule).hostname.toLowerCase();
      } else {
        rule = rule.split('/')[0].split(':')[0];
      }
    } catch (_error) {
      return '';
    }
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2).replace(/^\.+|\.+$/g, '');
      return suffix ? `*.${suffix}` : '';
    }
    return rule.replace(/^\.+|\.+$/g, '');
  }

  function normalizeHostRules(value) {
    const entries = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
    return Array.from(new Set(entries.map(normalizeHostRule).filter(Boolean))).slice(0, 200);
  }

  function hostMatchesRule(hostname, rule) {
    const host = String(hostname ?? '').toLowerCase();
    const normalized = normalizeHostRule(rule);
    if (!host || !normalized) {
      return false;
    }
    if (normalized.startsWith('*.')) {
      const suffix = normalized.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === normalized;
  }

  function matchesAnyHost(hostname, rules) {
    return normalizeHostRules(rules).some((rule) => hostMatchesRule(hostname, rule));
  }

  function normalizeSupabaseUrl(value) {
    const raw = String(value ?? '').trim().replace(/\/+$/, '');
    if (!raw) {
      return '';
    }
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' ? truncate(url.origin, 300) : '';
    } catch (_error) {
      return '';
    }
  }

  function normalizeSettings(input) {
    const source = Object.assign({}, defaultSettings, input || {});
    const detectionEnabled = source.detectionEnabled ?? source.recordingEnabled;
    const maxIncidents = source.maxIncidents ?? source.maxBugs ?? source.maxErrors ?? defaultSettings.maxIncidents;
    return {
      profileId: truncate(source.profileId, 120),
      profileName: scrubText(source.profileName || defaultSettings.profileName, 80),
      profileRole: ['Developer', 'Tester'].includes(source.profileRole) ? source.profileRole : defaultSettings.profileRole,
      projectName: scrubText(source.projectName || defaultSettings.projectName, 100).trim() || defaultSettings.projectName,
      blurSensitiveData: Boolean(source.blurSensitiveData),
      detectionEnabled: Boolean(detectionEnabled),
      onboardingComplete: Boolean(source.onboardingComplete),
      allowedHosts: normalizeHostRules(source.allowedHosts),
      excludedHosts: normalizeHostRules(source.excludedHosts),
      retentionDays: clampInteger(source.retentionDays, 1, 90, defaultSettings.retentionDays),
      maxIncidents: clampInteger(maxIncidents, 25, 1000, defaultSettings.maxIncidents),
      capturePageTitle: Boolean(source.capturePageTitle),
      includeQueryParameters: Boolean(source.includeQueryParameters),
      detectConsoleErrors: source.detectConsoleErrors !== false,
      detectNetworkErrors: source.detectNetworkErrors !== false,
      detectResourceErrors: source.detectResourceErrors !== false,
      detectPerformanceFreezes: source.detectPerformanceFreezes !== false,
      detectMemoryLeaks: source.detectMemoryLeaks !== false,
      longTaskMs: clampInteger(source.longTaskMs, 200, 5000, defaultSettings.longTaskMs),
      memorySampleSeconds: clampInteger(source.memorySampleSeconds, 10, 60, defaultSettings.memorySampleSeconds),
      memoryWindowSeconds: clampInteger(source.memoryWindowSeconds, 60, 600, defaultSettings.memoryWindowSeconds),
      memoryGrowthMb: clampInteger(source.memoryGrowthMb, 16, 512, defaultSettings.memoryGrowthMb),
      datastoreMode: datastoreModes.includes(source.datastoreMode) ? source.datastoreMode : defaultSettings.datastoreMode,
      supabaseUrl: normalizeSupabaseUrl(source.supabaseUrl),
      supabaseKey: truncate(String(source.supabaseKey ?? '').trim(), 1000),
      projectId: truncate(String(source.projectId ?? '').trim(), 120),
      ingestToken: truncate(String(source.ingestToken ?? '').trim(), 500),
      adminToken: truncate(String(source.adminToken ?? '').trim(), 500),
      autoSync: source.autoSync !== false
    };
  }

  function isUrlAllowed(rawUrl, settings) {
    try {
      const url = new URL(String(rawUrl));
      const normalized = normalizeSettings(settings);
      if (!['http:', 'https:'].includes(url.protocol) || !normalized.detectionEnabled || normalized.allowedHosts.length === 0) {
        return false;
      }
      return matchesAnyHost(url.hostname, normalized.allowedHosts)
        && !matchesAnyHost(url.hostname, normalized.excludedHosts);
    } catch (_error) {
      return false;
    }
  }

  // remove credentials and fragments before a url is stored in a report
  function sanitizeUrl(rawUrl, includeQueryParameters = false) {
    try {
      const parsed = new URL(String(rawUrl));
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return `${parsed.protocol}//`;
      }
      parsed.username = '';
      parsed.password = '';
      parsed.hash = '';
      if (!includeQueryParameters) {
        parsed.search = '';
      } else {
        const parameters = new URLSearchParams();
        for (const [key, value] of parsed.searchParams.entries()) {
          const safeKey = truncate(key, 80);
          parameters.append(safeKey, sensitiveQueryKeyPattern.test(key) ? '[redacted]' : scrubText(value, 120));
        }
        parsed.search = parameters.toString() ? `?${parameters.toString()}` : '';
      }
      return truncate(parsed.toString(), 1000);
    } catch (_error) {
      return scrubText(rawUrl, 500);
    }
  }

  function sanitizeStack(stack, includeQueryParameters = false) {
    const source = truncate(stack, 8000);
    return scrubText(source.replace(/https?:\/\/[^\s)\]}>'"]+/gi, (url) => sanitizeUrl(url, includeQueryParameters)), 8000);
  }

  // cap nested evidence so a bad payload cannot fill extension storage
  function sanitizeValue(value, depth = 0) {
    if (value == null || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      return scrubText(value, 3000);
    }
    if (depth >= 4) {
      return '[truncated]';
    }
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((entry) => sanitizeValue(entry, depth + 1));
    }
    if (typeof value === 'object') {
      const output = {};
      for (const [key, nested] of Object.entries(value).slice(0, 60)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
          continue;
        }
        output[truncate(key, 80)] = sanitizeValue(nested, depth + 1);
      }
      return output;
    }
    return scrubText(String(value), 300);
  }

  function normalizePage(input, includeQueryParameters = false) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      url: sanitizeUrl(source.url || '', includeQueryParameters),
      title: scrubText(source.title || '', 200),
      referrer: sanitizeUrl(source.referrer || '', includeQueryParameters),
      viewport: {
        width: Math.max(0, Math.round(finiteNumber(source.viewport?.width))),
        height: Math.max(0, Math.round(finiteNumber(source.viewport?.height)))
      },
      visibilityState: truncate(source.visibilityState || '', 20),
      readyState: truncate(source.readyState || '', 20)
    };
  }

  function normalizeProfile(input, fallbackId = '') {
    const source = input && typeof input === 'object' ? input : {};
    return {
      profileId: truncate(source.profileId || fallbackId, 120),
      profileName: scrubText(source.profileName || 'Tester', 80),
      profileRole: ['Developer', 'Tester'].includes(source.profileRole) ? source.profileRole : 'Tester',
      browser: {
        name: scrubText(source.browser?.name || '', 80),
        version: scrubText(source.browser?.version || '', 80)
      },
      operatingSystem: scrubText(source.operatingSystem || '', 100),
      architecture: scrubText(source.architecture || '', 60),
      language: scrubText(source.language || '', 40),
      timezone: scrubText(source.timezone || '', 100),
      screen: {
        width: Math.max(0, Math.round(finiteNumber(source.screen?.width))),
        height: Math.max(0, Math.round(finiteNumber(source.screen?.height))),
        colorDepth: Math.max(0, Math.round(finiteNumber(source.screen?.colorDepth))),
        devicePixelRatio: Math.max(0, finiteNumber(source.screen?.devicePixelRatio, 1))
      },
      extensionVersion: scrubText(source.extensionVersion || '', 40),
      firstSeen: validTimestamp(source.firstSeen),
      lastSeen: validTimestamp(source.lastSeen)
    };
  }

  function hashString(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  // use stable failure details to group repeat reports from the same source
  function fingerprintIncident(input) {
    const source = input && typeof input === 'object' ? input : {};
    const pageUrl = sanitizeUrl(source.page?.url || '', false);
    const hostPath = (() => {
      try {
        const url = new URL(pageUrl);
        return `${url.hostname}${url.pathname}`;
      } catch (_error) {
        return pageUrl;
      }
    })();
    const stackHead = String(source.stack || source.evidence?.stack || '').split('\n').slice(0, 4).join('\n');
    const signal = [source.kind, source.title, source.evidence?.message, source.evidence?.status, source.evidence?.source, source.evidence?.line, hostPath, stackHead].join('|');
    return `fp_${hashString(signal.toLowerCase())}`;
  }

  function normalizeSync(input) {
    const source = input && typeof input === 'object' ? input : {};
    const state = ['pending', 'synced', 'failed', 'local'].includes(source.state) ? source.state : 'pending';
    return {
      state,
      lastAttempt: source.lastAttempt ? validTimestamp(source.lastAttempt, 0) : 0,
      error: scrubText(source.error || '', 500)
    };
  }

  // store every report in the same shape before merging or exporting it
  function normalizeIncident(input, settings = defaultSettings) {
    const source = input && typeof input === 'object' ? input : {};
    const normalizedSettings = normalizeSettings(settings);
    const now = Date.now();
    const detectedAt = validTimestamp(source.detectedAt || source.createdAt, now);
    const firstSeen = validTimestamp(source.firstSeen || source.createdAt, detectedAt);
    const lastSeen = validTimestamp(source.lastSeen || source.updatedAt, detectedAt);
    const status = statusValues.includes(source.status) ? source.status : 'found';
    const incident = {
      id: truncate(source.id || makeId('incident'), 120),
      fingerprint: truncate(source.fingerprint || '', 120),
      kind: truncate(source.kind || source.type || 'manual_bug', 100),
      title: scrubText(source.title || 'Detected bug', 180),
      description: scrubText(source.description || '', 3000),
      severity: severityValues.includes(source.severity) ? source.severity : 'medium',
      status,
      source: source.source === 'manual' ? 'manual' : 'automatic',
      detectedAt,
      firstSeen,
      lastSeen,
      fixedAt: status === 'fixed' && source.fixedAt ? validTimestamp(source.fixedAt) : null,
      occurrences: clampInteger(source.occurrences, 1, 1000000, 1),
      profileId: truncate(source.profileId || '', 120),
      sessionId: truncate(source.sessionId || '', 120),
      page: normalizePage(source.page, normalizedSettings.includeQueryParameters),
      stack: sanitizeStack(source.stack || source.evidence?.stack || '', normalizedSettings.includeQueryParameters),
      evidence: sanitizeValue(source.evidence || source.data || {}),
      sync: normalizeSync(source.sync)
    };
    if (!incident.fingerprint) {
      incident.fingerprint = fingerprintIncident(incident);
    }
    return incident;
  }

  function normalizeManualIncident(input, settings = defaultSettings) {
    const source = input && typeof input === 'object' ? input : {};
    return normalizeIncident({
      id: source.id,
      kind: 'manual_bug',
      title: source.title,
      description: source.description,
      severity: source.severity,
      status: source.status,
      source: 'manual',
      page: source.page,
      profileId: source.profileId,
      sessionId: source.sessionId,
      evidence: source.evidence || {},
      sync: source.sync
    }, settings);
  }

  function mergeIncident(existing, incoming, settings = defaultSettings) {
    const left = normalizeIncident(existing, settings);
    const right = normalizeIncident(incoming, settings);
    return normalizeIncident({
      ...left,
      title: right.title || left.title,
      description: right.description || left.description,
      severity: right.severity === 'high' || left.severity === 'high' ? 'high' : right.severity,
      status: left.status,
      lastSeen: Math.max(left.lastSeen, right.lastSeen),
      occurrences: Math.max(left.occurrences, 1) + Math.max(right.occurrences, 1),
      page: right.page,
      stack: right.stack || left.stack,
      evidence: right.evidence,
      sync: { state: 'pending', lastAttempt: 0, error: '' }
    }, settings);
  }

  // keep browser detection small because it runs inside the tested page
  function detectBrowser(userAgent, userAgentData) {
    const ua = String(userAgent || '');
    const brands = Array.isArray(userAgentData?.brands) ? userAgentData.brands : [];
    const brandText = brands.map((item) => `${item.brand}/${item.version}`).join(' ');
    const source = `${brandText} ${ua}`;
    const candidates = [
      ['Microsoft Edge', /(?:Microsoft Edge|Edg)\/?([\d.]+)/i],
      ['Opera', /(?:Opera|OPR)\/?([\d.]+)/i],
      ['Firefox', /Firefox\/?([\d.]+)/i],
      ['Chrome', /(?:Google Chrome|Chrome|Chromium)\/?([\d.]+)/i],
      ['Safari', /Version\/?([\d.]+).*Safari/i]
    ];
    let name = 'Unknown';
    let version = '';
    for (const [candidate, pattern] of candidates) {
      const match = source.match(pattern);
      if (match) {
        name = candidate;
        version = match[1] || '';
        break;
      }
    }
    let operatingSystem = 'Unknown';
    if (/Windows/i.test(ua)) operatingSystem = 'Windows';
    else if (/Android/i.test(ua)) operatingSystem = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) operatingSystem = 'iOS';
    else if (/Mac OS X|Macintosh/i.test(ua)) operatingSystem = 'macOS';
    else if (/Linux/i.test(ua)) operatingSystem = 'Linux';
    return { name, version, operatingSystem };
  }

  function validateReport(report) {
    if (!report || typeof report !== 'object') {
      return { valid: false, reason: 'Report must be a JSON object.' };
    }
    if (report.schemaVersion !== 3) {
      return { valid: false, reason: 'Unsupported report version.' };
    }
    if (!Array.isArray(report.data?.incidents) || !Array.isArray(report.data?.profiles)) {
      return { valid: false, reason: 'Report data is incomplete.' };
    }
    return { valid: true, reason: '' };
  }

  function isRemoteConfigured(settings, requireAdmin = false) {
    const normalized = normalizeSettings(settings);
    if (normalized.datastoreMode !== 'supabase') {
      return false;
    }
    const base = Boolean(normalized.supabaseUrl && normalized.supabaseKey && normalized.projectId && normalized.ingestToken);
    return requireAdmin ? base && Boolean(normalized.adminToken) : base;
  }

  function makeId(prefix = 'id') {
    const random = root.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    return `${prefix}_${random}`;
  }

  const api = Object.freeze({
    dayMilliseconds,
    defaultSettings,
    severityValues,
    clampInteger,
    finiteNumber,
    validTimestamp,
    truncate,
    scrubText,
    normalizeHostRule,
    normalizeHostRules,
    hostMatchesRule,
    matchesAnyHost,
    normalizeSettings,
    isUrlAllowed,
    sanitizeUrl,
    sanitizeStack,
    sanitizeValue,
    normalizePage,
    normalizeProfile,
    fingerprintIncident,
    normalizeIncident,
    normalizeManualIncident,
    mergeIncident,
    detectBrowser,
    validateReport,
    isRemoteConfigured,
    makeId
  });

  root.GlitchReaperCore = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
