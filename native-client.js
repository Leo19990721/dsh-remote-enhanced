window.__ModuleLoader__.load({
  id: '@local/dsh-remote-enhanced',
  factory(require) {
    const React = require('react');
    const dictionaries = {"zh":{"offline":"离线","unavailable":"暂不可用","loadFailed":"远程工作区加载失败，点击重试。","partialFailed":"部分远程工作区加载失败，点击重试。","connecting":"正在连接对应电脑…","hostOffline":"这台电脑已离线，连接恢复后再打开。","openFailed":"会话打开失败，请检查 Remote 连接后重试。","sessionUnavailable":"这个会话暂不可用，请刷新工作区后重试。","independentRoutingRequired":"全局切换入口已停用，请直接点击对应工作区中的会话。","fileUnavailable":"远端文件不可用，请检查电脑连接、文件路径和读取权限。","imageOpen":"查看远端图片","close":"关闭","download":"下载到本机","fileMenu":"文件操作","retry":"刷新","parentDirectory":"上一级文件夹","directory":"远端文件夹","directoryTruncated":"文件夹内容较多，当前列表已达到显示上限。","openSidebar":"在侧栏打开","copyRemotePath":"复制远端路径","copyLink":"复制链接","remoteApplication":"远端文件请先预览或下载到本机。","previewSourceComputer":"网页所属电脑","previewPortDenied":"{computer} 尚未允许网页端口 {port}。请在那台电脑已登录的 DSH Remote 设置中允许此端口并保存，然后回到这里刷新网页。","previewServiceUnavailable":"{computer} 的网页服务未响应端口 {port}。请在那台电脑启动对应网页服务，然后回到这里刷新。","mapFiles":"整理地图文件","mapFilesEnable":"开启本机预览","mapFilesDisable":"关闭本机预览","mapFilesHint":"点击地图中的文件后，在此选择预览或下载。开关会重新载入当前网页。","mapFilesOffHint":"先开启本机预览。当前网页原操作会在远端电脑执行；切换将重载此页。","mapFilesResume":"重新载入本机预览","mapFilesCurrentSession":"当前会话","mapFilesConfirm":"确认打开远端资源","mapFilesSource":"来源：","mapFilesPreview":"预览","mapFilesFolder":"查看文件夹","cancel":"取消","connectionRateLimited":"请求太多，请等一会儿再试。","connectionServiceUnavailable":"远程服务暂时不可用，请稍后再试。","connectionHostOffline":"电脑不在线。请在那台电脑打开 DSH，再试一次。","connectionConnectionTimeout":"连接超时。请确认那台电脑已联网并打开 DSH，再试一次。","connectionAuthorizationRequired":"请打开远程工作台，检查登录和设备授权。","connectionConnectionInterrupted":"远程连接断开了。请在远程工作台查看连接状态。","connectionConnectionFailed":"暂时连不上。请确认那台电脑已联网并打开 DSH。"},"en":{"offline":"Offline","unavailable":"Unavailable","loadFailed":"Could not load remote workspaces. Click to retry.","partialFailed":"Some remote workspaces could not load. Click to retry.","connecting":"Connecting to the selected computer…","hostOffline":"This computer is offline. Open it after it reconnects.","openFailed":"Could not open the session. Check the Remote connection and retry.","sessionUnavailable":"This session is unavailable. Refresh the workspaces and retry.","independentRoutingRequired":"Global-target selection has been retired. Open the session directly from its workspace.","fileUnavailable":"Remote file unavailable. Check the computer connection, path and read permissions.","imageOpen":"View remote image","close":"Close","download":"Download to this computer","fileMenu":"File actions","retry":"Refresh","parentDirectory":"Parent folder","directory":"Remote folder","directoryTruncated":"This folder reached the display limit.","openSidebar":"Open in sidebar","copyRemotePath":"Copy remote path","copyLink":"Copy link","remoteApplication":"Preview remote files or download them to this computer first.","previewSourceComputer":"The page's computer","previewPortDenied":"{computer} has not allowed webpage port {port}. Allow this port in the signed-in DSH Remote settings on that computer, save, then refresh this page here.","previewServiceUnavailable":"The webpage service on {computer} did not respond on port {port}. Start that service on that computer, then refresh this page here.","mapFiles":"Map files","mapFilesEnable":"Enable local preview","mapFilesDisable":"Disable local preview","mapFilesHint":"Click a map file, then preview or download it here. Toggling reloads this page.","mapFilesOffHint":"Enable local preview first. Original page actions run on the remote computer; toggling reloads this page.","mapFilesResume":"Reload local preview","mapFilesCurrentSession":"Current session","mapFilesConfirm":"Confirm remote resource","mapFilesSource":"Source:","mapFilesPreview":"Preview","mapFilesFolder":"View folder","cancel":"Cancel","connectionRateLimited":"Too many requests. Wait a moment, then try again.","connectionServiceUnavailable":"Remote is temporarily unavailable. Try again later.","connectionHostOffline":"This computer is offline. Open DSH on it, then try again.","connectionConnectionTimeout":"Connection timed out. Check that the other computer is online and DSH is open, then try again.","connectionAuthorizationRequired":"Open Remote Workbench to check sign-in and device access.","connectionConnectionInterrupted":"The connection dropped. Check its status in Remote Workbench.","connectionConnectionFailed":"Could not connect. Check that the other computer is online and DSH is open."}};
    // One authenticated socket carries every independently cancellable logical
// stream. Separate long-lived HTTP fetches would exhaust Chromium's per-origin
// connection pool and block ordinary Session commands.
class SessionStreams {
  constructor(openSocket, viewId) { this.openSocket = openSocket; this.viewId = viewId; this.streams = new Map(); this.closed = false; }
  connect(signal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Session carrier disposed');
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket);
    if (!this.connecting) {
      const socket = this.openSocket('/dsh-session-hosts/mux?viewId=' + encodeURIComponent(this.viewId));
      this.socket = socket;
      this.connecting = new Promise((resolve, reject) => {
        const failed = () => {
          const error = carrierError('Session connection closed');
          if (this.socket === socket) {
            this.socket = undefined; this.connecting = undefined;
            for (const stream of this.streams.values()) stream.fail(error);
          }
          reject(error);
        };
        socket.addEventListener('open', () => resolve(socket), { once: true });
        socket.addEventListener('close', failed, { once: true });
        socket.addEventListener('error', failed, { once: true });
        socket.addEventListener('message', event => {
          try {
            const frame = JSON.parse(event.data), stream = this.streams.get(frame.streamId);
            if (!stream) return;
            if (frame.type === 'item') stream.push(frame.value);
            else if (frame.type === 'inputAccepted') stream.inputAccepted?.();
            else if (frame.type === 'end') stream.end();
            else if (frame.type === 'error') stream.fail(Object.assign(new Error(frame.error.message), frame.error, { isDSHRemoteError: true }));
            else throw new Error('Invalid Session stream frame');
          } catch { socket.close(4002, 'Invalid stream frame'); }
        });
      });
      void this.connecting.catch(() => {});
    }
    return waitForSignal(this.connecting, signal);
  }
  open(endpoint, payload, signal, uplink) {
    const owner = this;
    return { async *[Symbol.asyncIterator]() {
      const id = crypto.randomUUID(), inbox = new StreamInbox(), inputStop = new AbortController();
      let socket, ended = false, input, credit;
      const abort = () => { inbox.fail(signal.reason); inputStop.abort(); credit?.(); };
      signal.addEventListener('abort', abort, { once: true });
      inbox.inputAccepted = () => { credit?.(); credit = undefined; };
      owner.streams.set(id, inbox);
      try {
        socket = await owner.connect(signal); signal.throwIfAborted();
        socket.send(JSON.stringify({ type: 'open', streamId: id, endpoint, payload }));
        if (uplink) {
          input = uplink[Symbol.asyncIterator]();
          void (async () => {
            try {
              while (!inputStop.signal.aborted) {
                const next = await waitForSignal(input.next(), inputStop.signal);
                inputStop.signal.throwIfAborted();
                if (next.done) { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'inputEnd', streamId: id })); break; }
                const frame = JSON.stringify({ type: 'input', streamId: id, value: next.value });
                if (new TextEncoder().encode(frame).byteLength > 256 * 1024) throw new Error('Terminal input is too large');
                const accepted = new Promise(resolve => { credit = resolve; });
                socket.send(frame);
                await waitForSignal(accepted, inputStop.signal);
              }
            } catch (error) { if (!inputStop.signal.aborted) inbox.fail(error); }
          })();
        }
        for (;;) {
          const next = await inbox.next();
          if (next.done) { ended = true; return; }
          yield next.value;
        }
      } finally {
        inputStop.abort(); credit?.();
        void input?.return?.().catch(() => {});
        signal.removeEventListener('abort', abort); owner.streams.delete(id);
        if (!ended && socket?.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', streamId: id }));
      }
    } };
  }
  dispose() {
    this.closed = true;
    for (const stream of this.streams.values()) stream.fail(carrierError('Session carrier disposed'));
    this.streams.clear(); this.socket?.close(1000, 'View closed');
  }
}
class StreamInbox {
  constructor() { this.items = []; this.waiter = undefined; this.done = false; }
  push(value) { if (this.done) return; this.items.push(value); this.wake(); }
  end() { this.done = true; this.wake(); }
  fail(error) { this.error = error; this.end(); }
  wake() { this.waiter?.(); this.waiter = undefined; }
  async next() {
    while (!this.items.length && !this.done) await new Promise(resolve => { this.waiter = resolve; });
    if (this.error) throw this.error;
    if (this.items.length) return { value: this.items.shift(), done: false };
    return { done: true };
  }
}
function carrierError(message) { return Object.assign(new Error(message), { dshRemoteStreamFailure: { kind: 'carrier' } }); }
async function waitForSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted(); let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}


