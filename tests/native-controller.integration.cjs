// Opt-in installed-version integration test. Uses an isolated Cordis tree and
// synthetic carriers; never talks to the user's Host or reads conversation data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
(async () => {
  const install = process.env.DSH_INSTALL_DIR;
  assert.ok(install, 'Run under the installed Electron Node runtime');
  const resolve = createRequire(path.join(install, 'package.json'));
  const { Context } = resolve('@deepseek-ai/cordis');
  const api = await import(pathToFileURL(resolve.resolve('@deepseek-ai/dsh-api-gateway/client')).href);
  const { FederatedGateway } = await import('../federated-gateway.js');
  let factory;
  const context = { window: { __ModuleLoader__: { load(row) { factory = row.factory; } } }, console, queueMicrotask, AbortController, AbortSignal, setTimeout, clearTimeout, Symbol, Promise };
  vm.runInNewContext(fs.readFileSync(resolve.resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8'), context);
  assert.equal(typeof factory, 'function');
  const store = {
    createSnapshotStore(initial) {
      let value = initial; const listeners = new Set();
      return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of listeners) fn(); } };
    },
    notifySubscribers(listeners) { for (const listener of [...listeners]) listener(); },
  };
  const entry = factory(id => id === '@deepseek-ai/cordis' ? resolve(id) : id === '@deepseek-ai/dsh-api-gateway/client' ? api : id === '@deepseek-ai/dsh-client-store' ? store : (() => { throw new Error('Unexpected module ' + id); })());
  const calls = [], owner = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const raw = hostId => ({
    async call(endpoint, payload) {
      calls.push([hostId, endpoint, payload]);
      if (endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 'same', updatedAt: 1, running: false, blank: true, agentAvailable: true }] } };
      return { ok: true, value: { matched: true } };
    },
    open(endpoint, payload, signal) { return (async function* () {
      calls.push([hostId, endpoint, payload]);
      if (endpoint === 'session/follow') yield { type: 'snapshot', header: { id: 'same', version: 3, createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } };
      else if (endpoint === 'session/control') yield { type: 'baseline', value: { projections: {} } };
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    })(); },
  });
  const request = { type: 'object', properties: { sessionId: { type: 'string' }, address: { type: 'object', properties: { sessionId: { type: 'string' } } } } };
  const gateway = new FederatedGateway({ local: () => raw('local'), channels: { async retain(id) { return { ...raw(id), release: async () => {} }; } }, hosts: async () => [{ hostId: 'remote', name: 'Remote-PC', online: true }], descriptor: endpoint => ({ parameters: endpoint.startsWith('commands/') ? [{ wire: 'agentId', source: 'lookup', lookup: 'agent' }] : [{ wire: endpoint === 'session/list' ? '_request' : 'request', codec: { jsonSchema: request } }], result: {} }) });
  const remote = {
    $on: () => () => {},
    $stream: options => new api.RemoteStream({ generation: { getSnapshot: () => ({ id: 1 }), subscribe: () => () => {} } }, options),
    commands: { execute: (agentId, line, attachments, signal) => gateway.call('commands/execute', { args: { agentId, line, attachments } }, signal, owner) },
    subagents: {},
    session: {
      list: args => gateway.call('session/list', { args: { _request: args } }, owner.signal, owner),
      follow: (args, signal) => gateway.open('session/follow', { args: { request: args } }, signal, owner),
      control: signal => gateway.open('session/control', { args: {} }, signal, owner),
    },
  };
  const ctx = new Context();
  const setup = ctx.plugin({ apply(scope) {
    scope.provide('connection', { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } });
    scope.provide('remote', remote);
    scope.provide('typert', { contexts: { registerClient() {} } });
    scope.provide('fileUpload', {});
    scope.provide('remote.commands', remote.commands);
    scope.provide('remote.session', remote.session);
    scope.provide('remote.subagents', remote.subagents);
  } });
  await setup.inertia;
  assert.equal(setup.state, 2, 'isolated services activated');
  const fiber = ctx.plugin(entry);
  try {
    await fiber.inertia;
    assert.equal(fiber.state, 2, 'native controller activated');
    const sessions = ctx.get('sessions');
    await sessions.refresh();
    const remoteId = gateway.identities.encode('remote', 'session', 'same');
    assert.deepEqual([...sessions.list.getSnapshot().ids].sort(), ['same', remoteId].sort());
    const local = sessions.retain('same', { source: 'mainView' });
    const foreign = sessions.retain(remoteId, { source: 'mainView' });
    await Promise.all([local.ready, foreign.ready]);
    assert.notEqual(local.binding, foreign.binding);
    assert.equal(local.binding.session.sessionId, 'same');
    assert.equal(foreign.binding.session.sessionId, remoteId);
    await foreign.binding.session.command('/inspect');
    await local.binding.session.command('/inspect');
    assert.deepEqual(calls.filter(row => row[1] === 'commands/execute').map(row => [row[0], row[2].args.agentId]), [['remote', 'same'], ['local', 'same']]);
    foreign.release();
    assert.equal(sessions.binding('same'), local.binding);
    local.release();
    console.log('PASS native ClientSessions retains local/remote bindings simultaneously and routes commands independently');
  } finally { await fiber.dispose(); await setup.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
