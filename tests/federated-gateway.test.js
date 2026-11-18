import test from 'node:test';
import assert from 'node:assert/strict';
import { FederatedGateway } from '../federated-gateway.js';

const owner = { principal: { kind: 'owner' }, signal: new AbortController().signal };
const requestSchema = { type: 'object', properties: { sessionId: { type: 'string' }, workspaceId: { type: 'string' }, content: {} } };
function fixture(baseHost = 'local') {
  const calls = [], releases = [];
  const carrier = hostId => ({
    async call(endpoint, payload) {
      calls.push([hostId, endpoint, payload]);
      if (endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 'same', updatedAt: 0, running: false, blank: false, agentAvailable: true }] } };
      if (endpoint === 'session/fork') return { ok: true, value: { sessionId: 'child' } };
      return { ok: true, value: { accepted: true } };
    },
    async open(endpoint, _payload, signal) { return (async function* () {
      if (endpoint === 'session/follow') { yield { type: 'snapshot', header: { id: 'same' }, records: [{ type: 'event', event: { type: 'user/message', data: { text: 'same', sessionId: 'opaque' } } }] }; return; }
      if (endpoint === 'workspace/follow') yield { type: 'baseline', value: { items: [{ workspaceId: 'w', title: 'Desktop', path: 'C:/Desktop', sessionIds: ['same'] }], archivedSessionIds: [], pinnedSessionIds: [] } };
      else if (endpoint === 'session/control') yield { type: 'baseline', value: { projections: { same: { asOfSeq: 0, values: { title: 'same' } } } } };
      else if (endpoint === '$events') { yield { type: 'ready', clientId: 'client-' + hostId, host: { home: 'C:/' } }; yield { type: 'waterfall', agentId: 'same', event: 'approval/request', eventId: 'event', request: { title: 'Keep unchanged' } }; }
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    })(); },
  });
  const channels = { async retain(hostId) { const value = carrier(hostId); return { ...value, async release() { releases.push(hostId); } }; } };
  const gateway = new FederatedGateway({ local: () => carrier('local'), channels, baseHost,
    hosts: async () => [{ hostId: 'remote', name: 'Remote-PC', online: true }],
    descriptor: endpoint => ({ parameters: [{ wire: 'request', codec: { jsonSchema: requestSchema } }], result: { jsonSchema: endpoint === 'session/fork' ? { type: 'object', properties: { sessionId: { type: 'string' } } } : {} } }),
  });
  return { gateway, calls, releases };
}

test('same native identity on two computers routes independently without a selected computer', async () => {
  const { gateway, calls } = fixture();
  const id = gateway.identities.encode('remote', 'session', 'same');
  const original = { args: { request: { sessionId: id, content: { sessionId: id, text: id } } } };
  await gateway.call('session/prompt', original, owner.signal, owner);
  await gateway.call('session/cancel', { args: { request: { sessionId: 'same' } } }, owner.signal, owner);
  assert.equal(calls[0][0], 'remote'); assert.equal(calls[0][2].args.request.sessionId, 'same');
  assert.deepEqual(calls[0][2].args.request.content, original.args.request.content);
  assert.equal(calls[1][0], 'local');
});

test('native catalog sees both sessions and fork result belongs to the source computer', async () => {
  const { gateway } = fixture();
  const rows = await gateway.call('session/list', { args: { _request: {} } }, owner.signal, owner);
  const remoteId = gateway.identities.encode('remote', 'session', 'same');
  assert.deepEqual(rows.value.items.map(row => row.sessionId), ['same', remoteId]);
  const fork = await gateway.call('session/fork', { args: { request: { sessionId: remoteId } } }, owner.signal, owner);
  assert.equal(fork.value.sessionId, gateway.identities.encode('remote', 'session', 'child'));
});

test('history snapshot maps only the Session envelope and leaves message data untouched', async () => {
  const { gateway, releases } = fixture();
  const id = gateway.identities.encode('remote', 'session', 'same');
  const source = gateway.open('session/follow', { args: { request: { sessionId: id } } }, owner.signal, owner);
  const values = []; for await (const value of source) values.push(value);
  assert.equal(values[0].header.id, id);
  assert.deepEqual(values[0].records[0].event.data, { text: 'same', sessionId: 'opaque' });
  assert.deepEqual(releases, ['remote']);
});

