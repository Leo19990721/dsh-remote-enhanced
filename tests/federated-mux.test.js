import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerSessionMux } from '../federated-mux.js';
import { SessionStreams } from '../client-streams.js';

test('many native logical streams share one socket and cancel independently', { timeout: 5000 }, async () => {
  const disposers = [], calls = [], finished = [], stop = new AbortController();
  const peer = { principal: { kind: 'owner' }, signal: stop.signal };
  let route;
  const view = { peer, stop: new AbortController(), gateway: { open(endpoint, payload, signal) { return (async function* () {
    calls.push([endpoint, payload]);
    try { yield { sessionId: payload.args.sessionId }; if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); }
    finally { finished.push(payload.args.sessionId); }
  })(); } } };
  const ctx = { connection: { admit: () => ({ peer }) }, webServer: { registerUpgrade(value) { route = value; return () => {}; } }, effect(factory) { for (const dispose of factory()) disposers.push(dispose); } };
  registerSessionMux(ctx, { WebSocketServer, descriptor: () => ({}) }, (id, value) => { if (id !== 'v' || peer !== value) throw new Error('VIEW_UNAVAILABLE'); return view; }, stop.signal);
  const server = createServer(); server.on('upgrade', (req, socket, head) => route.handler(req, socket, head));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let sockets = 0;
  const streams = new SessionStreams(path => { sockets++; return new WebSocket('ws://127.0.0.1:' + server.address().port + path); }, 'v');
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const iterators = controllers.map((control, index) => streams.open('session/follow', { args: { sessionId: 's' + index } }, control.signal)[Symbol.asyncIterator]());
  try {
    const values = await Promise.all(iterators.map(iterator => iterator.next()));
    assert.equal(sockets, 1); assert.equal(calls.length, 10);
    assert.deepEqual(values.map(next => next.value.sessionId), Array.from({ length: 10 }, (_, index) => 's' + index));
    const pending = iterators[0].next(); controllers[0].abort(new Error('only s0'));
    await assert.rejects(pending, /only s0/);
    assert.equal(streams.socket.readyState, 1);
    assert.equal(streams.streams.size, 9);
  } finally {
    for (const controller of controllers) controller.abort();
    streams.dispose(); stop.abort();
    await Promise.allSettled(iterators.map(iterator => iterator.return()));
    for (const dispose of disposers.reverse()) await dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  assert.equal(finished.length, 10);
});
