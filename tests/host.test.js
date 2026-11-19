import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../native-host.js';
import * as adapter from '../remote-adapter.js';
import { readFile } from 'node:fs/promises';
import { createRemoteReader } from '../remote-adapter.js';
import { WebSocketServer } from 'ws';
import { remoteProfile } from './helpers/remote-profile.js';

test('host RPC rejects non-owner and shares read operations with the tool', async t => {
  const profileDirectory = await remoteProfile(t);
  let route, tool; const routes = [];
  const disposers = [];
  const ctx = {
    root: { baseDir: profileDirectory },
    effect: factory => { const disposer = factory(); if (typeof disposer === 'function') disposers.push(disposer); else if (disposer?.[Symbol.iterator]) for (const item of disposer) if (typeof item === 'function') disposers.push(item); return () => {}; },
    connection: { admit: request => request.admission },
    webServer: { register: value => { routes.push(value); if (value.path === '/dsh-remote-workspaces') route = value; return () => {}; }, registerUpgrade: () => () => {} },
    tools: { register: value => { tool = value; return () => {}; } },
    dshRemoteClient: { status: () => ({ mode: 'local' }), gatewaySwitch: { local() {} }, withToolRemote() {}, remoteTypertGateway() {} },
    typert: { remotes: { get() {} }, local: { get() {} } },
    get: name => name === 'profileContext' ? { dir: profileDirectory } : name === 'dshRemoteClient' ? ctx.dshRemoteClient : undefined,
  };
  await apply(ctx);
  const signal = new AbortController().signal;
  const { Readable } = await import('node:stream');
  const { EventEmitter } = await import('node:events');
  async function request(kind, action = 'status') {
    const req = Readable.from([JSON.stringify({ type: 'client-request', rpcId: 'test', method: action, payload: {} })]);
    Object.assign(req, { url: '/dsh-remote-workspaces/' + action, method: 'POST', headers: { 'content-type': 'application/json' }, admission: { peer: { principal: { kind } } } });
    const res = Object.assign(new EventEmitter(), { writeHead(code) { this.code = code; }, end(body) { this.body = body; this.writableEnded = true; } });
    await route.handler(req, res);
    return res;
  }
  const denied = await request('member');
  assert.equal(denied.code, 403);
  const allowed = JSON.parse((await request('owner')).body).result;
  const same = await tool.execute({ action: 'status' }, { signal });
  assert.equal(allowed.ok, true); assert.deepEqual(allowed.value, same);
  ctx.dshRemoteClient.devices = async () => [];
  const checked = await request('owner', 'selfCheck');
  assert.equal(checked.code, 200);
  assert.deepEqual(JSON.parse(checked.body).result.value, await tool.execute({ action: 'selfCheck' }, { signal }));
  assert.equal((await request('member', 'selfCheck')).code, 403);
  for (const disposer of disposers.reverse()) await disposer();
});
test('profile location follows the operating computer instead of a copied old path', async () => {
  for (const dir of ['C:/Users/another-user/.dsh/profiles/desktop', 'D:/Harness Data/profiles/work']) {
    assert.equal(adapter.remoteProfileDirectory({ get: name => name === 'profileContext' ? { dir } : undefined }, { profileDirectory: 'C:/old-computer/profile' }), dir);
  }
  assert.equal(adapter.remoteProfileDirectory({ get: () => undefined }, { profileDirectory: 'D:/explicit/profile' }), 'D:/explicit/profile');
  assert.throws(() => adapter.remoteProfileDirectory({ get: () => undefined }), /profile directory unavailable/);
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(patch, /profileDirectory|C:\/|Users|Leo/);
  assert.match(patch, /filePreviewTargets:\s*\[\]/);
});
test('adapter uses its declared WebSocket dependency without loading a profile runtime', async t => {
  const profileDirectory = await remoteProfile(t);
  assert.equal(adapter.loadWebSocketServer(profileDirectory), WebSocketServer);
  assert.equal(adapter.loadWebSocketServer(), WebSocketServer);
  const createPreview = await adapter.loadLoopbackPreview(profileDirectory);
  const preview = createPreview({});
  await preview.close();
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.dependencies, { semver: '7.8.6', ws: '8.18.3' });
  assert.equal(manifest.peerDependencies['ds-harness-remote'], '0.6.5');
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.3');
  assert.equal(manifest.engines.node, '>=24');
});
test('adapter rejects an unverified Remote manifest before using a carrier', async t => {
  const profileDirectory = await remoteProfile(t, { version: '0.6.4' });
  await assert.rejects(createRemoteReader(profileDirectory), /verified Remote 0\.6\.5/);
  await assert.rejects(adapter.loadLoopbackPreview(profileDirectory), /verified Remote 0\.6\.5/);
});
test('adapter reads metadata through Remote carrier and closes only its own follow stream', async t => {
  const reader = await createRemoteReader(await remoteProfile(t));
  const operations = [];
  const client = {
    withToolRemote: async (hostId, signal, query) => {
      operations.push(['carrier', hostId]);
      return query({ features: { remoteGateway: true } }, signal);
    },
    remoteTypertGateway: () => ({
      open: async (endpoint, payload, signal) => {
        operations.push(['open', endpoint, payload]);
        return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: { type: 'baseline', value: { items: [{ workspaceId: 'w' }], archivedSessionIds: ['hidden'] } } }), return: async () => { assert.equal(signal.aborted, true); operations.push(['close-follow']); return { done: true }; } }) };
      },
      invoke: async request => { operations.push(['invoke', request.namespace, request.method]); return { items: [{ sessionId: 's' }] }; },
    }),
  };
  const result = await reader(client, 'remote', new AbortController().signal);
  assert.deepEqual(result.archivedSessionIds, ['hidden']); assert.equal(result.sessions[0].sessionId, 's');
  assert.deepEqual(operations.map(row => row[0]), ['carrier', 'open', 'close-follow', 'invoke']);
  assert.deepEqual(operations.at(-1), ['invoke', 'session', 'list']);
});
