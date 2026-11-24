const SESSION_ORDER_MIGRATED_KEY = 'dsh.remote-enhanced.session-order-migrated.v1';
const REMOTE_WORKSPACE_PREFIX = 'dsh-peer:';
const LOCAL_ORDER_ONLY_KEY = 'dsh.remote-enhanced.session-order-local-only.v1';

const UNSUPPORTED_ORDER_CODES = new Set([
  'METHOD_NOT_ALLOWED', 'FEATURE_NOT_SUPPORTED', 'UNKNOWN_ENDPOINT',
  'gateway/definition-unavailable', 'gateway/method-unavailable', 'session-hosts/route-unavailable',
]);
const ORDER_DENIAL_CODES = new Set(['PERMISSION_DENIED', 'FORBIDDEN', 'gateway/forbidden', 'remote-access/denied']);
const workspaceRevision = row => Date.parse(row?.updatedAt);
const orderedMembers = (current, desired) => {
  const members = new Set(current);
  const order = [...new Set(desired)].filter(id => members.delete(id));
  return [...order, ...members];
};

function orderFailureCode(error) {
  return error?.rpcError?.code || error?.code || /^workspace move failed: ([\w/-]+):/.exec(error?.message || '')?.[1];
}

export function workspaceOwner(workspaceId, baseHost = 'local') {
  if (typeof workspaceId !== 'string' || !workspaceId) return undefined;
  if (!workspaceId.startsWith(REMOTE_WORKSPACE_PREFIX)) return { hostId: baseHost, id: workspaceId };
  try {
    const parts = JSON.parse(workspaceId.slice(REMOTE_WORKSPACE_PREFIX.length));
    if (Array.isArray(parts) && parts.length === 3 && parts[1] === 'workspace'
      && typeof parts[0] === 'string' && parts[0] && typeof parts[2] === 'string' && parts[2]) {
      return { hostId: parts[0], id: parts[2] };
    }
  } catch { /* Invalid federated identity; never treat it as local. */ }
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

// Native Manual reconciliation for accounted Workspace members. Save the raw
// order: the renderer partitions visible pinned/blank rows without moving the
// saved slots of archived rows, and unpin/archive changes reuse those slots.
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
  return [...pins, ...ordered, ...ordinary, ...archives, ...unsummarized];
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

function readOrderKeys(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter(id => typeof id === 'string' && id)) : new Set();
  } catch {
    return new Set();
  }
}

function writeOrderKeys(storage, key, ids) {
  try {
    storage?.setItem?.(key, JSON.stringify([...ids].sort()));
  } catch { /* storage unavailable or quota exceeded */ }
}