test('native workspace and control streams receive one combined baseline', async () => {
  const { gateway } = fixture();
  for (const endpoint of ['workspace/follow', 'session/control']) {
    const stop = new AbortController();
    const iterator = gateway.open(endpoint, { args: {} }, stop.signal, owner)[Symbol.asyncIterator]();
    const first = (await iterator.next()).value;
    assert.equal(first.type, 'baseline');
    if (endpoint === 'workspace/follow') {
      let value = first.value;
      while (value.items.length < 2) value = (await iterator.next()).value.value;
      assert.deepEqual(value.items.map(row => row.title), ['Desktop', 'Desktop（Remote-PC）']);
    } else {
      const seen = new Set(Object.keys(first.value.projections));
      while (seen.size < 2) seen.add((await iterator.next()).value.sessionId);
    }
    stop.abort(); await iterator.return();
  }
});

test('current remote page keeps its exact native identity while adding local sessions', async () => {
  const { gateway, calls } = fixture('remote');
  const rows = await gateway.call('session/list', { args: { _request: {} } }, owner.signal, owner);
  assert.deepEqual(rows.value.items.map(row => row.sessionId), ['same', gateway.identities.encode('local', 'session', 'same')]);
  await gateway.call('session/prompt', { args: { request: { sessionId: 'same' } } }, owner.signal, owner);
  await gateway.call('session/prompt', { args: { request: { sessionId: gateway.identities.encode('local', 'session', 'same') } } }, owner.signal, owner);
  assert.deepEqual(calls.slice(-2).map(row => row[0]), ['remote', 'local']);
});

test('permission requests from two computers keep separate native bindings and reply routes', async () => {
  const { gateway, calls } = fixture();
  const stop = new AbortController(), iterator = gateway.open('$events', { args: {} }, stop.signal, owner)[Symbol.asyncIterator]();
  try {
    const ready = (await iterator.next()).value;
    assert.equal(ready.type, 'ready');
    const frames = [(await iterator.next()).value, (await iterator.next()).value];
    assert.equal(new Set(frames.map(frame => frame.eventId)).size, 2);
    assert.deepEqual(frames.map(frame => frame.agentId).sort(), ['same', gateway.identities.encode('remote', 'session', 'same')].sort());
    const remote = frames.find(frame => frame.agentId !== 'same');
    assert.deepEqual(remote.request, { title: 'Keep unchanged' });
    const payload = { args: { clientId: ready.clientId, eventId: remote.eventId, outcome: { kind: 'next' } } };
    await assert.rejects(gateway.call('$events/result', payload, stop.signal, { ...owner }), /EVENT_CLIENT_UNAVAILABLE/);
    assert.deepEqual(calls.filter(row => row[1] === '$events/result'), []);
    await gateway.call('$events/result', payload, stop.signal, owner);
    assert.deepEqual(calls.find(row => row[1] === '$events/result'), ['remote', '$events/result', { args: { clientId: 'client-remote', eventId: 'event', outcome: { kind: 'next' } } }]);
  } finally { stop.abort(); await iterator.return(); }
});

test('remote control stream reconnects without replacing the local generation', { timeout: 2000 }, async () => {
  const { gateway } = fixture(); let generations = 0;
  gateway.channels.retain = async () => ({
    call: async () => ({ ok: true, value: {} }), release: async () => {},
    open(_endpoint, _payload, signal) { return (async function* () {
      generations++; yield { type: 'baseline', value: { projections: { same: { asOfSeq: generations, values: { title: 'generation ' + generations } } } } };
      if (generations === 1) throw new Error('synthetic transport loss');
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    })(); },
  });
  const stop = new AbortController(), iterator = gateway.open('session/control', { args: {} }, stop.signal, owner)[Symbol.asyncIterator]();
  try {
    assert.equal((await iterator.next()).value.type, 'baseline');
    let recovered;
    for (;;) { const frame = (await iterator.next()).value; if (frame.sessionId?.startsWith('dsh-peer:') && frame.seq === 2) { recovered = frame; break; } }
    assert.equal(recovered.changes[0].val, 'generation 2'); assert.equal(generations, 2);
    // Event readiness owns the online edge; a control baseline alone must
    // not trigger history recovery before permission delivery is ready.
    assert.equal(gateway.statuses.get('remote'), false);
  } finally { stop.abort(); await iterator.return(); }
});

