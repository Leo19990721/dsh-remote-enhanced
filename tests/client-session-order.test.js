import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installSessionOrderSync,
  planSessionMoves,
  reconcileDisplayOrder,
} from '../client-session-order.js';

function applyMoves(initial, moves) {
  const arr = [...initial];
  for (const { sessionId, beforeSessionId } of moves) {
    const idx = arr.indexOf(sessionId);
    assert.notEqual(idx, -1, `session ${sessionId} must exist`);
    arr.splice(idx, 1);
    if (beforeSessionId === undefined) {
      arr.push(sessionId);
    } else {
      const anchor = arr.indexOf(beforeSessionId);
      assert.notEqual(anchor, -1, `anchor ${beforeSessionId} must exist`);
      arr.splice(anchor, 0, sessionId);
    }
  }
  return arr;
}

function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    dump: () => Object.fromEntries(data),
  };
}

function createFixture({
  orderBy = 'manual',
  sessionOrderByAccount = {},
  workspaces = [],
  workspacePhase = 'ready',
  pinnedSessionIds = [],
  archivedSessionIds = [],
  sessions = {},
  sessionPhase = 'ready',
  storage = createMemoryStorage(),
  onInsert,
} = {}) {
  let viewState = {
    groupBy: 'workspace',
    orderBy,
    groupExpansion: {},
    sessionOrderByAccount: Object.fromEntries(
      Object.entries(sessionOrderByAccount).map(([k, v]) => [k, [...v]]),
    ),
    archivedFilter: 'default',
  };
  let wsState = {
    phase: workspacePhase,
    items: workspaces.map(ws => ({ ...ws, sessionIds: [...ws.sessionIds] })),
    pinnedSessionIds: [...pinnedSessionIds],
    archivedSessionIds: [...archivedSessionIds],
  };
  let sessState = {
    phase: sessionPhase,
    ids: Object.keys(sessions),
    byId: { ...sessions },
  };
  const wsListeners = new Set();
  const sessListeners = new Set();
  const calls = [];
  const syncCalls = [];

  const emitWs = () => { for (const fn of [...wsListeners]) fn(); };
  const emitSess = () => { for (const fn of [...sessListeners]) fn(); };

  const viewActions = {
    setOrderBy(mode, initialOrders = {}) {
      if (mode === viewState.orderBy) return;
      viewState = {
        ...viewState,
        orderBy: mode,
        sessionOrderByAccount: mode === 'manual'
          ? Object.fromEntries(Object.entries(initialOrders).map(([k, v]) => [k, [...v]]))
          : {},
      };
    },
    syncSessionOrders(orders) {
      if (viewState.orderBy !== 'manual') return;
      syncCalls.push(orders);
      viewState = {
        ...viewState,
        sessionOrderByAccount: {
          ...viewState.sessionOrderByAccount,
          ...Object.fromEntries(Object.entries(orders).map(([k, v]) => [k, [...v]])),
        },
      };
    },
    setSessionOrder(accountKey, order, initialOrders = {}) {
      const nextMap = viewState.orderBy === 'updated'
        ? Object.fromEntries(Object.entries(initialOrders).map(([k, v]) => [k, [...v]]))
        : {
            ...viewState.sessionOrderByAccount,
            ...Object.fromEntries(Object.entries(initialOrders).map(([k, v]) => [k, [...v]])),
          };
      nextMap[accountKey] = [...order];
      viewState = { ...viewState, orderBy: 'manual', sessionOrderByAccount: nextMap };
    },
    pinSessionOrder(sessionId, accountKeys, source) {
      const selected = new Set(accountKeys);
      const nextMap = { ...viewState.sessionOrderByAccount };
      for (const [key, members] of Object.entries(source?.members || {})) {
        const order = reconcileDisplayOrder(members, nextMap[key], source.summaries, source.rowState);
        nextMap[key] = selected.has(key) ? [sessionId, ...order.filter(id => id !== sessionId)] : order;
      }
      viewState = { ...viewState, sessionOrderByAccount: nextMap };
    },
  };

  const viewInstance = {
    getSnapshot: () => viewState,
    actions: viewActions,
  };
  const entry = {
    store: { create: () => viewInstance },
    children: { 'sidebar.workspaces.directoryFlow': {} },
  };

  function mutateWorkspace(workspaceId, sessionId, beforeSessionId) {
    wsState = {
      ...wsState,
      items: wsState.items.map(ws => {
        if (ws.workspaceId !== workspaceId) return ws;
        const without = ws.sessionIds.filter(id => id !== sessionId);
        const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId);
        assert.notEqual(at, -1, `missing anchor ${beforeSessionId}`);
        return {
          ...ws,
          sessionIds: [...without.slice(0, at), sessionId, ...without.slice(at)],
        };
      }),
    };
    emitWs();
    return wsState.items.find(ws => ws.workspaceId === workspaceId);
  }

  const ctx = {
    workspaces: {
      list: {
        getSnapshot: () => wsState,
        subscribe(fn) { wsListeners.add(fn); return () => wsListeners.delete(fn); },
      },
      async insertSessionBefore(workspaceId, sessionId, beforeSessionId) {
        calls.push({ workspaceId, sessionId, beforeSessionId });
        if (onInsert) return await onInsert({ workspaceId, sessionId, beforeSessionId, mutate: () => mutateWorkspace(workspaceId, sessionId, beforeSessionId) });
        return mutateWorkspace(workspaceId, sessionId, beforeSessionId);
      },
    },
    sessions: {
      list: {
        getSnapshot: () => sessState,
        subscribe(fn) { sessListeners.add(fn); return () => sessListeners.delete(fn); },
      },
    },
  };

  return {
    ctx,
    entry,
    storage,
    viewInstance,
    viewActions,
    calls,
    syncCalls,
    getView: () => viewState,
    getWorkspaces: () => wsState,
    setWorkspaces(patch) {
      wsState = { ...wsState, ...patch };
      emitWs();
    },
    setSessions(patch) {
      sessState = { ...sessState, ...patch };
      emitSess();
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 10));
}

