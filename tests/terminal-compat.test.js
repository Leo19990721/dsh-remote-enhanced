import test from 'node:test';
import assert from 'node:assert/strict';
import { openHostStream } from '../federated-terminal.js';
import { StreamInput } from '../federated-input.js';

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

test('stream input bounds and cancellation discard pending writes', async () => {
  const input = new StreamInput({ maxItems: 1, maxBytes: 64 }); input.push({ text: 'first' });
  assert.throws(() => input.push({ text: 'overflow' }), /OVERFLOW/);
  input.close(); assert.deepEqual(await Array.fromAsync(input), []);
  assert.throws(() => input.push({ text: 'replay' }), /CLOSED/);
});