test('a terminal workspace feed failure is observable without retrying permission denial', { timeout: 1500 }, async () => {
  const { gateway } = fixture(); let opened = 0;
  const denial = Object.assign(new Error('sensitive host detail must not enter diagnostics'), { isDSHRemoteError: true, code: 'gateway/forbidden' });
  gateway.channels.retain = async () => ({
    release: async () => {},
    open() { return (async function* () { opened++; throw denial; })(); },
  });
  const stop = new AbortController(), iterator = gateway.openHost({ hostId: 'remote' }, 'workspace/follow', { args: {} }, stop.signal, owner);
  try {
    await assert.rejects(iterator.next(), error => error === denial);
    assert.equal(opened, 1);
    const state = gateway.streamStates.get('remote').get('workspace/follow');
    assert.equal(state.state, 'failed'); assert.equal(state.code, 'gateway/forbidden');
    assert.doesNotMatch(JSON.stringify(state), /sensitive|detail/);
  } finally { stop.abort(); await iterator.return(); }
});

test('slow remote catalog never delays the local native session list', { timeout: 500 }, async () => {
  const { gateway } = fixture();
  gateway.hosts = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const result = await gateway.call('session/list', { args: { _request: {} } }, owner.signal, owner);
  assert.deepEqual(result.value.items.map(row => row.sessionId), ['same']);
});

test('pending remote discovery never delays local native baseline or ready frame', { timeout: 500 }, async () => {
  const { gateway } = fixture();
  gateway.hosts = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  for (const endpoint of ['$events', 'workspace/follow', 'session/control']) {
    const stop = new AbortController(), iterator = gateway.open(endpoint, { args: {} }, stop.signal, owner)[Symbol.asyncIterator]();
    try { assert.equal((await iterator.next()).value.type, endpoint === '$events' ? 'ready' : 'baseline'); }
    finally { stop.abort(); await iterator.return(); }
  }
});

test('offline base Host and failed device discovery cannot block local list or event readiness', { timeout: 1000 }, async () => {
  const { gateway } = fixture('remote');
  gateway.hosts = async () => { throw new Error('DISCOVERY_OFFLINE'); };
  const list = await gateway.call('session/list', { args: { _request: {} } }, owner.signal, owner);
  assert.equal(list.ok, true);
  assert.deepEqual(list.value.items.map(row => row.sessionId), [gateway.identities.encode('local', 'session', 'same')]);
  const stop = new AbortController(), iterator = gateway.open('$events', { args: {} }, stop.signal, owner)[Symbol.asyncIterator]();
  try { assert.equal((await iterator.next()).value.type, 'ready'); }
  finally { stop.abort(); await iterator.return(); }
});

test('projection identities and workspace mutation replies retain their owning computer', async () => {
  const { gateway } = fixture();
  const projectionSchema = { type: 'object', properties: { values: { type: 'object', properties: { subagentCatalog: { type: 'array', items: { type: 'object', properties: { sessionId: { type: 'string' }, parentSessionId: { type: 'string' } } } } } } } };
  const original = gateway.descriptor;
  gateway.descriptor = endpoint => endpoint === 'session/projections' ? { result: { jsonSchema: projectionSchema } } : original(endpoint);
  const snapshot = gateway.frame({ hostId: 'remote' }, 'session/follow', { type: 'snapshot', header: { id: 'same' }, records: [], projections: { asOfSeq: 3, values: { subagentCatalog: [{ sessionId: 'child', parentSessionId: 'same' }] } } });
  assert.equal(snapshot.projections.values.subagentCatalog[0].sessionId, gateway.identities.encode('remote', 'session', 'child'));
  gateway.hostNames.set('remote', 'Remote-PC');
  const renamed = gateway.result('remote', 'workspace/rename', { workspace: { workspaceId: 'w', title: 'New name', sessionIds: [] } }, { result: { jsonSchema: { type: 'object', properties: { workspace: { type: 'object', properties: { workspaceId: { type: 'string' } } } } } } });
  assert.equal(renamed.workspace.title, 'New name（Remote-PC）');
});