test('planSessionMoves computes exact minimal moves across common drags and 300 random permutations', () => {
  assert.deepEqual(planSessionMoves(['a', 'b', 'c', 'd'], ['c', 'a', 'b', 'd']), [
    { sessionId: 'c', beforeSessionId: 'a' },
  ]);
  assert.deepEqual(planSessionMoves(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'a']), [
    { sessionId: 'a' },
  ]);
  assert.deepEqual(planSessionMoves(['a', 'b', 'c', 'd'], ['blank-1', 'c', 'a']), [
    { sessionId: 'c', beforeSessionId: 'a' },
  ]);
  assert.deepEqual(planSessionMoves(['a', 'b', 'c'], ['a', 'b', 'c']), []);

  // Deterministic PRNG fuzzing (300 permutations of lengths 2..12).
  let seed = 0x51a7c3;
  const nextInt = max => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % max;
  };
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + (trial % 11);
    const current = Array.from({ length: n }, (_, i) => `s${i}`);
    const desired = [...current];
    for (let i = n - 1; i > 0; i--) {
      const j = nextInt(i + 1);
      [desired[i], desired[j]] = [desired[j], desired[i]];
    }
    const moves = planSessionMoves(current, desired);
    assert.deepEqual(applyMoves(current, moves), desired, `trial ${trial} failed`);
    assert.ok(moves.length <= n - 1, `trial ${trial} used too many moves`);
  }
});

