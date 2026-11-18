// Installed-native-stack integration, synthetic Hosts only. This test never
// contacts Remote, reads user history, sends a real prompt or controls the GUI.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
(async () => {
  const r = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const load = name => import(pathToFileURL(r.resolve(name)).href);
  const { Context } = r('@deepseek-ai/cordis');
  const connection = await load('@deepseek-ai/dsh-client-connection/client');
  const api = await load('@deepseek-ai/dsh-api-gateway/client');
  const { TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry');
  const { FederatedGateway } = await import('../federated-gateway.js');
  const { installSessionCarrier } = await import('../client-carrier.js');
  const remotes = [];
  for (const name of ['dsh-api-session-controller', 'dsh-commands', 'dsh-subagent', 'dsh-agent-preset-registry']) remotes.push((await load('@deepseek-ai/' + name + '/remote')).default);
  const descriptors = new Map(remotes.flatMap(row => row.descriptors.map(d => [d.namespace + '/' + d.method, d])));
  const calls = [], owner = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const raw = hostId => ({
    async call(endpoint, payload) {
      calls.push([hostId, endpoint, payload]);
      if (endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 'same', updatedAt: 1, running: false, blank: false, agentAvailable: true }] } };
      if (endpoint === 'session/prompt') return { ok: true, value: { accepted: true } };
      if (endpoint === 'agentPresets/select') return { ok: true, value: payload.args.agentPreset };
      if (endpoint === 'agentPresets/list') return { ok: true, value: { presets: [{ id: hostId, isDefault: true }] } };
      return { ok: true, value: { matched: true } };
    },
    async open(endpoint, payload, signal) { return (async function* () {
      calls.push([hostId, endpoint, payload]);
      if (endpoint === '$events') yield { type: 'ready', clientId: 'c-' + hostId, host: { home: 'C:/' } };
      else if (endpoint === 'session/follow') yield { type: 'snapshot', header: { id: 'same', version: 3, createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } };
      else if (endpoint === 'session/control') yield { type: 'baseline', value: { projections: {} } };
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    })(); },
  });
  const gateway = new FederatedGateway({ baseHost: 'remote', local: () => raw('local'), hosts: async () => [{ hostId: 'remote', name: 'Remote-PC', online: true }], channels: { async retain(id) { return { ...raw(id), release: async () => {} }; } }, descriptor: id => descriptors.get(id) });
  const originalRpc = {
    async call(channel, action, payload, signal) {
      if (channel === '/api') return raw('remote').call(action, payload, signal);
      if (action === 'attach') return { ok: true, value: { viewId: 'test', baseHost: 'remote' } };
      if (action === 'call') return gateway.call(payload.endpoint, payload.payload, signal, owner);
      return { ok: true };
    },
    open(_channel, endpoint, payload, signal) { return (async function* () { yield* await raw('remote').open(endpoint, payload, signal); })(); },
  };
  const ctx = new Context();
  let carrier;
  const setup = ctx.plugin({ apply(scope) { connection.installConnection(scope, { interactions: 'answer', transport: { rpc: originalRpc } }); new TypertRegistry(scope); scope.provide('fileUpload', {}); } });
  await setup.inertia; assert.equal(setup.state, 2);
  const gatewayFiber = ctx.plugin(api); await gatewayFiber.inertia; assert.equal(gatewayFiber.state, 2);
  for (const contribution of remotes) await ctx.get('remote').$mount(contribution);
  let controllerFactory;
  vm.runInNewContext(fs.readFileSync(r.resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8'), { window: { __ModuleLoader__: { load(row) { controllerFactory = row.factory; } } }, console, queueMicrotask, AbortController, AbortSignal, setTimeout, clearTimeout, Symbol, Promise, crypto: require('node:crypto').webcrypto });
  const store = { createSnapshotStore(initial) { let value = initial; const listeners = new Set(); return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of listeners) fn(); } }; }, notifySubscribers(listeners) { for (const fn of listeners) fn(); } };
  const controller = controllerFactory(id => id === '@deepseek-ai/cordis' ? r(id) : id === '@deepseek-ai/dsh-api-gateway/client' ? api : id === '@deepseek-ai/dsh-client-store' ? store : (() => { throw new Error('Unexpected module ' + id); })());
  const sessionsFiber = ctx.plugin(controller); await sessionsFiber.inertia; assert.equal(sessionsFiber.state, 2);
  const sessions = ctx.get('sessions');
  const bounded = promise => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Native stack integration timed out')), 3000); timer.unref(); })]);
  try {
    await sessions.refresh();
    const before = sessions.retain('same', { source: 'mainView' }); await bounded(before.ready);
    const previousBinding = before.binding;
    const nativeConnection = ctx.get('connection'), openSocket = nativeConnection.openWebSocket;
    nativeConnection.openWebSocket = undefined;
    carrier = await installSessionCarrier(ctx, { fetch: async (_url, init) => {
      const message = JSON.parse(init.body), chunks = gateway.open(message.payload.endpoint, message.payload.payload, init.signal, owner);
      return new Response(new ReadableStream({ async start(controller) {
        try { for await (const value of chunks) controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'item', value }) + '\n')); controller.enqueue(new TextEncoder().encode('{"type":"end"}\n')); controller.close(); }
        catch (error) { controller.error(error); }
      } }));
    } });
    nativeConnection.openWebSocket = openSocket;
    ctx.get('connection').reconnect();
    await sessions.refresh();
    const localId = gateway.identities.encode('local', 'session', 'same');
    assert.ok(sessions.list.getSnapshot().ids.includes(localId));
    const local = sessions.retain(localId, { source: 'mainView' }); await bounded(local.ready);
    assert.equal(sessions.binding('same'), previousBinding);
    assert.notEqual(local.binding, previousBinding);
    await before.binding.session.prompt([{ type: 'text', text: 'synthetic remote request' }], 'queue');
    await local.binding.session.prompt([{ type: 'text', text: 'synthetic local request' }], 'queue');
    assert.deepEqual(calls.filter(row => row[1] === 'session/prompt').map(row => [row[0], row[2].args.request.sessionId]), [['remote', 'same'], ['local', 'same']]);
    const presets = ctx.get('remote').agentPresets;
    assert.equal((await presets.list()).value.presets[0].id, 'remote');
    assert.equal((await presets.select('same', 'remote-preset')).value, 'remote-preset');
    assert.equal((await presets.select(localId, 'local-preset')).value, 'local-preset');
    assert.deepEqual(calls.filter(row => row[1] === 'agentPresets/select').map(row => [row[0], row[2].args.agentId]), [['remote', 'same'], ['local', 'same']]);
    for (const [endpoint, payload] of [['subscriptions-auth.status', {}], ['subscriptions-auth.usage', { provider: 'synthetic' }], ['subscriptions-auth.providerSettings', { provider: 'synthetic' }]]) {
      const count = calls.length;
      await ctx.get('connection').rpc.call('/api', endpoint, payload, owner.signal);
      assert.equal(calls.length, count + 1); assert.equal(calls.at(-1)[1], endpoint); assert.equal(calls.at(-1)[2], payload);
    }
    local.release(); before.release();
    console.log('PASS installed Connection + Gateway + generated API + native Session controller preserve existing binding and route two synthetic Hosts');
  } finally { await carrier?.dispose(); await sessionsFiber.dispose(); await gatewayFiber.dispose(); await setup.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
