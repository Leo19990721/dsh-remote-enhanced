import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { SessionStreams } from '../client-streams.js';
import { registerSessionMux } from '../federated-mux.js';
const { WebSocket, WebSocketServer } = createRequire(import.meta.url)('ws');

test('native duplex input reaches exactly its owning stream and cancellation never replays input', { timeout: 4000 }, async () => {
  const stop = new AbortController(), disposers = [], received = [];
  const peer = { principal: { kind: 'owner' }, signal: stop.signal };
  let route;
  const view = { stop: new AbortController(), gateway: { open(endpoint, payload, signal, admitted, uplink) {
    assert.equal(admitted, peer);
    return (async function* () {
      yield { ready: payload.args.id };
      if (endpoint === 'terminal/attach') for await (const value of uplink) { received.push([payload.args.id, value]); yield { accepted: value }; }
      else await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    })();
  } } };
  const ctx = { connection: { admit: () => ({ peer }) }, webServer: { registerUpgrade(value) { route = value; return () => {}; } }, effect(factory) { for (const dispose of factory()) disposers.push(dispose); } };
  registerSessionMux(ctx, { WebSocketServer, descriptor: endpoint => endpoint === 'terminal/attach' ? { uplink: {} } : {} }, () => view, stop.signal);
  const server = createServer(); server.on('upgrade', (req, socket, head) => route.handler(req, socket, head)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const streams = new SessionStreams(path => new WebSocket('ws://127.0.0.1:' + server.address().port + path), 'v');
  const one = new AbortController(), sibling = new AbortController();
  const inputs = { async *[Symbol.asyncIterator]() { yield { type: 'write', sequence: 1, data: 'only-one' }; } };
  const terminal = streams.open('terminal/attach', { args: { id: 'one' } }, one.signal, inputs)[Symbol.asyncIterator]();
  const history = streams.open('session/follow', { args: { id: 'other' } }, sibling.signal)[Symbol.asyncIterator]();
  try {
    assert.deepEqual((await terminal.next()).value, { ready: 'one' });
    assert.deepEqual((await history.next()).value, { ready: 'other' });
    assert.deepEqual((await terminal.next()).value, { accepted: { type: 'write', sequence: 1, data: 'only-one' } });
    assert.deepEqual(received, [['one', { type: 'write', sequence: 1, data: 'only-one' }]]);
    one.abort(); assert.equal(streams.socket.readyState, 1);
    assert.equal(streams.streams.size >= 1, true);
  } finally {
    one.abort(); sibling.abort(); streams.dispose(); stop.abort();
    await Promise.allSettled([terminal.return(), history.return()]);
    for (const dispose of disposers.reverse()) await dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