test('native raw reconciliation preserves saved pin and archived slots', () => {
  const result = reconcileDisplayOrder(
    ['u1', 'p2', 'a1', 'p1', 'u2', 'u3'],
    ['u2', 'a1', 'p1', 'u1'],
    {
      u1: { updatedAt: 10 },
      u2: { updatedAt: 20 },
      u3: { updatedAt: 50 },
      p1: { updatedAt: 30 },
      p2: { updatedAt: 40 },
      a1: { updatedAt: 60 },
    },
    { pinnedSessionIds: ['p2', 'p1'], archivedSessionIds: ['a1'] },
  );
  // The renderer groups visible pins without changing other saved positions.
  assert.deepEqual(result, ['p2', 'u2', 'a1', 'p1', 'u1', 'u3']);
});

test('one-time local migration pushes existing local order to local Host without touching remote Hosts', async () => {
  const remoteWs = 'dsh-peer:["host-b","workspace","ws-1"]';
  const f = createFixture({
    orderBy: 'manual',
    sessionOrderByAccount: {
      'local-ws': ['s3', 's1', 's2'],
      [remoteWs]: ['r-stale-2', 'r-stale-1'],
    },
    workspaces: [
      { workspaceId: 'local-ws', sessionIds: ['s1', 's2', 's3'] },
      { workspaceId: remoteWs, sessionIds: ['r1', 'r2', 'r3'] },
    ],
    sessions: {
      s1: { updatedAt: 1 }, s2: { updatedAt: 2 }, s3: { updatedAt: 3 },
      r1: { updatedAt: 1 }, r2: { updatedAt: 2 }, r3: { updatedAt: 3 },
    },
  });

  const controller = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage });
  try {
    await flush();
    // Only local-ws was written to Host (1 minimal move: s3 before s1).
    assert.deepEqual(f.calls, [{ workspaceId: 'local-ws', sessionId: 's3', beforeSessionId: 's1' }]);
    assert.deepEqual(f.getWorkspaces().items[0].sessionIds, ['s3', 's1', 's2']);
    // Remote workspace was pulled from remote Host, never pushed from stale local storage.
    assert.deepEqual(f.getView().sessionOrderByAccount[remoteWs], ['r1', 'r2', 'r3']);
    // Migration flag recorded for local-ws only.
    assert.deepEqual(
      JSON.parse(f.storage.getItem('dsh.remote-enhanced.session-order-migrated.v1')),
      ['local-ws'],
    );
  } finally {
    controller.dispose();
  }
});

test('one-time local migration waits for sessions readiness when saved order is partial', async () => {
  const f = createFixture({
    orderBy: 'manual',
    sessionOrderByAccount: { 'local-ws': ['s2'] },
    workspaces: [{ workspaceId: 'local-ws', sessionIds: ['s1', 's2', 's3'] }],
    sessionPhase: 'loading',
    sessions: {},
  });

  const controller = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage });
  try {
    await flush();
    assert.equal(f.calls.length, 0, 'must wait for sessions ready before migrating partial savedOrder');
    f.setSessions({
      phase: 'ready',
      ids: ['s1', 's2', 's3'],
      byId: { s1: { updatedAt: 10 }, s2: { updatedAt: 5 }, s3: { updatedAt: 30 } },
    });
    await flush();
    assert.deepEqual(f.getWorkspaces().items[0].sessionIds, ['s2', 's3', 's1']);
  } finally {
    controller.dispose();
  }
});

test('live workspace/follow updates sync remote & migrated local order without ping-pong and preserve leading blank', async () => {
  const remoteWs = 'dsh-peer:["host-b","workspace","ws-1"]';
  const f = createFixture({
    orderBy: 'manual',
    sessionOrderByAccount: {
      [remoteWs]: ['blank-1', 'r1', 'r2'],
    },
    workspaces: [{ workspaceId: remoteWs, sessionIds: ['r1', 'r2'] }],
    sessions: {
      'blank-1': { blank: true, updatedAt: 99 },
      r1: { updatedAt: 10 },
      r2: { updatedAt: 20 },
    },
  });

  const controller = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage });
  try {
    await flush();
    // Leading blank preserved -> no redundant syncSessionOrders call.
    assert.equal(f.syncCalls.length, 0);
    assert.equal(f.calls.length, 0);

    // Peer Host reorders r2 before r1.
    f.setWorkspaces({
      items: [{ workspaceId: remoteWs, sessionIds: ['r2', 'r1'] }],
    });
    assert.deepEqual(f.getView().sessionOrderByAccount[remoteWs], ['blank-1', 'r2', 'r1']);
    assert.equal(f.calls.length, 0, 'Host->client pull must never write back to Host');
  } finally {
    controller.dispose();
  }
});