// Browser-side native Connection adapter. All existing generated APIs and
// native stores keep their objects; only the physical carrier is different.
async function installSessionCarrier(ctx, { fetch: send = globalThis.fetch, signal } = {}) {
  const connection = ctx.connection, registry = ctx.typert?.remotes;
  const t = ctx.locale?.bind('remoteWorkspaces');
  const localized = error => {
    const reason = error?.details?.reason;
    if (!t || !['rateLimited', 'serviceUnavailable', 'hostOffline', 'connectionTimeout', 'authorizationRequired', 'connectionInterrupted', 'connectionFailed'].includes(reason)) return error;
    const computer = error.details.computer || error.details.hostId;
    const message = String(computer || '') + ': ' + t('connection' + reason[0].toUpperCase() + reason.slice(1));
    return error instanceof Error ? Object.assign(error, { message }) : { ...error, message };
  };
  if (typeof registry?.get !== 'function' || typeof registry?.list !== 'function') throw new Error('Native API registry unavailable.');
  const nativeEndpoints = new Set(), nativeNamespaces = new Set();
  const rememberEndpoints = () => {
    for (const descriptor of registry.list()) {
      nativeEndpoints.add(descriptor.namespace + '/' + descriptor.method);
      nativeNamespaces.add(descriptor.namespace);
    }
  };
  rememberEndpoints();
  const originalCall = connection.rpc.call;
  const originalOpen = connection.rpc.open;
  const lifetime = new AbortController(), active = AbortSignal.any([lifetime.signal, ...signal ? [signal] : []]);
  const rpc = (action, payload, requestSignal = active) => originalCall.call(connection.rpc, '/dsh-session-hosts', action, payload, requestSignal);
  const attached = await rpc('attach', {});
  if (!attached.ok) throw new Error(attached.error.message);
  let viewId = attached.value.viewId, streams, renewal;
  const baseHost = attached.value.baseHost;
  const makeStreams = () => typeof connection.openWebSocket === 'function' ? new SessionStreams(path => connection.openWebSocket(path), viewId) : undefined;
  streams = makeStreams();
  const expired = result => !result?.ok && (result?.error?.code === 'session-hosts/view-expired' || result?.error?.message === 'VIEW_UNAVAILABLE');
  async function renew(previous) {
    active.throwIfAborted();
    if (viewId !== previous) return;
    if (!renewal) {
      renewal = (async () => {
        const result = await rpc('attach', { baseHost }, active);
        if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
        if (result.value.baseHost !== baseHost) throw new Error('Session ownership changed during reconnect');
        active.throwIfAborted();
        const old = streams; viewId = result.value.viewId; streams = makeStreams(); old?.dispose();
        void rpc('close', { viewId: previous }, AbortSignal.timeout(5000)).catch(() => {});
      })().finally(() => { renewal = undefined; });
    }
    return renewal;
  }
  async function viewCall(action, payload, requestSignal = active) {
    const previous = viewId;
    let result = await rpc(action, { ...payload, viewId: previous }, requestSignal);
    // An explicit pre-dispatch view rejection proves no operation was admitted.
    // A timeout or lost response is never replayed, including prompt/cancel.
    if (expired(result)) { await renew(previous); requestSignal.throwIfAborted(); result = await rpc(action, { ...payload, viewId }, requestSignal); }
    return result;
  }
  async function ensureView(requestSignal) {
    const result = await viewCall('ping', {}, requestSignal);
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
  }
  const identityFields = new Set(['sessionId', 'agentId', 'workspaceId', 'workspaceFileScopeId', 'parentSessionId', 'childSessionId', 'parentSession', 'beforeSessionId', 'beforeWorkspaceId', 'sessionIds', 'workspaceIds']);
  function hasSessionIdentity(payload) {
    const seen = new WeakSet();
    const visit = (value, identity = false) => {
      if (typeof value === 'string') return identity && (value.startsWith('dsh-peer:') || baseHost !== 'local');
      if (!value || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      if (Array.isArray(value)) return value.some(item => visit(item, identity));
      return Object.entries(value).some(([key, item]) => visit(item, identityFields.has(key)));
    };
    return visit(payload);
  }
  function federated(channel, endpoint, payload) {
    if (channel !== '/api') return false;
    if (['$events', '$events/result', '$hostStatus', '$previewFiles'].includes(endpoint)) return true;
    const descriptor = registry.get(endpoint);
    if (descriptor) {
      nativeEndpoints.add(endpoint); nativeNamespaces.add(descriptor.namespace);
      return true;
    }
    // Plugin-owned RPCs are not generated Gateway calls. Keep their original
    // carrier and business payload. A missing native method or addressed peer
    // operation cannot be interpreted safely by that unqualified carrier.
    if (nativeEndpoints.has(endpoint) || nativeNamespaces.has(String(endpoint).split(/[/.]/, 1)[0]) || hasSessionIdentity(payload)) {
      throw Object.assign(new Error('This Session operation has no mounted API route; reconnect or update the owning plugin.'), { code: 'session-hosts/route-unavailable', details: {}, isDSHRemoteError: true });
    }
    return false;
  }
  const wrappedCall = async (channel, endpoint, payload, requestSignal) => {
    if (!federated(channel, endpoint, payload)) return originalCall.call(connection.rpc, channel, endpoint, payload, requestSignal);
    try {
      const result = await viewCall('call', { endpoint, payload }, AbortSignal.any([active, ...requestSignal ? [requestSignal] : []]));
      return result.ok ? result : { ...result, error: localized(result.error) };
    } catch (error) { throw localized(error); }
  };
  const wrappedOpen = (channel, endpoint, payload, requestSignal, uplink) => {
    if (!federated(channel, endpoint, payload)) {
      // undefined preserves the installed Gateway's own native mux fallback.
      return originalOpen?.call(connection.rpc, channel, endpoint, payload, requestSignal, uplink);
    }
    const activeSignal = AbortSignal.any([active, ...requestSignal ? [requestSignal] : []]);
    return { async *[Symbol.asyncIterator]() {
      // On socket replacement verify that the server still recognizes this
      // view before opening streams; idle cleanup must never trap reconnect.
      try {
        if (!streams || streams.socket?.readyState !== 1) await ensureView(activeSignal);
        yield* (streams ? streams.open(endpoint, payload, activeSignal, registry.get(endpoint)?.uplink ? uplink : undefined) : readStream(endpoint, payload, activeSignal, uplink));
      } catch (error) {
        // Unloading this adapter interrupts the carrier, not the native model
        // that owns the logical subscription. Keep caller cancellation intact.
        if (active.aborted && !requestSignal?.aborted) throw Object.assign(new Error('Session adapter was replaced', { cause: error }), { dshRemoteStreamFailure: { kind: 'carrier' } });
        throw localized(error);
      }
    } };
  };
  function readStream(endpoint, payload, requestSignal, uplink) {
    return { async *[Symbol.asyncIterator]() {
      const stop = new AbortController(), streamSignal = AbortSignal.any([active, stop.signal, ...requestSignal ? [requestSignal] : []]);
      let reader;
      // Native downlink methods provide an empty uplink queue. End it on
      // cancellation; methods that actually consume input require a duplex
      // carrier and are rejected by the Host before opening.
      try {
        const response = await send('dsh-session-hosts/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal: streamSignal,
          body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'stream', payload: { viewId, endpoint, payload } }) });
        if (!response.ok || !response.body) throw new Error('Session stream HTTP ' + response.status);
        reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
        for (;;) {
          const next = await reader.read(); buffer += decoder.decode(next.value, { stream: !next.done });
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
            const frame = JSON.parse(line);
            if (frame.type === 'item') yield frame.value;
            else if (frame.type === 'end') return;
            else if (frame.type === 'error') throw Object.assign(new Error(frame.error.message), frame.error, { isDSHRemoteError: true });
            else throw new Error('INVALID_STREAM_FRAME');
          }
          if (next.done) { if (!streamSignal.aborted) throw new Error('SESSION_STREAM_ENDED'); return; }
        }
      } catch (error) {
        if (error?.isDSHRemoteError) throw error;
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { dshRemoteStreamFailure: { kind: 'carrier' } });
      } finally { stop.abort(); await reader?.cancel().catch(() => {}); }
    } };
  }
  const unsubscribeRegistry = registry.subscribe?.(rememberEndpoints);
  connection.rpc.call = wrappedCall;
  connection.rpc.open = wrappedOpen;
  let disposed = false;
  return {
    get viewId() { return viewId; }, baseHost,
    mediaUrl(sessionId, path) { return new URL('dsh-session-hosts/media?' + new URLSearchParams({ viewId, sessionId, path }), document.baseURI).href; },
    get canRevealSavedFile() { return !!registry.get('session/openWorkspacePath'); },
    async revealSavedFile(path, signal) {
      const endpoint = 'session/openWorkspacePath';
      const requestSignal = AbortSignal.any([active, ...signal ? [signal] : [], AbortSignal.timeout(15000)]);
      requestSignal.throwIfAborted();
      if (!registry.get(endpoint) || typeof path !== 'string' || !path) throw new Error('Saved file location unavailable.');
      const request = { endpoint, payload: { args: { request: { path, action: 'reveal' } } } };
      if (baseHost === 'local') return viewCall('call', request, requestSignal);
      // A Desktop save returns a path on this computer, even when the open
      // Session or the original Remote target is elsewhere. Keep the native
      // reveal method and its path checks; use a short-lived local view only.
      const attached = await rpc('attach', { baseHost: 'local' }, requestSignal);
      if (!attached.ok) return attached;
      const localView = attached.value.viewId;
      if (typeof localView !== 'string' || !localView || localView === viewId) throw new Error('Local view unavailable.');
      try {
        if (attached.value.baseHost !== 'local') throw new Error('Local view unavailable.');
        requestSignal.throwIfAborted();
        return await rpc('call', { ...request, viewId: localView }, requestSignal);
      } finally { await rpc('close', { viewId: localView }, AbortSignal.timeout(5000)).catch(() => {}); }
    },
    previewOpen: (sessionId, url, leaseId, signal, options = {}) => viewCall('previewOpen', { sessionId, url, leaseId, fileMode: options.fileMode === true }, signal || active),
    previewFileClaim: (leaseId, actionId, signal) => viewCall('previewFileClaim', { leaseId, actionId }, signal || active),
    previewFiles: (leaseId, signal) => wrappedOpen('/api', '$previewFiles', { leaseId }, signal || active),
    previewClose: leaseId => viewCall('previewClose', { leaseId }, AbortSignal.timeout(5000)),
    modelCatalog: (sessionId, signal) => viewCall('modelCatalog', { sessionId }, signal || active),
    async *status(signal) {
      const statusSignal = AbortSignal.any([active, ...signal ? [signal] : []]);
      while (!statusSignal.aborted) {
        try { yield* wrappedOpen('/api', '$hostStatus', { args: {} }, statusSignal); }
        catch (error) { if (statusSignal.aborted) return; if (error?.isDSHRemoteError) throw error; }
        if (!statusSignal.aborted) await new Promise(resolve => {
          const done = () => { clearTimeout(timer); statusSignal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 500); statusSignal.addEventListener('abort', done, { once: true });
        });
      }
    },
    async postUpload(request) {
      const url = new URL(request.path, 'http://dsh.internal/');
      url.searchParams.set('viewId', viewId);
      const response = await send('dsh-session-hosts/upload?' + url.searchParams, { method: 'POST', headers: request.headers, body: request.body, credentials: 'same-origin', signal: AbortSignal.any([active, ...request.signal ? [request.signal] : []]), ...(request.body instanceof ReadableStream ? { duplex: 'half' } : {}) });
      if (request.body instanceof Blob) request.onProgress?.({ loaded: request.body.size, total: request.body.size });
      return { status: response.status, body: await response.text() };
    },
    async dispose() {
      if (disposed) return; disposed = true;
      unsubscribeRegistry?.();
      if (connection.rpc.call === wrappedCall) connection.rpc.call = originalCall;
      if (connection.rpc.open === wrappedOpen) {
        if (originalOpen === undefined) delete connection.rpc.open;
        else connection.rpc.open = originalOpen;
      }
      lifetime.abort(); streams?.dispose();
      await rpc('close', { viewId }, AbortSignal.timeout(5000)).catch(() => {});
    },
  };
}

    // Version-scoped native model-directory adapter. The original ModelDirectory
