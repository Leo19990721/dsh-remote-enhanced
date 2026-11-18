import { sessionHost } from './client-resources.js';

// Menu callbacks keep the clicked Session. Never pass a remote path to this
// computer's native open/reveal APIs, including menus loaded before the plugin.
export function installPeerMenuSafety(ctx, baseHost, openFile, saveFile, t) {
  const menus = ctx.contextMenus, original = menus.resolve, disposers = [];
  const remote = target => {
    const value = target?.value, host = sessionHost(value?.sessionId, baseHost);
    if (host !== undefined) return host !== 'local';
    if (target?.kind === 'workspace' && value?.workspaceId?.startsWith('dsh-peer:')) {
      try { return JSON.parse(value.workspaceId.slice(9))[0] !== 'local'; } catch { return false; }
    }
    return false;
  };
  const unsafe = row => row.id.startsWith('open-in-app.') || row.id.startsWith('file-actions.');
  const filter = (items, target) => remote(target) ? items.filter(row => !unsafe(row)) : items;
  const resolve = target => {
    const native = original.call(menus, target);
    if (!remote(target)) return native;
    let previous, snapshot;
    return { ...native, source: { subscribe: native.source.subscribe.bind(native.source), getSnapshot: () => {
      const current = native.source.getSnapshot(); if (previous !== current) { previous = current; snapshot = filter(current, target); } return snapshot;
    } }, select(id) { if (!unsafe({ id })) native.select(id); } };
  };
  menus.resolve = resolve;
  disposers.push(() => { if (menus.resolve === resolve) menus.resolve = original; });
  for (const kind of ['file', 'directory', 'image', 'url', 'workspace']) disposers.push(menus.register({ id: 'peer-resource', target: kind, order: 100, resolve: value => {
    if (!remote({ kind, value })) return [];
    const { sessionId, path, url } = value;
    if (!sessionId) return [{ id: 'remote-only', label: t('remoteApplication'), disabled: true }];
    if (kind === 'url') return [{ id: 'open', label: t('openSidebar'), run: () => ctx.sidebarRight.openTabIn(sessionId, 'browser', { params: { url } }) }, { id: 'copy', label: t('copyLink'), run: () => navigator.clipboard.writeText(url) }];
    if (!path) return [];
    return [
      { id: 'open', label: t('openSidebar'), run: () => openFile(sessionId, path) },
      ...['file', 'image'].includes(kind) ? [{ id: 'download', label: t('download'), run: () => saveFile(sessionId, path) }] : [],
      { id: 'copy', label: t('copyRemotePath'), run: () => navigator.clipboard.writeText(path) },
    ];
  } }));
  // The shortcut registry retains the original command objects. This narrow
  // version-scoped guard covers native application launch from the keyboard.
  const command = ctx.shortcuts?.registry?.commands?.get('workspace.openLocal');
  if (command) {
    const originalResolve = command.resolve;
    const guard = context => {
      const selected = Object.values(ctx.sessions.list.getSnapshot().byId).find(row => row.retainedBy?.mainView > 0);
      return selected && sessionHost(selected.sessionId, baseHost) !== 'local' ? { status: 'blocked', reason: t('remoteApplication') } : originalResolve(context);
    };
    command.resolve = guard; disposers.push(() => { if (command.resolve === guard) command.resolve = originalResolve; });
  }
  return { filter, remote, dispose() { for (const dispose of disposers.reverse()) dispose(); } };
}