test('rapid drags coalesce cleanly without intermediate upsert echo clobbering optimistic order', async () => {
  const remoteWs = 'dsh-peer:["host-b","workspace","ws-1"]';
  const gates = [];
  const f = createFixture({
    orderBy: 'manual',
    workspaces: [{ workspaceId: remoteWs, sessionIds: ['a', 'b', 'c', 'd'] }],
    onInsert: async ({ mutate }) => {
      const gate = Promise.withResolvers();
      gates.push(gate);
      await gate.promise;
      return mutate();
    },
  });

  const controller = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage });
  try {
    await flush();
    // Drag 1: reverse [d, c, b, a] (needs multiple moves).
    f.viewActions.setSessionOrder(remoteWs, ['d', 'c', 'b', 'a'], {});
    await Promise.resolve();
    assert.equal(gates.length, 1);

    // Before drag 1 finishes, user drags again to [b, a, c, d].
    f.viewActions.setSessionOrder(remoteWs, ['b', 'a', 'c', 'd'], {});
    assert.deepEqual(f.getView().sessionOrderByAccount[remoteWs], ['b', 'a', 'c', 'd']);

    // Release in-flight RPC #1 -> intermediate upsert must NOT clobber view's [b, a, c, d].
    gates.shift().resolve();
    await flush();
    assert.deepEqual(f.getView().sessionOrderByAccount[remoteWs], ['b', 'a', 'c', 'd']);

    // Drain remaining coalesced RPCs.
    while (gates.length) {
      gates.shift().resolve();
      await flush();
    }
    assert.deepEqual(f.getWorkspaces().items[0].sessionIds, ['b', 'a', 'c', 'd']);
    assert.deepEqual(f.getView().sessionOrderByAccount[remoteWs], ['b', 'a', 'c', 'd']);
  } finally {
    controller.dispose();
  }
});

test('pinSessionOrder syncs pinned session to top on Host in both manual and updated modes', async () => {
  const remoteWs = 'dsh-peer:["host-b","workspace","ws-1"]';
  const f = createFixture({
    orderBy: 'updated',
    workspaces: [{ workspaceId: remoteWs, sessionIds: ['r1', 'r2', 'r3'] }],
    sessions: { r1: { updatedAt: 1 }, r2: { updatedAt: 2 }, r3: { updatedAt: 3 } },
  });

  const controller = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage });
  try {
    f.viewActions.pinSessionOrder('r3', [remoteWs], {
      members: { [remoteWs]: ['r1', 'r2', 'r3'] },
      summaries: f.ctx.sessions.list.getSnapshot().byId,
      rowState: { pinnedSessionIds: ['r3'], archivedSessionIds: [] },
    });
    await flush();
    assert.deepEqual(f.calls, [{ workspaceId: remoteWs, sessionId: 'r3', beforeSessionId: 'r1' }]);
    assert.deepEqual(f.getWorkspaces().items[0].sessionIds, ['r3', 'r1', 'r2']);
  } finally {
    controller.dispose();
  }
});

