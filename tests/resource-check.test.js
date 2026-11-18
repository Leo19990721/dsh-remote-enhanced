import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSessionResources } from '../federated-resource-check.js';
import { LoopbackPreview } from '../federated-preview-transport.js';
import { WebSocketServer } from 'ws';
const signal = new AbortController().signal, peer = { principal: { kind: 'owner' }, signal };
function fixture(ports = [41788]) {
  const requests = [], api = [];
  const options = { hosts: async () => [{ hostId: 'pc', name: 'PC', online: true }], channels: { retain: async () => ({
    call: async (endpoint, payload) => { api.push([endpoint, payload]); return { ok: true, value: { path: '.', entries: [{ name: 'private-name' }], truncated: false } }; },
    query: async callback => callback({ client: { rpc: async (_method, value) => { requests.push(value); return value.op === 'describe' ? { ports } : value.op === 'http.open' ? { status: 200, headers: [['x-private', 'secret']] } : value.op === 'http.read' ? { data: '', done: true } : {}; } } }, signal), release: async () => {},
  }) }, descriptor: () => ({ parameters: [{ source: 'lookup', lookup: 'workspaceFileScope', wire: 'workspaceFileScopeId' }], result: {} }) };
  return { options, requests, api };
}
test('resource acceptance checks use owning Session and return only safe metadata', async () => {
  const { options, requests, api } = fixture();
  const result = await checkSessionResources(options, { hostId: 'pc', sessionId: 's', path: '.', url: 'http://localhost:41788/map?q=1' }, signal, peer);
  assert.deepEqual(result.file, { ok: true, kind: 'directory', entries: 1, truncated: false });
  assert.deepEqual(result.page, { port: 41788, allowed: true, ok: true, httpStatus: 200 });
  assert.equal(api[0][1].args.workspaceFileScopeId, 's');
  assert.equal(requests.find(row => row.op === 'http.open').method, 'HEAD');
  assert.equal(requests.at(-1).op, 'close');
  assert.doesNotMatch(JSON.stringify(result), /private-name|secret|x-private/);
});
test('GET-only pages are probed safely after HEAD is unsupported without returning bodies', async () => {
  const { options, requests } = fixture();
  options.channels.retain = async () => ({ query: async callback => callback({ client: { rpc: async (_method, value) => {
    requests.push(value);
    if (value.op === 'describe') return { ports: [41788] };
    if (value.op === 'http.open') return { status: value.method === 'HEAD' ? 405 : 200, headers: [] };
    return {};
  } } }, signal), release: async () => {} });
  const result = await checkSessionResources(options, { hostId: 'pc', sessionId: 's', url: 'http://localhost:41788/' }, signal, peer);
  assert.equal(result.page.httpStatus, 200); assert.equal(result.page.method, 'GET');
  assert.deepEqual(requests.filter(row => row.op === 'http.open').map(row => row.method), ['HEAD', 'GET']);
  assert.equal(requests.filter(row => row.op === 'close').length, 2);
  assert.ok(!requests.some(row => row.op === 'http.read'));
});
test('resource acceptance probes the same isolated preview listener used by native tabs', async () => {
  const { options, requests } = fixture();
  let preview;
  options.createPreview = client => (preview = new LoopbackPreview(client, WebSocketServer));
  const result = await checkSessionResources(options, { hostId: 'pc', sessionId: 's', url: 'http://localhost:41788/' }, signal, peer);
  assert.equal(result.page.preview?.ok, true);
  assert.equal(result.page.preview.httpStatus, 200);
  assert.equal(requests.filter(row => row.op === 'describe').length, 2, 'probe must pass the actual preview authorization gate');
  assert.equal(requests.filter(row => row.op === 'close').length, 2);
  assert.equal(preview.servers.size, 0); assert.equal(preview.sockets.size, 0);
  assert.ok(requests.some(row => row.op === 'http.read'), 'preview acceptance must drain through EOF');
  assert.equal(result.page.preview.complete, true); assert.equal(result.page.preview.bytes, 0);
});
test('isolated preview probe supports a real GET-only upstream and disposes its listener', async () => {
  const { options, requests } = fixture(); let preview;
  options.channels.retain = async () => ({ query: async callback => callback({ client: { rpc: async (_method, value) => {
    requests.push(value);
    if (value.op === 'describe') return { ports: [41788] };
    if (value.op === 'http.open') return { status: value.method === 'HEAD' ? 404 : 200, headers: [] };
    if (value.op === 'http.read') return { data: Buffer.from('private fixture body').toString('base64'), done: true };
    return {};
  } } }, signal), release: async () => {} });
  options.createPreview = client => (preview = new LoopbackPreview(client, WebSocketServer));
  const result = await checkSessionResources(options, { hostId: 'pc', sessionId: 's', url: 'http://localhost:41788/' }, signal, peer);
  assert.deepEqual(result.page.preview, { ok: true, method: 'GET', httpStatus: 200, bytes: 20, complete: true });
  assert.doesNotMatch(JSON.stringify(result), /private|fixture|body/);
  assert.equal(preview.servers.size, 0); assert.equal(preview.sockets.size, 0);
});
test('preview acceptance must detect a response truncated after successful headers', async () => {
  const { options } = fixture(); let reads = 0, preview;
  options.channels.retain = async () => ({ query: async callback => callback({ client: { rpc: async (_method, value) => {
    if (value.op === 'describe') return { ports: [41788] };
    if (value.op === 'http.open') return { status: 200, headers: [] };
    if (value.op === 'http.read') {
      if (!reads++) return { data: Buffer.from('private-partial-body').toString('base64'), done: false };
      throw Object.assign(new Error('private source detail'), { code: 'LOOPBACK_READ_FAILED' });
    }
    return {};
  } } }, signal), release: async () => {} });
  options.createPreview = client => (preview = new LoopbackPreview(client, WebSocketServer));
  const result = await checkSessionResources(options, { hostId: 'pc', sessionId: 's', url: 'http://localhost:41788/' }, signal, peer);
  assert.equal(result.page.preview.ok, false, '200 response headers cannot prove a complete page');
  assert.doesNotMatch(JSON.stringify(result), /private|partial|source detail/);
  assert.equal(preview.servers.size, 0); assert.equal(preview.sockets.size, 0);
});
test('resource check never contacts a forbidden port or bypasses owner authorization', async () => {
  const { options, requests } = fixture([]);
  const result = await checkSessionResources(options, { hostId: 'pc', sessionId: 's', url: 'http://localhost:41788/' }, signal, peer);
  assert.equal(result.page.code, 'LOOPBACK_PORT_DENIED'); assert.equal(requests.length, 1);
  await assert.rejects(checkSessionResources(options, { hostId: 'pc', sessionId: 's' }, signal, { principal: { kind: 'guest' } }), /OWNER_REQUIRED/);
});
test('resource diagnostics never return a transport error message containing source details', async () => {
  const { options } = fixture();
  options.channels.retain = async () => { throw new Error('private path C:/sensitive'); };
  const result = await checkSessionResources(options, { hostId: 'pc', sessionId: 's', path: '.' }, signal, peer);
  assert.deepEqual(result.file, { ok: false, code: 'UNAVAILABLE' }); assert.doesNotMatch(JSON.stringify(result), /sensitive/);
});
