import test from 'node:test';
import assert from 'node:assert/strict';
import { openHostStream } from '../federated-terminal.js';
import { StreamInput } from '../federated-input.js';
import { FederatedGateway } from '../federated-gateway.js';

test('remote terminal attach uses Remote compatibility with the exact carrier and input, never the global selector', async () => {
  const target = { open() { throw new Error('native attach is not directly allowed'); } }, signal = new AbortController().signal, uplink = new StreamInput();
  let args;
  const expected = { async *[Symbol.asyncIterator]() { yield { type: 'snapshot' }; } };
  const stream = await openHostStream(target, 'terminal/attach', { args: { agentId: 's', id: 't' } }, signal, uplink, { terminalAdapter: async () => (...value) => { args = value; return expected; } });
  assert.equal(stream, expected); assert.deepEqual(args.slice(0, 3), [target, { args: { agentId: 's', id: 't' } }, signal]);
  uplink.push({ type: 'write', data: 'typed', sequence: 1, typed: true }); uplink.end();
  assert.deepEqual(await Array.fromAsync(args[3]), [{ type: 'write', data: 'typed', sequence: 1 }]);
});

test('remote terminal roster uses only authorized list calls and publishes changed whole sets', async () => {
  const stop = new AbortController(); let reads = 0;
  const stream = await openHostStream({ dispatch: async (endpoint, payload) => { assert.equal(endpoint, 'terminal/list'); assert.deepEqual(payload, { args: { sessionId: 's' } }); return { ok: true, value: ++reads < 3 ? [] : [{ id: 't' }] }; } }, 'terminal/watch', { args: { sessionId: 's' } }, stop.signal, undefined, { terminalWatchIntervalMs: 1 });
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, []);
  assert.deepEqual((await iterator.next()).value, [{ id: 't' }]);
  stop.abort(); await iterator.return(); assert.equal(reads, 3);
});

test('switching Sessions routes the same terminal id to each owning computer', async () => {
  const signal = new AbortController().signal, peer = { principal: { kind: 'owner' }, signal };
  const calls = [], released = [], endpoints = [];
  const raw = host => ({
    open(endpoint, { args }, active, uplink) {
      endpoints.push([host, endpoint, args.agentId, args.id]);
      return (async function* () { for await (const frame of uplink) { active.throwIfAborted(); calls.push([host, frame.data]); yield { type: 'echo', data: frame.data }; } })();
    },
  });
  const gateway = new FederatedGateway({
    baseHost: 'local', local: owner => { assert.equal(owner, peer); return raw('local'); },
    channels: { retain: async host => ({ ...raw(host), release: async () => released.push(host) }) },
    descriptor: () => ({ parameters: [{ source: 'lookup', lookup: 'agent', wire: 'agentId' }], uplink: {}, result: {} }),
  });
  for (const host of ['one', 'two', 'local', 'one']) {
    const id = gateway.identities.encode(host, 'session', 'same');
    const input = new StreamInput(); input.push({ type: 'write', data: `typed on ${host}` }); input.end();
    const stream = gateway.open('terminal/attach', { args: { agentId: id, id: 'same-tab' } }, signal, peer, input);
    assert.deepEqual(await Array.fromAsync(stream), [{ type: 'echo', data: `typed on ${host}` }]);
  }
  assert.deepEqual(endpoints, ['one', 'two', 'local', 'one'].map(host => [host, 'terminal/attach', 'same', 'same-tab']));
  assert.deepEqual(calls, ['one', 'two', 'local', 'one'].map(host => [host, `typed on ${host}`]));
  assert.deepEqual(released, ['one', 'two', 'one']);
});

test('stream input bounds and cancellation discard pending writes', async () => {
  const input = new StreamInput({ maxItems: 1, maxBytes: 64 }); input.push({ text: 'first' });
  assert.throws(() => input.push({ text: 'overflow' }), /OVERFLOW/);
  input.close(); assert.deepEqual(await Array.fromAsync(input), []);
  assert.throws(() => input.push({ text: 'replay' }), /CLOSED/);
});