test('switching from updated to manual mode pulls authoritative Host order instead of freezing recency', async () => {
  const remoteWs = 'dsh-peer:["host-b","workspace","ws-1"]';
  const f = createFixture({
    orderBy: 'updated',
    workspaces: [
      { workspaceId: 'local-ws', sessionIds: ['l2', 'l1'] },
      { workspaceId: remoteWs, sessionIds: ['r3', 'r1', 'r2'] },
    ],
  });

  const controller = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage });
  try {
    // Switching via menu passes recency-sorted initialOrders.
    f.viewActions.setOrderBy('manual', {
      'local-ws': ['l1', 'l2'],
      [remoteWs]: ['r1', 'r2', 'r3'],
    });
    assert.deepEqual(f.getView().sessionOrderByAccount['local-ws'], ['l2', 'l1']);
    assert.deepEqual(f.getView().sessionOrderByAccount[remoteWs], ['r3', 'r1', 'r2']);
    assert.equal(f.calls.length, 0);
  } finally {
    controller.dispose();
  }
});

test('wrapActions forwards cloned action objects and dispose restores original actions cleanly', async () => {
  const remoteWs = 'dsh-peer:["host-b","workspace","ws-1"]';
  const f = createFixture({
    orderBy: 'manual',
    workspaces: [{ workspaceId: remoteWs, sessionIds: ['r1', 'r2'] }],
  });
  const origSet = f.viewActions.setSessionOrder;
  const origPin = f.viewActions.pinSessionOrder;
  const origMode = f.viewActions.setOrderBy;

  const controller = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage });
  const cloned = { ...f.viewActions, setSessionOrder: origSet };
  const wrapped = controller.wrapActions(cloned);
  assert.equal(controller.wrapActions(cloned), wrapped, 'wrapActions must be referentially stable');
  assert.equal(controller.wrapActions(f.viewActions), f.viewActions);

  wrapped.setSessionOrder(remoteWs, ['r2', 'r1'], {});
  await flush();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.getWorkspaces().items[0].sessionIds, ['r2', 'r1']);

  controller.dispose();
  assert.equal(f.viewActions.setSessionOrder, origSet);
  assert.equal(f.viewActions.pinSessionOrder, origPin);
  assert.equal(f.viewActions.setOrderBy, origMode);
});

const migrationKey = 'dsh.remote-enhanced.session-order-migrated.v1';
const fallbackKey = 'dsh.remote-enhanced.session-order-local-only.v1';
const revision = n => new Date(n).toISOString();

function freshCarrier(baseHost, readWorkspaceOrder) {
  return { baseHost, canSyncWorkspaceOrder: true, readWorkspaceOrder: async id => ({ ok: true, value: { workspace: await readWorkspaceOrder(id) } }) };
}

test('a remote base view never migrates unqualified remote layout and can migrate its physically local workspace', async () => {
  const localWs = 'dsh-peer:["local","workspace","local-ws"]';
  const remoteWs = 'remote-ws';
  const f = createFixture({
    sessionOrderByAccount: { [localWs]: ['l2', 'l1'], [remoteWs]: ['r2', 'r1'] },
    workspaces: [{ workspaceId: localWs, sessionIds: ['l1', 'l2'] }, { workspaceId: remoteWs, sessionIds: ['r1', 'r2'] }],
  });
  const opened = [];
  const carrier = freshCarrier('host-b', id => { opened.push(id); return f.getWorkspaces().items.find(row => row.workspaceId === id); });
  const c = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage, carrier });
  try {
    await flush();
    assert.deepEqual(opened, [localWs]);
    assert.ok(f.calls.length && f.calls.every(call => call.workspaceId === localWs));
    assert.deepEqual(JSON.parse(f.storage.getItem(migrationKey)), ['local-ws']);
    assert.deepEqual(f.getView().sessionOrderByAccount[remoteWs], ['r1', 'r2']);
  } finally { c.dispose(); }
});

