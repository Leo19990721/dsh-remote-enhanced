// Adapt only the original browser's props. No domain service or root standard
// source is replaced, so other surfaces never see foreign synthetic IDs.
export function adaptBrowserProps(props, controls) {
  const foreign = controls.isVirtual;
  return {
    useStore(selector, equal) {
      return props.useStore(snapshot => selector(snapshot.groupBy === 'workspace-tree' ? { ...snapshot, groupBy: 'workspace' } : snapshot), equal);
    },
    useWorkspaces: controls.useWorkspaces,
    useSessions: controls.useSessions,
    open(id) {
      if (controls.busy()) return;
      if (!foreign(id)) return props.open(id);
      const target = controls.target(id);
      if (target) controls.open(target); else controls.unavailable();
    },
    startSession(id, options) { if (!foreign(id)) props.startSession(id, options); },
    requestSessionRename(id, title) { if (!foreign(id)) props.requestSessionRename(id, title); },
    useSessionAccess(id, action) {
      const admitted = props.useSessionAccess(id, foreign(id) ? undefined : action);
      return foreign(id) ? false : admitted;
    },
    useWorkspaceAccess(id, action) {
      const admitted = props.useWorkspaceAccess(id, foreign(id) ? undefined : action);
      return foreign(id) ? false : admitted;
    },
    renderSlot(name, owner, options) {
      return foreign(owner?.sessionId) ? null : props.renderSlot(name, owner, options);
    },
    renderFactorySlot(name, owner, options) {
      const id = owner?.target?.value?.sessionId || owner?.target?.value?.workspaceId;
      return foreign(id) ? null : props.renderFactorySlot(name, owner, options);
    },
    useContextMenu() {
      const menu = props.useContextMenu();
      return { ...menu, getTriggerProps(target, options) {
        const id = target?.value?.sessionId || target?.value?.workspaceId;
        return menu.getTriggerProps(foreign(id) ? undefined : target, options);
      } };
    },
    insertWorkspaceBefore(id, beforeId) {
      return foreign(id) || foreign(beforeId) ? Promise.resolve() : props.insertWorkspaceBefore(id, beforeId);
    },
  };
}
