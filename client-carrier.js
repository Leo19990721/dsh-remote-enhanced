import { SessionStreams } from './client-streams.js';

// Browser-side native Connection adapter. All existing generated APIs and
// native stores keep their objects; only the physical carrier is different.
export async function installSessionCarrier(ctx, { fetch: send = globalThis.fetch, signal } = {}) {
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