// instance, its store and both native menu entries are preserved. Only its
// previously Host-global catalog is rebound to the owning Session.
function installSessionModels(service, carrier, signal) {
  const original = service.directoryFor, catalogs = new Map();
  function ownerOf(sessionId) {
    if (!sessionId.startsWith('dsh-peer:')) return carrier.baseHost;
    const tuple = JSON.parse(sessionId.slice(9));
    return tuple[0];
  }
  function catalogFor(sessionId) {
    const hostId = ownerOf(sessionId);
    let catalog = catalogs.get(hostId);
    if (catalog) return catalog;
    let value = { value: null, status: 'idle', error: null }, inflight;
    const listeners = new Set();
    const publish = next => { value = next; for (const listener of listeners) listener(); };
    catalog = {
      store: { getSnapshot: () => value, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
      invalidate() { publish({ ...value, status: 'idle' }); },
      reasoningFor(selection) { return value.value?.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model)?.reasoning; },
      load() {
        if (value.status === 'ready') return Promise.resolve(value.value);
        if (inflight) return inflight;
        publish({ ...value, status: 'loading', error: null });
        inflight = carrier.modelCatalog(sessionId, signal).then(result => {
          if (!result.ok) throw new Error(result.error.message);
          signal?.throwIfAborted();
          publish({ value: result.value, status: 'ready', error: null }); return result.value;
        }).catch(error => { if (!signal?.aborted) publish({ ...value, status: 'error', error: error.message }); throw error; }).finally(() => { inflight = undefined; });
        return inflight;
      },
    };
    catalogs.set(hostId, catalog); return catalog;
  }
  const patched = new Map();
  const wrap = directory => {
    if (patched.has(directory)) return directory;
    if (!directory?.catalog?.store || typeof directory.syncInputs !== 'function' || !directory.sessionId) throw new Error('Native model directory version is unsupported');
    const previous = directory.catalog, next = catalogFor(directory.sessionId);
    directory.unsubscribeCatalog(); directory.catalog = next;
    directory.unsubscribeCatalog = next.store.subscribe(() => directory.syncInputs());
    directory.syncInputs();
    patched.set(directory, { previous, next });
    return directory;
  };
  for (const directory of service.live?.directories?.values || []) wrap(directory);
  function directoryFor(...args) { return wrap(original.apply(this, args)); }
  service.directoryFor = directoryFor;
  const dispose = () => {
    if (service.directoryFor === directoryFor) service.directoryFor = original;
    for (const [directory, { previous, next }] of patched) {
      if (directory.catalog !== next || directory.disposed) continue;
      directory.unsubscribeCatalog(); directory.catalog = previous;
      directory.unsubscribeCatalog = previous.store.subscribe(() => directory.syncInputs()); directory.syncInputs();
    }
    patched.clear(); catalogs.clear();
  };
  dispose.refresh = hostId => {
    for (const [owner, catalog] of catalogs) {
      if (hostId !== undefined && owner !== hostId) continue;
      catalog.invalidate(); void catalog.load().catch(() => {});
    }
  };
  return dispose;
}

    // Keep a bounded set of actually viewed native bindings. An extra native
