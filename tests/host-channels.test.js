import test from 'node:test';
import assert from 'node:assert/strict';
import { HostChannels } from '../host-channels.js';

function fixture() {
  const calls = [], close = [], readers = new Map();
  const runtime = {
    setMode() { throw new Error('global target must never change'); },
    status: () => ({ mode: 'local' }),
    async withToolRemote(hostId, signal, operation) {
      calls.push(['connect', hostId]);
      try { return await operation({ target: { deviceId: hostId }, features: { remoteGateway: true } }, signal); }
      finally { close.push(hostId); }
    },
    remoteTypertGateway(remote) {
      const hostId = remote.target.deviceId;
      return {
        async dispatch(endpoint, payload, signal) { signal.throwIfAborted(); calls.push(['call', hostId, endpoint, payload]); return { ok: true, value: hostId }; },
        async open(endpoint, payload, signal) {
          calls.push(['stream', hostId, endpoint, payload]);
          const values = [hostId];
          const iterator = { next: async () => {
            signal.throwIfAborted();
            if (values.length) return { done: false, value: values.shift() };
            return new Promise(resolve => { readers.set(hostId, resolve); signal.addEventListener('abort', () => resolve({ done: true }), { once: true }); });
          }, return: async () => { calls.push(['return', hostId]); readers.get(hostId)?.({ done: true }); return { done: true }; } };
          return { [Symbol.asyncIterator]: () => iterator };
        },
      };
    },
  };
  return { channels: new HostChannels(runtime), runtime, calls, close };
}

test('same host shares a carrier; different hosts stay connected independently', async () => {
  const { channels, runtime, calls, close } = fixture();
  const [a, a2, b] = await Promise.all([channels.retain('pc-a'), channels.retain('pc-a'), channels.retain('pc-b')]);
  assert.deepEqual(calls, [['connect', 'pc-a'], ['connect', 'pc-b']]);
  assert.deepEqual(await Promise.all([a.call('session/page', {}), b.call('session/page', {})]), [{ ok: true, value: 'pc-a' }, { ok: true, value: 'pc-b' }]);
  await a.release(); assert.deepEqual(close, []);
  await a2.release(); assert.deepEqual(close, ['pc-a']);
  assert.equal((await b.call('session/page', {})).value, 'pc-b');
  assert.deepEqual(runtime.status(), { mode: 'local' });
  await b.release(); await channels.dispose(); assert.deepEqual(close, ['pc-a', 'pc-b']);
});

test('cancelling one stream neither closes another host nor changes its route', async () => {
  const { channels, close } = fixture();
  const a = await channels.retain('pc-a'), b = await channels.retain('pc-b');
  const stopA = new AbortController();
  const streamA = a.open('session/follow', {}, stopA.signal)[Symbol.asyncIterator]();
  const streamB = b.open('session/follow', {})[Symbol.asyncIterator]();
  assert.equal((await streamA.next()).value, 'pc-a');
  assert.equal((await streamB.next()).value, 'pc-b');
  const waiting = streamA.next(); stopA.abort(); assert.equal((await waiting).done, true);
  assert.deepEqual(close, []);
  assert.equal((await b.call('session/page', {})).value, 'pc-b');
  await streamB.return(); await a.release(); await b.release(); await channels.dispose();
});

test('a cancelled acquisition releases only its own interest', async () => {
  const { channels, calls, close } = fixture();
  const stop = new AbortController(); stop.abort();
  await assert.rejects(channels.retain('pc-a', stop.signal));
  assert.deepEqual(calls, []); assert.deepEqual(close, []);
  await channels.dispose();
});

test('unavailable remote cannot fall through to another carrier', async () => {
  const channels = new HostChannels({ async withToolRemote() { throw new Error('HOST_OFFLINE'); } });
  await assert.rejects(channels.retain('offline'), /HOST_OFFLINE/);
  await channels.dispose();
});

test('normal Remote tools can share an independently held Host without replacing it', async () => {
  const { channels, runtime, calls } = fixture();
  const undo = channels.shareTools();
  const carrier = await channels.retain('pc-a');
  const result = await runtime.withToolRemote('pc-a', new AbortController().signal, async remote => remote.target.deviceId);
  assert.equal(result, 'pc-a');
  assert.equal(calls.filter(row => row[0] === 'connect').length, 1);
  await carrier.release(); undo(); await channels.dispose();
});

test('silent transport failure retires the stale carrier so the next read reconnects', { timeout: 1500 }, async () => {
  let connections = 0; const healthStarted = Promise.withResolvers(), connectionEnded = Promise.withResolvers();
  const runtime = {
    async withToolRemote(hostId, signal, operation) {
      const generation = ++connections;
      try { return await operation({ features: { remoteGateway: true }, client: {
        rpc: async (_method, _payload, active) => {
          if (generation > 1) return {};
          healthStarted.resolve();
          await new Promise((_, reject) => { active.addEventListener('abort', () => reject(active.reason), { once: true }); });
        },
      } }, signal); } finally { connectionEnded.resolve(); }
    },
    remoteTypertGateway: () => ({ async dispatch() { return { ok: true, value: connections }; } }),
  };
  const channels = new HostChannels(runtime, { healthIntervalMs: 5, healthTimeoutMs: 15 });
  let first, replacement;
  try {
    first = await channels.retain('pc');
    await healthStarted.promise;
    await connectionEnded.promise;
    replacement = await channels.retain('pc');
    assert.equal((await replacement.call('session/modelCatalog', {})).value, 2);
    await assert.rejects(first.call('session/modelCatalog', {}));
  } finally { await first?.release(); await replacement?.release(); await channels.dispose(); }
});

test('a live borrowed channel still checks authorization before each operation', async () => {
  const { channels, runtime, calls } = fixture(); let revoked = false, queries = 0;
  runtime.assertHostAuthorizationForDeviceDiscovery = () => { if (revoked) throw Object.assign(new Error('revoked'), { code: 'AUTHORIZATION_REVOKED' }); };
  const carrier = await channels.retain('pc-a');
  try {
    assert.equal(await carrier.query(async () => ++queries), 1);
    revoked = true;
    await assert.rejects(carrier.query(async () => ++queries), { code: 'AUTHORIZATION_REVOKED' });
    await assert.rejects(carrier.call('session/page', {}), { code: 'AUTHORIZATION_REVOKED' });
    assert.equal(queries, 1); assert.equal(calls.filter(row => row[0] === 'call').length, 0);
  } finally { await carrier.release(); await channels.dispose(); }
});

test('disposal ends all owned channels and later operations fail', async () => {
  const { channels, close } = fixture();
  const a = await channels.retain('pc-a'), b = await channels.retain('pc-b');
  await channels.dispose();
  assert.deepEqual(close.sort(), ['pc-a', 'pc-b']);
  await assert.rejects(a.call('session/page', {}));
  await assert.rejects(channels.retain('pc-c'), /disposed/);
  await a.release(); await b.release();
});
