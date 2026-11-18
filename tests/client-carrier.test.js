import test from 'node:test';
import assert from 'node:assert/strict';
import { installSessionCarrier } from '../client-carrier.js';
import { carrierRegistry } from './carrier-fixture.js';

test('native API uses independent carrier and disposal restores the exact original methods', async () => {
  const calls = [];
  const original = async (channel, endpoint, payload) => {
    calls.push([channel, endpoint, payload]);
    return endpoint === 'attach' ? { ok: true, value: { viewId: 'v', baseHost: 'local' } } : { ok: true, value: 'read' };
  };
  const ctx = { typert: carrierRegistry(), connection: { rpc: { call: original } } };
  const carrier = await installSessionCarrier(ctx, { fetch: async () => new Response('{"type":"item","value":{"text":"原生"}}\n{"type":"end"}\n') });
  const result = await ctx.connection.rpc.call('/api', 'session/list', { args: { _request: {} } });
  assert.equal(result.value, 'read');
  assert.deepEqual(calls[1], ['/dsh-session-hosts', 'call', { viewId: 'v', endpoint: 'session/list', payload: { args: { _request: {} } } }]);
  const values = [];
  for await (const value of ctx.connection.rpc.open('/api', 'session/follow', { args: {} }, new AbortController().signal)) values.push(value);
  assert.deepEqual(values, [{ text: '原生' }]);
  await carrier.dispose();
  assert.equal(ctx.connection.rpc.call, original); assert.equal(Object.hasOwn(ctx.connection.rpc, 'open'), false);
  assert.equal(calls.at(-1)[1], 'close');
});

test('connection guidance uses the current UI language for calls and streams', async () => {
  const remoteError = { code: 'CONNECTION_FAILED', message: '中文备用提示', details: { hostId: 'pc', computer: 'Remote-PC', reason: 'connectionFailed' } };
  const ctx = { locale: { bind: () => key => ({ connectionConnectionFailed: 'Check Remote status and the network on both computers, then retry.' })[key] }, typert: carrierRegistry(), connection: { rpc: { call: async (_channel, endpoint) => endpoint === 'attach' ? { ok: true, value: { viewId: 'v', baseHost: 'local' } } : endpoint === 'call' ? { ok: false, error: remoteError } : { ok: true } } } };
  const carrier = await installSessionCarrier(ctx, { fetch: async () => new Response(JSON.stringify({ type: 'error', error: remoteError }) + '\n') });
  try {
    const call = await ctx.connection.rpc.call('/api', 'session/prompt', { args: {} });
    assert.match(call.error.message, /Remote-PC: Check Remote/); assert.doesNotMatch(call.error.message, /中文/);
    const stream = ctx.connection.rpc.open('/api', 'session/follow', { args: {} }, new AbortController().signal)[Symbol.asyncIterator]();
    await assert.rejects(stream.next(), error => /Remote-PC: Check Remote/.test(error.message) && error.code === 'CONNECTION_FAILED');
  } finally { await carrier.dispose(); }
});
test('failed attach leaves native transport untouched', async () => {
  const call = async () => ({ ok: false, error: { message: 'Unavailable' } }), ctx = { typert: carrierRegistry(), connection: { rpc: { call } } };
  await assert.rejects(installSessionCarrier(ctx), /Unavailable/);
  assert.equal(ctx.connection.rpc.call, call); assert.equal(ctx.connection.rpc.open, undefined);
});

test('Host status subscription resumes after its physical stream disconnects', { timeout: 2000 }, async () => {
  let opens = 0; const stop = new AbortController();
  const ctx = { typert: carrierRegistry(), connection: { rpc: { call: async (_channel, endpoint) => ({ ok: true, value: endpoint === 'attach' ? { viewId: 'v', baseHost: 'local' } : null }) } } };
  const carrier = await installSessionCarrier(ctx, { signal: stop.signal, fetch: async () => {
    opens++;
    if (opens === 1) throw new Error('synthetic physical disconnect');
    return new Response('{"type":"item","value":{"hostId":"pc","online":true}}\n{"type":"end"}\n');
  } });
  const iterator = carrier.status(stop.signal)[Symbol.asyncIterator]();
  try {
    assert.deepEqual((await iterator.next()).value, { hostId: 'pc', online: true });
    assert.equal(opens, 2);
  } finally { stop.abort(); await iterator.return(); await carrier.dispose(); }
});

test('extension lifetime cancellation stays a retryable carrier loss for surviving native consumers', async () => {
  const lifetime = new AbortController(), consumer = new AbortController(), started = Promise.withResolvers();
  const ctx = { typert: carrierRegistry(), connection: { rpc: { call: async (_channel, endpoint) => ({ ok: true, value: endpoint === 'attach' ? { viewId: 'v', baseHost: 'local' } : null }) } } };
  // Production uses the multiplexed socket, whose logical cancellation must
  // cross the same carrier boundary as the HTTP fallback.
  ctx.connection.openWebSocket = () => {
    const socket = new EventTarget(); socket.readyState = 1; socket.send = () => started.resolve(); socket.close = () => { socket.readyState = 3; };
    queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket;
  };
  const carrier = await installSessionCarrier(ctx, { signal: lifetime.signal });
  const iterator = ctx.connection.rpc.open('/api', 'session/follow', { args: {} }, consumer.signal)[Symbol.asyncIterator]();
  const pending = iterator.next(); await started.promise; lifetime.abort();
  try { await assert.rejects(pending, error => error.dshRemoteStreamFailure?.kind === 'carrier'); }
  finally { consumer.abort(); await iterator.return(); await carrier.dispose(); }
});

test('closing a logical stream aborts only that request and UTF-8 split frames are reassembled', async () => {
  const requests = [];
  const ctx = { typert: carrierRegistry(), connection: { rpc: { call: async (_channel, endpoint) => ({ ok: true, value: endpoint === 'attach' ? { viewId: 'v', baseHost: 'local' } : null }) } } };
  const bytes = new TextEncoder().encode('{"type":"item","value":"中文"}\n{"type":"end"}\n');
  const carrier = await installSessionCarrier(ctx, { fetch: async (_url, init) => {
    requests.push(init.signal);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 24)); controller.enqueue(bytes.slice(24)); controller.close(); } }));
  } });
  const iterator = ctx.connection.rpc.open('/api', 'session/follow', { args: {} }, new AbortController().signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value, '中文'); await iterator.return();
  assert.equal(requests[0].aborted, true);
  await carrier.dispose();
});
