import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { connectionIssue } from './federated-connection.js';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));
const row = (id, state, facts = {}) => ({ id, state, ...facts });
// Versions are diagnostic metadata. The required carrier interfaces determine compatibility.
function versionMetadata(id, value) {
  const present = typeof value === 'string' && value.trim().length > 0;
  const safe = present && value.length <= 80 && (id === 'dshVersion' ? semver.valid(value) : /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(value));
  return row(id, (id === 'dshVersion' ? safe : present) ? 'pass' : 'unknown', safe ? { actual: value } : {});
}
const stateOf = checks => checks.some(check => check.state === 'fail') ? 'fail' : checks.some(check => check.state !== 'pass') ? 'warn' : 'pass';

export async function installationHealth(ctx) {
  const profile = ctx.get('profileContext'), checks = [];
  let dshVersion;
  if (profile?.installAnchor) {
    try {
      const require = createRequire(profile.installAnchor);
      const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
      dshVersion = boot.getDshRuntimeVersion();
    } catch { /* The missing version is reported as unknown. */ }
  }
  checks.push(versionMetadata('dshVersion', dshVersion));
  let remoteVersion;
  if (profile?.dir) {
    try {
      const require = createRequire(join(profile.dir, 'package.json'));
      remoteVersion = require('ds-harness-remote/package.json').version;
    } catch { /* Do not load Remote code to read its manifest. */ }
  }
  checks.push(versionMetadata('remoteVersion', remoteVersion));
  const runtime = ctx.dshRemoteClient;
  checks.push(row('carrier', ['withToolRemote', 'remoteTypertGateway'].every(key => typeof runtime?.[key] === 'function') && typeof runtime?.gatewaySwitch?.local === 'function' ? 'pass' : 'fail'));
  return { version: manifest.version, state: stateOf(checks), checks };
}
export async function assertInstallation(ctx) {
  const health = await installationHealth(ctx);
  if (health.state === 'fail') throw Object.assign(new Error('Remote Enhanced 需要原版 Remote 提供的原生 Harness 连接接口。请在插件管理器检查原版 Remote 是否已启用后重试。'), { code: 'session-hosts/incompatible', details: { checks: health.checks } });
  return health;
}
function childScope(value, hostId) {
  if (!value) return undefined;
  if (typeof value !== 'string' || value.length > 1024) throw new Error('INVALID_SESSION_SCOPE');
  if (!value.startsWith('dsh-peer:')) return value;
  let parts;
  try { parts = JSON.parse(value.slice(9)); } catch { throw new Error('INVALID_SESSION_SCOPE'); }
  if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== hostId || parts[1] !== 'session' || typeof parts[2] !== 'string' || !parts[2]) throw new Error('INVALID_SESSION_SCOPE');
  return parts[2];
}
// Directory-only by default. A requested Host is probed once, through the same
// encrypted pool used by its Sessions. No Session is created or turn started.
export async function selfCheck(ctx, federation, args, signal) {
  signal.throwIfAborted();
  const local = await installationHealth(ctx);
  const hostId = args.hostId;
  if (hostId !== undefined && (typeof hostId !== 'string' || !hostId || hostId.length > 256)) throw new Error('HOST_REQUIRED');
  const sessionId = childScope(args.sessionId, hostId);
  if (sessionId && (!hostId || hostId === 'local')) throw new Error('REMOTE_HOST_REQUIRED');
  let devices;
  try { devices = await ctx.dshRemoteClient.devices(AbortSignal.any([signal, AbortSignal.timeout(8000)])); }
  catch (error) { signal.throwIfAborted(); return { local, state: 'fail', discovery: { state: 'fail', ...connectionIssue(error) }, hosts: [] }; }
  signal.throwIfAborted();
  const hosts = [];
  const targets = hostId && hostId !== 'local' ? devices.filter(device => device.deviceId === hostId) : hostId === 'local' ? [] : devices;
  if (hostId && hostId !== 'local' && !targets.length) return { local, state: 'fail', discovery: { state: 'pass' }, hosts: [{ hostId, checks: [row('connection', 'fail', { issue: connectionIssue({ code: 'AUTHORIZATION_REQUIRED' }) })] }] };
  for (const device of targets) {
    const checks = [versionMetadata('dshVersion', device.harnessVersion), versionMetadata('remoteVersion', device.clientVersion)];
    const host = { hostId: device.deviceId, name: String(device.name || device.deviceId).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120), online: device.online === true, checks };
    hosts.push(host);
    if (!hostId) { checks.push(row('connection', 'unknown')); continue; }
    if (!host.online) { checks.push(row('connection', 'fail', { issue: connectionIssue({ code: 'HOST_OFFLINE' }) })); continue; }
    const active = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    let channel;
    try {
      channel = await federation.channels.retain(device.deviceId, active);
      const features = await channel.query(async (remote, current) => {
        const description = await remote.client.rpc('harness.transport.describe', {}, current);
        current.throwIfAborted();
        if (!Array.isArray(description?.capabilities) || description.capabilities.some(item => typeof item !== 'string')) throw new Error('INVALID_CAPABILITIES');
        return { remoteGateway: description.capabilities.includes('harness.remote.v3') || description.capabilities.includes('harness.remote.v1'), terminal: description.capabilities.includes('harness.terminal.v1') };
      }, active);
      checks.push(row('connection', 'pass'), row('carrier', features.remoteGateway ? 'pass' : 'fail'), row('terminal', features.terminal ? 'pass' : 'warn'));
      if (sessionId) {
        try {
          const commands = await channel.call('commands/list', { args: { agentId: sessionId } }, active);
          checks.push(row('childStop', commands.ok && Array.isArray(commands.value) ? commands.value.some(command => command.name === 'remote-stop-child') ? 'pass' : 'warn' : 'unknown'));
        } catch (error) { signal.throwIfAborted(); checks.push(row('childStop', 'unknown', { issue: connectionIssue(error) })); }
      } else checks.push(row('childStop', 'unknown'));
    } catch (error) {
      signal.throwIfAborted(); checks.push(row('connection', 'fail', { issue: connectionIssue(error) }));
    } finally { await channel?.release(); }
  }
  return { local, state: stateOf([...local.checks, ...hosts.flatMap(host => host.checks)]), discovery: { state: 'pass' }, hosts };
}
