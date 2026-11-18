import { remoteBrowser, isLoopbackPage } from './client-browser.js';
import { installPeerMenuSafety } from './client-resource-menus.js';

export function sessionHost(sessionId, baseHost) {
  if (typeof sessionId !== 'string') return undefined;
  if (!sessionId.startsWith('dsh-peer:')) return baseHost;
  try { const tuple = JSON.parse(sessionId.slice(9)); return Array.isArray(tuple) && tuple.length === 3 && tuple[1] === 'session' && tuple.every(part => typeof part === 'string' && part) ? tuple[0] : undefined; } catch { return undefined; }
}
export function resolvePeerPath(base, path) {
  if (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path) || !base) return path;
  return base.replace(/[\\/]+$/, '') + '/' + path.replace(/^\.\//, '');
}
export function peerFileAddress(sessionId, path) {
  const encode = value => encodeURIComponent(value).replaceAll('%3A', ':');
  return `dsh-resource://file/session/${encode(sessionId)}/${path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').split('/').map(encode).join('/')}`;
}
function peerDirectoryAddress(sessionId, path) { return `dsh-resource://peer-directory/session/${encodeURIComponent(sessionId)}/${encodeURIComponent(path)}`; }
function directoryPath(address) { const parts = new URL(address).pathname.split('/'); return decodeURIComponent(parts.slice(3).join('/')); }