test('a remote event carrier becoming ready loads its catalog even after the initial list has returned', { timeout: 1500 }, async () => {
  const { gateway, calls } = fixture();
  const stop = new AbortController();
  const iterator = gateway.open('$events', { args: {} }, stop.signal, owner)[Symbol.asyncIterator]();
  try {
    assert.equal((await iterator.next()).value.type, 'ready');
    let found = false;
    const deadline = setTimeout(() => stop.abort(), 600);
    try {
      for (let index = 0; index < 5; index++) {
        const next = await iterator.next();
        if (next.done) break;
        if (next.value?.event === 'api-session/added') { found = true; break; }
      }
    } finally { clearTimeout(deadline); }
    assert.equal(found, true);
    assert.equal(calls.some(row => row[0] === 'remote' && row[1] === 'session/list'), true);
  } finally { stop.abort(); await iterator.return(); }
});

test('a ready remote event carrier loads its sessions even when device presence says offline', { timeout: 1500 }, async () => {
  const { gateway, calls } = fixture();
  let discovered = 0;
  gateway.hosts = async () => [{ hostId: 'remote', name: 'Remote-PC', online: discovered++ === 0 }];
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 800);
  const iterator = gateway.open('$events', { args: {} }, stop.signal, owner)[Symbol.asyncIterator]();
  try {
    let found = false;
    for await (const frame of iterator) if (frame.event === 'api-session/added' && frame.args[0].sessionId.startsWith('dsh-peer:')) { found = true; break; }
    assert.equal(found, true, 'a live authenticated carrier must not lose its session catalog to transient presence');
    assert.equal(calls.some(row => row[0] === 'remote' && row[1] === 'session/list'), true);
  } finally { clearTimeout(timer); stop.abort(); await iterator.return(); }
});

test('a transient remote catalog failure retries while its event carrier stays ready', { timeout: 2200 }, async () => {
  const { gateway } = fixture();
  const retain = gateway.channels.retain.bind(gateway.channels);
  let attempts = 0;
  gateway.channels.retain = async (...args) => {
    const channel = await retain(...args), call = channel.call;
    return { ...channel, async call(endpoint, ...rest) {
      if (endpoint === 'session/list' && ++attempts === 1) throw new Error('synthetic metadata read failure');
      return call(endpoint, ...rest);
    } };
  };
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 1400);
  const iterator = gateway.open('$events', { args: {} }, stop.signal, owner)[Symbol.asyncIterator]();
  try {
    let found = false;
    for await (const frame of iterator) if (frame.event === 'api-session/added') { found = true; break; }
    assert.equal(found, true, 'the existing ready stream must publish a retried catalog without reconnecting');
    assert.equal(attempts, 2);
  } finally { clearTimeout(timer); stop.abort(); await iterator.return(); }
});

test('closing events does not wait for a shared slow catalog read', { timeout: 1000 }, async () => {
  const { gateway } = fixture(), read = Promise.withResolvers(), started = Promise.withResolvers();
  const retain = gateway.channels.retain.bind(gateway.channels);
  gateway.channels.retain = async (...args) => {
    const channel = await retain(...args), call = channel.call;
    return { ...channel, async call(endpoint, ...rest) {
      if (endpoint === 'session/list') { started.resolve(); return read.promise; }
      return call(endpoint, ...rest);
    } };
  };
  const stop = new AbortController(), iterator = gateway.open('$events', { args: {} }, stop.signal, owner)[Symbol.asyncIterator]();
  try {
    await iterator.next(); await started.promise; stop.abort();
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 150);
    let closed;
    try { closed = await Promise.race([iterator.return().then(() => true), new Promise(resolve => deadline.signal.addEventListener('abort', () => resolve(false), { once: true }))]); }
    finally { clearTimeout(timer); }
    assert.equal(closed, true, 'tab events must cancel promptly even while a catalog read is shared');
  } finally { read.resolve({ ok: true, value: { items: [] } }); stop.abort(); await iterator.return(); }
});

test('non-owner cannot invoke or subscribe through the aggregate carrier', async () => {
  const { gateway, calls } = fixture();
  const member = { ...owner, principal: { kind: 'member' } };
  await assert.rejects(gateway.call('session/list', { args: {} }, owner.signal, member), /OWNER_REQUIRED/);
  await assert.rejects(gateway.open('session/control', { args: {} }, owner.signal, member)[Symbol.asyncIterator]().next(), /OWNER_REQUIRED/);
  assert.deepEqual(calls, []);
});
