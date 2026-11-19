import { sessionHost } from './client-resources.js';

// Keep the file address's Session even when a preview was opened in another
// pane. Decode the native address without URL-normalizing its path segments.
export function sessionFileFromTab(tab) {
  if (typeof tab?.contentId !== 'string') return;
  const parts = /^dsh-resource:\/\/file\/session\/([^/?#]+)\/([^?#]+)/.exec(tab.contentId);
  if (!parts) return;
  try { return { sessionId: decodeURIComponent(parts[1]), path: parts[2].split('/').map(decodeURIComponent).join('/') }; } catch { /* Invalid resource address. */ }
}

// Menu callbacks keep the clicked Session. Never pass a remote path to this
// computer's native open/reveal APIs, including menus loaded before the plugin.
export function installPeerMenuSafety(ctx, baseHost, openFile, fileActions, t) {
  const menus = ctx.contextMenus, original = menus.resolve, disposers = [];
  const remote = target => {
    const value = target?.value;
    const owner = target?.kind === 'tab' ? sessionFileFromTab(value?.tab)?.sessionId : undefined;
    const host = sessionHost(owner ?? value?.sessionId, baseHost);
    if (host !== undefined) return host !== 'local';
    if (target?.kind === 'workspace' && value?.workspaceId?.startsWith('dsh-peer:')) {
      try { return JSON.parse(value.workspaceId.slice(9))[0] !== 'local'; } catch { return false; }
    }
    return false;
  };
  // An image with only a URL uses the normal URL-based image actions, not a
  // workspace path. Leave those actions to their native owner.
  const unsafe = (id, target) => id.startsWith('open-in-app.') || (id.startsWith('file-actions.')
    && (target.kind !== 'image' || !!target.value.path));
  const filter = (items, target) => remote(target) ? items.filter(row => !unsafe(row.id, target)) : items;
  const resolve = target => {
    const native = original.call(menus, target);
    if (!remote(target)) return native;
    let previous, snapshot;
    return { ...native, source: { subscribe: native.source.subscribe.bind(native.source), getSnapshot: () => {
      const current = native.source.getSnapshot(); if (previous !== current) { previous = current; snapshot = filter(current, target); } return snapshot;
    } }, select(id) { if (!unsafe(id, target)) native.select(id); } };
  };
  menus.resolve = resolve;
  disposers.push(() => { if (menus.resolve === resolve) menus.resolve = original; });
  for (const kind of ['file', 'directory', 'image', 'url', 'workspace', 'tab']) disposers.push(menus.register({ id: 'peer-resource', target: kind, order: 100, resolve: value => {
    if (kind === 'tab') {
      const file = sessionFileFromTab(value.tab);
      return file && remote({ kind: 'file', value: file }) ? fileActions.menu(file.sessionId, file.path) : [];
    }
    if (!remote({ kind, value })) return [];
    const { sessionId, path, url, line } = value;
    if (!sessionId) return [{ id: 'remote-only', label: t('remoteApplication'), disabled: true }];
    if (kind === 'url') return [{ id: 'open', label: t('openSidebar'), run: () => ctx.sidebarRight.openTabIn(sessionId, 'browser', { params: { url } }) }, { id: 'copy', label: t('copyLink'), run: () => navigator.clipboard.writeText(url) }];
    if (typeof path !== 'string' || !path) return [];
    return [
      { id: 'open', label: t('openSidebar'), icon: { key: 'open-in-app.sidebar' }, run: () => openFile(sessionId, path, { line }) },
      ...(kind === 'file' || kind === 'image' ? fileActions.menu(sessionId, path) : []),
      { id: 'copy', label: t('copyRemotePath'), icon: { key: 'open-in-app.copy' }, run: () => navigator.clipboard.writeText(path) },
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
