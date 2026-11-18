import test from 'node:test';
import assert from 'node:assert/strict';
import { combineBaselines, StreamQueue } from '../federated-streams.js';

function participant(hostId, initial, gate) {
  const queue = new StreamQueue();
  return { hostId, queue, open(_endpoint, _payload, signal) { return (async function* () {
    if (gate) await gate;
    if (signal.aborted) return;
    yield { type: 'baseline', value: initial };
    yield* queue.iterate(signal);
  })(); } };
}
const merge = values => ({ items: values.flatMap(value => value.items), archivedSessionIds: values.flatMap(value => value.archivedSessionIds), pinnedSessionIds: values.flatMap(value => value.pinnedSessionIds) });
const base = id => ({ items: [{ workspaceId: id }], archivedSessionIds: [], pinnedSessionIds: [] });

test('late empty-session control baseline never emits an invalid negative sequence', { timeout: 1000 }, async () => {
  const stop = new AbortController(), ready = Promise.withResolvers();
  const local = participant('local', { projections: {} });
  const remote = participant('remote', { projections: { empty: { asOfSeq: -1, values: {} }, active: { asOfSeq: 3, values: { title: 'active' } } } }, ready.promise);
  const iterator = combineBaselines([local, remote], 'session/control', {}, stop.signal, { map: (_host, frame) => frame, merge: values => ({ projections: Object.assign({}, ...values.map(value => value.projections)) }) })[Symbol.asyncIterator]();
  try {
    assert.equal((await iterator.next()).value.type, 'baseline'); ready.resolve();
    const frame = (await iterator.next()).value;
    assert.equal(frame.sessionId, 'active'); assert.equal(frame.seq, 3);
  } finally { stop.abort(); ready.resolve(); await iterator.return(); }
});

test('workspace order reorders known rows without deleting omitted workspaces', { timeout: 2000 }, async () => {
  const stop = new AbortController();
  const local = participant('local', base('local'));
  const remote = participant('remote', { ...base('desktop'), items: [{ workspaceId: 'desktop' }, { workspaceId: 'documents' }] });
  const iterator = combineBaselines([local, remote], 'workspace/follow', {}, stop.signal, { map: (_host, frame) => frame, merge })[Symbol.asyncIterator]();
  try {
    let frame = (await iterator.next()).value;
    while (frame.value.items.length < 3) frame = (await iterator.next()).value;
    remote.queue.push({ type: 'order', workspaceIds: ['desktop'] });
    const reordered = (await iterator.next()).value;
    assert.deepEqual(reordered.value.items.map(row => row.workspaceId), ['local', 'desktop', 'documents']);
    remote.queue.push({ type: 'remove', workspaceId: 'documents' });
    assert.deepEqual((await iterator.next()).value.value.items.map(row => row.workspaceId), ['local', 'desktop']);
  } finally { stop.abort(); await iterator.return(); }
});

test('slow remote opening cannot hold the local baseline hostage', { timeout: 2000 }, async () => {
  const remoteReady = Promise.withResolvers(), stop = new AbortController();
  const local = participant('local', base('local')), remote = participant('remote', base('remote'), remoteReady.promise);
  const iterator = combineBaselines([local, remote], 'workspace/follow', {}, stop.signal, { map: (_host, frame) => frame, merge })[Symbol.asyncIterator]();
  try {
    assert.deepEqual((await iterator.next()).value.value.items, [{ workspaceId: 'local' }]);
    remoteReady.resolve();
    const joined = (await iterator.next()).value;
    assert.equal(joined.type, 'replace');
    assert.deepEqual(joined.value.items, [{ workspaceId: 'local' }, { workspaceId: 'remote' }]);
    remote.queue.push({ type: 'pinned', pinnedSessionIds: ['remote-session'] });
    const pinned = (await iterator.next()).value;
    assert.equal(pinned.value.items.length, 2); assert.deepEqual(pinned.value.pinnedSessionIds, ['remote-session']);
    local.queue.push({ type: 'pinned', pinnedSessionIds: ['local-session'] });
    assert.deepEqual((await iterator.next()).value.value.pinnedSessionIds, ['local-session', 'remote-session']);
  } finally { remoteReady.resolve(); stop.abort(); await iterator.return(); }
});
