import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteBrowser } from '../client-browser.js';
import { peerFileAddress, sessionHost } from '../client-resources.js';
const id = 'dsh-peer:' + JSON.stringify(['pc', 'session', 's']);
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const loads = [], opened = [], released = [], requests = [], tab = new AbortController();
  const native = { mount(value) { requests.push(value); return () => {}; }, loadUrl: (...args) => loads.push(args), reload: () => {} };
  const carrier = { async previewOpen(session, url, lease, _signal, options) { opened.push({ session, url, lease, fileMode: options?.fileMode }); return { ok: true, value: { filePreviewAvailable: true, url: 'http://dsh-a.localhost:1234/' + new URL(url).pathname.slice(1) + new URL(url).search + new URL(url).hash } }; }, async previewClose(lease) { released.push(lease); } };
  const adapter = remoteBrowser(native, carrier, id);
  adapter.mount({ tabId: 'tab', signal: tab.signal, initialUrl: 'http://127.0.0.1:41788/map?q=1#x', openTab() {} });
  return { adapter, loads, opened, released, requests, tab, carrier };
}
test('remote browser never initially navigates to this computer localhost', async () => {
  const { adapter, loads, opened, requests } = fixture(); await tick();
  assert.equal(requests[0].initialUrl, undefined); assert.equal(opened[0].session, id);
  assert.equal(loads[0][1], 'http://dsh-a.localhost:1234/map?q=1#x'); await adapter.dispose();
});
test('remote browser retry retains original ownership and tab close releases leases', async () => {
  const { adapter, carrier, tab, released, loads } = fixture(); await tick();
  carrier.previewOpen = async () => ({ ok: false, error: { message: 'allow port 41788' } });
  const nativeState = { frame: { target: { url: loads[0][1] } } };
  adapter.displayState('tab', nativeState);
  adapter.reload('tab'); await tick();
  assert.equal(adapter.displayState('tab', nativeState).frame.error.description, 'allow port 41788');
  tab.abort(); await tick(); assert.equal(released.length, 1); await adapter.dispose();
});
test('denied preview port uses localized source-specific guidance and preserves error code routing', async () => {
  const { readFile } = await import('node:fs/promises');
  const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8')).ui;
  const t = (key, values) => zh[key]?.replace(/\{(\w+)\}/g, (_match, name) => values[name]);
  const { previewErrorMessage } = await import('../client-browser.js');
  const message = previewErrorMessage({ code: 'LOOPBACK_PORT_DENIED', message: 'Allow this port in Host settings' }, 'http://127.0.0.1:41788/', 'Desktop（Remote-PC）', t);
  assert.match(message, /Desktop（Remote-PC）/); assert.match(message, /41788/); assert.match(message, /保存/);
  assert.doesNotMatch(message, /Allow this port|loopback\.ports/);
  assert.match(previewErrorMessage({ code: 'LOOPBACK_UNAVAILABLE' }, 'http://localhost:41789/', 'another-PC', t), /41789.*another-PC|another-PC.*41789/);
  assert.equal(previewErrorMessage({ code: 'OTHER', message: 'Original actionable failure' }, 'http://localhost:41788/', 'pc', t), 'Original actionable failure');
});

