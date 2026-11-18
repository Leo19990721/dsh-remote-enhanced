import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionPreviews, loopbackTarget } from '../federated-previews.js';
import { SurfaceIdentities } from '../federated-identities.js';
import { FederatedGateway } from '../federated-gateway.js';
const id = host => 'dsh-peer:' + JSON.stringify([host, 'session', 's']);
function fixture() {
  const stop = new AbortController(), calls = [], entries = [];
  const peer = { principal: { kind: 'owner' } };
  const gateway = { owner(p) { assert.equal(p, peer); }, identities: new SurfaceIdentities('local'), async channel(host) { return { query: async operation => operation({ client: { rpc: async (method, payload) => { calls.push([host, method, payload]); return { ports: [41788] }; } } }, stop.signal), release: async () => {} }; } };
  const manager = new SessionPreviews(gateway, peer, client => {
    const preview = { closed: 0, async open(port) { const allowed = await client.rpc('loopback.call', { op: 'describe' }); if (!allowed.ports.includes(port)) throw Object.assign(new Error('denied'), { code: 'LOOPBACK_PORT_DENIED' }); return { url: `http://dsh-${entries.length}.localhost:1234/` }; }, async close() { this.closed++; } };
    entries.push(preview); return preview;
  }, stop.signal);
  return { manager, stop, calls, entries };
}
test('preview ownership separates identical ports on different computers and preserves URL suffix', async () => {
  const { manager, stop, calls, entries } = fixture();
  try {
    const one = await manager.open(id('one'), 'http://127.0.0.1:41788/map/?q=1#here', 'a', stop.signal);
    const two = await manager.open(id('two'), 'http://localhost:41788/', 'b', stop.signal);
    assert.notEqual(new URL(one.url).origin, new URL(two.url).origin);
    assert.equal(new URL(one.url).pathname + new URL(one.url).search + new URL(one.url).hash, '/map/?q=1#here');
    assert.deepEqual(calls.map(row => row[0]), ['one', 'two']);
    await manager.release('a'); assert.equal(entries[0].closed, 1); assert.equal(entries[1].closed, 0);
  } finally { await manager.close(); }
});
test('authorized preview transfer ignores stale device presence between response chunks', async () => {
  const stop = new AbortController(), peer = { principal: { kind: 'owner' }, signal: stop.signal };
  let discoveries = 0, reads = 0, releases = 0;
  const calls = [];
  const gateway = new FederatedGateway({ baseHost: 'local',
    hosts: async () => [{ hostId: 'pc', online: ++discoveries === 1 }],
    channels: { retain: async (hostId, active) => {
      assert.equal(hostId, 'pc'); active.throwIfAborted();
      return { query: operation => operation({ client: { rpc: async (_method, value) => {
        calls.push(value.op); return value.op === 'describe' ? { ports: [41788] }
          : value.op === 'http.read' ? { data: 'eA==', done: ++reads === 3 } : {};
      } } }, active), release: async () => { releases++; } };
    } },
  });
  const manager = new SessionPreviews(gateway, peer, client => ({ async open() {
    await client.rpc('loopback.call', { op: 'describe' });
    await client.rpc('loopback.call', { op: 'http.open', id: 'request' });
    while (!(await client.rpc('loopback.call', { op: 'http.read', id: 'request' })).done) {}
    return { url: 'http://dsh-synthetic.localhost:1234/' };
  }, async close() {} }), stop.signal);
  try {
    await manager.open(id('pc'), 'http://localhost:41788/', 'tab', stop.signal);
    assert.equal(reads, 3); assert.equal(discoveries, 0, 'live authorized RPCs must not query server presence');
    assert.equal(releases, calls.length);
  } finally { await manager.close(); }
});
test('each ordinary tab owns its origin so switching file mode can revoke old history safely', async () => {
  const { manager, stop, entries } = fixture();
  await manager.open(id('one'), 'http://localhost:41788/', 'a', stop.signal);
  await manager.open(id('one'), 'http://localhost:41788/', 'b', stop.signal);
  assert.equal(entries.length, 2, 'siblings must not keep an old transparent /open origin alive');
  await manager.release('a'); assert.equal(entries[0].closed, 1); assert.equal(entries[1].closed, 0);
  await manager.close(); assert.equal(entries[1].closed, 1); assert.equal(manager.entries.size, 0);
});
test('rapid same-tab navigation cannot let an obsolete failure close the current lease', async () => {
  const { manager, stop, entries } = fixture();
  const pending = Promise.withResolvers();
  manager.createPreview = () => { const value = { closed: 0, count: 0, open() { return ++this.count === 1 ? pending.promise : Promise.resolve({ url: 'http://dsh-new.localhost:1234/' }); }, async close() { this.closed++; } }; entries.push(value); return value; };
  try {
    const first = manager.open(id('one'), 'http://localhost:41788/old', 'tab', stop.signal);
    const handled = assert.rejects(first, /obsolete/);
    const next = await manager.open(id('one'), 'http://localhost:41788/new', 'tab', stop.signal);
    assert.equal(new URL(next.url).pathname, '/new'); pending.reject(new Error('obsolete')); await handled;
    assert.equal(manager.leases.size, 1); assert.equal(entries[0].closed, 0);
  } finally { await manager.close(); }
});
test('view cancellation still permits bounded authorized remote-handle cleanup', async () => {
  const viewStop = new AbortController(), peerStop = new AbortController(), calls = [];
  const peer = { principal: { kind: 'owner' }, signal: peerStop.signal };
  const gateway = { owner() {}, identities: new SurfaceIdentities('local'), async channel(_host, _peer, active) { active.throwIfAborted(); return { query: operation => operation({ client: { rpc: async (_method, payload) => { active.throwIfAborted(); calls.push(payload.op); return {}; } } }, active), release: async () => {} }; } };
  const manager = new SessionPreviews(gateway, peer, client => ({ open: async () => ({ url: 'http://dsh-a.localhost:1234/' }), close: () => client.rpc('loopback.call', { op: 'close', id: 'owned-handle' }, AbortSignal.timeout(100)) }), viewStop.signal);
  await manager.open(id('one'), 'http://localhost:41788/', 'a', viewStop.signal);
  viewStop.abort(); await manager.close(); assert.deepEqual(calls, ['close']);
});
test('preview cleanup cannot use a revoked owner Peer', async () => {
  const viewStop = new AbortController(), peerStop = new AbortController(); let rpcCalls = 0;
  const peer = { principal: { kind: 'owner' }, signal: peerStop.signal };
  const gateway = { owner(value) { value.signal.throwIfAborted(); }, identities: new SurfaceIdentities('local'), channel: async () => ({ query: async () => { rpcCalls++; }, release: async () => {} }) };
  const manager = new SessionPreviews(gateway, peer, client => ({ open: async () => ({ url: 'http://dsh-a.localhost:1234/' }), close: () => client.rpc('loopback.call', { op: 'close', id: 'owned' }, AbortSignal.timeout(100)) }), viewStop.signal);
  await manager.open(id('one'), 'http://localhost:41788/', 'a', viewStop.signal);
  peerStop.abort(); await assert.rejects(manager.close(), { name: 'AbortError' }); assert.equal(rpcCalls, 0);
});
test('preview never expands port authority and rejects unsafe addresses', async () => {
  const { manager, stop, entries } = fixture();
  await assert.rejects(manager.open(id('one'), 'http://localhost:41789/', 'a', stop.signal), { code: 'LOOPBACK_PORT_DENIED' });
  assert.equal(entries[0].closed, 1);
  for (const url of ['https://localhost:41788/', 'http://user:pass@localhost:41788/', 'http://localhost:80/']) assert.throws(() => loopbackTarget(url));
  assert.equal(loopbackTarget('http://example.com/'), undefined);
  await manager.close();
});
