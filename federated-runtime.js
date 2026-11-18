import { HostChannels } from './host-channels.js';
import { currentTarget } from './catalog.js';
import { remoteProfileDirectory } from './remote-adapter.js';
import { loadTerminalAdapter } from './federated-terminal.js';

// Remote 0.6.5 owns the original local dispatcher. Calling that dispatcher
// preserves the actual admitted Peer and bypasses only its global Host switch.
export function createFederatedRuntime(ctx) {
  const runtime = ctx.dshRemoteClient;
  if (!runtime.gatewaySwitch?.local || !runtime.withToolRemote) throw new Error('Verified Remote carrier unavailable');
  let terminalAdapter;
  const channels = new HostChannels(runtime, { terminalAdapter: () => terminalAdapter ??= loadTerminalAdapter(remoteProfileDirectory(ctx)) });
  const restoreTools = channels.shareTools();
  const hosts = async signal => {
    const rows = await runtime.devices(signal);
    return rows.map(row => ({ hostId: row.deviceId, name: row.name || row.deviceId, online: row.online === true }));
  };
  const options = {
    channels, hosts, fileUploads: ctx.fileUploads, officeKit: ctx.get('officeKit'), diagnostics: () => channels.diagnostics(),
    baseHost: () => {
      const status = runtime.status();
      if ((status.backend || 'harness') !== 'harness') throw new Error('HARNESS_TARGET_REQUIRED');
      return currentTarget(status).hostId;
    },
    local: peer => {
      const carrier = runtime.gatewaySwitch.local(peer);
      return { call: (endpoint, payload, signal) => carrier.dispatch(endpoint, payload, signal), open: (endpoint, payload, signal, uplink) => carrier.open(endpoint, payload, signal, uplink) };
    },
    descriptor: endpoint => ctx.typert.local.get(endpoint) || ctx.typert.remotes.get(endpoint),
  };
  return { ...options, async dispose() { restoreTools(); await channels.dispose(); } };
}
