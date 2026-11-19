// Exercise the installed native browser controller, without React, DOM, a real
// page, profile changes or user navigation. The page provider is an IO boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
(async () => {
  const r = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const source = fs.readFileSync(r.resolve('@deepseek-ai/dsh-client-ui-sidebar-browser/client'), 'utf8');
  const begin = source.indexOf('var BrowserController=class{');
  const finish = source.indexOf('function createBrowserControllers(', begin);
  assert.ok(begin >= 0 && finish > begin, 'verified installed BrowserController section must exist');
  // Include the factory by balancing its own braces; neither class nor factory
  // is modified. BrowserPage and snapshot storage are framework-neutral seams.
  let body = source.indexOf('{', finish), depth = 1, end = body + 1;
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  assert.equal(depth, 0);
  const store = { createSnapshotStore(value) {
    const listeners = new Set();
    return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      set(next) { value = next; for (const fn of listeners) fn(); } };
  } };
  const parser = source.indexOf('const MAX_BROWSER_URL_LENGTH=');
  assert.ok(parser >= 0 && parser < begin, 'installed address parser must precede the controller');
  const createBrowserControllers = vm.runInNewContext(source.slice(parser, end) + ';createBrowserControllers', {
    _deepseek_ai_dsh_client_store: store, URL,
    currentBrowserTarget: state => state?.entries[state.index],
  });
  const { remoteBrowser } = await import('../client-browser.js');
  const id = 'dsh-peer:' + JSON.stringify(['pc', 'session', 's']);
  const writes = [], loads = [], pages = [], opened = [], released = [], previews = [];
  const actions = { replace(tab, value) { writes.push([tab, value]); }, forget() {} };
  const native = createBrowserControllers(actions, options => {
    let value = { address: 'empty', loading: false };
    const listeners = new Set();
    const page = { disposed: false, frame: {
      getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      loadUrl(target) {
        loads.push(target.url); value = { address: 'observed', target, loading: false };
        options.persist({ entries: [target], index: 0, navigation: { status: 'known', revision: 1 } });
        for (const fn of listeners) fn();
      }, reload() { throw new Error('remote refresh must reacquire the authorized preview'); },
      dispose: async () => { page.disposed = true; },
    }, presentation: { mount: () => () => {} } };
    pages.push(page); return page;
  }, () => true);
  const carrier = { async previewOpen(sessionId, url, lease) {
    previews.push({ sessionId, url });
    return { ok: true, value: { url: 'http://dsh-synthetic.localhost:1234' + new URL(url).pathname } };
  }, async previewClose(lease) { released.push(lease); } };
  const adapter = remoteBrowser(native, carrier, id), stop = new AbortController();
  adapter.bindActions(actions);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    adapter.mount({ tabId: 't', signal: stop.signal, viewportId: 'synthetic', applicationOrigin: 'http://127.0.0.1:3109',
      initialUrl: 'localhost:41788/map', openTab: url => opened.push(url) });
    await tick();
    assert.deepEqual(loads, ['http://dsh-synthetic.localhost:1234/map']);
    assert.equal(writes.at(-1)[1].entries[0].url, 'http://localhost:41788/map');
    adapter.displayState('t', native.keyedHooks.browserState('t').getSnapshot());
    adapter.reload('t'); await tick();
    assert.equal(previews.length, 2); assert.ok(previews.every(row => row.sessionId === id));
    assert.ok(loads.every(url => url.startsWith('http://dsh-synthetic.localhost:1234/')));
    stop.abort(); await tick();
    assert.equal(pages[0].disposed, true); assert.equal(released.length, 1);
    const saved = writes.at(-1)[1], restoreStop = new AbortController();
    adapter.mount({ tabId: 'restored', signal: restoreStop.signal, viewportId: 'synthetic', applicationOrigin: 'http://127.0.0.1:3109',
      initial: saved, openTab() {} });
    assert.equal(loads.length, 2, 'saved native checkpoint must not start navigation automatically');
    adapter.restore('restored'); await tick();
    assert.equal(loads.length, 3); assert.equal(previews.at(-1).url, 'http://localhost:41788/map');
    restoreStop.abort(); await tick();
  } finally { stop.abort(); await adapter.dispose(); await native.dispose(); }
  console.log('PASS installed native browser initial open, remote refresh, checkpoint restore and tab disposal retain source ownership');
})().catch(error => { console.error(error); process.exitCode = 1; });
