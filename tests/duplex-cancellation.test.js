import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStreams } from '../client-streams.js';

test('cancellation racing a resolved input drops it before socket send', async () => {
  const frames = [], value = Promise.withResolvers(), waiting = Promise.withResolvers();
  const socket = new EventTarget(); socket.readyState = 1; socket.close = () => {};
  socket.send = raw => frames.push(JSON.parse(raw));
  const streams = new SessionStreams(() => { queueMicrotask(() => socket.dispatchEvent(new Event('open'))); return socket; }, 'v');
  const stop = new AbortController();
  const uplink = { [Symbol.asyncIterator]: () => ({ next() { waiting.resolve(); return value.promise; }, return: async () => ({ done: true }) }) };
  const iterator = streams.open('terminal/attach', { args: {} }, stop.signal, uplink)[Symbol.asyncIterator]();
  const next = iterator.next();
  await waiting.promise;
  value.resolve({ done: false, value: { type: 'write', sequence: 1, data: 'must-drop' } });
  stop.abort();
  await assert.rejects(next, /abort/i); await iterator.return(); streams.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.filter(frame => frame.type === 'input').length, 0);
});