// Synchronizes manual sidebar session order with each workspace's owning Host
// using DSH's native workspace/insertSessionBefore RPC and workspace/follow stream.
export function installSessionOrderSync(ctx, entry, { signal, storage, carrier } = {}) {
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
  const migrated = readOrderKeys(resolvedStorage, SESSION_ORDER_MIGRATED_KEY);
  const initialView = viewInstance.getSnapshot();
  const legacy = new Map(initialView?.orderBy === 'manual' ? Object.entries(initialView.sessionOrderByAccount || {}).filter(([, order]) => Array.isArray(order) && order.length > 0) : []);
  const localOnly = readOrderKeys(resolvedStorage, LOCAL_ORDER_ONLY_KEY);
  const unsupportedHosts = new Set();
  const pendingWrites = new Map();
  const migrationBackoff = new Map();
  const accepted = new Map();
  const wrappedActionCache = new WeakMap();
  const stop = new AbortController();
  let disposed = false;

  const isStopped = () => disposed || Boolean(signal?.aborted);
  const ownerOf = id => workspaceOwner(id, carrier?.baseHost);
  const workspaceById = workspaceId => ctx.workspaces.list.getSnapshot()?.items?.find(row => row.workspaceId === workspaceId);
  const canSync = owner => owner && carrier?.canSyncWorkspaceOrder !== false && !unsupportedHosts.has(owner.hostId);
  const ready = snapshot => snapshot?.phase === 'ready' && (snapshot.state === undefined || snapshot.state === 'idle');
  const notifyFailure = (code, migration) => {
    if (migration || isStopped()) return;
    const t = ctx.locale?.bind('remoteWorkspaces');
    const key = UNSUPPORTED_ORDER_CODES.has(code) ? 'sessionOrderUnsupported'
      : ORDER_DENIAL_CODES.has(code) ? 'sessionOrderDenied' : 'sessionOrderNotSynced';
    console.warn('[remote-workspaces]', t?.(key) || key);
  };

  function applyLocalOverride(workspaceId, value) {
    // Persist the fallback, not a write to replay. A fresh drag (or explicitly
    // selecting Manual anew) is what can replace it with the Host's order.
    if (localOnly.has(workspaceId) === value) return;
    if (value) localOnly.add(workspaceId); else localOnly.delete(workspaceId);
    writeOrderKeys(resolvedStorage, LOCAL_ORDER_ONLY_KEY, localOnly);
  }

  function rememberRow(row, authoritative = false) {
    if (!row || typeof row.workspaceId !== 'string' || !Array.isArray(row.sessionIds)) return;
    const previous = accepted.get(row.workspaceId);
    if (previous && Number.isFinite(workspaceRevision(row)) && Number.isFinite(workspaceRevision(previous.row))) {
      const before = workspaceRevision(row) - workspaceRevision(previous.row);
      if (before < 0 || !authoritative && before === 0 && previous.authoritative) return previous.row;
    }
    accepted.set(row.workspaceId, { row, authoritative });
    return row;
  }

  async function readFresh(workspaceId) {
    if (typeof carrier?.readWorkspaceOrder === 'function') {
      const receipt = await carrier.readWorkspaceOrder(workspaceId, stop.signal);
      if (!receipt?.ok) throw Object.assign(new Error('Workspace order read failed'), { code: receipt?.error?.code });
      const value = receipt.value;
      if (value?.workspace?.workspaceId !== workspaceId || !Array.isArray(value.workspace.sessionIds)) {
        throw new Error('Invalid Workspace order baseline');
      }
      if (rememberRow(value.workspace, true) !== value.workspace) throw new Error('Workspace order baseline was superseded');
      return value;
    }
    // Native-only fixture/adapter: the caller's Workspace source must be live.
    const snapshot = ctx.workspaces.list.getSnapshot();
    const workspace = workspaceById(workspaceId);
    if (!workspace || !ready(snapshot)) throw new Error('Workspace order baseline unavailable');
    return { workspace, archivedSessionIds: snapshot.archivedSessionIds, pinnedSessionIds: snapshot.pinnedSessionIds };
  }

  const origSetSessionOrder = viewActions.setSessionOrder;
  const origPinSessionOrder = viewActions.pinSessionOrder;
  const origSetOrderBy = viewActions.setOrderBy;
  const origSyncSessionOrders = viewActions.syncSessionOrders;

  function markMigrated(workspaceId) {
    const owner = ownerOf(workspaceId);
    if (owner?.hostId !== 'local') return;
    legacy.delete(workspaceId);
    if (!migrated.has(owner.id)) {
      migrated.add(owner.id);
      writeOrderKeys(resolvedStorage, SESSION_ORDER_MIGRATED_KEY, migrated);
    }
  }

  function pullHostOrders(onlyWorkspaceIds) {
    if (isStopped()) return;
    const view = viewInstance.getSnapshot();
    if (view?.orderBy !== 'manual') return;
    const wsSnap = ctx.workspaces.list.getSnapshot();
    if (!ready(wsSnap)) return;
    const summaries = ctx.sessions?.list?.getSnapshot?.()?.byId;
    const updates = {};
    for (const ws of wsSnap.items || []) {
      const id = ws.workspaceId;
      if (onlyWorkspaceIds && !onlyWorkspaceIds.has(id)) continue;
      const owner = ownerOf(id);
      if (!canSync(owner)) continue;
      const row = rememberRow(ws);
      if (pendingWrites.has(id) || localOnly.has(id)) continue;
      if (owner.hostId === 'local' && legacy.has(id) && !migrated.has(owner.id)) continue;
      const hostIds = row?.sessionIds;
      if (!hostIds) continue;
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

  function enqueueHostWrite(workspaceId, intent) {
    const owner = ownerOf(workspaceId);
    if (isStopped() || !owner) return;
    if (!canSync(owner)) {
      if (!intent.migration) {
        applyLocalOverride(workspaceId, true);
        notifyFailure('gateway/method-unavailable', false);
      }
      return;
    }
    // If the page closes or loses its carrier before the receipt arrives, the
    // new local arrangement must not be replayed or replaced on the next load.
    if (!intent.migration) applyLocalOverride(workspaceId, true);
    const pending = pendingWrites.get(workspaceId);
    if (pending) { pending.next = intent; return; }
    const state = { next: intent };
    pendingWrites.set(workspaceId, state);
    void (async () => {
      try {
        while (state.next && !isStopped()) {
          const { order, migration, pin } = state.next;
          state.next = undefined;
          let dispatched = false;
          try {
            const baseline = await readFresh(workspaceId);
            if (state.next || isStopped()) continue;
            let current = baseline.workspace.sessionIds;
            let desired = order;
            if (migration) {
              // Read the preserved pre-upgrade Browser layout, not a store
              // rewritten by a stale workspace frame or pin on another account.
              const summaries = ctx.sessions?.list?.getSnapshot?.()?.byId || {};
              const saved = new Set(order);
              if (ctx.sessions?.list && current.some(id => !saved.has(id) && !summaries[id])) break;
              desired = order.some(id => current.includes(id))
                ? reconcileDisplayOrder(current, order, summaries, baseline) : current;
            } else if (pin) {
              if (!current.includes(pin)) throw new Error('Pinned Session is not accounted');
              // Move only the pinned row; preserve every other saved slot.
              desired = [pin, ...current.filter(id => id !== pin)];
            } else {
              // A Session attached after the drag snapshot retains its fresh
              // slot. Never let a stale client move an unknown row to the tail.
              const dragMembers = new Set(order);
              const ranked = orderedMembers(current.filter(id => dragMembers.has(id)), order);
              let index = 0;
              desired = current.map(id => dragMembers.has(id) ? ranked[index++] : id);
            }
            const expected = orderedMembers(current, desired);
            const moves = planSessionMoves(current, expected);
            for (const { sessionId, beforeSessionId } of moves) {
              if (isStopped() || state.next) break;
              dispatched = true;
              const ack = await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId);
              if (ack?.workspaceId !== workspaceId || !Array.isArray(ack.sessionIds)) throw new Error('Invalid Workspace order receipt');
              if (rememberRow(ack, true) !== ack) throw new Error('Workspace order receipt was superseded');
              const projected = current.filter(id => id !== sessionId);
              const insertAt = beforeSessionId === undefined ? projected.length : projected.indexOf(beforeSessionId);
              projected.splice(insertAt, 0, sessionId);
              if (!arraysEqual(ack.sessionIds, projected)) {
                // Membership or order changed concurrently. Never continue
                // sending the old plan against the new version of that Host.
                throw new Error('Workspace order changed during the write');
              }
              current = ack.sessionIds;
            }
            if (state.next || isStopped()) continue;
            if (!arraysEqual(expected, current)) throw new Error('Workspace order not confirmed');
            markMigrated(workspaceId);
            migrationBackoff.delete(workspaceId);
            applyLocalOverride(workspaceId, false);
          } catch (error) {
            if (isStopped()) break;
            const code = orderFailureCode(error);
            if (UNSUPPORTED_ORDER_CODES.has(code)) unsupportedHosts.add(owner.hostId);
            if (!migration || dispatched || ORDER_DENIAL_CODES.has(code)) applyLocalOverride(workspaceId, true);
            else migrationBackoff.set(workspaceId, Date.now() + 10000);
            if (!state.next || !canSync(owner)) { notifyFailure(code, migration); break; }
          }
        }
      } finally {
        pendingWrites.delete(workspaceId);
        if (!isStopped()) pullHostOrders(new Set([workspaceId]));
      }
    })();
  }

  function reconcile() {
    if (isStopped() || viewInstance.getSnapshot()?.orderBy !== 'manual') return;
    const wsSnap = ctx.workspaces.list.getSnapshot();
    if (!ready(wsSnap)) return;
    const sessSnap = ctx.sessions?.list?.getSnapshot?.();
    for (const ws of wsSnap.items || []) {
      const id = ws.workspaceId;
      const owner = ownerOf(id);
      const saved = legacy.get(id);
      if (owner?.hostId !== 'local' || !saved || !canSync(owner) || migrated.has(owner.id)
        || pendingWrites.has(id) || localOnly.has(id) || (migrationBackoff.get(id) || 0) > Date.now()) continue;
      const savedSet = new Set(saved);
      if (ctx.sessions?.list && (ws.sessionIds || []).some(sessionId => !savedSet.has(sessionId)
        && (sessSnap?.phase !== 'ready' || !sessSnap.byId?.[sessionId]))) continue;
      void enqueueHostWrite(id, { order: saved, migration: true });
    }
    pullHostOrders();
  }

  function wrappedSetSessionOrder(accountKey, order, initialOrders) {
    const wasUpdated = viewInstance.getSnapshot()?.orderBy === 'updated';
    const result = origSetSessionOrder.call(viewActions, accountKey, order, initialOrders);
    if (!isStopped()) {
      if (workspaceById(accountKey) && Array.isArray(order)) {
        void enqueueHostWrite(accountKey, { order });
      }
      if (wasUpdated) pullHostOrders();
    }
    return result;
  }

  function wrappedPinSessionOrder(sessionId, accountKeys, source) {
    const result = origPinSessionOrder ? origPinSessionOrder.call(viewActions, sessionId, accountKeys, source) : undefined;
    if (!isStopped()) {
      for (const key of Array.isArray(accountKeys) ? accountKeys : []) {
        const ws = workspaceById(key);
        if (ws?.sessionIds?.includes(sessionId)) {
          const saved = legacy.get(key);
          const owner = ownerOf(key);
          if (owner?.hostId === 'local' && saved && !migrated.has(owner.id)) {
            // Finish the owner migration before letting the Pin update turn a
            // partially reconciled local view into the shared order.
            const order = [sessionId, ...saved.filter(id => id !== sessionId)];
            legacy.set(key, order);
            void enqueueHostWrite(key, { order, migration: true });
          } else void enqueueHostWrite(key, { pin: sessionId });
        }
      }
    }
    return result;
  }

  function wrappedSetOrderBy(mode, initialOrders) {
    const wasUpdated = viewInstance.getSnapshot()?.orderBy === 'updated';
    const result = origSetOrderBy ? origSetOrderBy.call(viewActions, mode, initialOrders) : undefined;
    if (!isStopped() && mode === 'manual') {
      if (wasUpdated) {
        for (const id of [...localOnly]) if (canSync(ownerOf(id))) applyLocalOverride(id, false);
      }
      reconcile();
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
    stop.abort();
    signal?.removeEventListener?.('abort', onAbort);
    unsubWorkspaces?.();
    unsubSessions?.();
    if (viewActions.setSessionOrder === wrappedSetSessionOrder) viewActions.setSessionOrder = origSetSessionOrder;
    if (origPinSessionOrder && viewActions.pinSessionOrder === wrappedPinSessionOrder) viewActions.pinSessionOrder = origPinSessionOrder;
    if (origSetOrderBy && viewActions.setOrderBy === wrappedSetOrderBy) viewActions.setOrderBy = origSetOrderBy;
    pendingWrites.clear();
    accepted.clear();
  }

  return { wrapActions, dispose };
}