test('writes plan from a fresh host baseline and do not regress on stale replaces after ack', async () => {
  const ws = 'dsh-peer:["host-b","workspace","ws"]';
  const stale = { workspaceId: ws, sessionIds: ['b', 'a', 'c'], updatedAt: revision(1) };
  let host = { workspaceId: ws, sessionIds: ['a', 'new', 'b', 'c'], updatedAt: revision(2) };
  const f = createFixture({ workspaces: [stale], onInsert({ sessionId, beforeSessionId }) {
    host = { ...host, sessionIds: applyMoves(host.sessionIds, [{ sessionId, beforeSessionId }]), updatedAt: revision(Date.parse(host.updatedAt) + 1) };
    return host; // No native mutation echo on the stale list yet.
  } });
  const c = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage, carrier: freshCarrier('local', () => host) });
  try {
    f.viewActions.setSessionOrder(ws, ['b', 'a', 'c'], {});
    await flush();
    assert.deepEqual(host.sessionIds, ['b', 'new', 'a', 'c']);
    f.setWorkspaces({ items: [stale] });
    assert.deepEqual(f.getView().sessionOrderByAccount[ws], ['b', 'new', 'a', 'c']);
    const changed = { ...host, sessionIds: ['c', 'b', 'a', 'new'], updatedAt: revision(10) };
    f.setWorkspaces({ items: [changed] });
    assert.deepEqual(f.getView().sessionOrderByAccount[ws], changed.sessionIds);
  } finally { c.dispose(); }
});

test('unsupported peers keep browser-local order without blocking other peers', async () => {
  const first = 'dsh-peer:["host-b","workspace","ws"]';
  const second = 'dsh-peer:["host-b","workspace","ws2"]';
  const third = 'dsh-peer:["host-c","workspace","ws"]';
  const f = createFixture({ workspaces: [first, second, third].map(workspaceId => ({ workspaceId, sessionIds: ['a', 'b', 'c'] })),
    onInsert({ workspaceId, mutate }) {
      if (workspaceId === first) throw new Error('workspace move failed: METHOD_NOT_ALLOWED: old bridge');
      return mutate();
    },
  });
  const c = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage });
  try {
    for (const id of [first, second, third]) {
      f.viewActions.setSessionOrder(id, ['b', 'c', 'a'], {});
      await flush();
    }
    assert.deepEqual(f.calls.map(call => call.workspaceId), [first, third]);
    assert.deepEqual(f.getView().sessionOrderByAccount, { [first]: ['b', 'c', 'a'], [second]: ['b', 'c', 'a'], [third]: ['b', 'c', 'a'] });
    assert.deepEqual(JSON.parse(f.storage.getItem(fallbackKey)).sort(), [first, second].sort());
  } finally { c.dispose(); }
});

test('denied or offline writes retain local order across reconnect and reload; never auto-replay', async () => {
  for (const code of ['remote-access/denied', 'HOST_OFFLINE']) {
    const ws = 'dsh-peer:["host-b","workspace","ws"]';
    const row = { workspaceId: ws, sessionIds: ['a', 'b', 'c'], updatedAt: revision(1) };
    const f = createFixture({ workspaces: [row], onInsert() { throw Object.assign(new Error(code), { code }); } });
    const c = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage });
    f.viewActions.setSessionOrder(ws, ['b', 'c', 'a'], {});
    await flush();
    f.setWorkspaces({ items: [row] });
    assert.deepEqual(f.getView().sessionOrderByAccount[ws], ['b', 'c', 'a']);
    c.dispose();
    const g = createFixture({ workspaces: [row], sessionOrderByAccount: f.getView().sessionOrderByAccount, storage: f.storage });
    const d = installSessionOrderSync(g.ctx, g.entry, { storage: g.storage });
    try {
      await flush();
      assert.deepEqual(g.getView().sessionOrderByAccount[ws], ['b', 'c', 'a']);
      assert.equal(g.calls.length, 0);
    } finally { d.dispose(); }
  }
});

