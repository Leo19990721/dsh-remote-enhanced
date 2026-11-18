import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadForSession } from '../federated-uploads.js';
import { SurfaceIdentities } from '../federated-identities.js';

test('local and remote raw uploads retain the exact Session and receipt owner', async () => {
  const ids = new SurfaceIdentities(), calls = [], signal = new AbortController().signal;
  const gateway = { identities: ids, owner() {}, async channel(hostId) { return { async call(endpoint, payload) { calls.push([hostId, endpoint, payload]); return { ok: true, value: { status: 200, json: { ok: true, value: { receiptId: 'remote-receipt' } } } }; }, release: async () => {} }; } };
  const service = { async uploadStream(request) { const chunks = []; for await (const chunk of request.data) chunks.push(chunk); calls.push(['local', request.sessionId, Buffer.concat(chunks).toString()]); return { receiptId: 'local-receipt' }; } };
  const chunks = () => (async function* () { yield Buffer.from('file bytes'); })();
  assert.equal((await uploadForSession(gateway, service, new URLSearchParams({ sessionId: 'same' }), chunks(), signal, {})).value.receiptId, 'local-receipt');
  assert.equal((await uploadForSession(gateway, service, new URLSearchParams({ sessionId: ids.encode('remote', 'session', 'same'), mediaType: 'image/png', name: 'image.png' }), chunks(), signal, {})).value.receiptId, 'remote-receipt');
  assert.deepEqual(calls[0], ['local', 'same', 'file bytes']);
  assert.equal(calls[1][0], 'remote'); assert.equal(calls[1][1], 'remoteUploads/upload');
  assert.deepEqual(calls[1][2].args, { endpoint: 'image', payload: { sessionId: 'same', data: Buffer.from('file bytes').toString('base64'), name: 'image.png', mediaType: 'image/png' } });
});
