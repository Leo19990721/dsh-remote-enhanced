const SESSION_ORDER_MIGRATED_KEY = 'dsh.remote-enhanced.session-order-migrated.v1';
const REMOTE_WORKSPACE_PREFIX = 'dsh-peer:';

export function isRemoteWorkspaceId(workspaceId) {
  return typeof workspaceId === 'string' && workspaceId.startsWith(REMOTE_WORKSPACE_PREFIX);
}

export function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

function orderByRecency(sessionIds, summaries) {
  return sessionIds
    .flatMap(id => {
      const summary = summaries?.[id];
      if (summary === undefined) return [];
      return [{ id, rank: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0 }];
    })
    .sort((a, b) => (a.rank !== b.rank ? b.rank - a.rank : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(member => member.id);
}

// Mirrors native reconcileManualOrder + sectionMembers (pinned -> unpinned -> archived)
// restricted to accounted workspace session IDs for lossless one-time local migration.
export function reconcileDisplayOrder(memberIds, savedOrder, summaries = {}, rowState = {}) {
  const members = new Set(memberIds || []);
  const included = new Set();
  const ordered = [];
  for (const key of savedOrder || []) {
    if (!members.has(key) || included.has(key)) continue;
    ordered.push(key);
    included.add(key);
  }
  const archived = new Set(rowState?.archivedSessionIds || []);
  const pinned = new Set(rowState?.pinnedSessionIds || []);
  const pins = [];
  for (const id of rowState?.pinnedSessionIds || []) {
    if (!members.has(id) || included.has(id) || archived.has(id) || summaries?.[id] === undefined) continue;
    pins.push(id);
    included.add(id);
  }
  const remaining = [...members].filter(id => !included.has(id));
  const ordinary = [];
  const archives = [];
  const summarized = new Set();
  for (const id of orderByRecency(remaining, summaries)) {
    summarized.add(id);
    if (archived.has(id)) archives.push(id);
    else ordinary.push(id);
  }
  const unsummarized = remaining.filter(id => !summarized.has(id));
  const reconciled = [...pins, ...ordered, ...ordinary, ...archives, ...unsummarized];
  const pinnedSection = [];
  const unpinnedSection = [];
  const archivedSection = [];
  for (const id of reconciled) {
    if (archived.has(id)) archivedSection.push(id);
    else if (pinned.has(id)) pinnedSection.push(id);
    else unpinnedSection.push(id);
  }
  return [...pinnedSection, ...unpinnedSection, ...archivedSection];
}

// Computes the minimal sequence of insertSessionBefore moves (via LIS) needed
// to turn currentIds into desiredOrder while preserving unaccounted tail items.
export function planSessionMoves(currentIds, desiredOrder) {
  if (!Array.isArray(currentIds) || currentIds.length <= 1 || !Array.isArray(desiredOrder)) return [];
  const currentSet = new Set(currentIds);
  const target = [];
  const seen = new Set();
  for (const id of desiredOrder) {
    if (!currentSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    target.push(id);
  }
  for (const id of currentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    target.push(id);
  }
  if (arraysEqual(currentIds, target)) return [];

  const rankOf = new Map(target.map((id, index) => [id, index]));
  const ranks = currentIds.map(id => rankOf.get(id));
  const tails = [];
  const tailIdx = [];
  const prev = new Array(ranks.length).fill(-1);
  for (let i = 0; i < ranks.length; i++) {
    const rank = ranks[i];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < rank) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = rank;
    tailIdx[lo] = i;
    if (lo > 0) prev[i] = tailIdx[lo - 1];
  }
  const keep = new Set();
  for (let idx = tailIdx.length ? tailIdx[tailIdx.length - 1] : -1; idx !== -1; idx = prev[idx]) {
    keep.add(currentIds[idx]);
  }

  const working = [...currentIds];
  const moves = [];
  for (let i = target.length - 1; i >= 0; i--) {
    const sessionId = target[i];
    if (keep.has(sessionId)) continue;
    const beforeSessionId = i + 1 < target.length ? target[i + 1] : undefined;
    const currentPos = working.indexOf(sessionId);
    const alreadyInPlace = beforeSessionId === undefined
      ? currentPos === working.length - 1
      : working[currentPos + 1] === beforeSessionId;
    if (alreadyInPlace) continue;
    moves.push(beforeSessionId === undefined ? { sessionId } : { sessionId, beforeSessionId });
    working.splice(currentPos, 1);
    const insertAt = beforeSessionId === undefined ? working.length : working.indexOf(beforeSessionId);
    working.splice(insertAt, 0, sessionId);
  }
  return moves;
}

function readMigratedWorkspaces(storage) {
  try {
    const raw = storage?.getItem?.(SESSION_ORDER_MIGRATED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter(id => typeof id === 'string' && id)) : new Set();
  } catch {
    return new Set();
  }
}

function writeMigratedWorkspaces(storage, migrated) {
  try {
    storage?.setItem?.(SESSION_ORDER_MIGRATED_KEY, JSON.stringify([...migrated].sort()));
  } catch { /* storage unavailable or quota exceeded */ }
}

// Synchronizes manual sidebar session order with each workspace's owning Host
// using DSH's native workspace/insertSessionBefore RPC and workspace/follow stream.
export function installSessionOrderSync(ctx, entry, { signal, storage } = {}) {
  const noop = { wrapActions: actions => actions, dispose() {} };
  const viewInstance = typeof entry?.store?.create === 'function' ? entry.store.create() : undefined;
  const viewActions = viewInstance?.actions;
  if (!viewActions || typeof viewInstance.getSnapshot !== 'function'
    || typeof viewActions.syncSessionOrders !== 'function'
    || typeof viewActions.setSessionOrder !== 'function'
    || typeof ctx.workspaces?.insertSessionBefore !== 'function'
    || typeof ctx.workspaces?.list?.getSnapshot !== 'function'
    || typeof ctx.workspaces?.list?.subscribe !== 'function') {
    return noop;
  }

  const resolvedStorage = storage === undefined ? globalThis.localStorage : storage;
  const migrated = readMigratedWorkspaces(resolvedStorage);
  const pendingWrites = new Map();
  const migrating = new Set();
  const wrappedActionCache = new WeakMap();
  let disposed = false;

  const isStopped = () => disposed || Boolean(signal?.aborted);
  const workspaceById = workspaceId => ctx.workspaces.list.getSnapshot()?.items?.find(row => row.workspaceId === workspaceId);

  const origSetSessionOrder = viewActions.setSessionOrder;
  const origPinSessionOrder = viewActions.pinSessionOrder;
  const origSetOrderBy = viewActions.setOrderBy;
  const origSyncSessionOrders = viewActions.syncSessionOrders;

  function markMigrated(workspaceIds) {
    let changed = false;
    for (const id of workspaceIds) {
      if (!id || isRemoteWorkspaceId(id) || migrated.has(id)) continue;
      migrated.add(id);
      changed = true;
    }
    if (changed) writeMigratedWorkspaces(resolvedStorage, migrated);
  }

  function pullHostOrders(onlyWorkspaceIds) {
    if (isStopped()) return;
    const view = viewInstance.getSnapshot();
    if (view?.orderBy !== 'manual') return;
    const wsSnap = ctx.workspaces.list.getSnapshot();
    if (!wsSnap || wsSnap.phase !== 'ready') return;
    const summaries = ctx.sessions?.list?.getSnapshot?.()?.byId;
    const updates = {};
    for (const ws of wsSnap.items || []) {
      const id = ws.workspaceId;
      if (onlyWorkspaceIds && !onlyWorkspaceIds.has(id)) continue;
      if (pendingWrites.has(id) || migrating.has(id)) continue;
      if (!isRemoteWorkspaceId(id) && !migrated.has(id)) continue;
      const hostIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
      const hostSet = new Set(hostIds);
      const saved = view.sessionOrderByAccount?.[id];
      const leadingBlanks = [];
      if (Array.isArray(saved) && summaries) {
        for (const sessionId of saved) {
          if (hostSet.has(sessionId) || !summaries[sessionId]?.blank) break;
          leadingBlanks.push(sessionId);
        }
      }
      const nextOrder = leadingBlanks.length ? [...leadingBlanks, ...hostIds] : [...hostIds];
      if (!arraysEqual(saved, nextOrder)) updates[id] = nextOrder;
    }
    if (Object.keys(updates).length > 0) origSyncSessionOrders.call(viewActions, updates);
  }

  function enqueueHostWrite(workspaceId, desiredOrder, { persistMigrated = false } = {}) {
    if (isStopped() || !workspaceId || !Array.isArray(desiredOrder)) return Promise.resolve(false);
    let state = pendingWrites.get(workspaceId);
    if (!state) {
      state = { desired: [...desiredOrder], persistMigrated, running: false, promise: null };
      pendingWrites.set(workspaceId, state);
    } else {
      state.desired = [...desiredOrder];
      if (persistMigrated) state.persistMigrated = true;
    }
    if (state.running) return state.promise;

    state.running = true;
    state.promise = (async () => {
      let succeeded = false;
      try {
        while (!isStopped()) {
          const desired = state.desired;
          state.desired = null;
          const ws = workspaceById(workspaceId);
          if (!ws) { succeeded = false; break; }
          const moves = planSessionMoves(ws.sessionIds || [], desired);
          let failed = false;
          for (const { sessionId, beforeSessionId } of moves) {
            if (isStopped()) { failed = true; break; }
            if (state.desired !== null) break;
            try {
              await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId);
            } catch (error) {
              console.warn('[remote-workspaces] Session order sync failed', workspaceId, error);
              failed = true;
              break;
            }
          }
          if (state.desired !== null) continue;
          succeeded = !failed;
          break;
        }
        if (succeeded && state.persistMigrated && !isRemoteWorkspaceId(workspaceId)) {
          markMigrated([workspaceId]);
        }
      } finally {
        if (pendingWrites.get(workspaceId) === state) pendingWrites.delete(workspaceId);
        migrating.delete(workspaceId);
      }
      if (!isStopped()) pullHostOrders(new Set([workspaceId]));
      return succeeded;
    })();
    return state.promise;
  }

  function reconcile() {
    if (isStopped()) return;
    const view = viewInstance.getSnapshot();
    const wsSnap = ctx.workspaces.list.getSnapshot();
    if (!wsSnap || wsSnap.phase !== 'ready' || view?.orderBy !== 'manual') return;
    const sessSnap = ctx.sessions?.list?.getSnapshot?.();
    const sessionsReady = !ctx.sessions?.list || sessSnap?.phase === 'ready';

    for (const ws of wsSnap.items || []) {
      const id = ws.workspaceId;
      if (isRemoteWorkspaceId(id) || migrated.has(id) || migrating.has(id) || pendingWrites.has(id)) continue;
      const saved = view.sessionOrderByAccount?.[id];
      const hostIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
      if (!Array.isArray(saved) || saved.length === 0) {
        markMigrated([id]);
        continue;
      }
      const savedSet = new Set(saved);
      const coversAll = hostIds.every(sessionId => savedSet.has(sessionId));
      if (!sessionsReady && !coversAll) continue;
      const desired = reconcileDisplayOrder(hostIds, saved, sessSnap?.byId || {}, {
        pinnedSessionIds: wsSnap.pinnedSessionIds,
        archivedSessionIds: wsSnap.archivedSessionIds,
      });
      if (planSessionMoves(hostIds, desired).length === 0) {
        markMigrated([id]);
        continue;
      }
      migrating.add(id);
      void enqueueHostWrite(id, desired, { persistMigrated: true });
    }
    pullHostOrders();
  }

  function wrappedSetSessionOrder(accountKey, order, initialOrders) {
    const wasUpdated = viewInstance.getSnapshot()?.orderBy === 'updated';
    const result = origSetSessionOrder.call(viewActions, accountKey, order, initialOrders);
    if (!isStopped()) {
      const ws = workspaceById(accountKey);
      if (ws && Array.isArray(order)) {
        void enqueueHostWrite(accountKey, order, { persistMigrated: !isRemoteWorkspaceId(accountKey) });
      }
      if (wasUpdated) {
        const wsSnap = ctx.workspaces.list.getSnapshot();
        const others = new Set();
        const localOthers = [];
        for (const row of wsSnap?.items || []) {
          if (row.workspaceId === accountKey) continue;
          others.add(row.workspaceId);
          if (!isRemoteWorkspaceId(row.workspaceId)) localOthers.push(row.workspaceId);
        }
        markMigrated(localOthers);
        pullHostOrders(others);
      }
    }
    return result;
  }

  function wrappedPinSessionOrder(sessionId, accountKeys, source) {
    const result = origPinSessionOrder ? origPinSessionOrder.call(viewActions, sessionId, accountKeys, source) : undefined;
    if (!isStopped()) {
      const view = viewInstance.getSnapshot();
      for (const key of Array.isArray(accountKeys) ? accountKeys : []) {
        const ws = workspaceById(key);
        if (!ws || !Array.isArray(ws.sessionIds) || !ws.sessionIds.includes(sessionId)) continue;
        const desired = view?.orderBy === 'manual' && Array.isArray(view.sessionOrderByAccount?.[key])
          ? view.sessionOrderByAccount[key]
          : [sessionId, ...ws.sessionIds.filter(id => id !== sessionId)];
        void enqueueHostWrite(key, desired, { persistMigrated: !isRemoteWorkspaceId(key) });
      }
    }
    return result;
  }

  function wrappedSetOrderBy(mode, initialOrders) {
    const result = origSetOrderBy ? origSetOrderBy.call(viewActions, mode, initialOrders) : undefined;
    if (!isStopped() && mode === 'manual') {
      const wsSnap = ctx.workspaces.list.getSnapshot();
      markMigrated((wsSnap?.items || []).map(row => row.workspaceId));
      pullHostOrders();
    }
    return result;
  }

  viewActions.setSessionOrder = wrappedSetSessionOrder;
  if (origPinSessionOrder) viewActions.pinSessionOrder = wrappedPinSessionOrder;
  if (origSetOrderBy) viewActions.setOrderBy = wrappedSetOrderBy;

  const unsubWorkspaces = ctx.workspaces.list.subscribe(reconcile);
  const unsubSessions = typeof ctx.sessions?.list?.subscribe === 'function'
    ? ctx.sessions.list.subscribe(reconcile)
    : undefined;
  const onAbort = () => dispose();
  signal?.addEventListener?.('abort', onAbort, { once: true });

  reconcile();

  function wrapActions(actions) {
    if (!actions || actions === viewActions) return actions;
    let wrapped = wrappedActionCache.get(actions);
    if (!wrapped) {
      wrapped = {
        ...actions,
        setSessionOrder: wrappedSetSessionOrder,
        ...(origPinSessionOrder ? { pinSessionOrder: wrappedPinSessionOrder } : {}),
        ...(origSetOrderBy ? { setOrderBy: wrappedSetOrderBy } : {}),
      };
      wrappedActionCache.set(actions, wrapped);
    }
    return wrapped;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener?.('abort', onAbort);
    unsubWorkspaces?.();
    unsubSessions?.();
    if (viewActions.setSessionOrder === wrappedSetSessionOrder) viewActions.setSessionOrder = origSetSessionOrder;
    if (origPinSessionOrder && viewActions.pinSessionOrder === wrappedPinSessionOrder) viewActions.pinSessionOrder = origPinSessionOrder;
    if (origSetOrderBy && viewActions.setOrderBy === wrappedSetOrderBy) viewActions.setOrderBy = origSetOrderBy;
    pendingWrites.clear();
    migrating.clear();
  }

  return { wrapActions, dispose };
}