test('two Manual clients converge through the owning workspace while Updated remains local', async () => {
  const localWs = 'w';
  const remoteWs = 'dsh-peer:["owner-pc","workspace","w"]';
  const remoteId = id => `dsh-peer:["owner-pc","session","${id}"]`;
  let host = ['p2', 'u2', 'arch', 'p1', 'u1'];
  let version = 1;
  const localRow = () => ({ workspaceId: localWs, sessionIds: host, updatedAt: revision(version) });
  const remoteRow = () => ({ ...localRow(), workspaceId: remoteWs, sessionIds: host.map(remoteId) });
  const publish = () => {
    a.setWorkspaces({ items: [localRow()] });
    b.setWorkspaces({ items: [remoteRow()] });
  };
  const move = (sessionId, beforeSessionId) => {
    host = applyMoves(host, [{ sessionId, beforeSessionId }]);
    version++;
    publish();
  };
  const a = createFixture({ workspaces: [localRow()], sessionOrderByAccount: { [localWs]: ['p1', 'u1', 'arch', 'p2', 'u2'] },
    onInsert({ sessionId, beforeSessionId }) { move(sessionId, beforeSessionId); return localRow(); } });
  const b = createFixture({ orderBy: 'updated', workspaces: [remoteRow()],
    onInsert({ sessionId, beforeSessionId }) {
      const decode = id => id === undefined ? undefined : JSON.parse(id.slice(9))[2];
      move(decode(sessionId), decode(beforeSessionId));
      return remoteRow();
    } });
  const ac = installSessionOrderSync(a.ctx, a.entry, { storage: a.storage, carrier: freshCarrier('local', localRow) });
  const bc = installSessionOrderSync(b.ctx, b.entry, { storage: b.storage, carrier: freshCarrier('local', remoteRow) });
  try {
    await flush();
    assert.deepEqual(host, ['p1', 'u1', 'arch', 'p2', 'u2']);
    assert.equal(b.getView().orderBy, 'updated');
    b.viewActions.setOrderBy('manual', { [remoteWs]: [] });
    assert.deepEqual(b.getView().sessionOrderByAccount[remoteWs], host.map(remoteId));
    b.viewActions.setSessionOrder(remoteWs, ['p1', 'u2', 'u1', 'arch', 'p2'].map(remoteId), {});
    await flush();
    assert.deepEqual(host, ['p1', 'u2', 'u1', 'arch', 'p2']);
    assert.deepEqual(a.getView().sessionOrderByAccount[localWs], host);
    assert.deepEqual(b.getView().sessionOrderByAccount[remoteWs], host.map(remoteId));
    assert.equal(b.calls.length, 1, 'the owner does not echo remote layout as new writes');
  } finally { ac.dispose(); bc.dispose(); }
});

test('the owner migration does not move archived slots or import a stale cached workspace', async () => {
  const workspaceId = 'local-ws';
  const wanted = ['u2', 'a', 'p2', 'u1', 'p1'];
  let host = { workspaceId, sessionIds: ['p1', 'a', 'u1', 'u2', 'p2'], updatedAt: revision(9) };
  const f = createFixture({ sessionOrderByAccount: { [workspaceId]: wanted }, workspaces: [{ workspaceId, sessionIds: wanted, updatedAt: revision(1) }],
    onInsert({ sessionId, beforeSessionId }) {
      host = { ...host, sessionIds: applyMoves(host.sessionIds, [{ sessionId, beforeSessionId }]), updatedAt: revision(Date.parse(host.updatedAt) + 1) };
      return host;
    },
  });
  const c = installSessionOrderSync(f.ctx, f.entry, { storage: f.storage, carrier: freshCarrier('local', () => host) });
  try {
    await flush();
    assert.ok(f.calls.length, 'matching stale cache must not mark migration without comparing live Host order');
    assert.deepEqual(host.sessionIds, wanted);
    assert.deepEqual(JSON.parse(f.storage.getItem(migrationKey)), [workspaceId]);
  } finally { c.dispose(); }
});
