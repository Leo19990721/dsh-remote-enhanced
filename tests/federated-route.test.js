import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerFederatedRoute } from '../federated-route.js';
import { installSessionCarrier } from '../client-carrier.js';
import { carrierRegistry } from './carrier-fixture.js';

// Isolated loopback HTTP test on an OS-assigned port. No user Host, profile,
// sessions, credentials or GUI are involved; the server closes within this test.
test('authenticated HTTP route drives native carrier calls and streams end to end', { timeout: 5000 }, async () => {
  let route; const disposers = [];
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const calls = [];
  const ctx = {
    connection: { admit: request => request.headers['x-test-owner'] === 'owner' ? { peer } : { rejection: 401 } },
    webServer: { register(value) { route = value; return () => {}; } },
    effect(factory) {
      const value = factory();
      if (typeof value === 'function') disposers.push(value);
      else for (const dispose of value) disposers.push(dispose);
    },
  };
  const raw = hostId => ({
    async call(endpoint, payload) {
      calls.push([hostId, endpoint, payload]);
      if (endpoint === 'session/openWorkspacePath') return { ok: true, value: { opened: true } };
      if (endpoint === 'remoteUploads/upload') return { ok: true, value: { status: 200, json: { ok: true, value: { receiptId: 'synthetic' } } } };
      return { ok: true, value: { sessionId: 's' } };
    },
    open() { return (async function* () { yield { type: 'snapshot', header: { id: 's' }, records: [] }; })(); },
  });
  let currentHost = 'local';
  const diagnostics = registerFederatedRoute(ctx, {
    baseHost: () => currentHost, hosts: async () => [{ hostId: 'remote', name: 'Remote-PC', online: true }],
    local: owner => { assert.equal(owner, peer); return raw('local'); },
    channels: { async retain(id) { return { ...raw(id), release: async () => {} }; } },
    descriptor: endpoint => ({ parameters: [{ wire: 'request', source: 'json', codec: { jsonSchema: { type: 'object', properties: endpoint === 'session/openWorkspacePath'
      ? { path: { type: 'string' }, action: { type: 'string', const: 'reveal' } } : { sessionId: { type: 'string' } } } } }], result: {} }),
  });
  const server = createServer((req, res) => { void route.handler(req, res).catch(error => { res.destroy(error); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/`;
  const send = (url, init) => fetch(new URL(url, base), { ...init, headers: { ...init.headers, 'x-test-owner': 'owner' } });
  const rpc = async (channel, method, payload, signal) => {
    const response = await send(channel.slice(1) + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }) });
    return (await response.json()).result;
  };
  let carrier, remoteBase;
  try {
    assert.equal((await fetch(base + 'dsh-session-hosts/attach', { method: 'POST' })).status, 401);
    const client = { typert: carrierRegistry(['session/rename', 'session/follow', 'session/openWorkspacePath']), connection: { rpc: { call: rpc } } };
    carrier = await installSessionCarrier(client, { fetch: send });
    assert.deepEqual(diagnostics(), [{ sockets: 0, hosts: [] }]);
    assert.doesNotMatch(JSON.stringify(diagnostics()), /sessionId|viewId|title/);
    const id = 'dsh-peer:' + JSON.stringify(['remote', 'session', 's']);
    const result = await client.connection.rpc.call('/api', 'session/rename', { args: { request: { sessionId: id } } });
    assert.equal(result.ok, true); assert.equal(calls[0][0], 'remote'); assert.equal(calls[0][2].args.request.sessionId, 's');
    const values = [];
    for await (const value of client.connection.rpc.open('/api', 'session/follow', { args: { request: { sessionId: id } } }, peer.signal)) values.push(value);
    assert.equal(values[0].header.id, id);
    const receipt = await carrier.postUpload({ path: '/api/files/upload?sessionId=' + encodeURIComponent(id) + '&name=test.txt', headers: { 'content-type': 'application/octet-stream' }, body: new Blob(['synthetic bytes']) });
    assert.equal(receipt.status, 200);
    assert.equal(JSON.parse(receipt.body).ok, true);
    assert.equal(calls.at(-1)[0], 'remote');
    assert.equal(calls.at(-1)[1], 'remoteUploads/upload');
    assert.equal(calls.at(-1)[2].args.payload.sessionId, 's');
    assert.equal(Buffer.from(calls.at(-1)[2].args.payload.data, 'base64').toString(), 'synthetic bytes');

    currentHost = 'remote';
    const remoteClient = { typert: client.typert, connection: { rpc: { call: rpc } } };
    remoteBase = await installSessionCarrier(remoteClient, { fetch: send });
    const savedPath = 'C:\\Downloads\\sample (1).txt';
    const count = calls.length;
    for (const adapter of [carrier, remoteBase]) {
      assert.equal(adapter.canRevealSavedFile, true);
      assert.deepEqual(await adapter.revealSavedFile(savedPath, peer.signal), { ok: true, value: { opened: true } });
    }
    assert.deepEqual(calls.slice(count), Array.from({ length: 2 }, () => [
      'local', 'session/openWorkspacePath', { args: { request: { path: savedPath, action: 'reveal' } } },
    ]));
    assert.equal(remoteBase.baseHost, 'remote');
    assert.equal(currentHost, 'remote');
    assert.equal(diagnostics().length, 2, 'temporary local reveal view was closed');
    await remoteClient.connection.rpc.call('/api', 'session/rename', { args: { request: { sessionId: 's' } } });
    assert.equal(calls.at(-1)[0], 'remote', 'native Session dispatch still uses the original view');
  } finally {
    await remoteBase?.dispose();
    await carrier?.dispose();
    for (const dispose of disposers.reverse()) await dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
