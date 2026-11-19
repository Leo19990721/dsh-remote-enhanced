import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remoteProfile } from './helpers/remote-profile.js';
import { installationHealth, assertInstallation, selfCheck } from '../federated-health.js';
import { apply } from '../native-host.js';
import manifest from '../package.json' with { type: 'json' };

async function context(t, { remoteVersion = '0.6.5', dshVersion, peerDshVersion = '0.2.2-rc.5' } = {}) {
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
  const runtime = { status: () => ({ mode: 'local' }), devices: async () => [{ deviceId: 'pc', name: 'Remote-PC', online: true, clientVersion: '0.6.5', harnessVersion: peerDshVersion }], gatewaySwitch: { local() {} }, withToolRemote() {}, remoteTypertGateway() {} };
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
test('incompatible install fails before command registration or transport changes', async t => {
  for (const version of ['0.6.4', '0.7.0']) {
    const ctx = await context(t, { remoteVersion: version }); let touched = 0;
    ctx.commands = { register() { touched++; } }; ctx.subagents = {};
    ctx.get = new Proxy(ctx.get, { apply(target, self, args) { return args[0] === 'commands' ? ctx.commands : args[0] === 'subagents' ? ctx.subagents : target(...args); } });
    ctx.effect = () => { touched++; };
    const original = ctx.dshRemoteClient.withToolRemote;
    await assert.rejects(apply(ctx), error => error.code === 'session-hosts/incompatible' && /0\.6\.5/.test(error.message));
    assert.equal(touched, 0); assert.equal(ctx.dshRemoteClient.withToolRemote, original);
  }
});
test('local launch anchor and remote metadata use the same prerelease-inclusive DSH bounds', async t => {
  for (const [version, state] of [
    ['0.2.2-rc.2', 'fail'], ['0.2.2-rc.3', 'pass'], ['0.2.2-rc.4', 'pass'], ['0.2.2-rc.5', 'pass'],
    ['0.2.2', 'pass'], ['0.2.3-alpha.1', 'pass'], ['0.2.9', 'pass'],
    ['0.3.0-0', 'fail'], ['0.3.0-alpha.1', 'fail'], ['0.3.0', 'fail'],
  ]) {
    const ctx = await context(t, { dshVersion: version, peerDshVersion: version });
    const health = await installationHealth(ctx);
    const result = await selfCheck(ctx, {}, {}, new AbortController().signal);
    for (const checks of [health.checks, result.hosts[0].checks]) {
      assert.deepEqual(checks.find(row => row.id === 'dshVersion'), {
        id: 'dshVersion', state, expected: manifest.engines.dsh, actual: version,
      });
    }
    if (state === 'fail') await assert.rejects(assertInstallation(ctx), { code: 'session-hosts/incompatible' });
    else assert.equal((await assertInstallation(ctx)).state, 'pass');
  }
});
test('unknown remote DSH version remains visible and an out-of-range Host is not probed', async t => {
  const ctx = await context(t);
  ctx.dshRemoteClient.devices = async () => [
    { deviceId: 'unknown', online: true, clientVersion: '0.6.5' },
    { deviceId: 'outside', online: true, clientVersion: '0.6.5', harnessVersion: '0.3.0-alpha.1' },
    { deviceId: 'invalid', online: true, clientVersion: '0.6.5', harnessVersion: 'not-semver' },
  ];
  const result = await selfCheck(ctx, {}, {}, new AbortController().signal);
  assert.deepEqual(result.hosts.map(host => host.checks.find(row => row.id === 'dshVersion').state), ['unknown', 'fail', 'fail']);
  const blocked = await selfCheck(ctx, { channels: { retain() { assert.fail('unsupported Host must not be probed'); } } }, { hostId: 'outside' }, new AbortController().signal);
  assert.equal(blocked.hosts[0].checks.find(row => row.id === 'connection').state, 'unknown');
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
