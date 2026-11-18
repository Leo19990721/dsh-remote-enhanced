function browserInputUrl(value) {
  // Match the native address bar's scheme inference before choosing the Host.
  // Otherwise `localhost:41788` passes this guard and is opened on this PC.
  const trimmed = value.trim();
  const explicit = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed);
  try { return new URL(explicit ? trimmed : `https://${trimmed}`); } catch { return undefined; }
}
export function isLoopbackPage(value) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(browserInputUrl(value)?.hostname);
}

export function previewErrorMessage(error, value, source, t) {
  const target = browserInputUrl(value);
  const key = { LOOPBACK_PORT_DENIED: 'previewPortDenied', LOOPBACK_UNAVAILABLE: 'previewServiceUnavailable' }[error?.code];
  if (key && target && t) return t(key, { computer: source || t('previewSourceComputer'), port: target.port || (target.protocol === 'https:' ? '443' : '80') });
  return error?.message || '远端网页打开失败，请检查连接和端口设置后重试。';
}

// Adapt only the native browser's injected commands, leaving its renderer,
// Electron page, partition, tab identities and navigation implementation intact.
export function remoteBrowser(native, carrier, sessionId, { notify = () => {}, signal, t, sourceName = () => undefined } = {}) {
  const tabs = new Map(), origins = new Map(); let disposed = false, actions;
  const originalOf = value => {
    try {
      const url = new URL(value), source = origins.get(url.origin);
      return source ? source + url.pathname + url.search + url.hash : value;
    } catch { return value; }
  };
  const canonicalTarget = target => target ? { ...target, url: originalOf(target.url) } : target;
  const canonicalState = state => state ? { ...state, entries: state.entries.map(canonicalTarget), request: state.request ? { ...state.request, target: canonicalTarget(state.request.target) } : state.request } : state;
  const update = tab => { tab.revision++; for (const listener of tab.listeners) listener(); };
  const subscribe = (tab, fn) => { tab.listeners.add(fn); return () => { tab.listeners.delete(fn); }; };
  const snapshot = tab => {
    const base = tab.nativeState;
    if (!base) return undefined;
    if (!tab.busy && !tab.error && !tab.fileMode) return base;
    if (!tab.snapshot || tab.base !== base) {
      tab.base = base;
      tab.snapshot = { ...base, restoreTarget: undefined, frame: { ...base.frame, loading: tab.busy || base.frame.loading, canGoBack: tab.fileMode ? false : base.frame.canGoBack, canGoForward: tab.fileMode ? false : base.frame.canGoForward, target: base.frame.target || (tab.original ? { kind: 'http', url: tab.original, title: 'Remote' } : undefined), error: tab.error ? { code: 0, description: tab.error } : base.frame.error } };
    }
    return tab.snapshot;
  };
  const stateOf = id => {
    let tab = tabs.get(id);
    if (!tab) {
      tab = { id, occurrence: crypto.randomUUID(), leases: new Set(), listeners: new Set(), sequence: 0, busy: false, revision: 0, fileMode: false };
      tab.source = { getSnapshot: () => tab.revision, subscribe: fn => subscribe(tab, fn) };
      tabs.set(id, tab);
    }
    return tab;
  };
  async function navigate(id, value) {
    if (disposed) return;
    const tab = stateOf(id), generation = ++tab.sequence;
    tab.pending?.abort(); tab.fileWatch?.abort(); tab.fileWatch = undefined; tab.fileRequest = undefined;
    tab.fileLease = undefined; tab.fileOrigin = undefined; tab.fileAvailable = false; tab.fileRequest = undefined;
    tab.pending = new AbortController();
    const active = AbortSignal.any([tab.pending.signal, ...[signal, tab.signal].filter(Boolean)]);
    const original = originalOf(value); tab.original = original; tab.busy = true; tab.error = undefined; tab.snapshot = undefined; update(tab);
    try {
      let destination = original;
      const target = isLoopbackPage(original) ? browserInputUrl(original) : undefined;
      const port = target ? target.port || (target.protocol === 'https:' ? '443' : '80') : undefined;
      // Occurrences are never reused after closing a tab. Every explicit file
      // navigation gets a new lease, invalidating native history's old origins.
      const fileMode = tab.fileMode;
      const lease = target ? JSON.stringify([sessionId, id, tab.occurrence, port, ...(fileMode ? [generation, 'files'] : [])]) : undefined;
      const obsolete = [...tab.leases].filter(value => value !== lease);
      await Promise.all(obsolete.map(async value => {
        const closed = await carrier.previewClose(value);
        if (closed?.ok === false) throw new Error(closed.error?.message || '旧网页未关闭，请重试。');
        tab.leases.delete(value);
      }));
      active.throwIfAborted();
      if (tab.sequence !== generation) return;
      if (target) {
        tab.leases.add(lease);
        const result = await carrier.previewOpen(sessionId, target.href, lease, active, { fileMode });
        if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
        active.throwIfAborted();
        if (tab.sequence !== generation) return;
        const proxy = new URL(result.value.url); origins.set(proxy.origin, target.origin);
        destination = result.value.url; tab.fileLease = fileMode ? lease : undefined; tab.fileOrigin = fileMode ? proxy.origin : undefined;
        tab.fileAvailable = result.value.filePreviewAvailable === true; tab.fileTarget = target.origin + target.pathname;
        if (fileMode) await watchFiles(tab, lease, generation);
      } else if (/^https?:\/\/dsh-[a-f0-9]+\.localhost(?::\d+)?\//i.test(original)) {
        throw new Error('保存的远端转发地址已失效，请从原始 localhost 链接重新打开。');
      }
      active.throwIfAborted();
      if (tab.sequence !== generation) return;
      native.loadUrl(id, destination);
    } catch (error) {
      if (active.aborted || tab.sequence !== generation) return;
      tab.error = previewErrorMessage(error, original, sourceName(), t); notify(tab.error);
    } finally {
      if (tab.sequence === generation) { tab.busy = false; tab.snapshot = undefined; update(tab); }
    }
  }
  function watchFiles(tab, lease, generation) {
    const control = new AbortController(); tab.fileWatch = control;
    const active = AbortSignal.any([control.signal, ...[signal, tab.signal].filter(Boolean)]);
    let resolveReady, rejectReady, received = false;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const cancelled = () => rejectReady(active.reason);
    const timer = setTimeout(() => { rejectReady(new Error('文件预览连接超时，请重新载入。')); control.abort(); }, 15000);
    active.addEventListener('abort', cancelled, { once: true });
    void (async () => {
      try {
        for await (const state of carrier.previewFiles(lease, active)) {
          active.throwIfAborted();
          if (tab.sequence !== generation) return;
          tab.fileRequest = state.pending || undefined; tab.fileError = undefined; update(tab);
          if (!received) { received = true; clearTimeout(timer); resolveReady(); }
        }
        if (!active.aborted && tab.sequence === generation) throw new Error('文件预览连接已关闭，请关闭再开启本机预览。');
      } catch (error) {
        if (!received) rejectReady(error);
        if (!active.aborted && tab.sequence === generation) { tab.fileRequest = undefined; tab.fileError = error.message; update(tab); }
      } finally { clearTimeout(timer); active.removeEventListener('abort', cancelled); }
    })();
    return ready;
  }
  async function consumeFile(id, mode, handle) {
    const tab = tabs.get(id), pending = tab?.fileRequest, lease = tab?.fileLease, generation = tab?.sequence;
    let activeOrigin = false;
    try { activeOrigin = new URL(tab?.nativeState?.frame?.target?.url || '').origin === tab?.fileOrigin && tab?.nativeState?.frame?.address !== 'unknown'; } catch {}
    if (!pending || !lease || !activeOrigin || tab.fileBusy || !['preview', 'download', 'cancel'].includes(mode)) return;
    tab.fileBusy = true; tab.fileError = undefined; update(tab);
    try {
      const result = await carrier.previewFileClaim(lease, pending.id, AbortSignal.any([tab.fileWatch.signal, ...[signal, tab.signal].filter(Boolean)]));
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
      if (tab.sequence !== generation || tab.signal?.aborted || disposed) return;
      if (result.value.sessionId !== sessionId || result.value.path !== pending.path || result.value.kind !== pending.kind) throw new Error('文件请求来源已变化，请重新点击。');
      if (tab.fileRequest?.id === pending.id) tab.fileRequest = undefined;
      if (mode !== 'cancel') await handle(result.value);
    } catch (error) {
      if (tab.sequence === generation && !tab.signal?.aborted && !disposed) { tab.fileError = error.message; notify(error.message); }
    } finally { tab.fileBusy = false; if (!disposed) update(tab); }
  }
  async function release(tab) {
    tab.pending?.abort(); tab.fileWatch?.abort(); tabs.delete(tab.id);
    await Promise.all([...tab.leases].map(lease => carrier.previewClose(lease).catch(() => {}))); tab.leases.clear();
  }
  return {
    canonicalState,
    originalOf,
    fileState(id) {
      const tab = stateOf(id), frame = tab.nativeState?.frame;
      const current = originalOf(frame?.target?.url || tab.original || '');
      let atTarget = false, active = false;
      try {
        const parsed = new URL(current); atTarget = parsed.origin + parsed.pathname === tab.fileTarget;
        active = !!tab.fileOrigin && new URL(frame?.target?.url || '').origin === tab.fileOrigin && frame?.address !== 'unknown';
      } catch {}
      return { enabled: tab.fileMode, active, pending: active ? tab.fileRequest : undefined, busy: tab.fileBusy || tab.busy, error: tab.fileError, available: tab.fileAvailable && atTarget && frame?.address !== 'unknown' };
    },
    async setFileMode(id, enabled) {
      const tab = stateOf(id);
      if (tab.fileBusy || tab.busy || disposed) return;
      const current = originalOf(tab.nativeState?.frame?.target?.url || tab.original || '');
      if (enabled && (!this.fileState(id).available || !isLoopbackPage(current))) return;
      tab.fileMode = enabled === true; tab.fileError = undefined; update(tab);
      await navigate(id, current);
    },
    resumeFiles(id) {
      const tab = stateOf(id);
      if (tab.fileMode && !tab.fileBusy && !tab.busy && tab.original) void navigate(id, tab.original);
    },
    goBack(id) { if (!stateOf(id).fileMode) native.goBack?.(id); },
    goForward(id) { if (!stateOf(id).fileMode) native.goForward?.(id); },
    consumeFile,
    bindActions(value) { actions = value; },
    displayState(id, value) {
      const tab = stateOf(id);
      if (tab.nativeState !== value) { tab.nativeState = value; tab.snapshot = undefined; }
      return snapshot(tab);
    },
    keyedHooks: { browserState: id => stateOf(id).source },
    mount(request) {
      const tab = stateOf(request.tabId); tab.signal = request.signal;
      if (actions && native.rebind) native.rebind({ ...actions, replace: (id, state) => actions.replace(id, canonicalState(state)) });
      tab.initial = canonicalState(request.initial);
      const hide = native.mount({ ...request, initial: tab.initial, initialUrl: undefined, openTab: value => request.openTab(originalOf(value)) });
      if (!tab.attached) {
        tab.attached = true;
        request.signal.addEventListener('abort', () => { void release(tab); }, { once: true });
        if (request.initialUrl !== undefined) void navigate(tab.id, request.initialUrl);
      }
      return hide;
    },
    loadUrl: (id, value) => { void navigate(id, value); },
    restore(id) {
      const tab = stateOf(id), selected = tab.initial?.entries[tab.initial.index];
      if (selected) void navigate(id, selected.url);
    },
    reload(id) {
      const tab = stateOf(id), current = tab.nativeState;
      if (tab.error && tab.original) void navigate(id, tab.original);
      else if (current?.restoreTarget) void navigate(id, current.restoreTarget.url);
      else if (current?.frame.target) void navigate(id, originalOf(current.frame.target.url));
      else native.reload(id);
    },
    async dispose() { disposed = true; await Promise.all([...tabs.values()].map(release)); origins.clear(); },
  };
}
