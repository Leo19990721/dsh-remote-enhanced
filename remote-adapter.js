import { createRequire } from 'node:module';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { LoopbackPreview } from './federated-preview-transport.js';

// profileContext is supplied by DSH's launcher before plugins mount. A copied
// legacy config must never override the profile running on this computer.
export function remoteProfileDirectory(ctx, config = {}) {
  const directory = ctx.get('profileContext')?.dir || config.profileDirectory;
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Remote profile directory unavailable.');
  return directory;
}

export async function loadLoopbackPreview(profileDirectory, options) {
  const resolve = createRequire(join(profileDirectory, 'package.json'));
  const manifestPath = resolve.resolve('ds-harness-remote/package.json');
  if (resolve(manifestPath).version !== '0.6.5') throw new Error('Remote preview requires verified Remote 0.6.5.');
  return (client, previewOptions) => new LoopbackPreview(client, loadWebSocketServer(profileDirectory), { ...options, ...previewOptions });
}

export function loadWebSocketServer() {
  return WebSocketServer;
}

// Version-scoped adapter reuses Remote's own encrypted carrier and protocol.
// No credentials, alternate transport, or installed files are changed.
export async function createRemoteReader(profileDirectory, channels) {
  if (!profileDirectory) throw new Error('Remote profile directory unavailable.');
  const resolve = createRequire(join(profileDirectory, 'package.json'));
  const manifestPath = resolve.resolve('ds-harness-remote/package.json');
  const manifest = resolve(manifestPath);
  if (manifest.version !== '0.6.5') throw new Error('Unified sessions requires the verified Remote 0.6.5 adapter.');
  return async (client, hostId, signal) => {
    if (typeof client.withToolRemote !== 'function' || typeof client.remoteTypertGateway !== 'function') throw new Error('Remote read-only carrier unavailable.');
    if (channels) {
      const channel = await channels.retain(hostId, signal);
      try { return await readCatalog(channel, signal); } finally { await channel.release(); }
    }
    return client.withToolRemote(hostId, signal, async (remote, active) => {
      if (!remote.features.remoteGateway) throw new Error('Harness sessions unavailable.');
      const gateway = client.remoteTypertGateway(remote);
      return readCatalog({ open: (...args) => gateway.open(...args), call: async (endpoint, payload, activeSignal) => ({ ok: true, value: await gateway.invoke({ namespace: endpoint.split('/')[0], method: endpoint.split('/')[1], args: payload.args, signal: activeSignal }) }) }, active);
    });
  };
}
async function readCatalog(channel, signal) {
  const stop = new AbortController();
  const stream = await channel.open('workspace/follow', { args: {} }, AbortSignal.any([signal, stop.signal]));
  const iterator = stream[Symbol.asyncIterator]();
  let baseline;
  try {
    const frame = await iterator.next();
    if (frame.done || frame.value?.type !== 'baseline') throw new Error('Workspace baseline unavailable.');
    baseline = frame.value.value;
  } finally { stop.abort(); await iterator.return?.(); }
  const result = await channel.call('session/list', { args: { _request: {} } }, signal);
  if (!result.ok) throw new Error(result.error.message);
  signal.throwIfAborted();
  return { workspaces: baseline.items, archivedSessionIds: baseline.archivedSessionIds || [], pinnedSessionIds: baseline.pinnedSessionIds || [], sessions: result.value.items };
}
