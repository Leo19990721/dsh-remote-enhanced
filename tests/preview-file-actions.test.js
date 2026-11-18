import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionPreviews } from '../federated-previews.js';
import { SurfaceIdentities } from '../federated-identities.js';
const id = (session = 'a', host = 'pc') => 'dsh-peer:' + JSON.stringify([host, 'session', session]);
function fixture() {
  const stop = new AbortController(), peer = { principal: { kind: 'owner' }, signal: stop.signal }, entries = [], calls = [];
  const gateway = { identities: new SurfaceIdentities('local'), owner(value) { assert.equal(value, peer); value.signal.throwIfAborted(); }, async channel() { throw new Error('file proposal must not read or execute anything'); } };
  const manager = new SessionPreviews(gateway, peer, (client, options = {}) => {
    const entry = { options, closed: 0, async open() { calls.push('open'); return { url: `http://dsh-${entries.indexOf(entry)}.localhost:1234/` }; }, async close() { this.closed++; } };
    entries.push(entry); return entry;
  }, stop.signal, { filePreviewTargets: [{ hostId: 'pc', port: 41788, path: '/' }] });
  return { manager, stop, entries, calls };
}

test('explicit file mode isolates identical Host ports by tab and source Session', async () => {
  const { manager, stop, entries } = fixture();
  try {
    const one = await manager.open(id('a'), 'http://localhost:41788/', 'tab-a', stop.signal, { fileMode: true });
    const two = await manager.open(id('b'), 'http://localhost:41788/', 'tab-b', stop.signal, { fileMode: true });
    assert.notEqual(new URL(one.url).origin, new URL(two.url).origin);
    assert.equal(typeof entries[0].options.onFileRequest, 'function');
    assert.equal(typeof entries[1].options.onFileRequest, 'function');
  } finally { await manager.close(); }
});

test('page can only propose a pending action and DSH claims once with immutable Session ownership', async () => {
  const { manager, stop, entries, calls } = fixture();
  try {
    await manager.open(id('b'), 'http://localhost:41788/', 'tab-b', stop.signal, { fileMode: true });
    const follow = manager.fileActions('tab-b', stop.signal)[Symbol.asyncIterator]();
    assert.deepEqual((await follow.next()).value, { pending: null });
    const proposal = entries[0].options.onFileRequest({ path: 'D:\\Synthetic\\报告.pdf', kind: 'file' });
    assert.equal(proposal.status, 409); assert.match(proposal.error, /DSH/);
    assert.doesNotMatch(JSON.stringify(proposal), /报告|session|bytes/);
    const pending = (await follow.next()).value.pending;
    assert.equal(pending.path, 'D:\\Synthetic\\报告.pdf'); assert.equal(pending.kind, 'file');
    const action = manager.claimFileAction('tab-b', pending.id);
    assert.deepEqual(action, { sessionId: id('b'), path: 'D:\\Synthetic\\报告.pdf', kind: 'file' });
    assert.throws(() => manager.claimFileAction('tab-b', pending.id), /已失效/);
    assert.deepEqual((await follow.next()).value, { pending: null });
    assert.deepEqual(calls, ['open'], 'no stat/list/read/remote open before the DSH confirmation');
    await follow.return();
  } finally { await manager.close(); }
});

test('file mode fails closed without an owner subscriber and limits pending proposals', async () => {
  const { manager, stop, entries } = fixture();
  try {
    await manager.open(id(), 'http://localhost:41788/', 'tab', stop.signal, { fileMode: true });
    const request = entries[0].options.onFileRequest;
    const proposal = { path: 'C:\\Synthetic\\a.txt', kind: 'file' };
    assert.equal(request(proposal).status, 503);
    const follow = manager.fileActions('tab', stop.signal)[Symbol.asyncIterator](); await follow.next();
    assert.equal(request(proposal).status, 409);
    const original = (await follow.next()).value.pending;
    assert.equal(request({ ...proposal, path: 'C:\\Synthetic\\b.txt' }).status, 429);
    assert.equal(request(proposal).status, 409, 'duplicate proposal is coalesced');
    await follow.return();
    assert.throws(() => manager.claimFileAction('tab', original.id), /已失效/);
    assert.equal(request(proposal).status, 503);
  } finally { await manager.close(); }
});

test('closed or superseded tabs revoke pending actions without affecting sibling tabs', async () => {
  const { manager, stop, entries } = fixture();
  try {
    await manager.open(id('a'), 'http://localhost:41788/', 'one', stop.signal, { fileMode: true });
    await manager.open(id('b'), 'http://localhost:41788/', 'two', stop.signal, { fileMode: true });
    const one = manager.fileActions('one', stop.signal)[Symbol.asyncIterator](), two = manager.fileActions('two', stop.signal)[Symbol.asyncIterator]();
    await one.next(); await two.next();
    entries[0].options.onFileRequest({ path: 'C:\\Synthetic\\a.txt', kind: 'file' });
    const action = (await one.next()).value.pending;
    await manager.release('one');
    assert.throws(() => manager.claimFileAction('one', action.id), /已失效/);
    assert.equal((await one.next()).done, true);
    assert.equal(entries[1].options.onFileRequest({ path: 'C:\\Synthetic\\b.txt', kind: 'file' }).status, 409);
    assert.equal((await two.next()).value.pending.path, 'C:\\Synthetic\\b.txt');
    await two.return();
  } finally { await manager.close(); }
});

test('resource proposal accepts only explicit ordinary absolute paths and known kinds', async () => {
  const { manager, stop, entries } = fixture();
  try {
    await manager.open(id(), 'http://localhost:41788/', 'tab', stop.signal, { fileMode: true });
    const follow = manager.fileActions('tab', stop.signal)[Symbol.asyncIterator](); await follow.next();
    for (const value of [
      { path: '../secret', kind: 'file' }, { path: 'C:relative', kind: 'file' }, { path: '\\\\pc\\share\\a', kind: 'file' },
      { path: 'file:///D:/a', kind: 'file' }, { path: 'D:\\a\u0000b', kind: 'file' }, { path: 'D:\\a', kind: 'run' },
      { path: 'D:\\a', kind: 'file', sessionId: id('other') }, { path: 'D:\\a.txt:stream', kind: 'file' },
      { path: 'D:\\a\\..\\private', kind: 'file' },
    ]) assert.equal(entries[0].options.onFileRequest(value).status, 400, JSON.stringify(value));
    assert.equal(entries[0].options.onFileRequest({ path: 'D:\\Synthetic', kind: 'folder' }).status, 409);
    await follow.return();
  } finally { await manager.close(); }
});
