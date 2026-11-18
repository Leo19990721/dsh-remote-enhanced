const PREFIX = 'remote-workspace:';
export function virtualId(hostId, backend, kind, id) {
  return PREFIX + JSON.stringify([hostId, backend, kind, id]);
}
export function isVirtual(id) { return typeof id === 'string' && id.startsWith(PREFIX); }

// A read-only projection for the original WorkspaceBrowser only. Domain stores
// and conversation objects never receive another computer's synthetic IDs.
export function createProjection(computers, current, nativeWorkspaces, nativeSessions, offlineLabel = '离线', unavailableLabel = '暂不可用') {
  const items = [], ids = [...nativeSessions.ids], byId = { ...nativeSessions.byId };
  const targets = {}, workspaceTargets = {};
  const archivedSessionIds = [], pinnedSessionIds = [];
  for (const computer of computers) {
    const backend = computer.backend || 'harness';
    const selected = current?.hostId === computer.hostId && current?.backend === backend;
    const sourceWorkspaces = selected ? nativeWorkspaces.items : computer.workspaces || [];
    const sourceSessions = selected
      ? nativeSessions.ids.flatMap(id => nativeSessions.byId[id] ? [{ ...nativeSessions.byId[id], sessionId: id }] : [])
      : computer.sessions || [];
    const workspaceId = id => selected ? id : virtualId(computer.hostId, backend, 'workspace', id);
    const sessionId = id => selected ? id : virtualId(computer.hostId, backend, 'session', id);
    const owned = new Map();
    for (const workspace of sourceWorkspaces) for (const id of workspace.sessionIds || []) owned.set(id, workspace.workspaceId);
    const rootSessions = sourceSessions.filter(row => row.origin !== 'subagent' && !row.parentId && !row.parentSessionId && (selected || owned.has(row.sessionId)));
    const allowed = new Set(rootSessions.map(row => row.sessionId));
    for (const row of sourceWorkspaces) {
      const id = workspaceId(row.workspaceId);
      const title = computer.hostId === 'local' ? row.title : `${row.title}（${computer.name}）`;
      const suffix = computer.online === false ? ` · ${offlineLabel}` : computer.unavailable ? ` · ${unavailableLabel}` : '';
      items.push({ ...row, workspaceId: id, title: title + suffix, sessionIds: (row.sessionIds || []).filter(id => allowed.has(id)).map(sessionId) });
      workspaceTargets[id] = { hostId: computer.hostId, backend, workspaceId: row.workspaceId };
    }
    for (const row of rootSessions) {
      const id = sessionId(row.sessionId), workspace = owned.get(row.sessionId);
      if (!selected) {
        const title = row.projections?.values?.title || row.projectionValues?.title || row.title || '';
        ids.push(id);
        byId[id] = { id, title, displayTitle: title || id, cwd: row.cwd, updatedAt: row.updatedAt || 0, running: row.running === true, blank: row.blank === true, retainedBy: {} };
      }
      if (workspace) targets[id] = { hostId: computer.hostId, backend, workspaceId: workspace, sessionId: row.sessionId };
    }
    const archived = selected ? nativeWorkspaces.archivedSessionIds : computer.archivedSessionIds;
    const pinned = selected ? nativeWorkspaces.pinnedSessionIds : computer.pinnedSessionIds;
    archivedSessionIds.push(...(archived || []).map(sessionId));
    pinnedSessionIds.push(...(pinned || []).map(sessionId));
  }
  return { workspaces: { ...nativeWorkspaces, items, archivedSessionIds, pinnedSessionIds }, sessions: { ...nativeSessions, ids, byId }, targets, workspaceTargets };
}
