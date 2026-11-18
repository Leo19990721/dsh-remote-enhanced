// Installed generated native terminal APIs over the actual candidate socket,
// synthetic Hosts only. No GUI, user Session or profile mutation.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
(async () => {
  const requireInstalled = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const load = name => import(pathToFileURL(requireInstalled.resolve(name)).href);
  const { Context } = requireInstalled('@deepseek-ai/cordis');
  const { WebSocketServer, WebSocket } = requireInstalled('ws');
  const api = await load('@deepseek-ai/dsh-api-gateway/client');
  const connection = await load('@deepseek-ai/dsh-client-connection/client');
  const { TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry');
  const { default: terminal } = await load('@deepseek-ai/dsh-api-terminal-controller/remote');
  const { registerFederatedRoute } = await import('../federated-route.js');
  const { installSessionCarrier } = await import('../client-carrier.js');
  const descriptors = new Map(terminal.descriptors.map(d => [d.namespace + '/' + d.method, d]));
  const calls = [], writes = [], lifetime = new AbortController();
  const peer = { principal: { kind: 'owner' }, signal: lifetime.signal };
  const frameInfo = { id: 'fixture-terminal', title: 'Fixture', shell: { path: 'pwsh', args: [], name: 'pwsh' }, cwd: 'C:/fixture', cols: 80, rows: 24, state: 'running', exitCode: null, origin: 'user', control: 'user' };
  const raw = host => ({ call: async () => ({ ok: true }), open(endpoint, payload, signal, uplink) { return (async function* () {
    if (endpoint !== 'terminal/attach') { if (endpoint === '$events') yield { type: 'ready', clientId: host, host: { home: 'C:/fixture' } }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return; }
    calls.push([host, endpoint, payload]); assert.equal(payload.args.agentId, 'same-session');
    yield { type: 'snapshot', sequence: 0, screen: host, info: frameInfo, writable: true };
    for await (const value of uplink) {
      writes.push([host, value]); yield { type: 'ack', sequence: value.sequence };
    }
  })(); } });
  const host = new Context(), routes = new Map(), upgrades = new Map();
  host.connection = { admit: () => ({ peer }) };
  host.webServer = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); }, registerUpgrade(route) { upgrades.set(route.path, route); return () => upgrades.delete(route.path); } };
  const hostFiber = host.plugin({ apply(ctx) { registerFederatedRoute(ctx, { WebSocketServer, baseHost: () => 'local', local: () => raw('local'), channels: { retain: async () => ({ ...raw('remote'), release: async () => {} }) }, descriptor: endpoint => descriptors.get(endpoint) }); } });
  await hostFiber.inertia; assert.equal(hostFiber.state, 2);
  const server = createServer((request, response) => { const route = [...routes.values()].find(row => request.url.startsWith(row.path + '/')); void route.handler(request, response).catch(error => response.destroy(error)); });
  server.on('upgrade', (request, socket, head) => { const route = upgrades.get(new URL(request.url, 'http://fixture').pathname); if (route) route.handler(request, socket, head); else socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const client = new Context(); let carrier;
  const original = { async call(channel, endpoint, payload, signal) {
    const response = await fetch(base + channel + '/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: endpoint, payload }), signal });
    return (await response.json()).result;
  } };
  const setup = client.plugin({ apply(ctx) { connection.installConnection(ctx, { interactions: 'answer', transport: { rpc: original, streamBaseUrl: base, createWebSocket: url => new WebSocket(url) } }); new TypertRegistry(ctx); } });
  await setup.inertia; const gateway = client.plugin(api); await gateway.inertia;
  const remote = client.get('remote'); await remote.$mount(terminal);
  const opened = [];
  try {
    carrier = await installSessionCarrier(client);
    for (const [hostId, sessionId] of [['local', 'same-session'], ['remote', 'dsh-peer:' + JSON.stringify(['remote','session','same-session'])]]) {
      const control = new AbortController();
      const handle = remote.terminal.attach(sessionId, 'fixture-terminal', control.signal);
      const iterator = handle[Symbol.asyncIterator](); opened.push({ handle, iterator, control });
      assert.equal((await iterator.next()).value.screen, hostId);
      handle.send({ type: 'write', sequence: 1, data: hostId, typed: true });
      assert.deepEqual((await iterator.next()).value, { type: 'ack', sequence: 1 });
      handle.send({ type: 'resize', sequence: 2, cols: 100, rows: 31 });
      assert.deepEqual((await iterator.next()).value, { type: 'ack', sequence: 2 });
    }
    assert.deepEqual(writes.map(([hostId, value]) => [hostId, value.type]), [['local','write'],['local','resize'],['remote','write'],['remote','resize']]);
    assert.equal(calls.length, 2);
    console.log('PASS installed generated terminal attach over candidate mux: independent Host routing, typed write and resize');
  } finally {
    for (const item of opened) { item.control.abort(); item.handle.end?.(); await item.iterator.return?.(); }
    await carrier?.dispose(); await gateway.dispose(); await setup.dispose(); lifetime.abort(); await hostFiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