// Version-scoped decorators on native entry Components. Inject caches and native
// service objects are untouched; already-bound entries receive the adaptation.
export function installSessionResources(ctx, carrier, React, signal) {
  const t = ctx.locale.bind('remoteWorkspaces'), patched = new Map(), disposers = [], browsers = new Map();
  const remote = id => { const host = sessionHost(id, carrier.baseHost); return host !== undefined && host !== 'local'; };
  const notify = message => ctx.contextMenus.notify(message);
  function PeerButton({ children, size: _size, variant: _variant, style, ...props }) {
    return React.createElement('button', { type: 'button', ...props, style: { color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6, padding: '4px 8px', font: 'inherit', cursor: props.disabled ? 'default' : 'pointer', opacity: props.disabled ? 0.5 : 1, ...style } }, children);
  }
  // Native Markdown elements retain their own provider and renderer. Decorate
  // the existing element props at the original component's output boundary;
  // no private Client package import or DOM scan is needed.
  function decorateMediaTree(node, id, base) {
    if (Array.isArray(node)) return node.map(child => decorateMediaTree(child, id, base));
    if (!React.isValidElement(node)) return node;
    const changes = {};
    if (node.props.fileImages) changes.fileImages = imageFace(id, base, node.props.fileImages);
    if (node.props.pathImages) {
      const previous = node.props.pathImages;
      changes.pathImages = { ...previous, resolve(value) {
        const resolved = previous.resolve(value);
        if (!resolved) return resolved;
        try { const path = new URL(resolved, document.baseURI).searchParams.get('path'); return path ? carrier.mediaUrl(id, path) : resolved; } catch { return undefined; }
      } };
    }
    if (node.props.children !== undefined) changes.children = decorateMediaTree(node.props.children, id, base);
    return Object.keys(changes).length ? React.cloneElement(node, changes) : node;
  }
  function nativeResult(Native, props) {
    if (typeof Native === 'function') return Native(props);
    if (typeof Native?.type === 'function') return Native.type(props);
    throw new Error('Unsupported native resource renderer');
  }
  const checked = async promise => { const result = await promise; if (!result.ok) throw Object.assign(new Error(result.error.message), result.error); return result.value; };
  const cwdOf = id => ctx.sessions.list.getSnapshot().byId[id]?.cwd;
  async function openFile(id, path, options) {
    const metadata = await ctx.remote.workspaceFiles.stat(id, path, signal);
    if (metadata.ok) { ctx.sidebarRight.openResourceIn(id, peerFileAddress(id, path), options?.line === undefined ? {} : { params: { line: options.line } }); return; }
    const directory = await ctx.remote.workspaceFiles.list(id, path, signal);
    if (directory.ok) { ctx.sidebarRight.openResourceIn(id, peerDirectoryAddress(id, path)); return; }
    throw new Error(metadata.error?.message || directory.error?.message || t('fileUnavailable'));
  }
  const imageFace = (id, base, previous = {}) => ({
    ...previous, fileDrag: previous.fileDrag || ctx.fileDrag.actions,
    resolve: path => carrier.mediaUrl(id, resolvePeerPath(base, path)),
    resourceAddress: path => peerFileAddress(id, resolvePeerPath(base, path)),
    labels: previous.labels || { open: t('imageOpen'), loading: t('connecting'), failed: t('fileUnavailable'), dialog: t('imageOpen'), close: t('close') },
  });
  async function saveFile(id, path) {
    notify(t('downloadLoading'));
    const result = await ctx.fileActions.save({ name: path.split(/[\\/]/).at(-1), url: carrier.mediaUrl(id, path), read: async active => {
      // Saving opaque original bytes must preserve the supplied extension. An
      // untyped blob becomes text/plain in Electron and renames even .docx to
      // .txt; octet-stream maps to .bin in the native filename resolver.
      const file = await checked(ctx.remote.workspaceFiles.readBytes(id, path, {}, active)); return new Blob([file.data], { type: 'application/x-dsh-original' });
    } }, ctx.fileActions.canSaveAs ? 'saveAs' : 'download');
    if (result.status !== 'cancelled') ctx.contextMenus.notify(t(result.status === 'requested' ? 'downloadStarted' : 'downloadSaved'), true);
  }
  function Download({ sessionId, absolutePath }) {
    const [busy, setBusy] = React.useState(false);
    return React.createElement(PeerButton, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => {
      setBusy(true); void saveFile(sessionId, absolutePath).catch(error => notify(error.message || t('fileUnavailable'))).finally(() => setBusy(false));
    } }, t(busy ? 'downloadLoading' : 'download'));
  }
  function Directory(props) {
    const { tab } = props.useTabInfo(), path = directoryPath(tab.navigation.address);
    const [state, setState] = React.useState({ loading: true }), [revision, refresh] = React.useState(0);
    React.useEffect(() => {
      const stop = new AbortController(), active = AbortSignal.any([signal, tab.signal, stop.signal]);
      setState({ loading: true });
      void checked(ctx.remote.workspaceFiles.list(props.sessionId, path, active)).then(value => { if (!active.aborted) setState({ value }); }, error => { if (!active.aborted) setState({ error: error.message }); });
      return () => stop.abort();
    }, [path, tab.signal, props.sessionId, revision]);
    const visit = (child, isDirectory) => ctx.sidebarRight.openResourceIn(props.sessionId, isDirectory ? peerDirectoryAddress(props.sessionId, child) : peerFileAddress(props.sessionId, child));
    const root = cwdOf(props.sessionId)?.replaceAll('\\', '/').replace(/\/$/, ''), current = resolvePeerPath(root, path).replaceAll('\\', '/').replace(/\/$/, '');
    const parent = current.slice(0, current.lastIndexOf('/'));
    return React.createElement('section', { style: { padding: 16, overflow: 'auto', height: '100%' }, 'data-peer-directory': true },
      React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } },
        React.createElement('strong', { style: { flex: 1, overflowWrap: 'anywhere' } }, path),
        React.createElement(PeerButton, { size: 'sm', variant: 'ghost', disabled: state.loading, onClick: () => refresh(value => value + 1) }, t('retry'))),
      root && current !== root && current.startsWith(root + '/') && React.createElement(PeerButton, { size: 'sm', variant: 'ghost', onClick: () => visit(parent, true) }, t('parentDirectory')),
      state.loading ? React.createElement('p', { role: 'status' }, t('connecting')) : state.error ? React.createElement('p', { role: 'alert' }, state.error) :
        React.createElement('div', null, ...(state.value?.entries || []).map(item => React.createElement('div', { key: item.name, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' } },
          React.createElement(PeerButton, { size: 'sm', variant: 'ghost', onClick: () => visit(resolvePeerPath(current, item.name), item.type === 'directory'), style: { justifyContent: 'flex-start', flex: 1 } }, (item.type === 'directory' ? '📁 ' : '📄 ') + item.name),
          item.type === 'file' && React.createElement(Download, { sessionId: props.sessionId, absolutePath: resolvePeerPath(current, item.name) }))),
        state.value?.truncated && React.createElement('p', { role: 'status' }, t('directoryTruncated'))));
  }
  disposers.push(ctx.sidebarRightTabs.register({ id: '@local/dsh-unified-sessions/directory', kind: 'peerDirectory', patterns: ['dsh-resource://peer-directory/**'], priority: 'extension', title: address => directoryPath(address).split(/[\\/]/).filter(Boolean).at(-1) || t('directory') }));
  disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '@local/dsh-unified-sessions/directory' }, Directory)));
  const watch = (name, decorate) => {
    const reconcile = () => { for (const entry of ctx.slots.entries(name)) {
      if (patched.has(entry) || typeof entry.component !== 'function' && typeof entry.component !== 'object') continue;
      const Native = entry.component, Wrapper = decorate(entry, Native); if (!Wrapper) continue;
      entry.component = Wrapper; patched.set(entry, { Native, Wrapper });
    } };
    disposers.push(ctx.slots.inject(name, () => { reconcile(); return ctx.slots.subscribe(name, reconcile); }));
  };
  watch('conversation.view', (entry, Native) => entry.children?.['conversation.chat.flow'] ? function ResourceChat(props) {
    const open = React.useCallback((path, options) => remote(props.sessionId) ? openFile(props.sessionId, path, options) : props.openFile(path, options), [props.sessionId, props.openFile]);
    const external = React.useCallback(url => {
      if (remote(props.sessionId) && isLoopbackPage(url)) ctx.sidebarRight.openTabIn(props.sessionId, 'browser', { params: { url } });
      else props.openExternalLink(url);
    }, [props.sessionId, props.openExternalLink]);
    const result = nativeResult(Native, { ...props, openFile: open, openExternalLink: external });
    return remote(props.sessionId) ? decorateMediaTree(result, props.sessionId, cwdOf(props.sessionId)) : result;
  } : undefined);
  watch('sidebar.right.tab.document', (entry, Native) => String(entry.options.key).endsWith('/markdown') ? function PeerMarkdown(props) {
    const result = nativeResult(Native, props);
    return remote(props.sessionId) ? decorateMediaTree(result, props.sessionId, cwdOf(props.sessionId)) : result;
  } : undefined);
  for (const seat of ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable', 'sidebar.right.tab.files.actions', 'deliverables.file.actions', 'deliverables.review.file.actions']) {
    watch(seat, (entry, Native) => entry.options.id === 'open-in-app' || entry.registrant === '@deepseek-ai/dsh-client-ui-open-in-app' ? function PeerActions(props) {
      return remote(props.sessionId) ? null : React.createElement(Native, props);
    } : undefined);
  }
  for (const name of ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable']) {
    disposers.push(ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'peer-download' }, props => remote(props.sessionId) ? React.createElement(Download, props) : null)));
  }
  function BrowserFiles({ adapter, useTabInfo, useBrowserState, sessionId }) {
    const { tab } = useTabInfo();
    // The panel and native body each subscribe in their own normal Hook order.
    // A native committed navigation must also refresh the panel's source label.
    useBrowserState(tab.id);
    const state = adapter.fileState(tab.id);
    if (!state.available && !state.enabled) return null;
    const workspace = ctx.workspaces?.list.getSnapshot().items.find(row => row.sessionIds.includes(sessionId));
    const act = mode => { void adapter.consumeFile(tab.id, mode, ({ sessionId: owner, path, kind }) => mode === 'download'
      ? saveFile(owner, path)
      : kind === 'folder' ? ctx.sidebarRight.openResourceIn(owner, peerDirectoryAddress(owner, path)) : openFile(owner, path)); };
    return React.createElement('section', { 'aria-label': t('mapFiles'), 'aria-busy': !!state.busy, style: { padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-base)', flexShrink: 0, font: 'inherit', color: 'var(--dsw-alias-label-primary)' } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
        React.createElement('span', { style: { flex: 1 } }, t('mapFiles')),
        React.createElement(PeerButton, { disabled: state.busy || !state.enabled && !state.available, 'aria-pressed': state.enabled && state.active, onClick: () => { void adapter.setFileMode(tab.id, !state.enabled); } }, t(state.enabled ? 'mapFilesDisable' : 'mapFilesEnable'))),
      React.createElement('p', { style: { margin: '4px 0', fontSize: '0.85em', opacity: 0.8 } }, t(state.enabled ? 'mapFilesHint' : 'mapFilesOffHint')),
      state.busy && React.createElement('p', { role: 'status', style: { margin: '4px 0' } }, t('connecting')),
      state.enabled && !state.active && !state.busy && React.createElement(PeerButton, { onClick: () => adapter.resumeFiles(tab.id) }, t('mapFilesResume')),
      state.error && React.createElement('p', { role: 'alert', style: { margin: '6px 0', overflowWrap: 'anywhere' } }, state.error),
      state.pending && React.createElement('div', { role: 'group', 'aria-live': 'polite', 'aria-label': t('mapFilesConfirm'), style: { marginTop: 8 } },
        React.createElement('div', null, t('mapFilesSource') + ' ' + (workspace?.title || sessionHost(sessionId, carrier.baseHost)) + ' · ' + (ctx.sessions.list.getSnapshot().byId[sessionId]?.title || t('mapFilesCurrentSession'))),
        React.createElement('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '6em', overflow: 'auto', margin: '6px 0', userSelect: 'text' } }, state.pending.path),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          React.createElement(PeerButton, { disabled: state.busy, onClick: () => act('preview') }, t(state.pending.kind === 'folder' ? 'mapFilesFolder' : 'mapFilesPreview')),
          state.pending.kind === 'file' && React.createElement(PeerButton, { disabled: state.busy, onClick: () => act('download') }, t('download')),
          React.createElement(PeerButton, { disabled: state.busy, onClick: () => act('cancel') }, t('cancel')))));
  }
  watch('sidebar.right.pane.tab', (entry, Native) => entry.options.key === '@deepseek-ai/dsh-client-ui-sidebar-browser' ? function PeerBrowser(props) {
    const key = props.sessionId;
    const adapter = React.useMemo(() => {
      if (!remote(props.sessionId)) return undefined;
      let value = browsers.get(key);
      if (!value) {
        value = remoteBrowser(props, carrier, props.sessionId, { signal, notify, t, sourceName: () => ctx.workspaces?.list.getSnapshot().items.find(row => row.sessionIds.includes(key))?.title }); browsers.set(key, value);
      }
      return value;
    }, [key]);
    adapter?.bindActions(props.actions);
    const useBrowserState = React.useMemo(() => adapter ? id => {
      // The native keyed source is bound by the child slot. Read it here, in
      // that child's normal Hook order, rather than duplicating its binding in
      // the outer decorator; layout-effect forwarding can stall the toolbar.
      const nativeState = props.useBrowserState(id);
      const source = adapter.keyedHooks.browserState(id);
      const overlay = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
      return adapter.displayState(id, nativeState, overlay);
    } : props.useBrowserState, [adapter, props.useBrowserState]);
    if (!adapter) return React.createElement(Native, props);
    return React.createElement('div', { style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', color: 'inherit' } },
      React.createElement(BrowserFiles, { adapter, useTabInfo: props.useTabInfo, useBrowserState, sessionId: props.sessionId }),
      React.createElement('div', { style: { flex: 1, minHeight: 0, position: 'relative' } }, React.createElement(Native, { ...props, mount: adapter.mount, loadUrl: adapter.loadUrl, restore: adapter.restore, reload: adapter.reload, goBack: adapter.goBack, goForward: adapter.goForward, useBrowserState })));
  } : undefined);
  const menuSafety = installPeerMenuSafety(ctx, carrier.baseHost, openFile, saveFile, t);
  disposers.push(() => menuSafety.dispose());
  watch('shell.overlay', (entry, Native) => entry.options.id === 'context-menu' ? function PeerMenuOverlay(props) {
    const cache = React.useRef();
    const useStore = (selector, equal) => props.useStore(state => {
      const held = cache.current;
      if (!held || held.state !== state) cache.current = { state, value: { ...state, items: menuSafety.filter(state.items, state.target) } };
      return selector(cache.current.value);
    }, equal);
    return React.createElement(Native, { ...props, useStore });
  } : undefined);
  return async () => {
    for (const dispose of disposers.reverse()) dispose();
    for (const [entry, saved] of patched) if (entry.component === saved.Wrapper) entry.component = saved.Native;
    patched.clear(); await Promise.all([...browsers.values()].map(browser => browser.dispose())); browsers.clear();
  };
}
