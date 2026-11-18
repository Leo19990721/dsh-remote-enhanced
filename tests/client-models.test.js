import test from 'node:test';
import assert from 'node:assert/strict';
import { installSessionModels } from '../client-models.js';

function catalog(value) {
  const listeners = new Set();
  return { store: { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } } };
}
test('native model directories keep their instance and load their own computer catalog', async () => {
  const originalCatalog = catalog({ status: 'ready', value: { groups: [] } }), calls = [];
  const remoteId = 'dsh-peer:' + JSON.stringify(['remote', 'session', 's']);
  const directories = new Map(['local', remoteId].map(sessionId => [sessionId, { sessionId, catalog: originalCatalog, unsubscribeCatalog() {}, syncInputs() { this.snapshot = this.catalog.store.getSnapshot(); } }]));
  const original = function (id) { return directories.get(id); };
  const service = { live: { directories: { values: directories.values() } }, directoryFor: original };
  const dispose = installSessionModels(service, { baseHost: 'local', modelCatalog: async sessionId => { calls.push(sessionId); return { ok: true, value: { groups: [{ id: sessionId, models: [] }] } }; } }, new AbortController().signal);
  const remote = service.directoryFor(remoteId), local = service.directoryFor('local');
  assert.equal(remote, directories.get(remoteId));
  await Promise.all([remote.catalog.load(), local.catalog.load()]);
  assert.equal(remote.snapshot.value.groups[0].id, remoteId); assert.equal(local.snapshot.value.groups[0].id, 'local');
  assert.deepEqual(calls, [remoteId, 'local']);
  dispose(); assert.equal(service.directoryFor, original); assert.equal(remote.catalog, originalCatalog);
});

test('sessions on one Host share one model catalog and refresh once after settings change', async () => {
  const previous = catalog({ status: 'ready', value: { groups: [] } });
  const remoteId = id => 'dsh-peer:' + JSON.stringify(['pc', 'session', id]);
  const directories = new Map(['local-a', 'local-b', remoteId('a'), remoteId('b')].map(sessionId => [sessionId, { sessionId, catalog: previous, unsubscribeCatalog() {}, syncInputs() {} }]));
  const service = { directoryFor: id => directories.get(id) }, calls = [];
  const dispose = installSessionModels(service, { baseHost: 'local', async modelCatalog(id) { calls.push(id); return { ok: true, value: { groups: [], failures: [] } }; } }, new AbortController().signal);
  try {
    const rows = [...directories.keys()].map(id => service.directoryFor(id));
    await Promise.all(rows.map(row => row.catalog.load()));
    assert.equal(calls.length, 2, 'one load for local and one for pc');
    assert.equal(rows[0].catalog, rows[1].catalog);
    assert.equal(rows[2].catalog, rows[3].catalog);
    assert.notEqual(rows[0].catalog, rows[2].catalog);
    dispose.refresh('pc');
    await rows[2].catalog.load();
    assert.equal(calls.length, 3, 'Host refresh must not refetch once per session');
  } finally { dispose(); }
});
