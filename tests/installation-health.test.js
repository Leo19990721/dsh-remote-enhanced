import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remoteProfile } from './helpers/remote-profile.js';
import { installationHealth, assertInstallation, selfCheck } from '../federated-health.js';
import { apply } from '../native-host.js';
import manifest from '../package.json' with { type: 'json' };

async function context(t, { remoteVersion = '0.6.5', dshVersion, peerRemoteVersion = '0.6.5', peerDshVersion = '0.2.2-rc.5' } = {}) {
  const dir = await remoteProfile(t, { version: remoteVersion });
  const profile = { dir };
  if (dshVersion !== undefined) {
    const installation = join(dir, 'fixture-installation');
    const boot = join(installation, 'node_modules', '@deepseek-ai', 'dsh-app-boot');
    await mkdir(boot, { recursive: true });
    await writeFile(join(boot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', type: 'module', exports: './index.js' }));
    await writeFile(join(boot, 'index.js'), `export const getDshRuntimeVersion=()=> ${JSON.stringify(dshVersion)};`);
    profile.installAnchor = join(installation, 'package.json');
  }
  const runtime = { status: () => ({ mode: 'local' }), devices: async () => [{ deviceId: 'pc', name: 'Remote-PC', online: true, clientVersion: peerRemoteVersion, harnessVersion: peerDshVersion }], gatewaySwitch: { local() {} }, withToolRemote() {}, remoteTypertGateway() {} };
  return { dshRemoteClient: runtime, get: name => name === 'profileContext' ? profile : undefined };
}
test('installation checks report compatibility without loading the Remote runtime', async t => {
  const ctx = await context(t), result = await installationHealth(ctx);
  assert.equal(result.version, manifest.version);
  assert.equal(result.checks.find(row => row.id === 'remoteVersion').state, 'pass');
  assert.equal(result.checks.find(row => row.id === 'carrier').state, 'pass');
  assert.equal(result.checks.find(row => row.id === 'dshVersion').state, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /Users|profile|synthetic-remote/);
  await assertInstallation(ctx);
});
test('missing carrier interfaces fail before command registration or transport changes, regardless of version', async t => {
  for (const [remoteVersion, missing] of [['0.6.5', 'withToolRemote'], ['0.6.7', 'remoteTypertGateway'], ['0.7.0', 'gatewaySwitch']]) {
    const ctx = await context(t, { remoteVersion }); let touched = 0;
    ctx.commands = { register() { touched++; } }; ctx.subagents = {};
    ctx.get = new Proxy(ctx.get, { apply(target, self, args) { return args[0] === 'commands' ? ctx.commands : args[0] === 'subagents' ? ctx.subagents : target(...args); } });
    ctx.effect = () => { touched++; };
    delete ctx.dshRemoteClient[missing];
    const original = ctx.dshRemoteClient.withToolRemote;
    await assert.rejects(apply(ctx), { code: 'session-hosts/incompatible', message: /原生 Harness 连接接口/ });
    assert.equal(touched, 0); assert.equal(ctx.dshRemoteClient.withToolRemote, original);
  }
});
test('mixed Remote versions only affect metadata, not activation or the live Host probe', async t => {
  for (const [remoteVersion, peerRemoteVersion] of [['0.6.5', '0.6.7'], ['0.6.7', '0.6.5'], ['0.7.0-rc.1', '0.6.4'], ['custom-build', 'development']]) {
    const ctx = await context(t, { remoteVersion, peerRemoteVersion, dshVersion: '0.2.2-rc.5' });
    assert.deepEqual((await assertInstallation(ctx)).checks.find(row => row.id === 'remoteVersion'), { id: 'remoteVersion', state: 'pass', actual: remoteVersion });
    let acquired = 0, released = 0;
    const channels = { async retain(hostId) {
      assert.equal(hostId, 'pc'); acquired++;
      return { query: (op, signal) => op({ client: { rpc: async () => ({ capabilities: ['harness.remote.v3'] }) } }, signal), release() { released++; } };
    } };
    const result = await selfCheck(ctx, { channels }, { hostId: 'pc' }, new AbortController().signal);
    const checks = result.hosts[0].checks;
    assert.deepEqual(checks.find(row => row.id === 'remoteVersion'), { id: 'remoteVersion', state: 'pass', actual: peerRemoteVersion });
    assert.equal(checks.find(row => row.id === 'connection').state, 'pass');
    assert.equal(checks.find(row => row.id === 'carrier').state, 'pass');
    assert.equal(acquired, 1); assert.equal(released, 1);
  }
});
test('nonempty Remote metadata counts as present without echoing unsafe text', async t => {
  const ctx = await context(t, { remoteVersion: 'custom build\nwith controls', peerRemoteVersion: 'x'.repeat(81) });
  const result = await selfCheck(ctx, {}, {}, new AbortController().signal);
  for (const checks of [result.local.checks, result.hosts[0].checks]) {
    assert.deepEqual(checks.find(row => row.id === 'remoteVersion'), { id: 'remoteVersion', state: 'pass' });
  }
});
test('unknown Remote version metadata does not block a live probe or hide missing gateway capability', async t => {
  const ctx = await context(t, { remoteVersion: null, peerRemoteVersion: null });
  const actual = (await assertInstallation(ctx)).checks.find(row => row.id === 'remoteVersion');
  assert.deepEqual(actual, { id: 'remoteVersion', state: 'unknown' });
  const channels = { retain: async () => ({ query: (op, signal) => op({ client: { rpc: async () => ({ capabilities: [] }) } }, signal), release() {} }) };
  const result = await selfCheck(ctx, { channels }, { hostId: 'pc' }, new AbortController().signal);
  const checks = result.hosts[0].checks;
  assert.deepEqual(checks.find(row => row.id === 'remoteVersion'), actual);
  assert.equal(checks.find(row => row.id === 'connection').state, 'pass');
  assert.equal(checks.find(row => row.id === 'carrier').state, 'fail');
  assert.equal(result.state, 'fail');
});
test('local and remote DSH version metadata is reported without a version gate', async t => {
  for (const version of ['0.2.2-rc.2', '0.2.2-rc.5', '0.2.2', '0.3.0-rc.1', '0.3.0', '2.0.0']) {
    const ctx = await context(t, { dshVersion: version, peerDshVersion: version });
    const health = await installationHealth(ctx);
    const result = await selfCheck(ctx, {}, {}, new AbortController().signal);
    for (const checks of [health.checks, result.local.checks, result.hosts[0].checks]) {
      assert.deepEqual(checks.find(row => row.id === 'dshVersion'), {
        id: 'dshVersion', state: 'pass', actual: version,
      });
    }
    assert.equal((await assertInstallation(ctx)).state, 'pass');
  }
});
test('missing or invalid DSH metadata remains unknown and an older Host can be probed', async t => {
  const ctx = await context(t);
  ctx.dshRemoteClient.devices = async () => [
    { deviceId: 'unknown', online: true, clientVersion: '0.6.5' },
    { deviceId: 'older', online: true, clientVersion: '0.6.5', harnessVersion: '0.2.2-rc.2' },
    { deviceId: 'invalid', online: true, clientVersion: '0.6.5', harnessVersion: 'not-semver' },
  ];
  const result = await selfCheck(ctx, {}, {}, new AbortController().signal);
  assert.deepEqual(result.hosts.map(host => host.checks.find(row => row.id === 'dshVersion').state), ['unknown', 'pass', 'unknown']);
  let acquired = 0;
  const channels = { async retain(hostId) {
    assert.equal(hostId, 'older'); acquired++;
    return { query: (op, signal) => op({ client: { rpc: async () => ({ capabilities: ['harness.remote.v3'] }) } }, signal), release() {} };
  } };
  const checked = await selfCheck(ctx, { channels }, { hostId: 'older' }, new AbortController().signal);
  assert.equal(acquired, 1);
  assert.equal(checked.hosts[0].checks.find(row => row.id === 'connection').state, 'pass');
});
test('self-check reads only authorized metadata and releases its own channel', async t => {
  const ctx = await context(t); const calls = []; let releases = 0;
  const channels = { async retain(hostId, signal) { assert.equal(hostId, 'pc'); signal.throwIfAborted(); return {
    query: async operation => operation({ features: { remoteGateway: true, terminal: true }, client: { rpc: async (method, payload) => { calls.push([method, payload]); return { capabilities: ['harness.remote.v3'] }; } } }, signal),
    call: async (endpoint, payload) => { calls.push([endpoint, payload]); return { ok: true, value: [] }; },
    release: async () => { releases++; },
  }; } };
  const result = await selfCheck(ctx, { channels }, { hostId: 'pc', sessionId: 'root' }, new AbortController().signal);
  assert.equal(result.hosts[0].checks.find(row => row.id === 'remoteVersion').state, 'pass');
  assert.equal(result.hosts[0].checks.find(row => row.id === 'terminal').state, 'warn');
  assert.equal(result.hosts[0].checks.find(row => row.id === 'childStop').state, 'warn');
  assert.deepEqual(calls, [['harness.transport.describe', {}], ['commands/list', { args: { agentId: 'root' } }]]); assert.equal(releases, 1);
  assert.doesNotMatch(JSON.stringify(result), /root|credential|token|sessionId/);
  const directory = await selfCheck(ctx, { channels: { retain() { throw new Error('Must not connect'); } } }, {}, new AbortController().signal);
  assert.equal(directory.hosts[0].checks.find(row => row.id === 'connection').state, 'unknown');
});
test('a cached live feature cannot turn a failed roundtrip into connection success', async t => {
  const ctx = await context(t); let released = 0;
  const channels = { retain: async () => ({
    query: async operation => operation({ features: { remoteGateway: true, terminal: true }, client: { rpc: async () => { throw Object.assign(new Error('SECRET stale socket'), { code: 'CONNECTION_CLOSED' }); } } }, new AbortController().signal),
    release: async () => { released++; },
  }) };
  const result = await selfCheck(ctx, { channels }, { hostId: 'pc' }, new AbortController().signal);
  const checks = result.hosts[0].checks;
  assert.deepEqual(checks.filter(row => row.id === 'connection').map(row => row.state), ['fail']);
  assert.equal(released, 1); assert.doesNotMatch(JSON.stringify(result), /SECRET|stale socket/);
});
test('command-directory failure has one child check and no contradictory connection results', async t => {
  const ctx = await context(t);
  const channels = { retain: async () => ({
    query: async operation => operation({ client: { rpc: async () => ({ capabilities: ['harness.remote.v3'] }) } }, new AbortController().signal),
    call: async () => { throw Object.assign(new Error('SECRET'), { code: 'gateway/forbidden' }); }, release: async () => {},
  }) };
  const result = await selfCheck(ctx, { channels }, { hostId: 'pc', sessionId: 'root' }, new AbortController().signal);
  assert.deepEqual(result.hosts[0].checks.filter(row => row.id === 'connection').map(row => row.state), ['pass']);
  assert.equal(result.hosts[0].checks.find(row => row.id === 'childStop').state, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});
test('caller cancellation releases the self-check lease and never reports a late pass', async t => {
  const ctx = await context(t), stop = new AbortController(), started = Promise.withResolvers(); let released = 0;
  const channels = { retain: async () => ({ query: async () => { started.resolve(); await new Promise((_, reject) => stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true })); }, release: async () => { released++; } }) };
  const checking = selfCheck(ctx, { channels }, { hostId: 'pc' }, stop.signal);
  await started.promise; stop.abort(); await assert.rejects(checking); assert.equal(released, 1);
});
test('offline and failed discovery remain explicit and never acquire unlisted Hosts', async t => {
  const ctx = await context(t); let acquired = 0; const channels = { retain() { acquired++; throw new Error('SECRET'); } };
  ctx.dshRemoteClient.devices = async () => [{ deviceId: 'pc', name: 'Remote-PC', online: false }];
  const offline = await selfCheck(ctx, { channels }, { hostId: 'pc' }, new AbortController().signal);
  assert.equal(offline.hosts[0].checks.find(row => row.id === 'connection').state, 'fail'); assert.equal(acquired, 0);
  ctx.dshRemoteClient.devices = async () => { throw Object.assign(new Error('SECRET'), { code: 'RATE_LIMITED' }); };
  const failed = await selfCheck(ctx, { channels }, {}, new AbortController().signal);
  assert.equal(failed.discovery.reason, 'rateLimited'); assert.doesNotMatch(JSON.stringify(failed), /SECRET/);
});
