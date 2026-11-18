import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionPreviews } from '../federated-previews.js';
import { SurfaceIdentities } from '../federated-identities.js';

test('only the configured map Host port and entry can opt into file actions', async () => {
  const stop = new AbortController(), peer = { principal: { kind: 'owner' } }, created = [];
  const manager = new SessionPreviews({ owner() {}, identities: new SurfaceIdentities('local') }, peer,
    (_client, options) => { created.push(options); return { open: async () => ({ url: 'http://dsh-synthetic.localhost:1234/' }), close: async () => {} }; },
    stop.signal, { filePreviewTargets: [{ hostId: 'map-pc', port: 41788, path: '/' }] });
  const id = host => 'dsh-peer:' + JSON.stringify([host, 'session', 's']);
  try {
    for (const [host, url] of [['other-pc', 'http://localhost:41788/'], ['map-pc', 'http://localhost:41789/'], ['map-pc', 'http://localhost:41788/other']]) {
      const ordinary = await manager.open(id(host), url, 'tab', stop.signal);
      assert.equal(ordinary.filePreviewAvailable, false); assert.equal(created.at(-1), undefined);
      await assert.rejects(manager.open(id(host), url, 'files', stop.signal, { fileMode: true }), /未配置/);
    }
    const configured = await manager.open(id('map-pc'), 'http://127.0.0.1:41788/', 'tab', stop.signal);
    assert.equal(configured.filePreviewAvailable, true);
    await manager.open(id('map-pc'), 'http://localhost:41788/', 'files', stop.signal, { fileMode: true });
    assert.equal(typeof created.at(-1).onFileRequest, 'function');
  } finally { await manager.close(); }
});
