// Installed generated RPCs + authenticated HTTP multipart bytes; synthetic files
// only. No live Host, user documents, prompts, profile mutations or desktop IO.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createServer, request } = require('node:http');
const { once } = require('node:events');
(async () => {
  const r = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
  const load = name => import(pathToFileURL(r.resolve(name)).href);
  const { Context } = r('@deepseek-ai/cordis');
  const connection = await load('@deepseek-ai/dsh-client-connection/client');
  const api = await load('@deepseek-ai/dsh-api-gateway/client');
  const { TypertRegistry } = await load('@deepseek-ai/dsh-typert-registry');
  const { registerFederatedRoute } = await import('../federated-route.js');
  const { installSessionCarrier } = await import('../client-carrier.js');
  const { remoteBrowser } = await import('../client-browser.js');
  const { LoopbackPreview } = await import('../federated-preview-transport.js');
  const { WebSocketServer, WebSocket } = require('ws');
  const loopbackCalls = [];
  const definitions = await Promise.all(['dsh-api-workspace-files', 'dsh-office-kit', 'dsh-api-session-controller'].map(name => load('@deepseek-ai/' + name + '/remote')));
  const descriptors = new Map(definitions.flatMap(row => row.default.descriptors.map(d => [d.namespace + '/' + d.method, d])));
  const stop = new AbortController(), peer = { principal: { kind: 'owner' }, signal: stop.signal }, calls = [], releases = [];
  const file = new Uint8Array(4 * 1024 * 1024 + 17).fill(129), localFile = new Uint8Array([1, 2, 3]);
  const raw = host => ({ query: operation => operation({ client: { rpc: async (_method, payload) => {
    loopbackCalls.push([host, payload.op]);
    if (payload.op === 'describe') return { ports: [41788] };
    if (payload.op === 'close') return {};
    throw new Error('Native file confirmation must not call upstream /open');
  } } }, stop.signal), async call(endpoint, payload) {
    calls.push([host, endpoint, payload]); const data = host === 'local' ? localFile : file, args = payload.args;
    if (endpoint === 'session/openWorkspacePath') {
      assert.equal(host, 'local');
      return { ok: true, value: { opened: true } };
    }
    if (endpoint === 'workspaceFiles/stat') return args.path === 'directory'
      ? { ok: false, error: { code: 'workspace-file/not-file', message: 'synthetic directory', details: {} } }
      : { ok: true, value: { absolutePath: 'C:\\same.png', version: 'v-' + host, bytes: data.length } };
    if (endpoint === 'workspaceFiles/list') return { ok: true, value: { path: '', entries: [{ name: 'same.png', type: 'file' }], truncated: false } };
    if (endpoint === 'workspaceFiles/readBytes') { const { offset = 0, length = data.length } = args.options?.range || {}; return { ok: true, value: { absolutePath: 'C:\\same.png', version: 'v-' + host, bytes: data.length, offset, eof: offset + length >= data.length, data: data.slice(offset, offset + length) } }; }
    throw new Error('Unexpected synthetic endpoint ' + endpoint);
  }, release: async () => releases.push(host) });
  let route, upgrade; const cleanup = [];
  const hostCtx = { connection: { admit: req => req.headers['x-owner'] === 'yes' ? { peer } : { rejection: 401 } }, webServer: { register(value) { route = value; return () => {}; }, registerUpgrade(value) { upgrade = value; return () => {}; } }, effect(fn) { const result = fn(); if (typeof result === 'function') cleanup.push(result); else cleanup.push(...result); } };
  registerFederatedRoute(hostCtx, { WebSocketServer, filePreviewTargets: [{ hostId: 'pc', port: 41788, path: '/' }], createPreview: (client, options) => new LoopbackPreview(client, WebSocketServer, options), baseHost: () => 'local', local: () => raw('local'), channels: { retain: async () => raw('pc') }, hosts: async () => [{ hostId: 'pc', name: 'PC', online: true }], descriptor: endpoint => descriptors.get(endpoint), officeKit: { convert: async (request, active) => { const data = await request.source.read(active, 100 * 1024 * 1024); assert.deepEqual(data.bytes, file); return { pdf: new Uint8Array([37, 80, 68, 70]), missingFonts: [], generation: 'kit' }; } } });
  const server = createServer((req, res) => { void route.handler(req, res).catch(error => res.destroy(error)); });
  server.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/`, ctx = new Context(), fibers = [];
  const send = (url, init = {}) => fetch(new URL(url, base), { ...init, headers: { ...init.headers, 'x-owner': 'yes' } });
  let carrier, phase = 'installed setup';
  const deadline = setTimeout(() => { console.error('Native resources timed out:', phase); process.exit(1); }, 8000);
  try {
    const setup = ctx.plugin({ apply(scope) { connection.installConnection(scope, { interactions: 'answer', transport: { fetch: send, streamBaseUrl: base, createWebSocket: url => new WebSocket(url, { headers: { 'x-owner': 'yes' } }) } }); new TypertRegistry(scope); } }); fibers.push(setup); await setup.inertia;
    const gatewayFiber = ctx.plugin(api); fibers.push(gatewayFiber); await gatewayFiber.inertia;
    for (const definition of definitions) await ctx.get('remote').$mount(definition.default);
    carrier = await installSessionCarrier(ctx, { fetch: send });
    const remote = ctx.get('remote'), id = 'dsh-peer:' + JSON.stringify(['pc', 'session', 's']);
    const first = await remote.workspaceFiles.readBytes(id, 'same.png', {}, stop.signal); assert.equal(first.ok, true, JSON.stringify(first.error)); assert.deepEqual(first.value.data, file);
    // Use the installed native saving service, stopping at its desktop bridge
    // rather than opening a dialog or writing a user file. Actual RPCs and
    // multipart bytes remain in use; neither React nor a DOM is emulated.
    let actions, saved = 0, savedBytes, savedContentType, nativeRequest, saveResult = { status: 'cancelled' };
    const desktop = { async save(request) {
      saved++; nativeRequest = request;
      assert.ok(request.url.startsWith('blob:'), 'native bridge must receive the authorized bytes rather than a remote source path');
      const response = await fetch(request.url);
      savedContentType = response.headers.get('content-type');
      savedBytes = new Uint8Array(await response.arrayBuffer());
      return saveResult;
    } };
    // Plugin apply only creates the real service. Its optional menu registration
    // is independent and is covered by the menu contract test.
    const shell = { dshDesktop: { fileActions: desktop } };
    let nativeFactory;
    // Expose only the installed bundle's pure filename helper in this isolated
    // VM. It uses the same file-drag resolver and MIME table as Desktop; no
    // installed file is changed and this does not simulate a save dialog.
    const nativeSource = fs.readFileSync(r.resolve('@deepseek-ai/dsh-client-ui-file-actions/client'), 'utf8');
    assert.equal(nativeSource.split('return module.exports').length, 2);
    vm.runInNewContext(nativeSource.replace('return module.exports', 'module.exports.testExportName = exportName;return module.exports'), {
      window: { ...shell, __ModuleLoader__: { load(row) { nativeFactory = row.factory; } } }, Blob, URL, AbortController, TextEncoder,
    });
    const nativeFiles = nativeFactory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : (() => { throw new Error('Unexpected saving dependency ' + name); })());
    const fileDisposers = [];
    nativeFiles.apply({ provide(name, value) { if (name === 'fileActions') actions = value; }, effect(run) { fileDisposers.push(run()); }, inject() {} });
    const { installSessionResources } = await import('../client-resources.js');
    const menuEntries = [], navigations = [], notices = [];
    const resourceServices = {
      fileActions: actions, locale: { bind: () => key => key },
      sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
      slots: { entries: () => [], inject: (_key, run) => run(), register: () => () => {}, subscribe: () => () => {} },
      sidebarRightTabs: { register: () => () => {} }, sidebarRight: { openResourceIn: (...args) => navigations.push(args) },
      contextMenus: { resolve() {}, register(value) { menuEntries.push(value); return () => {}; }, notify: (...args) => notices.push(args) },
    };
    // Use the production nested injection under a real plugin Context, not a
    // root/plain object: Cordis enforces each generated namespace separately.
    const clientTemplate = fs.readFileSync(path.join(__dirname, '../native-client.template.js'), 'utf8');
    const resourceInject = JSON.parse(clientTemplate.match(/ctx\.inject\((\[[^\]]+\]), resourceCtx/)[1].replaceAll("'", '"'));
    for (const name of resourceInject) if (!name.startsWith('remote.') && name !== 'remote') ctx.provide(name, resourceServices[name] || {});
    for (const name of ['sessions', 'slots', 'locale']) ctx.provide(name, resourceServices[name]);
    let restoreResources;
    const resourceFiber = ctx.plugin({ inject: ['remote', 'slots', 'locale', 'sessions'], apply(scope) {
      scope.inject(resourceInject, injected => {
        restoreResources = installSessionResources(injected, { ...carrier, mediaUrl: () => 'http://unavailable.invalid/original' }, undefined, stop.signal);
      });
    } }); fibers.push(resourceFiber); await resourceFiber.inertia;
    assert.equal(typeof restoreResources, 'function');
    try {
      const fileMenu = menuEntries.find(row => row.target === 'file');
      const value = { sessionId: id, path: 'same.png' };
      await fileMenu.resolve(value).find(row => row.id === 'saveAs').run();
      assert.equal(saved, 1); assert.deepEqual(savedBytes, file); assert.equal(nativeRequest.name, 'same.png');
      assert.equal(nativeRequest.mode, 'saveAs');
      assert.equal(nativeRequest.mediaType, 'application/x-dsh-original', 'raw original bytes need an opaque MIME so Electron does not reinterpret them as text');
      assert.equal(savedContentType, nativeRequest.mediaType, 'the blob itself must carry the MIME because Desktop prefers the downloaded content type over request metadata');
      assert.equal(nativeFiles.testExportName('报告封面.docx', 'text/plain'), '报告封面.txt', 'the installed filename resolver reproduces the observed original regression');
      assert.equal(nativeFiles.testExportName('报告封面.docx', 'application/octet-stream'), '报告封面.bin', 'a generic binary MIME would still replace the original suffix');
      for (const name of ['same.png', '报告封面.docx', 'sample.md', 'unknown.custom']) {
        assert.equal(nativeFiles.testExportName(name, savedContentType), name, 'the installed original-file resolver must preserve the exact supplied suffix');
      }
      assert.deepEqual(notices, [], 'cancelled native dialog is silent');
      await assert.rejects(fetch(nativeRequest.url), /fetch failed/);
      await fileMenu.resolve(value).find(row => row.id === 'open').run();
      assert.equal(navigations.at(-1)[0], id); assert.match(navigations.at(-1)[1], /^dsh-resource:\/\/file\/session\//);
      const directoryMenu = menuEntries.find(row => row.target === 'directory');
      await directoryMenu.resolve({ sessionId: id, path: 'directory' }).find(row => row.id === 'open').run();
      assert.equal(navigations.at(-1)[0], id); assert.match(navigations.at(-1)[1], /^dsh-resource:\/\/peer-directory\/session\//);
      // Join the real preview listener, owner confirmation, generated RPCs and
      // installed save service in one flow. Only the webpage and desktop IO are
      // synthetic; no React/DOM, user files, credentials or live Hosts are used.
      const tab = new AbortController(), changed = new Set(); let adapter, browserCurrent;
      const nativeBrowser = { mount() { return () => {}; }, loadUrl(_tab, url) {
        browserCurrent = { frame: { address: 'observed', target: { url } } }; adapter.displayState('map', browserCurrent);
      } };
      adapter = remoteBrowser(nativeBrowser, carrier, id, { signal: stop.signal });
      const source = adapter.keyedHooks.browserState('map'), unsubscribe = source.subscribe(() => { for (const notify of changed) notify(); });
      const until = async condition => {
        if (condition()) return;
        let check, timer;
        try { await new Promise((resolve, reject) => {
          check = () => { if (condition()) resolve(); }; changed.add(check);
          timer = setTimeout(() => reject(new Error('native preview confirmation timed out')), 2000); check();
        }); } finally { changed.delete(check); clearTimeout(timer); }
      };
      adapter.mount({ tabId: 'map', signal: tab.signal, initialUrl: 'http://localhost:41788/', openTab() {} });
      phase = 'enable';
      try {
        await until(() => adapter.fileState('map').available);
        await adapter.setFileMode('map', true);
        assert.equal(adapter.fileState('map').active, true, JSON.stringify(adapter.fileState('map')));
        const page = browserCurrent.frame.target.url;
        const postFile = async path => {
          const url = new URL(page);
          return new Promise((resolve, reject) => {
            const req = request({ hostname: '127.0.0.1', port: url.port, path: '/open', method: 'POST', headers: {
              host: url.host, origin: url.origin, 'content-type': 'application/json',
            } }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode, text })); response.on('error', reject); });
            req.on('error', reject); req.end(JSON.stringify({ path, kind: 'file' }));
          });
        };
        const proposed = 'D:\\Synthetic\\same.png', beforeProposal = calls.length;
        phase = 'post-preview'; assert.equal((await postFile(proposed)).status, 409);
        phase = 'pending-preview'; await until(() => adapter.fileState('map').pending?.path === proposed);
        assert.equal(calls.length, beforeProposal, 'proposing in the page cannot stat/list/read any file');
        await adapter.consumeFile('map', 'preview', ({ sessionId, path }) => fileMenu.resolve({ sessionId, path }).find(row => row.id === 'open').run());
        assert.equal(navigations.at(-1)[0], id); assert.ok(navigations.at(-1)[1].endsWith('/D:/Synthetic/same.png'));
        assert.equal(calls.at(-1)[0], 'pc'); assert.equal(calls.at(-1)[2].args.workspaceFileScopeId, 's');
        const savedPath = 'C:\\Downloads\\same (1).png';
        saveResult = { status: 'saved', path: savedPath };
        phase = 'post-download'; assert.equal((await postFile(proposed)).status, 409);
        phase = 'pending-download'; await until(() => adapter.fileState('map').pending?.path === proposed);
        const saveBefore = saved;
        await adapter.consumeFile('map', 'download', ({ sessionId, path }) => fileMenu.resolve({ sessionId, path }).find(row => row.id === 'download').run());
        assert.equal(saved, saveBefore + 1); assert.deepEqual(savedBytes, file);
        assert.equal(nativeRequest.name, 'same.png'); assert.equal(nativeRequest.mode, 'download');
        const [notice, success, action] = notices.at(-1);
        assert.equal(notice, 'menu.downloaded'); assert.equal(success, true); assert.equal(action.label, 'menu.reveal');
        assert.ok(calls.every(row => row[1] !== 'session/openWorkspacePath'), 'saving alone does not reveal');
        phase = 'reveal saved copy'; await action.run();
        assert.deepEqual(calls.at(-1), ['local', 'session/openWorkspacePath', { args: { request: { path: savedPath, action: 'reveal' } } }]);
        await assert.rejects(fetch(nativeRequest.url), /fetch failed/);
        assert.ok(loopbackCalls.every(([, op]) => ['describe', 'close'].includes(op)), 'no remote OS action or business POST');
        assert.ok(calls.filter(row => row[2].args.path === proposed).every(row => row[0] === 'pc' && row[2].args.workspaceFileScopeId === 's'));
      } catch (error) { throw new Error('Webpage/native resources phase ' + phase, { cause: error }); }
      finally { phase = 'browser cleanup after ' + phase; unsubscribe(); tab.abort(); await adapter.dispose(); }
    } finally { await restoreResources(); for (const dispose of fileDisposers.reverse()) dispose(); }
    const second = await remote.workspaceFiles.readBytes('s', 'same.png', {}, stop.signal); assert.deepEqual(second.value.data, localFile);
    const list = await remote.workspaceFiles.list(id, '.', stop.signal); assert.equal(list.value.entries[0].name, 'same.png');
    const pdf = await remote.officeKit.render(id, 'same.docx', 'foreground', stop.signal); assert.equal(pdf.ok, true, JSON.stringify(pdf.error)); assert.deepEqual(pdf.value.data, new Uint8Array([37, 80, 68, 70])); assert.equal(pdf.value.bytes, 4);
    const query = new URLSearchParams({ viewId: carrier.viewId, sessionId: id, path: 'same.png' });
    assert.equal((await fetch(base + 'dsh-session-hosts/media?' + query)).status, 401);
    const image = await send('dsh-session-hosts/media?' + query); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png'); assert.deepEqual(new Uint8Array(await image.arrayBuffer()), file);
    assert.ok(calls.filter(row => row[0] === 'pc').every(row => row[2].args.workspaceFileScopeId === 's'));
    console.log('PASS webpage proposal -> DSH confirmation -> installed generated file API -> native preview/save bridge, plus cancellation, directory ownership, complete remote reads, Office PDF and image authentication');
  } finally {
    phase = 'carrier cleanup after ' + phase; await carrier?.dispose();
    phase = 'installed fibers cleanup'; for (const fiber of fibers.reverse()) await fiber.dispose();
    stop.abort(); phase = 'host mux cleanup'; for (const dispose of cleanup.reverse()) if (typeof dispose === 'function') await dispose();
    phase = 'HTTP listener cleanup'; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); clearTimeout(deadline);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
