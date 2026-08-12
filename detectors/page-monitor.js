'use strict';

(() => {
  const incidentUtils = GlitchReaperCore;

  // batch nearby failures to reduce extension messages during error bursts
  const flushDelayMilliseconds = 60;
  const maxQueuedIncidents = 100;
  const signalCooldownMilliseconds = 1000;
  const memoryCooldownMilliseconds = 300000;
  const sessionId = incidentUtils.makeId('session');
  let settings = incidentUtils.normalizeSettings();
  let profileId = '';
  let enabled = false;
  let listenersAttached = false;
  let flushTimer = null;
  let memoryTimer = null;
  let heartbeatTimer = null;
  let performanceObserver = null;
  let reporterFrame = null;
  let latestMainStats = { listenerCount: 0, listenerCountApproximate: true };
  let lastHeartbeat = performance.now();
  let lastMemoryIncident = 0;
  let memorySampleIndex = 0;
  const queue = [];
  const memorySamples = [];
  const recentSignals = new Map();

  // use one message helper so detector failures are handled the same way
  function sendMessage(message) {
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

  function pageDetails() {
    return {
      url: incidentUtils.sanitizeUrl(location.href, settings.includeQueryParameters),
      title: settings.capturePageTitle ? incidentUtils.scrubText(document.title, 200) : '',
      referrer: incidentUtils.sanitizeUrl(document.referrer || '', settings.includeQueryParameters),
      viewport: {
        width: Math.round(window.innerWidth || 0),
        height: Math.round(window.innerHeight || 0)
      },
      readyState: document.readyState,
      visibilityState: document.visibilityState
    };
  }

  function incident(kind, title, description, severity, evidence = {}, stack = '') {
    const detectedAt = Date.now();
    return incidentUtils.normalizeIncident({
      id: incidentUtils.makeId('incident'),
      kind,
      title,
      description,
      severity,
      status: 'found',
      source: 'automatic',
      detectedAt,
      firstSeen: detectedAt,
      lastSeen: detectedAt,
      occurrences: 1,
      profileId,
      sessionId,
      page: pageDetails(),
      evidence,
      stack,
      sync: { state: 'pending' }
    }, settings);
  }

  // ignore rapid repeats here; the worker still merges later occurrences by fingerprint
  function queueIncident(value) {
    if (!enabled) {
      return;
    }
    const now = Date.now();
    const previous = recentSignals.get(value.fingerprint) || 0;
    if (now - previous < signalCooldownMilliseconds) {
      return;
    }
    recentSignals.set(value.fingerprint, now);
    queue.push(value);
    if (queue.length >= maxQueuedIncidents) {
      flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = window.setTimeout(flush, flushDelayMilliseconds);
    }
  }

  // return a failed batch to the front of the queue for a later retry
  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (queue.length === 0) {
      return;
    }
    const batch = queue.splice(0, queue.length);
    sendMessage({ type: 'CAPTURE_INCIDENTS', incidents: batch }).catch(() => {
      const capacity = Math.max(0, maxQueuedIncidents - queue.length);
      queue.unshift(...batch.slice(-capacity));
      if (!flushTimer) {
        flushTimer = window.setTimeout(flush, 1000);
      }
    });
  }

  function resourceUrl(element) {
    const raw = element?.getAttribute?.('src') || element?.getAttribute?.('href') || '';
    try {
      return raw ? new URL(raw, location.href).toString() : '';
    } catch (_error) {
      return raw;
    }
  }

  // convert browser error signals into the common incident format
  function onError(event) {
    if (event.target && event.target !== window) {
      if (!settings.detectResourceErrors) {
        return;
      }
      const element = event.target instanceof Element ? event.target : null;
      const url = incidentUtils.sanitizeUrl(resourceUrl(element), false);
      queueIncident(incident(
        'resource_error',
        'Page resource failed to load',
        `${element?.tagName?.toLowerCase() || 'resource'} failed to load from ${url || 'an unknown URL'}.`,
        'medium',
        {
          resource: url,
          tag: element?.tagName?.toLowerCase() || 'unknown'
        }
      ));
      return;
    }
    const message = incidentUtils.scrubText(event.message || 'Unknown JavaScript error', 1500);
    const source = event.filename ? incidentUtils.sanitizeUrl(event.filename, settings.includeQueryParameters) : '';
    queueIncident(incident(
      'javascript_error',
      message.split('\n')[0] || 'JavaScript error',
      `An uncaught JavaScript error occurred${source ? ` in ${source}` : ''}.`,
      'high',
      {
        message,
        source,
        line: Number(event.lineno || 0),
        column: Number(event.colno || 0)
      },
      event.error?.stack || ''
    ));
  }

  function onRejection(event) {
    const reason = event.reason;
    const message = incidentUtils.scrubText(reason?.message || reason || 'Unhandled promise rejection', 1500);
    queueIncident(incident(
      'unhandled_rejection',
      message.split('\n')[0] || 'Unhandled promise rejection',
      'A Promise rejected without an error handler.',
      'high',
      { message },
      reason?.stack || ''
    ));
  }

  function networkSignal(payload) {
    const url = incidentUtils.sanitizeUrl(payload.url || '', settings.includeQueryParameters);
    const status = Number(payload.status || 0);
    const method = incidentUtils.scrubText(payload.method || 'GET', 20);
    const durationMs = Math.max(0, incidentUtils.finiteNumber(payload.durationMs));
    const failedRequest = {
      method,
      url,
      status,
      statusText: incidentUtils.scrubText(payload.statusText || '', 120),
      durationMs
    };
    if (payload.kind === 'fetch_rejection') {
      return incident(
        payload.kind,
        'Fetch request failed',
        `${method} ${url || 'request'} rejected before receiving a response.`,
        'high',
        { ...failedRequest, message: incidentUtils.scrubText(payload.message || '', 1000) },
        payload.stack || ''
      );
    }
    if (payload.kind === 'xhr_timeout') {
      return incident(payload.kind, 'XHR request timed out', `${method} ${url || 'request'} exceeded its timeout.`, 'high', failedRequest);
    }
    if (payload.kind === 'xhr_network_error') {
      return incident(payload.kind, 'XHR network request failed', `${method} ${url || 'request'} failed before a valid response was received.`, 'high', failedRequest);
    }
    const title = status >= 500 ? `Server returned HTTP ${status}` : `Request returned HTTP ${status}`;
    const severity = status >= 500 ? 'high' : 'medium';
    return incident(payload.kind, title, `${method} ${url || 'request'} returned ${status}${payload.statusText ? ` ${incidentUtils.scrubText(payload.statusText, 120)}` : ''}.`, severity, failedRequest);
  }

  function onSignal(event) {
    let payload;
    try {
      payload = JSON.parse(event.detail || '{}');
    } catch (_error) {
      return;
    }
    if (payload.kind === 'console_error') {
      if (!settings.detectConsoleErrors) {
        return;
      }
      const message = incidentUtils.scrubText(payload.message || 'console.error', 3000);
      queueIncident(incident(
        'console_error',
        message.split('\n')[0] || 'console.error',
        'The page called console.error.',
        'medium',
        { message },
        payload.stack || ''
      ));
      return;
    }
    if (!settings.detectNetworkErrors) {
      return;
    }
    if (['fetch_http_error', 'fetch_rejection', 'xhr_http_error', 'xhr_timeout', 'xhr_network_error'].includes(payload.kind)) {
      queueIncident(networkSignal(payload));
    }
  }

  function onStats(event) {
    try {
      const stats = JSON.parse(event.detail || '{}');
      latestMainStats = {
        listenerCount: Math.max(0, Math.round(incidentUtils.finiteNumber(stats.listenerCount))),
        listenerCountApproximate: stats.listenerCountApproximate !== false
      };
    } catch (_error) {
      latestMainStats = { listenerCount: 0, listenerCountApproximate: true };
    }
  }

  function onRoute() {
    memorySamples.length = 0;
    lastHeartbeat = performance.now();
  }

  function sampleDomNodes() {
    try {
      return document.getElementsByTagName('*').length;
    } catch (_error) {
      return 0;
    }
  }

  // use the best memory api available and fall back to the javascript heap estimate
  async function memoryBytes() {
    memorySampleIndex += 1;
    if (memorySampleIndex % 4 === 0 && globalThis.crossOriginIsolated && typeof performance.measureUserAgentSpecificMemory === 'function') {
      try {
        const measurement = await performance.measureUserAgentSpecificMemory();
        if (Number.isFinite(measurement?.bytes)) {
          return { bytes: measurement.bytes, source: 'measureUserAgentSpecificMemory' };
        }
      } catch (_error) {
      }
    }
    const memory = performance.memory;
    if (Number.isFinite(memory?.usedJSHeapSize)) {
      return {
        bytes: memory.usedJSHeapSize,
        source: 'performance.memory',
        limitBytes: Number(memory.jsHeapSizeLimit || 0),
        totalBytes: Number(memory.totalJSHeapSize || 0)
      };
    }
    return { bytes: 0, source: 'unavailable', limitBytes: 0, totalBytes: 0 };
  }

  function positiveRatio(samples, field) {
    let positive = 0;
    let compared = 0;
    for (let index = 1; index < samples.length; index += 1) {
      const before = incidentUtils.finiteNumber(samples[index - 1][field]);
      const after = incidentUtils.finiteNumber(samples[index][field]);
      if (before <= 0 && after <= 0) {
        continue;
      }
      compared += 1;
      if (after > before) {
        positive += 1;
      }
    }
    return compared ? positive / compared : 0;
  }

  // require sustained growth across the configured window before creating a report
  function evaluateMemoryLeak() {
    if (memorySamples.length < 5 || Date.now() - lastMemoryIncident < memoryCooldownMilliseconds) {
      return;
    }
    const first = memorySamples[0];
    const last = memorySamples[memorySamples.length - 1];
    const elapsedSeconds = (last.time - first.time) / 1000;
    if (elapsedSeconds < settings.memoryWindowSeconds) {
      return;
    }
    const thresholdBytes = settings.memoryGrowthMb * 1024 * 1024;
    const heapGrowth = last.bytes - first.bytes;
    const nodeGrowth = last.domNodes - first.domNodes;
    const listenerGrowth = last.listenerCount - first.listenerCount;
    const heapPositive = positiveRatio(memorySamples, 'bytes');
    const nodePositive = positiveRatio(memorySamples, 'domNodes');
    const listenerPositive = positiveRatio(memorySamples, 'listenerCount');
    const heapLeak = first.bytes > 0 && heapGrowth >= thresholdBytes && heapPositive >= 0.66;
    const structuralLeak = first.bytes === 0
      && nodeGrowth >= Math.max(1500, Math.round(first.domNodes * 0.5))
      && listenerGrowth >= 100
      && nodePositive >= 0.66
      && listenerPositive >= 0.66;
    if (!heapLeak && !structuralLeak) {
      return;
    }
    lastMemoryIncident = Date.now();
    const evidence = {
      measurementSource: last.source,
      windowSeconds: Math.round(elapsedSeconds),
      firstHeapBytes: first.bytes,
      lastHeapBytes: last.bytes,
      heapGrowthBytes: heapGrowth,
      heapGrowthMb: Math.round((heapGrowth / 1048576) * 100) / 100,
      heapGrowthPositiveRatio: Math.round(heapPositive * 100) / 100,
      heapLimitBytes: last.limitBytes || 0,
      firstDomNodes: first.domNodes,
      lastDomNodes: last.domNodes,
      domNodeGrowth: nodeGrowth,
      firstListenerCount: first.listenerCount,
      lastListenerCount: last.listenerCount,
      listenerGrowth,
      listenerCountApproximate: true
    };
    queueIncident(incident(
      'memory_leak_suspected',
      'Possible memory leak detected',
      heapLeak
        ? `JavaScript heap usage grew by ${evidence.heapGrowthMb} MB across ${evidence.windowSeconds} seconds without a sustained drop.`
        : `DOM nodes and event listeners grew continuously across ${evidence.windowSeconds} seconds while direct heap measurement was unavailable.`,
      heapLeak && heapGrowth >= thresholdBytes * 2 ? 'high' : 'medium',
      evidence
    ));
    memorySamples.splice(0, Math.max(0, memorySamples.length - 2));
  }

  async function takeMemorySample() {
    if (!enabled || !settings.detectMemoryLeaks || document.visibilityState === 'hidden') {
      return;
    }
    window.dispatchEvent(new CustomEvent('glitch-reaper:request-stats'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const memory = await memoryBytes();
    memorySamples.push({
      time: Date.now(),
      bytes: Math.max(0, Number(memory.bytes || 0)),
      source: memory.source,
      limitBytes: Math.max(0, Number(memory.limitBytes || 0)),
      totalBytes: Math.max(0, Number(memory.totalBytes || 0)),
      domNodes: sampleDomNodes(),
      listenerCount: latestMainStats.listenerCount
    });
    const maximum = Math.max(6, Math.ceil(settings.memoryWindowSeconds / settings.memorySampleSeconds) + 3);
    if (memorySamples.length > maximum) {
      memorySamples.splice(0, memorySamples.length - maximum);
    }
    evaluateMemoryLeak();
  }

  function startMemorySampling() {
    stopMemorySampling();
    if (!settings.detectMemoryLeaks) {
      return;
    }
    takeMemorySample().catch(() => undefined);
    memoryTimer = window.setInterval(() => takeMemorySample().catch(() => undefined), settings.memorySampleSeconds * 1000);
  }

  function stopMemorySampling() {
    if (memoryTimer) {
      clearInterval(memoryTimer);
      memoryTimer = null;
    }
    memorySamples.length = 0;
  }

  function onPerformanceEntries(list) {
    if (!settings.detectPerformanceFreezes) {
      return;
    }
    for (const entry of list.getEntries()) {
      if (entry.duration < settings.longTaskMs) {
        continue;
      }
      const durationMs = Math.round(entry.duration * 100) / 100;
      queueIncident(incident(
        'long_main_thread_task',
        `Main thread blocked for ${Math.round(durationMs)} ms`,
        `A browser task blocked the page's main thread for ${durationMs} ms.`,
        durationMs >= Math.max(1500, settings.longTaskMs * 2) ? 'high' : 'medium',
        {
          durationMs,
          entryType: entry.entryType,
          name: incidentUtils.scrubText(entry.name || '', 160),
          startTimeMs: Math.round(entry.startTime * 100) / 100
        }
      ));
    }
  }

  // prefer long animation frames when supported, otherwise use long tasks
  function startPerformanceObserver() {
    stopPerformanceObserver();
    if (!settings.detectPerformanceFreezes || typeof PerformanceObserver !== 'function') {
      return;
    }
    const supported = PerformanceObserver.supportedEntryTypes || [];
    const type = supported.includes('long-animation-frame') ? 'long-animation-frame' : supported.includes('longtask') ? 'longtask' : '';
    if (!type) {
      return;
    }
    try {
      performanceObserver = new PerformanceObserver(onPerformanceEntries);
      performanceObserver.observe({ type, buffered: false });
    } catch (_error) {
      performanceObserver = null;
    }
  }

  function stopPerformanceObserver() {
    performanceObserver?.disconnect();
    performanceObserver = null;
  }

  // catch long event-loop stalls that the performance observer may miss
  function heartbeat() {
    const now = performance.now();
    const delay = now - lastHeartbeat - 1000;
    lastHeartbeat = now;
    if (!enabled || !settings.detectPerformanceFreezes || document.visibilityState === 'hidden') {
      return;
    }
    const threshold = Math.max(2000, settings.longTaskMs * 2);
    if (delay < threshold) {
      return;
    }
    queueIncident(incident(
      'ui_freeze',
      `Page appeared frozen for ${Math.round(delay)} ms`,
      `The page's event loop stopped responding for approximately ${Math.round(delay)} ms.`,
      'high',
      { estimatedFreezeMs: Math.round(delay), thresholdMs: threshold }
    ));
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastHeartbeat = performance.now();
    heartbeatTimer = window.setInterval(heartbeat, 1000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // attach detectors only while the current page matches the saved host rules
  function attachListeners() {
    if (listenersAttached) {
      return;
    }
    listenersAttached = true;
    window.addEventListener('error', onError, true);
    window.addEventListener('unhandledrejection', onRejection, true);
    window.addEventListener('glitch-reaper:signal', onSignal, true);
    window.addEventListener('glitch-reaper:stats', onStats, true);
    window.addEventListener('glitch-reaper:route', onRoute, true);
    window.addEventListener('pagehide', flush, true);
    startPerformanceObserver();
    startMemorySampling();
    startHeartbeat();
  }

  function detachListeners() {
    if (!listenersAttached) {
      return;
    }
    listenersAttached = false;
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection, true);
    window.removeEventListener('glitch-reaper:signal', onSignal, true);
    window.removeEventListener('glitch-reaper:stats', onStats, true);
    window.removeEventListener('glitch-reaper:route', onRoute, true);
    window.removeEventListener('pagehide', flush, true);
    stopPerformanceObserver();
    stopMemorySampling();
    stopHeartbeat();
  }

  function applySettings(input) {
    settings = incidentUtils.normalizeSettings(input);
    const shouldEnable = incidentUtils.isUrlAllowed(location.href, settings);
    window.dispatchEvent(new CustomEvent('glitch-reaper:config', {
      detail: JSON.stringify({
        consoleEnabled: shouldEnable && settings.detectConsoleErrors,
        networkEnabled: shouldEnable && settings.detectNetworkErrors,
        memoryEnabled: shouldEnable && settings.detectMemoryLeaks,
        performanceEnabled: shouldEnable && settings.detectPerformanceFreezes
      })
    }));
    if (enabled === shouldEnable) {
      if (enabled) {
        startPerformanceObserver();
        startMemorySampling();
      }
      return;
    }
    enabled = shouldEnable;
    if (enabled) {
      attachListeners();
    } else {
      detachListeners();
      flush();
    }
  }

  function browserProfile() {
    const detected = incidentUtils.detectBrowser(navigator.userAgent, navigator.userAgentData);
    return {
      browser: { name: detected.name, version: detected.version },
      operatingSystem: detected.operatingSystem,
      language: navigator.language || '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      screen: {
        width: Math.round(window.screen?.width || 0),
        height: Math.round(window.screen?.height || 0),
        colorDepth: Number(window.screen?.colorDepth || 0),
        devicePixelRatio: Number(window.devicePixelRatio || 1)
      }
    };
  }

  function closeReporter() {
    reporterFrame?.remove();
    reporterFrame = null;
  }

  // load the manual form in an isolated extension frame above the tested page
  function openReporter() {
    if (reporterFrame) {
      reporterFrame.focus();
      return { opened: true };
    }
    const query = new URLSearchParams({
      url: incidentUtils.sanitizeUrl(location.href, settings.includeQueryParameters),
      title: settings.capturePageTitle ? incidentUtils.scrubText(document.title, 200) : ''
    });
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL(`manual-report/manual-report.html?${query.toString()}`);
    frame.title = 'Glitch Reaper bug reporter';
    Object.assign(frame.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      border: '0',
      margin: '0',
      padding: '0',
      zIndex: '2147483647',
      background: 'transparent',
      colorScheme: 'dark'
    });
    reporterFrame = frame;
    (document.documentElement || document.body).appendChild(frame);
    return { opened: true };
  }

  window.addEventListener('message', (event) => {
    if (event.source === reporterFrame?.contentWindow && event.data?.source === 'glitch-reaper' && event.data?.type === 'close-reporter') {
      closeReporter();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'OPEN_REPORTER') {
      sendResponse(openReporter());
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.gr_settings?.newValue) {
      applySettings(changes.gr_settings.newValue);
    }
  });

  async function initialise() {
    try {
      const result = await sendMessage({ type: 'GET_SETTINGS' });
      settings = incidentUtils.normalizeSettings(result.settings);
      const registration = await sendMessage({ type: 'REGISTER_PROFILE', profile: browserProfile() });
      profileId = registration.profileId;
      applySettings(registration.settings || settings);
    } catch (_error) {
      enabled = false;
    }
  }

  initialise();
})();