// reference keeps the history stream current when Workspace navigation releases
// its mainView reference; it never starts an Agent or sends a prompt.
function installSessionResidency(sessions, { maxSessions = 12 } = {}) {
  const original = sessions.retain, held = new Map();
  function remember(target, id) {
    const existing = held.get(id);
    if (existing) { held.delete(id); held.set(id, existing); return; }
    const reference = original.call(sessions, target, { source: 'workspaceCache' });
    held.set(id, reference);
    void reference.ready.catch(() => {});
    while (held.size > maxSessions) {
      const [oldest, value] = held.entries().next().value;
      held.delete(oldest); value.release();
    }
  }
  function retain(target, options) {
    const reference = original.call(this, target, options);
    if (options?.source === 'mainView') remember(target, reference.sessionId);
    return reference;
  }
  // Keep the already selected binding when this plugin activates in-place.
  const initial = sessions.list.getSnapshot();
  for (const id of initial.ids) if (initial.byId[id]?.retainedBy?.mainView && sessions.binding(id)) remember(id, id);
  sessions.retain = retain;
  const unsubscribe = sessions.list.subscribe(() => {
    const current = sessions.list.getSnapshot();
    for (const [id, reference] of held) if (!current.byId[id]) {
      // A federated baseline can arrive before this Host's catalog. Missing
      // metadata does not end an existing Session; use its explicit removal.
      const binding = sessions.binding(id);
      if (!binding || binding.session.getSnapshot().removed) { held.delete(id); reference.release(); }
    }
  });
  return () => {
    if (sessions.retain === retain) sessions.retain = original;
    unsubscribe();
    const references = [...held.values()]; held.clear();
    for (const reference of references) reference.release();
  };
}

    function browserInputUrl(value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  const explicit = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed);
  try {
    if (explicit) return new URL(trimmed);
    // Remote's authorized loopback preview uses HTTP. Treat omitted schemes on
    // its loopback addresses accordingly; never downgrade explicit HTTPS.
    const localPage = new URL(`http://${trimmed}`);
    return loopbackHostname(localPage.hostname) ? localPage : new URL(`https://${trimmed}`);
  } catch { return undefined; }
}
function loopbackHostname(hostname) { return ['localhost', '127.0.0.1', '[::1]'].includes(hostname); }
function isLoopbackPage(value) {
  return loopbackHostname(browserInputUrl(value)?.hostname);
}

function previewErrorMessage(error, value, source, t) {
  const target = browserInputUrl(value);
  const key = { LOOPBACK_PORT_DENIED: 'previewPortDenied', LOOPBACK_UNAVAILABLE: 'previewServiceUnavailable' }[error?.code];
  if (key && target && t) return t(key, { computer: source || t('previewSourceComputer'), port: target.port || (target.protocol === 'https:' ? '443' : '80') });
  return error?.message || '远端网页打开失败，请检查连接和端口设置后重试。';
}

