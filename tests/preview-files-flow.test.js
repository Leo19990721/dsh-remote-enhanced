import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { registerFederatedRoute } from '../federated-route.js';
import { LoopbackPreview } from '../federated-preview-transport.js';
import { installSessionCarrier } from '../client-carrier.js';
import { carrierRegistry } from './carrier-fixture.js';
const sessionId = 'dsh-peer:' + JSON.stringify(['pc', 'session', 'original']);
function pagePost(url, value) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: parsed.port, path: '/open', method: 'POST', headers: {
      host: parsed.host, origin: parsed.origin, 'content-type': 'application/json',
    } }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode, text })); response.on('error', reject); });
    req.on('error', reject); req.end(JSON.stringify(value));
  });
}

for (const mux of [false, true]) test(`owner-bound preview action uses ${mux ? 'multiplexed socket' : 'HTTP fallback'} and never executes remote open`, { timeout: 5000 }, async () => {
  const stop = new AbortController(), peer = { principal: { kind: 'owner' }, signal: stop.signal }, cleanup = [], calls = [];
  let route, upgrade;
  const ctx = {
    connection: { admit: req => req.headers['x-synthetic-owner'] === 'yes' ? { peer } : { rejection: 401 } },
    webServer: { register(value) { route = value; return () => {}; }, registerUpgrade(value) { upgrade = value; return () => {}; } },
    effect(factory) { const value = factory(); cleanup.push(...typeof value === 'function' ? [value] : value); },
  };
  registerFederatedRoute(ctx, { WebSocketServer: mux ? WebSocketServer : undefined, baseHost: () => 'local', descriptor: () => undefined,
    filePreviewTargets: [{ hostId: 'pc', port: 41788, path: '/' }], hosts: async () => [], local: () => { throw new Error('must never call local'); },
    channels: { retain: async host => ({ query: operation => operation({ client: { rpc: async (method, payload) => {
      calls.push({ host, method, payload });
      if (payload.op === 'describe') return { ports: [41788] };
      if (payload.op === 'close') return {};
      throw new Error('webpage proposal must not open remote files or APIs');
    } } }, stop.signal), release: async () => {} }) },
    createPreview: (client, options) => new LoopbackPreview(client, WebSocketServer, options),
  });
  const server = createServer((req, res) => { void route.handler(req, res).catch(error => res.destroy(error)); });
  if (mux) server.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/`;
  const send = (url, init = {}) => fetch(new URL(url, base), { ...init, headers: { ...init.headers, 'x-synthetic-owner': 'yes' } });
  const rpc = async (channel, method, payload, signal) => {
    const response = await send(channel.slice(1) + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId: 'synthetic', method, payload }) });
    return (await response.json()).result;
  };
  let carrier, iterator, view2;
  const followStop = new AbortController();
  try {
    carrier = await installSessionCarrier({ typert: carrierRegistry([]), connection: { rpc: { call: rpc },
      ...mux ? { openWebSocket: path => new WebSocket(new URL(path, base).href.replace(/^http:/, 'ws:'), { headers: { 'x-synthetic-owner': 'yes' } }) } : {} } }, { fetch: send });
    const opened = await carrier.previewOpen(sessionId, 'http://localhost:41788/', 'tab', stop.signal, { fileMode: true });
    assert.equal(opened.ok, true);
    iterator = carrier.previewFiles('tab', followStop.signal)[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, { pending: null });
    const resource = { path: 'D:\\Synthetic\\same.pdf', kind: 'file' };
    const posted = await pagePost(opened.value.url, resource);
    assert.equal(posted.status, 409); assert.doesNotMatch(posted.text, /same.pdf|original|dsh-peer|bytes/);
    const pending = (await iterator.next()).value.pending;
    assert.equal(pending.path, resource.path);
    view2 = await rpc('/dsh-session-hosts', 'attach', {});
    const unauthorized = await fetch(base + 'dsh-session-hosts/previewFileClaim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401);
    const crossed = await rpc('/dsh-session-hosts', 'previewFileClaim', { viewId: view2.value.viewId, leaseId: 'tab', actionId: pending.id });
    assert.equal(crossed.ok, false, 'another owner view cannot consume this tab action');
    const claimed = await carrier.previewFileClaim('tab', pending.id, stop.signal);
    assert.deepEqual(claimed, { ok: true, value: { sessionId, ...resource } });
    assert.equal((await carrier.previewFileClaim('tab', pending.id)).ok, false);
    assert.deepEqual((await iterator.next()).value, { pending: null });
    assert.deepEqual(calls.map(value => [value.host, value.payload.op]), [['pc', 'describe']], 'confirmation flow performs no native IO');
    followStop.abort(); await iterator.return(); iterator = undefined;
    await carrier.previewClose('tab');
    await assert.rejects(pagePost(opened.value.url, resource));
  } finally {
    followStop.abort(); await iterator?.return().catch(() => {});
    if (view2?.ok) await rpc('/dsh-session-hosts', 'close', { viewId: view2.value.viewId });
    await carrier?.dispose(); stop.abort();
    for (const dispose of cleanup.reverse()) if (typeof dispose === 'function') await dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
