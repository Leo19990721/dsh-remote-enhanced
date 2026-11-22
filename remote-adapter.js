import { WebSocketServer } from 'ws';
import { LoopbackPreview } from './federated-preview-transport.js';

// profileContext is supplied by DSH's launcher before plugins mount. A copied
// legacy config must never override the profile running on this computer.
export function remoteProfileDirectory(ctx, config = {}) {
  const directory = ctx.get('profileContext')?.dir || config.profileDirectory;
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Remote profile directory unavailable.');
  return directory;
}

export function loadLoopbackPreview(options) {
  return (client, previewOptions) => new LoopbackPreview(client, loadWebSocketServer(), { ...options, ...previewOptions });
}

export function loadWebSocketServer() {
  return WebSocketServer;
}

// Reuse Remote's own encrypted carrier and protocol.
// No credentials, alternate transport, or installed files are changed.
export function createRemoteReader(channels) {
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
