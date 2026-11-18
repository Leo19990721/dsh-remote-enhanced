// Installed SlotCore contract acceptance; no DOM, React rendering or live user
// state. Exercises the storage shape used by the running native slot registry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
(async () => {
  const resolve = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const frontend = path.dirname(resolve.resolve('@deepseek-ai/dsh-web-frontend/package.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(frontend, 'package.json'), 'utf8')).version, '0.2.2-rc.3');
  const html = fs.readFileSync(path.join(frontend, 'dist/index.html'), 'utf8');
  const entry = html.match(/src="\.\/assets\/(index-[^"]+\.js)"/)[1];
  const source = fs.readFileSync(path.join(frontend, 'dist/assets', entry), 'utf8');
  // SlotCore is a static browser identity and is not shipped as a Node package.
  // Evaluate this verified installation's pure registry section, unchanged.
  const start = source.indexOf('function MN('), end = source.indexOf('const RN=Object.freeze', start);
  assert.ok(start >= 0 && end > start, 'verified installed SlotCore section must exist');
  const SlotCore = vm.runInNewContext(source.slice(start, end) + '; AN', { queueMicrotask });
  const core = new SlotCore(), disposers = [];
  const seats = {
    'conversation.view': { kind: 'keyed', scope: 'session' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    'sidebar.right.tab.document': { kind: 'keyed', scope: 'session' },
    'sidebar.right.tab.document.actions': { kind: 'list', scope: 'session' },
    'sidebar.right.tab.document.unpreviewable': { kind: 'list', scope: 'session' },
    'sidebar.right.tab.files.actions': { kind: 'list', scope: 'session' },
    'deliverables.file.actions': { kind: 'list', scope: 'session' },
    'deliverables.review.file.actions': { kind: 'list', scope: 'session' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  };
  disposers.push(core.register({ name: 'root', children: seats }, function Root() {}));
  const bodies = new Map();
  const add = (seat, options, Native) => {
    disposers.push(core.register({ name: seat, ...options }, Native));
    const held = core.entries(seat).find(row => row.component === Native);
    bodies.set(Native, held); return held;
  };
  function Browser() {} function Markdown() {} function Menu() {} function Actions() {} function Chat() {} function Other() {}
  const browserInject = () => ({});
  const browser = add('sidebar.right.pane.tab', { key: '@deepseek-ai/dsh-client-ui-sidebar-browser', inject: browserInject }, Browser);
  const markdown = add('sidebar.right.tab.document', { key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown' }, Markdown);
  const overlay = add('shell.overlay', { id: 'context-menu' }, Menu);
  const actions = add('sidebar.right.tab.document.actions', { id: 'open-in-app' }, Actions);
  const chat = add('conversation.view', { key: 'chat', children: { 'conversation.chat.flow': { kind: 'single', scope: 'session' } } }, Chat);
  const other = add('sidebar.right.pane.tab', { key: 'unrelated' }, Other);
  const ctx = {
    locale: { bind: () => key => key }, sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
    slots: { entries: key => core.entries(key), subscribe: (key, listener) => core.subscribe(key, listener),
      register: (...args) => core.register(...args), inject: (_key, run) => run() },
    sidebarRightTabs: { register: () => () => {} },
    contextMenus: { resolve() {}, register: () => () => {}, notify() {} },
  };
  const { installSessionResources } = await import('../client-resources.js');
  const restore = installSessionResources(ctx, { baseHost: 'local' }, undefined, new AbortController().signal);
  try {
    assert.equal(browser.key, undefined, 'installed entries keep dispatch keys in options');
    assert.equal(browser.options.key, '@deepseek-ai/dsh-client-ui-sidebar-browser');
    assert.notEqual(browser.component, Browser, 'remote browser must be decorated on the actual installed registry shape');
    assert.notEqual(markdown.component, Markdown, 'Markdown media must use the same owning Session');
    assert.notEqual(overlay.component, Menu, 'already-bound native menu must be filtered');
    assert.notEqual(actions.component, Actions, 'native app actions must be hidden for remote paths');
    assert.notEqual(chat.component, Chat);
    assert.equal(other.component, Other); assert.equal(browser.inject, browserInject, 'native binding and state injection remain untouched');
  } finally {
    await restore();
    for (const [Native, held] of bodies) assert.equal(held.component, Native, 'unload restores each exact native component');
    for (const dispose of disposers.reverse()) dispose();
  }
  console.log('PASS installed SlotCore options, browser/Markdown/menu adaptation, native binding preservation and exact unload');
})().catch(error => { console.error(error); process.exitCode = 1; });