// Adapt only the native browser's injected commands, leaving its renderer,
// Electron page, partition, tab identities and navigation implementation intact.
function remoteBrowser(native, carrier, sessionId, { notify = () => {}, signal, t, sourceName = () => undefined } = {}) {
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
      const parsed = browserInputUrl(original);
      const target = loopbackHostname(parsed?.hostname) ? parsed : undefined;
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


// Keep the file address's Session even when a preview was opened in another
// pane. Decode the native address without URL-normalizing its path segments.
function sessionFileFromTab(tab) {
  if (typeof tab?.contentId !== 'string') return;
  const parts = /^dsh-resource:\/\/file\/session\/([^/?#]+)\/([^?#]+)/.exec(tab.contentId);
  if (!parts) return;
  try { return { sessionId: decodeURIComponent(parts[1]), path: parts[2].split('/').map(decodeURIComponent).join('/') }; } catch { /* Invalid resource address. */ }
}

// Menu callbacks keep the clicked Session. Never pass a remote path to this
// computer's native open/reveal APIs, including menus loaded before the plugin.
function installPeerMenuSafety(ctx, baseHost, openFile, fileActions, t) {
  const menus = ctx.contextMenus, original = menus.resolve, disposers = [];
  const remote = target => {
    const value = target?.value;
    const owner = target?.kind === 'tab' ? sessionFileFromTab(value?.tab)?.sessionId : undefined;
    const host = sessionHost(owner ?? value?.sessionId, baseHost);
    if (host !== undefined) return host !== 'local';
    if (target?.kind === 'workspace' && value?.workspaceId?.startsWith('dsh-peer:')) {
      try { return JSON.parse(value.workspaceId.slice(9))[0] !== 'local'; } catch { return false; }
    }
    return false;
  };
  // An image with only a URL uses the normal URL-based image actions, not a
  // workspace path. Leave those actions to their native owner.
  const unsafe = (id, target) => id.startsWith('open-in-app.') || (id.startsWith('file-actions.')
    && (target.kind !== 'image' || !!target.value.path));
  const filter = (items, target) => remote(target) ? items.filter(row => !unsafe(row.id, target)) : items;
  const resolve = target => {
    const native = original.call(menus, target);
    if (!remote(target)) return native;
    let previous, snapshot;
    return { ...native, source: { subscribe: native.source.subscribe.bind(native.source), getSnapshot: () => {
      const current = native.source.getSnapshot(); if (previous !== current) { previous = current; snapshot = filter(current, target); } return snapshot;
    } }, select(id) { if (!unsafe(id, target)) native.select(id); } };
  };
  menus.resolve = resolve;
  disposers.push(() => { if (menus.resolve === resolve) menus.resolve = original; });
  for (const kind of ['file', 'directory', 'image', 'url', 'workspace', 'tab']) disposers.push(menus.register({ id: 'peer-resource', target: kind, order: 100, resolve: value => {
    if (kind === 'tab') {
      const file = sessionFileFromTab(value.tab);
      return file && remote({ kind: 'file', value: file }) ? fileActions.menu(file.sessionId, file.path) : [];
    }
    if (!remote({ kind, value })) return [];
    const { sessionId, path, url, line } = value;
    if (!sessionId) return [{ id: 'remote-only', label: t('remoteApplication'), disabled: true }];
    if (kind === 'url') return [{ id: 'open', label: t('openSidebar'), run: () => ctx.sidebarRight.openTabIn(sessionId, 'browser', { params: { url } }) }, { id: 'copy', label: t('copyLink'), run: () => navigator.clipboard.writeText(url) }];
    if (typeof path !== 'string' || !path) return [];
    return [
      { id: 'open', label: t('openSidebar'), icon: { key: 'open-in-app.sidebar' }, run: () => openFile(sessionId, path, { line }) },
      ...(kind === 'file' || kind === 'image' ? fileActions.menu(sessionId, path) : []),
      { id: 'copy', label: t('copyRemotePath'), icon: { key: 'open-in-app.copy' }, run: () => navigator.clipboard.writeText(path) },
    ];
  } }));
  // The shortcut registry retains the original command objects. This narrow
  // version-scoped guard covers native application launch from the keyboard.
  const command = ctx.shortcuts?.registry?.commands?.get('workspace.openLocal');
  if (command) {
    const originalResolve = command.resolve;
    const guard = context => {
      const selected = Object.values(ctx.sessions.list.getSnapshot().byId).find(row => row.retainedBy?.mainView > 0);
      return selected && sessionHost(selected.sessionId, baseHost) !== 'local' ? { status: 'blocked', reason: t('remoteApplication') } : originalResolve(context);
    };
    command.resolve = guard; disposers.push(() => { if (command.resolve === guard) command.resolve = originalResolve; });
  }
  return { filter, remote, dispose() { for (const dispose of disposers.reverse()) dispose(); } };
}


function sessionHost(sessionId, baseHost) {
  if (typeof sessionId !== 'string') return undefined;
  if (!sessionId.startsWith('dsh-peer:')) return baseHost;
  try { const tuple = JSON.parse(sessionId.slice(9)); return Array.isArray(tuple) && tuple.length === 3 && tuple[1] === 'session' && tuple.every(part => typeof part === 'string' && part) ? tuple[0] : undefined; } catch { return undefined; }
}
function resolvePeerPath(base, path) {
  if (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path) || !base) return path;
  return base.replace(/[\\/]+$/, '') + '/' + path.replace(/^\.\//, '');
}
function peerFileAddress(sessionId, path) {
  const encode = value => encodeURIComponent(value).replaceAll('%3A', ':');
  return `dsh-resource://file/session/${encode(sessionId)}/${path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').split('/').map(encode).join('/')}`;
}
function peerDirectoryAddress(sessionId, path) { return `dsh-resource://peer-directory/session/${encodeURIComponent(sessionId)}/${encodeURIComponent(path)}`; }
function directoryPath(address) { const parts = new URL(address).pathname.split('/'); return decodeURIComponent(parts.slice(3).join('/')); }

function createPeerFileActions(ctx, carrier, signal, platform = () => globalThis.document?.documentElement?.dataset.platform) {
  const t = ctx.locale.bind('fileActions');
  const canSaveAs = () => ctx.fileActions.canSaveAs === true;
  async function save(sessionId, path, mode = 'download') {
    if (signal.aborted) return;
    const host = sessionHost(sessionId, carrier.baseHost);
    if (!sessionId || !host || host === 'local' || typeof path !== 'string' || !path) throw new Error(t('menu.saveFailed'));
    if (mode !== 'download' && !(mode === 'saveAs' && canSaveAs())) throw new Error(t('menu.saveFailed'));
    let result;
    try {
      result = await ctx.fileActions.save({
        name: path.split(/[\\/]/).at(-1),
        url: carrier.mediaUrl(sessionId, path),
        async read(readSignal) {
          const active = AbortSignal.any([signal, readSignal]);
          active.throwIfAborted();
          const source = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, active);
          active.throwIfAborted();
          if (!source.ok) throw Object.assign(new Error(source.error.message), source.error);
          // Keep the source extension and original bytes, including unknown types.
          return new Blob([source.value.data], { type: 'application/x-dsh-original' });
        },
      }, mode);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    if (signal.aborted || result.status === 'cancelled') return;
    if (result.status === 'requested') {
      ctx.contextMenus.notify(t('menu.downloadStarted'), true);
    } else if (result.status === 'saved') {
      const savedPath = result.path;
      const reveal = typeof savedPath === 'string' && savedPath && carrier.canRevealSavedFile ? {
        label: t(platform() === 'darwin' ? 'menu.finder' : 'menu.reveal'),
        failureLabel: t('path.revealError'),
        async run() {
          if (signal.aborted) return;
          const result = await carrier.revealSavedFile(savedPath, signal);
          if (!result.ok) throw new Error(t('path.revealError'));
        },
      } : undefined;
      ctx.contextMenus.notify(t(mode === 'download' ? 'menu.downloaded' : 'menu.saved'), true, reveal);
    }
  }
  function menu(sessionId, path) {
    const row = (mode, icon) => ({
      id: mode,
      label: t('menu.' + mode),
      icon: { key: 'file-actions.' + icon },
      failureLabel: t('menu.saveFailed'),
      run: () => save(sessionId, path, mode),
    });
    return [row('download', 'download'), ...(canSaveAs() ? [row('saveAs', 'save')] : [])];
  }
  return { save, menu };
}

// Version-scoped decorators on native entry Components. Inject caches and native
// service objects are untouched; already-bound entries receive the adaptation.
function installSessionResources(ctx, carrier, React, lifetime) {
  const stop = new AbortController(), signal = AbortSignal.any([lifetime, stop.signal]);
  const t = ctx.locale.bind('remoteWorkspaces'), patched = new Map(), disposers = [], browsers = new Map();
  const remote = id => { const host = sessionHost(id, carrier.baseHost); return host !== undefined && host !== 'local'; };
  const fileActions = createPeerFileActions(ctx, carrier, signal);
  const notify = message => ctx.contextMenus.notify(message);
  function PeerButton({ children, size: _size, variant: _variant, style, ...props }) {
    return React.createElement('button', { type: 'button', ...props, style: { color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6, padding: '4px 8px', font: 'inherit', cursor: props.disabled ? 'default' : 'pointer', opacity: props.disabled ? 0.5 : 1, ...style } }, children);
  }
  // Native Markdown elements retain their own provider and renderer. Decorate
  // the existing element props at the original component's output boundary;
  // no private Client package import or DOM scan is needed.
  function decorateMediaTree(node, id, base) {
    if (Array.isArray(node)) return node.map(child => decorateMediaTree(child, id, base));
    if (!React.isValidElement(node)) return node;
    const changes = {};
    if (node.props.fileImages) changes.fileImages = imageFace(id, base, node.props.fileImages);
    if (node.props.pathImages) {
      const previous = node.props.pathImages;
      changes.pathImages = { ...previous, resolve(value) {
        const resolved = previous.resolve(value);
        if (!resolved) return resolved;
        try { const path = new URL(resolved, document.baseURI).searchParams.get('path'); return path ? carrier.mediaUrl(id, path) : resolved; } catch { return undefined; }
      } };
    }
    if (node.props.children !== undefined) changes.children = decorateMediaTree(node.props.children, id, base);
    return Object.keys(changes).length ? React.cloneElement(node, changes) : node;
  }
  function nativeResult(Native, props) {
    if (typeof Native === 'function') return Native(props);
    if (typeof Native?.type === 'function') return Native.type(props);
    throw new Error('Unsupported native resource renderer');
  }
  const checked = async promise => { const result = await promise; if (!result.ok) throw Object.assign(new Error(result.error.message), result.error); return result.value; };
  const cwdOf = id => ctx.sessions.list.getSnapshot().byId[id]?.cwd;
  async function openFile(id, path, options) {
    const metadata = await ctx.remote.workspaceFiles.stat(id, path, signal);
    if (metadata.ok) { ctx.sidebarRight.openResourceIn(id, peerFileAddress(id, path), options?.line === undefined ? {} : { params: { line: options.line } }); return; }
    const directory = await ctx.remote.workspaceFiles.list(id, path, signal);
    if (directory.ok) { ctx.sidebarRight.openResourceIn(id, peerDirectoryAddress(id, path)); return; }
    throw new Error(metadata.error?.message || directory.error?.message || t('fileUnavailable'));
  }
  const imageFace = (id, base, previous = {}) => ({
    ...previous, fileDrag: previous.fileDrag || ctx.fileDrag.actions,
    resolve: path => carrier.mediaUrl(id, resolvePeerPath(base, path)),
    resourceAddress: path => peerFileAddress(id, resolvePeerPath(base, path)),
    labels: previous.labels || { open: t('imageOpen'), loading: t('connecting'), failed: t('fileUnavailable'), dialog: t('imageOpen'), close: t('close') },
  });
  function FileMenu({ sessionId, path, renderFactorySlot }) {
    if (!remote(sessionId) || !path || typeof renderFactorySlot !== 'function') return null;
    return renderFactorySlot('contextMenu.button', {
      target: { kind: 'file', value: { sessionId, path } }, label: t('fileMenu'), size: 'sm',
    });
  }
  function Directory(props) {
    const { tab } = props.useTabInfo(), path = directoryPath(tab.navigation.address);
    const [state, setState] = React.useState({ loading: true }), [revision, refresh] = React.useState(0);
    React.useEffect(() => {
      const stop = new AbortController(), active = AbortSignal.any([signal, tab.signal, stop.signal]);
      setState({ loading: true });
      void checked(ctx.remote.workspaceFiles.list(props.sessionId, path, active)).then(value => { if (!active.aborted) setState({ value }); }, error => { if (!active.aborted) setState({ error: error.message }); });
      return () => stop.abort();
    }, [path, tab.signal, props.sessionId, revision]);
    const visit = (child, isDirectory) => ctx.sidebarRight.openResourceIn(props.sessionId, isDirectory ? peerDirectoryAddress(props.sessionId, child) : peerFileAddress(props.sessionId, child));
    const root = cwdOf(props.sessionId)?.replaceAll('\\', '/').replace(/\/$/, ''), current = resolvePeerPath(root, path).replaceAll('\\', '/').replace(/\/$/, '');
    const parent = current.slice(0, current.lastIndexOf('/'));
    return React.createElement('section', { style: { padding: 16, overflow: 'auto', height: '100%' }, 'data-peer-directory': true },
      React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } },
        React.createElement('strong', { style: { flex: 1, overflowWrap: 'anywhere' } }, path),
        React.createElement(PeerButton, { size: 'sm', variant: 'ghost', disabled: state.loading, onClick: () => refresh(value => value + 1) }, t('retry'))),
      root && current !== root && current.startsWith(root + '/') && React.createElement(PeerButton, { size: 'sm', variant: 'ghost', onClick: () => visit(parent, true) }, t('parentDirectory')),
      state.loading ? React.createElement('p', { role: 'status' }, t('connecting')) : state.error ? React.createElement('p', { role: 'alert' }, state.error) :
        React.createElement('div', null, ...(state.value?.entries || []).map(item => React.createElement('div', { key: item.name, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' } },
          React.createElement(PeerButton, { size: 'sm', variant: 'ghost', onClick: () => visit(resolvePeerPath(current, item.name), item.type === 'directory'), style: { justifyContent: 'flex-start', flex: 1 } }, (item.type === 'directory' ? '📁 ' : '📄 ') + item.name),
          item.type === 'file' && React.createElement(FileMenu, { sessionId: props.sessionId, path: resolvePeerPath(current, item.name), renderFactorySlot: props.renderFactorySlot }))),
        state.value?.truncated && React.createElement('p', { role: 'status' }, t('directoryTruncated'))));
  }
  const directoryProviderId = '@local/dsh-remote-enhanced/directory';
  disposers.push(ctx.sidebarRightTabs.register({ id: directoryProviderId, kind: 'peerDirectory', patterns: ['dsh-resource://peer-directory/**'], priority: 'extension', title: address => directoryPath(address).split(/[\\/]/).filter(Boolean).at(-1) || t('directory') }));
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: directoryProviderId }, Directory)));
  const watch = (name, decorate) => {
    const reconcile = () => { for (const entry of ctx.slots.entries(name)) {
      if (patched.has(entry) || typeof entry.component !== 'function' && typeof entry.component !== 'object') continue;
      const Native = entry.component, Wrapper = decorate(entry, Native); if (!Wrapper) continue;
      entry.component = Wrapper; patched.set(entry, { Native, Wrapper });
    } };
    disposers.push(ctx.slots.inject(name, () => { reconcile(); return ctx.slots.subscribe(name, reconcile); }));
  };
  watch('conversation.view', (entry, Native) => entry.children?.['conversation.chat.flow'] ? function ResourceChat(props) {
    const open = React.useCallback((path, options) => remote(props.sessionId) ? openFile(props.sessionId, path, options) : props.openFile(path, options), [props.sessionId, props.openFile]);
    const external = React.useCallback(url => {
      if (remote(props.sessionId) && isLoopbackPage(url)) ctx.sidebarRight.openTabIn(props.sessionId, 'browser', { params: { url } });
      else props.openExternalLink(url);
    }, [props.sessionId, props.openExternalLink]);
    const result = nativeResult(Native, { ...props, openFile: open, openExternalLink: external });
    return remote(props.sessionId) ? decorateMediaTree(result, props.sessionId, cwdOf(props.sessionId)) : result;
  } : undefined);
  watch('sidebar.right.tab.document', (entry, Native) => String(entry.options.key).endsWith('/markdown') ? function PeerMarkdown(props) {
    const result = nativeResult(Native, props);
    return remote(props.sessionId) ? decorateMediaTree(result, props.sessionId, cwdOf(props.sessionId)) : result;
  } : undefined);
  const documentActions = 'sidebar.right.tab.document.actions', unpreviewable = 'sidebar.right.tab.document.unpreviewable';
  for (const seat of [documentActions, unpreviewable, 'sidebar.right.tab.files.actions', 'deliverables.file.actions', 'deliverables.review.file.actions']) {
    watch(seat, (entry, Native) => entry.options.id === 'open-in-app' || entry.registrant === '@deepseek-ai/dsh-client-ui-open-in-app' ? function PeerActions(props) {
      return remote(props.sessionId) || remote(props.peerFileOwner) ? null : React.createElement(Native, props);
    } : undefined);
  }
  watch('sidebar.right.pane.tab', (entry, Native) => entry.options.key === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' ? function PeerDocument(props) {
    const { tab } = props.useTabInfo();
    const file = sessionFileFromTab(tab);
    if (!file) return React.createElement(Native, props);
    const peerFile = remote(file.sessionId);
    // Keep the menu with the file's address, even if a different Session owns the pane.
    const renderSlot = (name, input, ...rest) => {
      if (name !== documentActions && name !== unpreviewable) return props.renderSlot(name, input, ...rest);
      const original = props.renderSlot(name, { ...input, peerFileOwner: file.sessionId }, ...rest);
      return name === documentActions ? React.createElement(React.Fragment, null, original, React.createElement(FileMenu, {
        ...file, renderFactorySlot: props.renderFactorySlot,
      })) : original;
    };
    const useContextMenu = () => {
      const menu = props.useContextMenu();
      return { ...menu, getTriggerProps: (target, handlers) => menu.getTriggerProps(target?.kind === 'file'
        ? { ...target, value: { ...target.value, ...file } } : target, handlers) };
    };
    return React.createElement(Native, {
      ...props, renderSlot: peerFile ? renderSlot : props.renderSlot,
      useContextMenu: file.sessionId === props.sessionId ? props.useContextMenu : useContextMenu,
    });
  } : undefined);
  function BrowserFiles({ adapter, useTabInfo, useBrowserState, sessionId }) {
    const { tab } = useTabInfo();
    // The panel and native body each subscribe in their own normal Hook order.
    // A native committed navigation must also refresh the panel's source label.
    useBrowserState(tab.id);
    const state = adapter.fileState(tab.id);
    if (!state.available && !state.enabled) return null;
    const workspace = ctx.workspaces?.list.getSnapshot().items.find(row => row.sessionIds.includes(sessionId));
    const act = mode => { void adapter.consumeFile(tab.id, mode, ({ sessionId: owner, path, kind }) => mode === 'download'
      ? fileActions.save(owner, path, ctx.fileActions.canSaveAs ? 'saveAs' : 'download')
      : kind === 'folder' ? ctx.sidebarRight.openResourceIn(owner, peerDirectoryAddress(owner, path)) : openFile(owner, path)); };
    return React.createElement('section', { 'aria-label': t('mapFiles'), 'aria-busy': !!state.busy, style: { padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-base)', flexShrink: 0, font: 'inherit', color: 'var(--dsw-alias-label-primary)' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
        React.createElement('span', { style: { flex: 1 } }, t('mapFiles')),
        React.createElement(PeerButton, { disabled: state.busy || !state.enabled && !state.available, 'aria-pressed': state.enabled && state.active, onClick: () => { void adapter.setFileMode(tab.id, !state.enabled); } }, t(state.enabled ? 'mapFilesDisable' : 'mapFilesEnable'))),
      React.createElement('p', { style: { margin: '4px 0', fontSize: '0.85em', opacity: 0.8 } }, t(state.enabled ? 'mapFilesHint' : 'mapFilesOffHint')),
      state.busy && React.createElement('p', { role: 'status', style: { margin: '4px 0' } }, t('connecting')),
      state.enabled && !state.active && !state.busy && React.createElement(PeerButton, { onClick: () => adapter.resumeFiles(tab.id) }, t('mapFilesResume')),
      state.error && React.createElement('p', { role: 'alert', style: { margin: '6px 0', overflowWrap: 'anywhere' } }, state.error),
      state.pending && React.createElement('div', { role: 'group', 'aria-live': 'polite', 'aria-label': t('mapFilesConfirm'), style: { marginTop: 8 } },
        React.createElement('div', null, t('mapFilesSource') + ' ' + (workspace?.title || sessionHost(sessionId, carrier.baseHost)) + ' · ' + (ctx.sessions.list.getSnapshot().byId[sessionId]?.title || t('mapFilesCurrentSession'))),
        React.createElement('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '6em', overflow: 'auto', margin: '6px 0', userSelect: 'text' } }, state.pending.path),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          React.createElement(PeerButton, { disabled: state.busy, onClick: () => act('preview') }, t(state.pending.kind === 'folder' ? 'mapFilesFolder' : 'mapFilesPreview')),
          state.pending.kind === 'file' && React.createElement(PeerButton, { disabled: state.busy, onClick: () => act('download') }, t('download')),
          React.createElement(PeerButton, { disabled: state.busy, onClick: () => act('cancel') }, t('cancel')))));
  }
  watch('sidebar.right.pane.tab', (entry, Native) => entry.options.key === '@deepseek-ai/dsh-client-ui-sidebar-browser' ? function PeerBrowser(props) {
    const key = props.sessionId;
    const adapter = React.useMemo(() => {
      if (!remote(props.sessionId)) return undefined;
      let value = browsers.get(key);
      if (!value) {
        value = remoteBrowser(props, carrier, props.sessionId, { signal, notify, t, sourceName: () => ctx.workspaces?.list.getSnapshot().items.find(row => row.sessionIds.includes(key))?.title }); browsers.set(key, value);
      }
      return value;
    }, [key]);
    adapter?.bindActions(props.actions);
    const useBrowserState = React.useMemo(() => adapter ? id => {
      // The native keyed source is bound by the child slot. Read it here, in
      // that child's normal Hook order, rather than duplicating its binding in
      // the outer decorator; layout-effect forwarding can stall the toolbar.
      const nativeState = props.useBrowserState(id);
      const source = adapter.keyedHooks.browserState(id);
      const overlay = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
      return adapter.displayState(id, nativeState, overlay);
    } : props.useBrowserState, [adapter, props.useBrowserState]);
    if (!adapter) return React.createElement(Native, props);
    return React.createElement('div', { style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', color: 'inherit' } },
      React.createElement(BrowserFiles, { adapter, useTabInfo: props.useTabInfo, useBrowserState, sessionId: props.sessionId }),
      React.createElement('div', { style: { flex: 1, minHeight: 0, position: 'relative' } }, React.createElement(Native, { ...props, mount: adapter.mount, loadUrl: adapter.loadUrl, restore: adapter.restore, reload: adapter.reload, goBack: adapter.goBack, goForward: adapter.goForward, useBrowserState })));
  } : undefined);
  const menuSafety = installPeerMenuSafety(ctx, carrier.baseHost, openFile, fileActions, t);
  disposers.push(() => menuSafety.dispose());
  watch('shell.overlay', (entry, Native) => entry.options.id === 'context-menu' ? function PeerMenuOverlay(props) {
    const cache = React.useRef();
    const useStore = (selector, equal) => props.useStore(state => {
      const held = cache.current;
      if (!held || held.state !== state) cache.current = { state, value: { ...state, items: menuSafety.filter(state.items, state.target) } };
      return selector(cache.current.value);
    }, equal);
    return React.createElement(Native, { ...props, useStore });
  } : undefined);
  return async () => {
    stop.abort();
    for (const dispose of disposers.reverse()) dispose();
    for (const [entry, saved] of patched) if (entry.component === saved.Wrapper) entry.component = saved.Native;
    patched.clear(); await Promise.all([...browsers.values()].map(browser => browser.dispose())); browsers.clear();
  };
}

    return {
      inject: ['connection', 'typert', 'remote', 'slots', 'sessions', 'workspaces', 'locale', 'fileUpload', 'modelDirectories'],
      async apply(ctx) {
        if (!ctx.connection.isLoopback) return;
        const stop = new AbortController();
        ctx.effect(() => ctx.locale.register('remoteWorkspaces', dictionaries), 'remote-workspaces: dictionaries');
        ctx.effect(() => () => stop.abort(), 'remote-workspaces: lifetime');
        // One existing Controller remains authoritative for every native view.
        // Attach first: a failed handshake cannot alter any original service.
        const carrier = await installSessionCarrier(ctx, { signal: stop.signal });
        if (stop.signal.aborted) { await carrier.dispose(); return; }
        ctx.effect(() => async () => {
          await carrier.dispose();
          ctx.connection.reconnect();
        }, 'remote-workspaces: native request carrier');
        ctx.effect(() => installSessionResidency(ctx.sessions), 'remote-workspaces: recently viewed sessions');
        const models = installSessionModels(ctx.modelDirectories, carrier, stop.signal);
        ctx.effect(() => models, 'remote-workspaces: session model catalogs');
        // Optional resource surfaces are composed by their original packages.
        ctx.inject(['remote.workspaceFiles', 'sidebarRight', 'sidebarRightTabs', 'resources', 'contextMenus', 'fileActions', 'fileDrag', 'shortcuts'], resourceCtx => {
          resourceCtx.effect(() => installSessionResources(resourceCtx, carrier, React, stop.signal), 'remote-workspaces: session resources');
        });
        for (const event of ['llm/adapters-updated', 'llm/models-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated']) ctx.remote.$on(event, () => models.refresh());
        const upload = ctx.fileUpload, originalPost = upload.post;
        const post = request => carrier.postUpload(request);
        upload.post = post;
        ctx.effect(() => () => { if (upload.post === post) upload.post = originalPost; }, 'remote-workspaces: session attachments');
        // Preserve the native folder component and every action. Only avoid
        // path-tree grouping, which would nest identically named computers.
        const entries = new Map();
        function reconcile() {
          for (const entry of ctx.slots.entries('sidebar.workspaces')) {
            if (entries.has(entry) || !entry.children?.['sidebar.workspaces.directoryFlow'] || typeof entry.component !== 'function') continue;
            const Native = entry.component;
            function WorkspacePeers(props) {
              const useStore = (selector, equal) => props.useStore(value => selector(value.groupBy === 'workspace-tree' ? { ...value, groupBy: 'workspace' } : value), equal);
              return React.createElement(Native, { ...props, useStore });
            }
            entry.component = WorkspacePeers;
            entries.set(entry, { original: Native, wrapper: WorkspacePeers });
          }
        }
        ctx.slots.inject('sidebar.workspaces', () => {
          reconcile();
          const unsubscribe = ctx.slots.subscribe('sidebar.workspaces', reconcile);
          return () => {
            unsubscribe();
            for (const [entry, saved] of entries) if (entry.component === saved.wrapper) entry.component = saved.original;
            entries.clear();
          };
        });
        // Version-scoped migration of already-open native logical streams. The
        // native supervisors replace their carriers while preserving bindings.
        ctx.connection.reconnect();
        ctx.remote.streams?.reconnect();
        for (const session of ctx.sessions.manager?.sessions?.values() || []) {
          if (session.events) session.events.restart();
        }
        // A recovered Host replaces only its own history generations. Native
        // bindings, renderer state and drafts remain resident.
        void (async () => {
          const offline = new Set();
          try {
            for await (const status of carrier.status(stop.signal)) {
              if (!status.online) { offline.add(status.hostId); continue; }
              if (status.catalogChanged) { models.refresh(status.hostId); continue; }
              if (!offline.delete(status.hostId)) continue;
              models.refresh(status.hostId);
              for (const session of ctx.sessions.manager?.sessions?.values() || []) {
                const id = session.sessionId;
                let hostId = carrier.baseHost;
                if (id.startsWith('dsh-peer:')) { try { hostId = JSON.parse(id.slice(9))[0]; } catch { continue; } }
                if (hostId === status.hostId) void session.resync().catch(error => console.error('[remote-workspaces] Session recovery failed', error));
              }
              await ctx.sessions.refresh();
            }
          } catch (error) { if (!stop.signal.aborted) console.error('[remote-workspaces] Host status stream failed', error); }
        })();
      },
    };
  },
});
