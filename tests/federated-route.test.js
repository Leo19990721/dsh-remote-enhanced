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
    async call(endpoint, payload) { calls.push([hostId, endpoint, payload]); return { ok: true, value: endpoint === 'remoteUploads/upload' ? { status: 200, json: { ok: true, value: { receiptId: 'synthetic' } } } : { sessionId: 's' } }; },
    open(endpoint, payload, signal) { return (async function* () { yield { type: 'snapshot', header: { id: 's' }, records: [] }; })(); },
  });
  const diagnostics = registerFederatedRoute(ctx, { baseHost: () => 'local', hosts: async () => [{ hostId: 'remote', name: 'Remote-PC', online: true }], local: () => raw('local'), channels: { async retain(id) { return { ...raw(id), release: async () => {} }; } }, descriptor: () => ({ parameters: [{ wire: 'request', codec: { jsonSchema: { type: 'object', properties: { sessionId: { type: 'string' } } } } }], result: {} }) });
  const server = createServer((req, res) => { void route.handler(req, res).catch(error => { res.destroy(error); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/`;
  const send = (url, init) => fetch(new URL(url, base), { ...init, headers: { ...init.headers, 'x-test-owner': 'owner' } });
  const rpc = async (channel, method, payload, signal) => {
    const response = await send(channel.slice(1) + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }) });
    return (await response.json()).result;
  };
  let carrier;
  try {
    assert.equal((await fetch(base + 'dsh-session-hosts/attach', { method: 'POST' })).status, 401);
    const client = { typert: carrierRegistry(), connection: { rpc: { call: rpc } } };
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
  } finally {
    await carrier?.dispose();
    for (const dispose of disposers.reverse()) await dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
