// Isolated installed-native acceptance. Two synthetic Hosts, no user sessions,
// no real prompts, no GUI or profile changes. Exercises migration from native
// WebSocket mux to the plugin mux, generated codecs, recovery and live models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const { once } = require('node:events');
(async () => {
  const r = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const load = name => import(pathToFileURL(r.resolve(name)).href);
  const { Context } = r('@deepseek-ai/cordis');
  const { WebSocketServer, WebSocket } = r('ws');
  const connection = await load('@deepseek-ai/dsh-client-connection/client');
  const api = await load('@deepseek-ai/dsh-api-gateway/client');
  const { TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry');
  const { registerFederatedRoute } = await import('../federated-route.js');
  const { installSessionCarrier } = await import('../client-carrier.js');
  const { installSessionModels } = await import('../client-models.js');
  const remotes = [];
  for (const name of ['dsh-api-session-controller', 'dsh-api-workspace-controller', 'dsh-commands', 'dsh-subagent']) remotes.push((await load('@deepseek-ai/' + name + '/remote')).default);
  const descriptors = new Map(remotes.flatMap(row => row.descriptors.map(d => [d.namespace + '/' + d.method, d])));
  const calls = [], sockets = [], ownerStop = new AbortController();
  const owner = { principal: { kind: 'owner' }, signal: ownerStop.signal };
  let remoteOnline = true, remoteGeneration = 0, catalogFailures = 0, lateCatalog = false;
  const drops = new Set();
  const raw = hostId => ({
    async call(endpoint, payload) {
      calls.push([hostId, endpoint, payload]);
      if (hostId === 'remote' && !remoteOnline) throw new Error('HOST_OFFLINE');
      if (endpoint === 'session/list') {
        if (hostId === 'remote' && catalogFailures > 0) { catalogFailures--; throw new Error('synthetic initial catalog read failure'); }
        const items = [{ sessionId: 'same', updatedAt: 1, running: false, blank: false, agentAvailable: true }];
        if (hostId === 'remote' && lateCatalog) items.push({ sessionId: 'late', updatedAt: 2, running: false, blank: false, agentAvailable: true, projections: { kind: 'cached', asOfSeq: -1, values: { title: 'Late remote Session' } } });
        return { ok: true, value: { items } };
      }
      if (endpoint === 'session/modelCatalog') return { ok: true, value: { groups: [{ id: hostId, name: hostId, models: [{ id: 'm', name: hostId + ' model' }] }], failures: [] } };
      return { ok: true, value: undefined };
    },
    async open(endpoint, payload, signal) { return (async function* () {
      calls.push([hostId, endpoint, payload]);
      if (hostId === 'remote' && !remoteOnline) throw new Error('HOST_OFFLINE');
      let close;
      const ended = new Promise(resolve => { close = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      if (hostId === 'remote') drops.add(close);
      try {
        if (endpoint === '$events') yield { type: 'ready', clientId: 'c-' + hostId + '-' + remoteGeneration, host: { home: 'C:/' } };
        else if (endpoint === 'session/follow') yield { type: 'snapshot', header: { id: 'same', version: 3, createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } };
        else if (endpoint === 'session/control') yield { type: 'baseline', value: { projections: {} } };
        else if (endpoint === 'workspace/follow') yield { type: 'baseline', value: { items: [{ workspaceId: 'w', title: 'Desktop', path: 'C:/Desktop', sessionIds: ['same', ...hostId === 'remote' && lateCatalog ? ['late'] : []] }], archivedSessionIds: [], pinnedSessionIds: [] } };
        await ended;
        if (!signal.aborted && hostId === 'remote') throw new Error('synthetic remote disconnect');
      } finally { signal.removeEventListener('abort', close); drops.delete(close); }
    })(); },
  });
  const host = new Context(), routes = new Map(), upgrades = new Map();
  host.connection = { admit: () => ({ peer: owner }) };
  host.webServer = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); }, registerUpgrade(route) { upgrades.set(route.path, route); return () => upgrades.delete(route.path); } };
  let inspectViews;
  const hostFiber = host.plugin({ apply(ctx) { inspectViews = registerFederatedRoute(ctx, { WebSocketServer, baseHost: () => 'remote', local: () => raw('local'), hosts: async () => [{ hostId: 'remote', name: 'Remote-PC', online: remoteOnline }], channels: { async retain() { return { ...raw('remote'), release: async () => {} }; } }, descriptor: endpoint => descriptors.get(endpoint) }); } });
  await hostFiber.inertia; assert.equal(hostFiber.state, 2);
  const server = createServer((req, res) => {
    const route = [...routes.values()].find(row => req.url.startsWith(row.path + '/'));
    if (route) void route.handler(req, res).catch(error => res.destroy(error));
    else {
      const endpoint = new URL(req.url, 'http://test').pathname.slice(5); let body = '';
      req.on('data', chunk => body += chunk); req.on('end', async () => {
        try { const m = JSON.parse(body), result = await raw('remote').call(endpoint, m.payload); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: m.rpcId, result })); }
        catch (error) { res.destroy(error); }
      });
    }
  });
  // The original installed Gateway client speaks its real native mux protocol.
  const original = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const route = upgrades.get(new URL(req.url, 'http://test').pathname);
    if (route) { route.handler(req, socket, head); return; }
    original.handleUpgrade(req, socket, head, ws => {
      const streams = new Map();
      ws.on('message', bytes => {
        const m = JSON.parse(bytes);
        if (m.type === 'cancel') { streams.get(m.streamId)?.abort(); return; }
        if (m.type !== 'open') return;
        const stop = new AbortController(); streams.set(m.streamId, stop);
        void (async () => { try { for await (const value of await raw('remote').open(m.endpoint, m.payload, stop.signal)) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'item', streamId: m.streamId, value })); } finally { streams.delete(m.streamId); } })();
      });
      ws.once('close', () => { for (const control of streams.values()) control.abort(); });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const ctx = new Context(); const fibers = [];
  const keepAlive = setInterval(() => {}, 1000);
  let carrier, undoModels, clientEntry;
  const store = { createSnapshotStore(initial) { let value = initial; const listeners = new Set(); return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of listeners) fn(); }, update(fn) { const next = { ...value }; fn(next); this.set(next); } }; }, notifySubscribers(listeners) { for (const fn of [...listeners]) fn(); } };
  function browserModule(name, modules) {
    let factory;
    vm.runInNewContext(fs.readFileSync(r.resolve(name + '/client'), 'utf8'), { window: { __ModuleLoader__: { load(row) { factory = row.factory; } } }, console, queueMicrotask, AbortController, AbortSignal, setTimeout, clearTimeout, Symbol, Promise, crypto: require('node:crypto').webcrypto });
    return factory(id => modules[id] || (() => { throw new Error('Unexpected module ' + id); })());
  }
  // UI exports are never rendered; this test exercises the installed model service only.
  const modules = { 'react': {}, 'react/jsx-runtime': {}, 'react-dom': {}, '@deepseek-ai/cordis': r('@deepseek-ai/cordis'), '@deepseek-ai/dsh-api-gateway/client': api, '@deepseek-ai/dsh-client-store': store };
  let phase = 'setup';
  const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native mux timed out: ' + phase)), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  const wait = async predicate => {
    const until = Date.now() + 4000;
    while (!predicate()) { if (Date.now() > until) throw new Error('Native mux acceptance timed out: ' + phase); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  try {
    const setup = ctx.plugin({ apply(scope) { connection.installConnection(scope, { interactions: 'answer', transport: { fetch: (url, init) => fetch(new URL(url, base), init), streamBaseUrl: base, createWebSocket(url) { sockets.push(url); return new WebSocket(url); } } }); new TypertRegistry(scope); scope.provide('fileUpload', {}); } }); fibers.push(setup); await setup.inertia; assert.equal(setup.state, 2);
    const apiFiber = ctx.plugin(api); fibers.push(apiFiber); await apiFiber.inertia;
    for (const remote of remotes) await ctx.get('remote').$mount(remote);
    const sessionFiber = ctx.plugin(browserModule('@deepseek-ai/dsh-api-session-controller', modules)); fibers.push(sessionFiber); await sessionFiber.inertia; assert.equal(sessionFiber.state, 2);
    const workspaceFiber = ctx.plugin(browserModule('@deepseek-ai/dsh-api-workspace-controller', modules)); fibers.push(workspaceFiber); await workspaceFiber.inertia; assert.equal(workspaceFiber.state, 2);
    const sessions = ctx.get('sessions'); await sessions.refresh();
    const before = sessions.retain('same', { source: 'mainView' }); await before.ready;
    const binding = before.binding;
    assert.ok(sockets.some(url => url.includes('/api/remote.mux')));
    const models = browserModule('@deepseek-ai/dsh-client-ui-model-selection', { ...modules, '@deepseek-ai/dsh-client-ui-primitives': {}, '@deepseek-ai/dsh-util-values': r('@deepseek-ai/dsh-util-values') });
    const modelFiber = ctx.plugin(models.ModelDirectoryResolver); fibers.push(modelFiber); await modelFiber.inertia; assert.equal(modelFiber.state, 2);
    const uiSetup = ctx.plugin({ apply(scope) {
      scope.provide('slots', { entries: () => [], inject(_key, factory) { scope.effect(factory); }, subscribe: () => () => {} });
      scope.provide('locale', { register: () => () => {}, bind: () => key => key });
    } }); fibers.push(uiSetup); await uiSetup.inertia;
    // Execute the generated production client entry, including its recovery
    // listener. Only transport URLs and empty UI slots are synthetic.
    // Keep the first aggregate responses local-only: the initial remote
    // reference must survive until catalog recovery publishes its row.
    catalogFailures = 2;
    let factory;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native-client.js'), 'utf8'), { window: { __ModuleLoader__: { load(row) { factory = row.factory; } } }, console, queueMicrotask, AbortController, AbortSignal, setTimeout, clearTimeout, Symbol, Promise, crypto: require('node:crypto').webcrypto, fetch: (url, init) => fetch(new URL(url, base), init), TextDecoder, URL, Blob, ReadableStream, JSON, Object, Error });
    clientEntry = ctx.plugin(factory(id => modules[id] || (() => { throw new Error('Unexpected client module ' + id); })()));
    phase = 'production client activation'; await bounded(clientEntry.inertia); assert.equal(clientEntry.state, 2);
    phase = 'native workspace migration';
    await sessions.refresh();
    await wait(() => ctx.get('workspaces').list.getSnapshot().items.length === 2);
    assert.deepEqual(Array.from(ctx.get('workspaces').list.getSnapshot().items, row => row.title), ['Desktop', 'Desktop（Remote-PC）']);
    const localId = 'dsh-peer:' + JSON.stringify(['local', 'session', 'same']);
    const local = sessions.retain(localId, { source: 'mainView' }); await local.ready;
    assert.equal(sessions.binding('same'), binding);
    await wait(() => calls.filter(row => row[0] === 'remote' && row[1] === 'session/follow').length >= 2);
    const a = ctx.get('modelDirectories').directoryFor('same'), b = ctx.get('modelDirectories').directoryFor(localId);
    await Promise.all([a.load(), b.load()]);
    assert.equal(a.store.getSnapshot().groups[0].id, 'remote'); assert.equal(b.store.getSnapshot().groups[0].id, 'local');
    const localFollowCount = () => calls.filter(row => row[0] === 'local' && row[1] === 'session/follow').length;
    const localCount = localFollowCount();
    remoteOnline = false; for (const drop of drops) drop();
    await wait(() => binding.session.getSnapshot().openError !== null);
    assert.equal(local.binding.session.getSnapshot().openError, null);
    remoteOnline = true; remoteGeneration++;
    await wait(() => binding.session.getSnapshot().openState === 'open');
    assert.equal(sessions.binding('same'), binding);
    assert.equal(localFollowCount(), localCount);
    assert.equal(binding.session.getSnapshot().openError, null);
    assert.ok(sockets.some(url => url.includes('/dsh-session-hosts/mux')));
    phase = 'resident session return without reloading';
    const remoteCount = calls.filter(row => row[0] === 'remote' && row[1] === 'session/follow').length;
    local.release(); before.release();
    const returned = sessions.retain('same', { source: 'mainView' }); await returned.ready;
    assert.ok(returned.binding === binding, 'a cold or delayed catalog must not retire the recently viewed native binding');
    assert.equal(calls.filter(row => row[0] === 'remote' && row[1] === 'session/follow').length, remoteCount);
    returned.release();
    phase = 'late remote catalog recovery through installed native events';
    lateCatalog = true; catalogFailures = 2;
    for (const drop of drops) drop();
    await wait(() => sessions.list.getSnapshot().byId.late?.displayTitle === 'Late remote Session');
    assert.ok(ctx.get('workspaces').list.getSnapshot().items.find(row => row.title === 'Desktop（Remote-PC）').sessionIds.includes('late'));
    assert.equal(catalogFailures, 0);
    const catalogState = inspectViews().flatMap(view => view.hosts).find(row => row.hostId === 'remote');
    assert.equal(catalogState.catalogReady, true); assert.equal(catalogState.rows, 2);
    assert.equal(catalogState.eventReady, true);
    assert.doesNotMatch(JSON.stringify(inspectViews()), /Late remote Session|sessionId|viewId|\"late\"/);
    phase = 'idle browser view eviction and native reconnect';
    const beforeEviction = binding;
    const muxUrl = sockets.filter(url => url.includes('/dsh-session-hosts/mux')).at(-1);
    const expiredViewId = new URL(muxUrl).searchParams.get('viewId');
    const evict = await fetch(base + 'dsh-session-hosts/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'synthetic-expiry', method: 'close', payload: { viewId: expiredViewId } }) });
    assert.equal((await evict.json()).result.ok, true);
    await wait(() => sockets.filter(url => url.includes('/dsh-session-hosts/mux')).some(url => new URL(url).searchParams.get('viewId') !== expiredViewId));
    await wait(() => ctx.get('connection').state.getSnapshot() === 'connected');
    await wait(() => beforeEviction.session.getSnapshot().openState === 'open');
    assert.equal(sessions.binding('same'), beforeEviction);
    await a.catalog.load();
    const retainedAcrossReload = sessions.retain('same', { source: 'mainView' }); await retainedAcrossReload.ready;
    phase = 'production client unload';
    await bounded(clientEntry.dispose());
    phase = 'production client reactivation';
    clientEntry = ctx.plugin(factory(id => modules[id] || (() => { throw new Error('Unexpected client module ' + id); })()));
    await bounded(clientEntry.inertia);
    phase = 'reactivated workspace follow';
    await wait(() => inspectViews().flatMap(view => view.hosts).some(row => row.hostId === 'remote' && row.workspaceRows === 1));
    assert.equal(sessions.binding('same'), beforeEviction);
    retainedAcrossReload.release();
    console.log('PASS installed native migration, resident return, model isolation, remote-only history recovery, evicted browser-view reconnect and plugin reactivation');
  } catch (error) {
    console.error('Native mux failure phase:', phase, error?.stack || error?.message || String(error)); throw error;
  } finally {
    await bounded(clientEntry?.dispose());
    undoModels?.();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    await carrier?.dispose(); ownerStop.abort(); clearInterval(keepAlive);
    await hostFiber.dispose();
    for (const socket of original.clients) socket.terminate(); await new Promise(resolve => original.close(resolve));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