test('browser persistence keeps both tabs original URLs across Session action rebinding', async () => {
  const writes = [], opened = [], stops = [new AbortController(), new AbortController()]; let writer;
  const native = { mount() { return () => {}; }, loadUrl() {}, rebind(value) { writer = value; } };
  const carrier = { async previewOpen(_session, value) { const url = new URL(value); return { ok: true, value: { url: `http://dsh-${url.port}.localhost:1234${url.pathname}${url.search}` } }; }, async previewClose() {} };
  const adapter = remoteBrowser(native, carrier, id);
  const actions = { replace: (tab, value) => writes.push([tab, value]), forget() {} };
  adapter.bindActions(actions);
  for (const [i, port] of [41788, 41789].entries()) adapter.mount({ tabId: 't' + i, signal: stops[i].signal, initialUrl: `http://localhost:${port}/map`, openTab: url => opened.push(url) });
  try {
    await tick();
    const state = port => ({ entries: [{ kind: 'http', url: `http://dsh-${port}.localhost:1234/map?q=1`, title: 'map' }], index: 0, navigation: { status: 'known', revision: 1 } });
    writer.replace('t0', state(41788)); writer.replace('t1', state(41789));
    assert.equal(writes[0][1].entries[0].url, 'http://localhost:41788/map?q=1');
    assert.equal(writes[1][1].entries[0].url, 'http://localhost:41789/map?q=1');
    adapter.bindActions({ ...actions, replace: (tab, value) => writes.push(['new-' + tab, value]) });
    writer.replace('t0', state(41788)); assert.equal(writes.at(-1)[0], 'new-t0');
    const source = adapter.keyedHooks.browserState('t0'), revision = source.getSnapshot(), observed = { frame: { target: state(41788).entries[0] } };
    assert.equal(adapter.displayState('t0', observed), observed); assert.equal(source.getSnapshot(), revision, 'render reads do not publish extra React work');
  } finally { stops.forEach(stop => stop.abort()); await adapter.dispose(); }
});
test('the remote sidebar opens a plain loopback address as HTTP on the Session computer', async () => {
  const loads = [], opened = [], tab = new AbortController();
  const adapter = remoteBrowser({ mount() { return () => {}; }, loadUrl: (...args) => loads.push(args) }, {
    async previewOpen(owner, url, _lease, _signal, { fileMode }) {
      opened.push([owner, url, fileMode]);
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' || parsed.port !== '32190') return { ok: false, error: { message: 'This remote address is unavailable.' } };
      return { ok: true, value: { url: 'http://dsh-test.localhost:1234' + parsed.pathname + parsed.search, filePreviewAvailable: false } };
    },
    async previewClose() {},
  }, id);
  adapter.mount({ tabId: 'bare', signal: tab.signal, openTab() {} });
  try {
    for (const value of ['localhost:32190/docs?q=1', '127.0.0.1:32190/docs', '[::1]:32190/docs', ' 127.1:32190/docs ']) {
      adapter.loadUrl('bare', value); await tick();
    }
    assert.deepEqual(opened.map(row => row[1]), ['http://localhost:32190/docs?q=1', 'http://127.0.0.1:32190/docs', 'http://[::1]:32190/docs', 'http://127.0.0.1:32190/docs']);
    assert.ok(opened.every(([owner, , fileMode]) => owner === id && fileMode === false));
    assert.deepEqual(loads.map(row => row[1]), ['http://dsh-test.localhost:1234/docs?q=1', ...Array(3).fill('http://dsh-test.localhost:1234/docs')]);
    for (const value of ['https://localhost:32190/docs', 'localhost:32191/docs']) {
      adapter.loadUrl('bare', value); await tick();
    }
    assert.deepEqual(opened.slice(-2).map(row => row[1]), ['https://localhost:32190/docs', 'http://localhost:32191/docs']);
    assert.equal(loads.length, 4, 'an unsupported or denied address never falls back to the local computer');
    adapter.loadUrl('bare', 'example.com/docs'); await tick();
    assert.deepEqual(loads.at(-1), ['bare', 'example.com/docs'], 'ordinary addresses still use native validation');
  } finally { tab.abort(); await adapter.dispose(); }
});
test('explicit file mode gets a fresh tab lease and claims only that immutable Session', async () => {
  const { adapter, carrier, tab, opened, loads, released } = fixture(); await tick();
  const read = [], handled = [], follow = Promise.withResolvers();
  carrier.previewFiles = (lease, signal) => ({ async *[Symbol.asyncIterator]() {
    read.push([lease, signal]); yield { pending: { id: 'request', path: 'D:\\Synthetic\\a.pdf', kind: 'file' } };
    await Promise.race([follow.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
  } });
  carrier.previewFileClaim = async (lease, actionId) => { assert.equal(lease, read[0][0]); assert.equal(actionId, 'request'); return { ok: true, value: { sessionId: id, path: 'D:\\Synthetic\\a.pdf', kind: 'file' } }; };
  adapter.displayState('tab', { frame: { target: { url: loads[0][1] } } });
  try {
    await adapter.setFileMode('tab', true); await tick();
    assert.equal(opened.at(-1).fileMode, true);
    assert.equal(adapter.fileState('tab').pending.id, 'request');
    await adapter.consumeFile('tab', 'preview', value => handled.push(value));
    assert.deepEqual(handled, [{ sessionId: id, path: 'D:\\Synthetic\\a.pdf', kind: 'file' }]);
    assert.equal(adapter.fileState('tab').pending, undefined);
    await adapter.setFileMode('tab', false); await tick();
    assert.equal(read[0][1].aborted, true); assert.ok(released.includes(read[0][0]));
  } finally { tab.abort(); follow.resolve(); await adapter.dispose(); }
});

test('file-mode page loads only after the owner action subscription is ready', async () => {
  const { adapter, carrier, tab, loads } = fixture(); await tick();
  adapter.displayState('tab', { frame: { target: { url: loads[0][1] } } });
  const ready = Promise.withResolvers(), end = Promise.withResolvers();
  carrier.previewFiles = (_lease, signal) => ({ async *[Symbol.asyncIterator]() {
    await ready.promise; yield { pending: null };
    await Promise.race([end.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
  } });
  const enabling = adapter.setFileMode('tab', true);
  try {
    await tick(); assert.equal(loads.length, 1, 'do not navigate before the authenticated subscriber is active');
    ready.resolve(); await enabling; assert.equal(loads.length, 2);
  } finally { ready.resolve(); end.resolve(); tab.abort(); await enabling; await adapter.dispose(); }
});

test('file-mode transition requires acknowledged old-origin revocation and does not fall back', async () => {
  const { adapter, carrier, tab, loads, opened } = fixture(); await tick();
  adapter.displayState('tab', { frame: { target: { url: loads[0][1] } } });
  carrier.previewClose = async () => { throw new Error('close response lost'); };
  try {
    await adapter.setFileMode('tab', true);
    assert.equal(opened.length, 1); assert.equal(loads.length, 1);
    assert.match(adapter.displayState('tab', { frame: { target: { url: loads[0][1] } } }).frame.error.description, /close response lost/);
    assert.equal(adapter.fileState('tab').active, false);
  } finally { carrier.previewClose = async () => ({ ok: true }); tab.abort(); await adapter.dispose(); }
});

test('leaving loopback revokes old origin and closing file mode still works on another page', async () => {
  const { adapter, carrier, tab, loads, released } = fixture(); await tick();
  carrier.previewFiles = (_lease, signal) => ({ async *[Symbol.asyncIterator]() { yield { pending: null }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } });
  adapter.displayState('tab', { frame: { target: { url: loads[0][1] } } });
  try {
    await adapter.setFileMode('tab', true); await tick();
    adapter.loadUrl('tab', 'https://example.com'); await tick();
    assert.equal(released.length, 2, 'ordinary and file-mode origins both revoked');
    adapter.displayState('tab', { frame: { target: { url: 'https://example.com/' } } });
    await adapter.setFileMode('tab', false);
    assert.equal(adapter.fileState('tab').enabled, false);
  } finally { tab.abort(); await adapter.dispose(); }
});

test('a new proposal arriving before an old claim response stays visible', async () => {
  const { adapter, carrier, tab, loads } = fixture(); await tick();
  const next = Promise.withResolvers(), claimed = Promise.withResolvers(), end = Promise.withResolvers();
  carrier.previewFiles = (_lease, signal) => ({ async *[Symbol.asyncIterator]() {
    yield { pending: { id: 'a', path: 'D:\\Synthetic\\a.pdf', kind: 'file' } }; await next.promise;
    yield { pending: { id: 'b', path: 'D:\\Synthetic\\b.pdf', kind: 'file' } };
    await Promise.race([end.promise, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
  } });
  carrier.previewFileClaim = async () => claimed.promise;
  adapter.displayState('tab', { frame: { target: { url: loads[0][1] } } });
  try {
    await adapter.setFileMode('tab', true); await tick();
    const consuming = adapter.consumeFile('tab', 'cancel', () => { throw new Error('cancel must not read'); });
    next.resolve(); await tick();
    claimed.resolve({ ok: true, value: { sessionId: id, path: 'D:\\Synthetic\\a.pdf', kind: 'file' } });
    await consuming;
    assert.equal(adapter.fileState('tab').pending.id, 'b');
  } finally { end.resolve(); next.resolve(); tab.abort(); await adapter.dispose(); }
});

test('obsolete file navigation cannot replace the current action lease or watcher', async () => {
  const { adapter, carrier, tab, loads, opened } = fixture(); await tick();
  adapter.displayState('tab', { frame: { target: { url: loads[0][1] } } });
  const old = Promise.withResolvers(), watching = [], closing = [];
  carrier.previewOpen = async (_session, _url, lease, _signal, options) => {
    opened.push({ lease, fileMode: options?.fileMode });
    if (opened.length === 2) return old.promise;
    return { ok: true, value: { url: 'http://dsh-new.localhost:1234/', filePreviewAvailable: true } };
  };
  carrier.previewClose = async lease => { closing.push(lease); return { ok: true }; };
  carrier.previewFiles = (lease, signal) => ({ async *[Symbol.asyncIterator]() { watching.push(lease); yield { pending: null }; if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); } });
  try {
    const obsolete = adapter.setFileMode('tab', true); await tick();
    adapter.loadUrl('tab', 'http://localhost:41788/'); await tick();
    old.resolve({ ok: true, value: { url: 'http://dsh-old.localhost:1234/', filePreviewAvailable: true } });
    await obsolete; await tick();
    assert.deepEqual(watching, [opened.at(-1).lease]);
    assert.ok(closing.includes(opened[1].lease));
    assert.equal(loads.at(-1)[1], 'http://dsh-new.localhost:1234/');
  } finally { old.resolve({ ok: false, error: { message: 'closed' } }); tab.abort(); await adapter.dispose(); }
});

test('native resource addresses keep per-segment encoding and source session identity', () => {
  const address = peerFileAddress(id, 'C:\\Folder\\same #1.png');
  assert.ok(address.endsWith('/C:/Folder/same%20%231.png'));
  assert.equal(sessionHost(id, 'local'), 'pc'); assert.equal(sessionHost('s', 'local'), 'local');
  assert.equal(sessionHost('dsh-peer:{}', 'local'), undefined);
});
