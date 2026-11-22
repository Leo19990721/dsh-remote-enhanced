import { UnifiedCatalog, CatalogError } from './catalog.js';
import { createRemoteReader, loadWebSocketServer, loadLoopbackPreview } from './remote-adapter.js';
import { registerOwnerRoute } from './owner-route.js';
import { createFederatedRuntime } from './federated-runtime.js';
import { registerFederatedRoute } from './federated-route.js';
import { checkSessionResources } from './federated-resource-check.js';
import { registerChildControl } from './federated-child-control.js';
import { assertInstallation, selfCheck } from './federated-health.js';
export const inject = ['connection', 'webServer', 'workspaceRegistry', 'sessionController', 'remoteAccess', 'dshRemoteClient', 'tools', 'typert', 'fileUploads', 'commands', 'subagents'];
export const RPC_CHANNEL = '/dsh-remote-workspaces';
export async function apply(ctx, config = {}) {
  const installation = await assertInstallation(ctx);
  registerChildControl(ctx);
  const federation = createFederatedRuntime(ctx);
  ctx.effect(() => () => federation.dispose(), 'remote-workspaces: independent Host connections');
  const readRemote = createRemoteReader(federation.channels);
  const previewFailures = [];
  const resources = { ...federation, createPreview: loadLoopbackPreview({ onFailure: value => {
    previewFailures.push({ at: Date.now(), ...value }); if (previewFailures.length > 8) previewFailures.shift();
  } }) };
  const views = registerFederatedRoute(ctx, { ...resources, filePreviewTargets: config.filePreviewTargets, WebSocketServer: loadWebSocketServer() });
  const catalog = new UnifiedCatalog(ctx, { readRemote });
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(), 'remote-workspaces: lifetime');
  async function operate(action, args, signal, peer = ctx.connection.browserPeer) {
    signal = AbortSignal.any([signal, ...peer?.signal ? [peer.signal] : [], lifetime.signal, AbortSignal.timeout(120000)]);
    if (action === 'selfCheck') return selfCheck(ctx, federation, args, signal);
    if (action === 'diagnostics') return { installation, ...federation.diagnostics(), filePreviewTargetCount: config.filePreviewTargets?.length || 0, views: views(), previewFailures: [...previewFailures] };
    if (action === 'resourceCheck') return checkSessionResources(resources, args, signal, peer);
    return catalog.run(action, args, signal);
  }
  registerOwnerRoute(ctx, RPC_CHANNEL, async (endpoint, args, signal, peer) => {
    if (peer?.principal?.kind !== 'owner') return { ok: false, error: { code: 'remote-workspaces/forbidden', message: 'Owner required.', details: {} } };
    try { return { ok: true, value: await operate(endpoint, args, signal, peer) }; }
    catch (error) { return { ok: false, error: { code: error instanceof CatalogError ? error.code : 'REMOTE_WORKSPACES_FAILED', message: String(error.message || 'Remote request failed.').slice(0, 200), details: {} } }; }
  });
  ctx.tools.register({
    name: 'remote_workspaces', description: 'Read local and authorized remote DSH workspace/session metadata, self-check installed versions and one optional Host connection, or check Session resource access without changing the global UI target. selfCheck without hostId lists metadata only; with hostId probes that authorized Host once; optional existing sessionId checks child-Stop command availability without executing it. resourceCheck returns file type/size or directory count and localhost authorization/status/completion/byte counts; drains the preview response under a 64 MiB/15 s bound, discards its bytes, and never returns file contents, HTTP bodies or header values. No messages, session creation or task interruption.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['snapshot', 'hosts', 'status', 'workspaces', 'sessions', 'diagnostics', 'selfCheck', 'resourceCheck'] }, hostId: { type: 'string' }, workspaceId: { type: 'string' }, sessionId: { type: 'string' }, path: { type: 'string' }, url: { type: 'string' }, backend: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['action'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute(args, exec) { const { action, ...input } = args; return operate(action, input, exec.signal); },
  });
}
