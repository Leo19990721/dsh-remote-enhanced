const LOCAL = 'local';
export class CatalogError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new CatalogError(code); };
const text = value => typeof value === 'string' ? value.slice(0, 500) : '';
export const targetKey = value => JSON.stringify([value.hostId, value.backend || 'harness', value.workspaceId || '', value.sessionId || '']);
export function currentTarget(status) {
  return status?.mode === 'remote'
    ? { hostId: status.target?.deviceId || status.connectedTargetDeviceId || 'unavailable', backend: status.backend || 'harness' }
    : { hostId: LOCAL, backend: 'harness' };
}
export function sessionSummary(row) {
  return {
    sessionId: row.sessionId,
    title: text(row.projections?.values?.title || row.title),
    running: row.running === true,
    blank: row.blank === true,
    updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
  };
}
const rootSessions = rows => rows.filter(row => row.origin !== 'subagent' && !row.parentSessionId && !row.parentId);
function navigationData(data) {
  const sessions = rootSessions(data.sessions || []).map(row => ({ ...sessionSummary(row), ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}) }));
  return {
    workspaces: (data.workspaces || []).map(row => ({ workspaceId: row.workspaceId || row.id, path: text(row.path), title: text(row.title), sessionIds: [...row.sessionIds || []], ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }), ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }) })),
    sessions,
    archivedSessionIds: [...data.archivedSessionIds || []], pinnedSessionIds: [...data.pinnedSessionIds || []],
  };
}
export class UnifiedCatalog {
  constructor(ctx, { readRemote } = {}) { this.ctx = ctx; this.readRemote = readRemote; this.tail = Promise.resolve(); }
  run(action, args = {}, signal = new AbortController().signal) {
    // Serialize metadata snapshots so their bounded reads share one pool interest.
    const operation = this.tail.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const result = await this.execute(action, args, signal);
      signal.throwIfAborted();
      return result;
    });
    this.tail = operation;
    return operation;
  }
  client() {
    const client = this.ctx.get?.('dshRemoteClient') || this.ctx.dshRemoteClient;
    if (!client) fail('REMOTE_UNAVAILABLE');
    return client;
  }
  async hosts(signal) {
    const client = this.client();
    const status = client.status();
    let devices = [], error;
    try { devices = await client.devices(signal); }
    catch { signal.throwIfAborted(); error = 'REMOTE_DISCOVERY_FAILED'; }
    return {
      current: currentTarget(status),
      local: { hostId: LOCAL, name: text(status.deviceName) || 'Local', online: true },
      hosts: devices.map(row => ({ hostId: row.deviceId, name: text(row.name), online: row.online === true, platform: text(row.platform) })),
      ...(error ? { error } : {}),
    };
  }
  localWorkspaces() {
    return this.ctx.workspaceRegistry.list().map(row => ({
      hostId: LOCAL, backend: 'harness', workspaceId: row.id, title: text(row.title), path: row.path,
    }));
  }
  async localSessions(workspaceId, signal) {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId);
    if (!workspace) fail('WORKSPACE_NOT_FOUND');
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds);
    const owned = new Set(workspace.sessionIds);
    const rows = (await this.ctx.sessionController.list({}, signal)).items;
    return rows.filter(row => owned.has(row.sessionId) && !archived.has(row.sessionId) && row.origin !== 'subagent' && row.parentSessionId === undefined)
      .map(sessionSummary).sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
  }
  async requireHost(hostId, signal) {
    const client = this.client();
    const devices = await client.devices(signal);
    const host = devices.find(row => row.deviceId === hostId);
    if (!host || !host.online) fail('HOST_OFFLINE');
    return client;
  }
  async workspaces(hostId, signal) {
    if (hostId === LOCAL) return { hostId, workspaces: this.localWorkspaces(), unavailable: [] };
    const client = await this.requireHost(hostId, signal);
    const result = await client.discoverToolWorkspaces(hostId, signal);
    return { hostId, workspaces: result.workspaces.map(row => ({ ...row, hostId })), unavailable: result.unavailable };
  }
  async sessions(args, signal) {
    if (args.backend && args.backend !== 'harness') fail('BACKEND_SESSIONS_UNAVAILABLE');
    const offset = args.offset ?? 0, limit = args.limit ?? 100;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_PAGE');
    if (args.hostId === LOCAL) {
      const rows = await this.localSessions(args.workspaceId, signal);
      return { hostId: LOCAL, backend: 'harness', workspaceId: args.workspaceId,
        sessions: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null };
    }
    const client = await this.requireHost(args.hostId, signal);
    if (!this.readRemote) fail('REMOTE_ADAPTER_UNAVAILABLE');
    const data = await this.readRemote(client, args.hostId, signal);
    const workspace = data.workspaces.find(row => row.workspaceId === args.workspaceId);
    if (!workspace) fail('WORKSPACE_NOT_FOUND');
    const owned = new Set(workspace.sessionIds), archived = new Set(data.archivedSessionIds);
    const rows = data.sessions.filter(row => owned.has(row.sessionId) && !archived.has(row.sessionId) && !row.parentSessionId && row.origin !== 'subagent')
      .map(sessionSummary).sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
    return { hostId: args.hostId, backend: 'harness', workspaceId: args.workspaceId,
      sessions: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null };
  }
  // Retired: selecting a computer changes every native Session's carrier.
  // Keep old callers fail-closed until independent Session routing is available.
  async select() { fail('INDEPENDENT_SESSION_ROUTING_REQUIRED'); }
  async execute(action, args, signal) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('INVALID_INPUT');
    if (action === 'hosts') return this.hosts(signal);
    if (action === 'status') return { current: currentTarget(this.client().status()) };
    if (action === 'snapshot') {
      const directory = await this.hosts(signal);
      const localSessions = (await this.ctx.sessionController.list({}, signal)).items;
      const local = { ...directory.local, backend: 'harness', ...navigationData({
        workspaces: this.ctx.workspaceRegistry.list(), sessions: localSessions,
        archivedSessionIds: this.ctx.workspaceRegistry.archivedSessionIds, pinnedSessionIds: this.ctx.workspaceRegistry.pinnedSessionIds,
      }) };
      const computers = [local], unavailable = [];
      for (const host of directory.hosts) {
        if (!host.online) { computers.push({ ...host, backend: 'harness', ...navigationData({}), unavailable: true }); continue; }
        try {
          const data = await this.readRemote(this.client(), host.hostId, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
          computers.push({ ...host, backend: 'harness', ...navigationData(data) });
        } catch {
          signal.throwIfAborted();
          computers.push({ ...host, backend: 'harness', ...navigationData({}), unavailable: true }); unavailable.push(host.hostId);
        }
      }
      return { computers, current: directory.current, unavailable, ...(directory.error ? { discoveryError: directory.error } : {}) };
    }
    if (typeof args.hostId !== 'string' || !args.hostId) fail('HOST_REQUIRED');
    if (action === 'workspaces') return this.workspaces(args.hostId, signal);
    if (action === 'sessions') return this.sessions(args, signal);
    if (action === 'select') return this.select(args, signal);
    fail('UNKNOWN_ACTION');
  }
}
