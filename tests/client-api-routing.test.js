import test from 'node:test';
import assert from 'node:assert/strict';
import { installSessionCarrier } from '../client-carrier.js';

function fixture(baseHost = 'local') {
  const descriptors = new Map(['session/list', 'session/prompt', 'agentPresets/list', 'agentPresets/select'].map(endpoint => [endpoint, { namespace: endpoint.split('/')[0], method: endpoint.split('/')[1] }]));
  const calls = [], listeners = new Set(), streams = [];
  const registry = { get: key => descriptors.get(key), list: () => [...descriptors.values()], subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const rpc = {
    async call(channel, endpoint, payload, signal) {
      calls.push({ receiver: this, channel, endpoint, payload, signal });
      if (endpoint === 'attach') return { ok: true, value: { viewId: 'v', baseHost } };
      return { ok: true, value: 'synthetic' };
    },
    open(...args) { streams.push({ receiver: this, args }); return { async *[Symbol.asyncIterator]() { yield 'plugin-stream'; } }; },
  };
  return { ctx: { connection: { rpc }, typert: { remotes: registry } }, rpc, calls, streams, descriptors,
    mount(endpoint) { descriptors.set(endpoint, { namespace: endpoint.split('/')[0], method: endpoint.split('/')[1] }); for (const fn of listeners) fn({ kind: 'remote', key: endpoint }); },
    withdraw(endpoint) { descriptors.delete(endpoint); for (const fn of listeners) fn({ kind: 'remote', key: endpoint }); }, listeners,
  };
}

test('plugin-owned status usage settings and login retain their exact original RPC route', async () => {
  const f = fixture(), carrier = await installSessionCarrier(f.ctx);
  try {
    for (const [endpoint, payload] of [
      ['subscriptions-auth.status', {}], ['subscriptions-auth.usage', { provider: 'synthetic', account: 'a' }],
      ['subscriptions-auth.providerSettings', { provider: 'synthetic' }], ['subscriptions-auth.login', { provider: 'synthetic' }],
      ['pluginBusiness/read', { args: { query: 'plugin-owned' } }],
    ]) {
      const signal = new AbortController().signal;
      const result = await f.rpc.call('/api', endpoint, payload, signal), actual = f.calls.at(-1);
      assert.equal(result.ok, true); assert.equal(actual.channel, '/api'); assert.equal(actual.endpoint, endpoint);
      assert.equal(actual.payload, payload); assert.equal(actual.signal, signal); assert.equal(actual.receiver, f.rpc);
    }
  } finally { await carrier.dispose(); }
});

test('mounted native session and preset calls remain federated for both source identities', async () => {
  const f = fixture(), carrier = await installSessionCarrier(f.ctx);
  try {
    for (const endpoint of ['session/prompt', 'agentPresets/list', 'agentPresets/select']) for (const sessionId of ['local-session', 'dsh-peer:["pc","session","remote-session"]']) {
      const payload = { args: { sessionId } };
      await f.rpc.call('/api', endpoint, payload);
      const actual = f.calls.at(-1);
      assert.equal(actual.channel, '/dsh-session-hosts'); assert.equal(actual.endpoint, 'call');
      assert.equal(actual.payload.endpoint, endpoint); assert.equal(actual.payload.payload, payload);
    }
  } finally { await carrier.dispose(); }
});

test('unregistered native methods and unknown remote identity operations never fall back locally', async () => {
  for (const baseHost of ['local', 'pc']) {
    const f = fixture(baseHost), carrier = await installSessionCarrier(f.ctx);
    try {
      for (const [endpoint, payload] of [
        ['session/notMounted', { args: {} }], ['agentPresets/notMounted', {}],
        ['unknownPlugin/mutate', { request: { sessionId: 'dsh-peer:["pc","session","s"]' } }],
        ['unknownPlugin.mutate', { args: { workspaceFileScopeId: 'dsh-peer:["pc","session","s"]' } }],
        ...baseHost === 'local' ? [] : [['unknownPlugin/mutate', { args: { sessionId: 'raw-remote-session' } }]],
      ]) {
        const before = f.calls.length;
        await assert.rejects(f.rpc.call('/api', endpoint, payload), error => error.code === 'session-hosts/route-unavailable');
        assert.equal(f.calls.length, before, 'reject before dispatching to either Host');
      }
    } finally { await carrier.dispose(); }
  }
});

test('plugin streams keep original opener arguments and native fallback when no opener existed', async () => {
  const f = fixture(), carrier = await installSessionCarrier(f.ctx);
  try {
    const signal = new AbortController().signal, payload = { topic: 'synthetic' }, uplink = {};
    const values = []; for await (const row of f.rpc.open('/api', 'plugin.usageWatch', payload, signal, uplink)) values.push(row);
    assert.deepEqual(values, ['plugin-stream']); assert.equal(f.streams[0].receiver, f.rpc);
    assert.deepEqual(f.streams[0].args, ['/api', 'plugin.usageWatch', payload, signal, uplink]);
  } finally { await carrier.dispose(); }
  const other = fixture(); delete other.rpc.open;
  const installed = await installSessionCarrier(other.ctx);
  try { assert.equal(other.rpc.open('/api', 'plugin/stream', {}, new AbortController().signal), undefined); }
  finally { await installed.dispose(); }
});

test('late mounted native endpoints become federated and withdrawn endpoints remain guarded', async () => {
  const f = fixture(), carrier = await installSessionCarrier(f.ctx);
  try {
    f.mount('nativeLater/read');
    await f.rpc.call('/api', 'nativeLater/read', { args: {} });
    assert.equal(f.calls.at(-1).channel, '/dsh-session-hosts');
    f.mount('nativeLater/neverCalled'); f.withdraw('nativeLater/neverCalled'); f.withdraw('nativeLater/read');
    const before = f.calls.length;
    await assert.rejects(f.rpc.call('/api', 'nativeLater/neverCalled', { args: {} }), error => error.code === 'session-hosts/route-unavailable');
    assert.equal(f.calls.length, before);
  } finally { await carrier.dispose(); }
  assert.equal(f.listeners.size, 0);
});

test('missing native registry leaves original RPC untouched instead of guessing API ownership', async () => {
  const f = fixture(); delete f.ctx.typert;
  const call = f.rpc.call, open = f.rpc.open;
  await assert.rejects(installSessionCarrier(f.ctx), /registry unavailable/);
  assert.equal(f.rpc.call, call); assert.equal(f.rpc.open, open); assert.equal(f.calls.length, 0);
});
