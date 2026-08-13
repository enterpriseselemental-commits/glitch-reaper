// coordinates page error, resource, performance and memory detection

'use strict';

(() => {
  if (window.__GLITCH_REAPER_MAIN__) return;
  window.__GLITCH_REAPER_MAIN__ = true;

  // keep original browser methods before wrapping page-level apis
  const nativeMethods = {
    add: EventTarget.prototype.addEventListener,
    remove: EventTarget.prototype.removeEventListener,
    consoleError: console.error,
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    pushState: history.pushState,
    replaceState: history.replaceState
  };
  const listenerRegistry = new WeakMap();
  const xhrMetadata = new WeakMap();
  let activeListenerCount = 0;
  let consoleEnabled = false;
  let networkEnabled = false;
  let memoryEnabled = false;
  let performanceEnabled = false;
  let routesEnabled = false;

  // send small json signals to the isolated content script for sanitizing and storage
  function emit(name, payload) {
    window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));
  }

  function emitSignal(payload) {
    emit('glitch-reaper:signal', payload);
  }

  function serialise(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`;
    if (typeof value === 'string') return value;
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (_key, nested) => {
        if (nested && typeof nested === 'object') {
          if (seen.has(nested)) return '[Circular]';
          seen.add(nested);
        }
        return nested;
      });
    } catch (_error) {
      return String(value);
    }
  }

  function listenerKey(options) {
    return typeof options === 'boolean' ? options : Boolean(options?.capture);
  }

  // track active listeners without keeping targets or callbacks alive
  function listenerRecord(target, type, listener, create) {
    if ((!listener || (typeof listener !== 'object' && typeof listener !== 'function')) || !type) return null;
    let targetMap = listenerRegistry.get(target);
    if (!targetMap && create) {
      targetMap = new Map();
      listenerRegistry.set(target, targetMap);
    }
    if (!targetMap) return null;
    let typeMap = targetMap.get(type);
    if (!typeMap && create) {
      typeMap = new WeakMap();
      targetMap.set(type, typeMap);
    }
    if (!typeMap) return null;
    let state = typeMap.get(listener);
    if (!state && create) {
      state = { capture: false, bubble: false };
      typeMap.set(listener, state);
    }
    return state || null;
  }

  function trackedAdd(type, listener, options) {
    const transient = typeof options === 'object' && options && (options.once || options.signal);
    const state = transient ? null : listenerRecord(this, String(type || ''), listener, true);
    if (state) {
      const key = listenerKey(options) ? 'capture' : 'bubble';
      if (!state[key]) {
        state[key] = true;
        activeListenerCount += 1;
      }
    }
    return nativeMethods.add.call(this, type, listener, options);
  }

  function trackedRemove(type, listener, options) {
    const state = listenerRecord(this, String(type || ''), listener, false);
    if (state) {
      const key = listenerKey(options) ? 'capture' : 'bubble';
      if (state[key]) {
        state[key] = false;
        activeListenerCount = Math.max(0, activeListenerCount - 1);
      }
    }
    return nativeMethods.remove.call(this, type, listener, options);
  }

  // count listener growth for the memory leak heuristic without reading callback data
  function setListenerTracking(enabled) {
    if (enabled && EventTarget.prototype.addEventListener !== trackedAdd) {
      activeListenerCount = 0;
      EventTarget.prototype.addEventListener = trackedAdd;
      EventTarget.prototype.removeEventListener = trackedRemove;
    } else if (!enabled && EventTarget.prototype.addEventListener === trackedAdd) {
      EventTarget.prototype.addEventListener = nativeMethods.add;
      EventTarget.prototype.removeEventListener = nativeMethods.remove;
      activeListenerCount = 0;
    }
  }

  function wrappedConsoleError(...args) {
    if (consoleEnabled) {
      try {
        emitSignal({ kind: 'console_error', message: args.map(serialise).join(' ').slice(0, 8000), stack: new Error('console.error').stack || '' });
      } catch (_error) {
      }
    }
    return nativeMethods.consoleError.apply(this, args);
  }

  function setConsoleCapture(enabled) {
    if (enabled && console.error !== wrappedConsoleError) console.error = wrappedConsoleError;
    else if (!enabled && console.error === wrappedConsoleError) console.error = nativeMethods.consoleError;
  }

  // report failed responses and rejected fetch calls while preserving page behavior
  async function wrappedFetch(input, init) {
    const started = performance.now();
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const url = String(input?.url || input || '');
    try {
      const response = await nativeMethods.fetch.apply(this, arguments);
      if (networkEnabled && response.status >= 400) {
        emitSignal({ kind: 'fetch_http_error', method, url: response.url || url, status: response.status, statusText: response.statusText, durationMs: Math.round((performance.now() - started) * 100) / 100 });
      }
      return response;
    } catch (error) {
      if (networkEnabled) {
        emitSignal({ kind: 'fetch_rejection', method, url, message: error?.message || String(error), stack: error?.stack || '', durationMs: Math.round((performance.now() - started) * 100) / 100 });
      }
      throw error;
    }
  }

  function wrappedXhrOpen(method, url) {
    xhrMetadata.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url || ''), started: 0, networkFailure: false, timeoutFailure: false });
    return nativeMethods.xhrOpen.apply(this, arguments);
  }

  // keep request metadata in a weak map so completed xhr objects can be collected
  function wrappedXhrSend() {
    const meta = xhrMetadata.get(this) || { method: 'GET', url: '', started: 0, networkFailure: false, timeoutFailure: false };
    meta.started = performance.now();
    xhrMetadata.set(this, meta);
    const onError = () => {
      meta.networkFailure = true;
    };
    const onTimeout = () => {
      meta.timeoutFailure = true;
    };
    const onLoadEnd = () => {
      nativeMethods.remove.call(this, 'error', onError);
      nativeMethods.remove.call(this, 'timeout', onTimeout);
      nativeMethods.remove.call(this, 'loadend', onLoadEnd);
      if (!networkEnabled) return;
      const durationMs = Math.round((performance.now() - meta.started) * 100) / 100;
      if (meta.networkFailure || meta.timeoutFailure) {
        emitSignal({ kind: meta.timeoutFailure ? 'xhr_timeout' : 'xhr_network_error', method: meta.method, url: this.responseURL || meta.url, status: Number(this.status || 0), durationMs });
      } else if (this.status >= 400) {
        emitSignal({ kind: 'xhr_http_error', method: meta.method, url: this.responseURL || meta.url, status: Number(this.status || 0), statusText: this.statusText || '', durationMs });
      }
    };
    nativeMethods.add.call(this, 'error', onError);
    nativeMethods.add.call(this, 'timeout', onTimeout);
    nativeMethods.add.call(this, 'loadend', onLoadEnd);
    return nativeMethods.xhrSend.apply(this, arguments);
  }

  function setNetworkCapture(enabled) {
    if (enabled) {
      if (window.fetch !== wrappedFetch) window.fetch = wrappedFetch;
      if (XMLHttpRequest.prototype.open !== wrappedXhrOpen) XMLHttpRequest.prototype.open = wrappedXhrOpen;
      if (XMLHttpRequest.prototype.send !== wrappedXhrSend) XMLHttpRequest.prototype.send = wrappedXhrSend;
    } else {
      if (window.fetch === wrappedFetch) window.fetch = nativeMethods.fetch;
      if (XMLHttpRequest.prototype.open === wrappedXhrOpen) XMLHttpRequest.prototype.open = nativeMethods.xhrOpen;
      if (XMLHttpRequest.prototype.send === wrappedXhrSend) XMLHttpRequest.prototype.send = nativeMethods.xhrSend;
    }
  }

  // notify the monitor when a single-page app changes routes
  function emitRoute() {
    window.dispatchEvent(new CustomEvent('glitch-reaper:route'));
  }

  function wrappedPushState(...args) {
    const result = nativeMethods.pushState.apply(this, args);
    emitRoute();
    return result;
  }

  function wrappedReplaceState(...args) {
    const result = nativeMethods.replaceState.apply(this, args);
    emitRoute();
    return result;
  }

  function setRouteCapture(enabled) {
    if (enabled && !routesEnabled) {
      routesEnabled = true;
      history.pushState = wrappedPushState;
      history.replaceState = wrappedReplaceState;
      nativeMethods.add.call(window, 'popstate', emitRoute, true);
      nativeMethods.add.call(window, 'hashchange', emitRoute, true);
    } else if (!enabled && routesEnabled) {
      routesEnabled = false;
      if (history.pushState === wrappedPushState) history.pushState = nativeMethods.pushState;
      if (history.replaceState === wrappedReplaceState) history.replaceState = nativeMethods.replaceState;
      nativeMethods.remove.call(window, 'popstate', emitRoute, true);
      nativeMethods.remove.call(window, 'hashchange', emitRoute, true);
    }
  }

  nativeMethods.add.call(window, 'glitch-reaper:config', (event) => {
    try {
      const config = JSON.parse(event.detail || '{}');
      consoleEnabled = Boolean(config.consoleEnabled);
      networkEnabled = Boolean(config.networkEnabled);
      memoryEnabled = Boolean(config.memoryEnabled);
      performanceEnabled = Boolean(config.performanceEnabled);
    } catch (_error) {
      consoleEnabled = false;
      networkEnabled = false;
      memoryEnabled = false;
      performanceEnabled = false;
    }
    setConsoleCapture(consoleEnabled);
    setNetworkCapture(networkEnabled);
    setListenerTracking(memoryEnabled);
    setRouteCapture(consoleEnabled || networkEnabled || memoryEnabled || performanceEnabled);
  }, true);

  nativeMethods.add.call(window, 'glitch-reaper:request-stats', () => {
    if (memoryEnabled) emit('glitch-reaper:stats', { listenerCount: activeListenerCount, listenerCountApproximate: true });
  }, true);
})();
