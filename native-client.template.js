window.__ModuleLoader__.load({
  id: '@local/dsh-unified-sessions',
  factory(require) {
    const React = require('react');
    const dictionaries = /* DICTIONARIES */ {};
    /* STREAMS */
    /* CARRIER */
    /* MODELS */
    /* RESIDENCY */
    /* BROWSER */
    /* RESOURCE_MENUS */
    /* RESOURCES */
    return {
      inject: ['connection', 'typert', 'remote', 'slots', 'sessions', 'workspaces', 'locale', 'fileUpload', 'modelDirectories'],
      async apply(ctx) {
        if (!ctx.connection.isLoopback) return;
        const stop = new AbortController();
        ctx.effect(() => ctx.locale.register('remoteWorkspaces', dictionaries), 'remote-workspaces: dictionaries');
        ctx.effect(() => () => stop.abort(), 'remote-workspaces: lifetime');
        // One existing Controller remains authoritative for every native view.
        // Attach first: a failed handshake cannot alter any original service.
        const carrier = await installSessionCarrier(ctx, { signal: stop.signal });
        if (stop.signal.aborted) { await carrier.dispose(); return; }
        ctx.effect(() => async () => {
          await carrier.dispose();
          ctx.connection.reconnect();
        }, 'remote-workspaces: native request carrier');
        ctx.effect(() => installSessionResidency(ctx.sessions), 'remote-workspaces: recently viewed sessions');
        const models = installSessionModels(ctx.modelDirectories, carrier, stop.signal);
        ctx.effect(() => models, 'remote-workspaces: session model catalogs');
        // Optional resource surfaces are composed by their original packages.
        ctx.inject(['remote.workspaceFiles', 'sidebarRight', 'sidebarRightTabs', 'resources', 'contextMenus', 'fileActions', 'fileDrag', 'shortcuts'], resourceCtx => {
          resourceCtx.effect(() => installSessionResources(resourceCtx, carrier, React, stop.signal), 'remote-workspaces: session resources');
        });
        for (const event of ['llm/adapters-updated', 'llm/models-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated']) ctx.remote.$on(event, () => models.refresh());
        const upload = ctx.fileUpload, originalPost = upload.post;
        const post = request => carrier.postUpload(request);
        upload.post = post;
        ctx.effect(() => () => { if (upload.post === post) upload.post = originalPost; }, 'remote-workspaces: session attachments');
        // Preserve the native folder component and every action. Only avoid
        // path-tree grouping, which would nest identically named computers.
        const entries = new Map();
        function reconcile() {
          for (const entry of ctx.slots.entries('sidebar.workspaces')) {
            if (entries.has(entry) || !entry.children?.['sidebar.workspaces.directoryFlow'] || typeof entry.component !== 'function') continue;
            const Native = entry.component;
            function WorkspacePeers(props) {
              const useStore = (selector, equal) => props.useStore(value => selector(value.groupBy === 'workspace-tree' ? { ...value, groupBy: 'workspace' } : value), equal);
              return React.createElement(Native, { ...props, useStore });
            }
            entry.component = WorkspacePeers;
            entries.set(entry, { original: Native, wrapper: WorkspacePeers });
          }
        }
        ctx.slots.inject('sidebar.workspaces', () => {
          reconcile();
          const unsubscribe = ctx.slots.subscribe('sidebar.workspaces', reconcile);
          return () => {
            unsubscribe();
            for (const [entry, saved] of entries) if (entry.component === saved.wrapper) entry.component = saved.original;
            entries.clear();
          };
        });
        // Version-scoped migration of already-open native logical streams. The
        // native supervisors replace their carriers while preserving bindings.
        ctx.connection.reconnect();
        ctx.remote.streams?.reconnect();
        for (const session of ctx.sessions.manager?.sessions?.values() || []) {
          if (session.events) session.events.restart();
        }
        // A recovered Host replaces only its own history generations. Native
        // bindings, renderer state and drafts remain resident.
        void (async () => {
          const offline = new Set();
          try {
            for await (const status of carrier.status(stop.signal)) {
              if (!status.online) { offline.add(status.hostId); continue; }
              if (status.catalogChanged) { models.refresh(status.hostId); continue; }
              if (!offline.delete(status.hostId)) continue;
              models.refresh(status.hostId);
              for (const session of ctx.sessions.manager?.sessions?.values() || []) {
                const id = session.sessionId;
                let hostId = carrier.baseHost;
                if (id.startsWith('dsh-peer:')) { try { hostId = JSON.parse(id.slice(9))[0]; } catch { continue; } }
                if (hostId === status.hostId) void session.resync().catch(error => console.error('[remote-workspaces] Session recovery failed', error));
              }
              await ctx.sessions.refresh();
            }
          } catch (error) { if (!stop.signal.aborted) console.error('[remote-workspaces] Host status stream failed', error); }
        })();
      },
    };
  },
});
