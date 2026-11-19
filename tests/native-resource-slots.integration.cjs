// Installed SlotCore contract acceptance; no DOM, React rendering or live user
// state. Exercises the storage shape used by the running native slot registry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
(async () => {
  const resolve = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const frontendManifest = resolve.resolve('@deepseek-ai/dsh-web-frontend/package.json');
  const range = require('../package.json').engines.dsh;
  assert.ok(require('semver').satisfies(resolve(frontendManifest).version, range, { includePrerelease: true }), 'installed frontend must satisfy the declared DSH range');
  const frontend = path.dirname(frontendManifest);
  const html = fs.readFileSync(path.join(frontend, 'dist/index.html'), 'utf8');
  const entry = html.match(/src="\.\/assets\/(index-[\w-]+\.js)"/)?.[1];
  assert.ok(entry, 'installed frontend entry must exist');
  const source = fs.readFileSync(path.join(frontend, 'dist/assets', entry), 'utf8');
  // SlotCore is in the frontend's static module table. Locate the pure registry
  // by its named exports, rather than pinning names from one minified build.
  const exports = /const [\w$]+=Object\.freeze\(Object\.defineProperty\(\{__proto__:null,SlotCore:([\w$]+),SlotOwnershipError:[\w$]+,StaleAuthorizationError:[\w$]+,resolveSlotLabel:[\w$]+,standardHookPropName:([\w$]+)\}/.exec(source);
  assert.ok(exports, 'installed frontend must expose the SlotCore module table entry');
  const [, coreName, hookName] = exports;
  const start = source.lastIndexOf(`function ${hookName}(`, exports.index);
  assert.ok(start >= 0 && exports.index > start && exports.index - start < 64_000, 'installed SlotCore registry must have the expected bounded shape');
  const SlotCore = vm.runInNewContext(source.slice(start, exports.index) + `; ${coreName}`, { queueMicrotask }, { timeout: 1000 });
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
  function Browser() {} function Document() {} function Markdown() {} function Menu() {} function Actions() {} function Chat() {} function Other() {}
  const browserInject = () => ({});
  const browser = add('sidebar.right.pane.tab', { key: '@deepseek-ai/dsh-client-ui-sidebar-browser', inject: browserInject }, Browser);
  const document = add('sidebar.right.pane.tab', { key: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' }, Document);
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
    assert.notEqual(document.component, Document, 'document file actions use the original tab registry seat');
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
