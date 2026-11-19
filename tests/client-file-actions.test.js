import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerFileActions } from '../client-resources.js';
import { FederatedGateway } from '../federated-gateway.js';

const id = host => 'dsh-peer:' + JSON.stringify([host, 'session', 'same']);
const sourcePath = 'C:\\Ordinary project\\Report #1.docx';

function fixture({ desktop = true, platform = 'win32', canReveal = true } = {}) {
  const stop = new AbortController(), reads = [], saves = [], reveals = [], notices = [];
  const peer = { principal: { kind: 'owner' }, signal: stop.signal };
  const bytes = { local: 99, laptop: 1, desktop: 2 };
  const handle = host => ({ async call(endpoint, { args }) {
    assert.equal(endpoint, 'workspaceFiles/readBytes');
    reads.push([host, args.workspaceFileScopeId, args.path]);
    return { ok: true, value: { absolutePath: sourcePath, bytes: 3, version: 'v1', offset: 0, eof: true, data: Uint8Array.of(bytes[host], 255, 0) } };
  } });
  const gateway = new FederatedGateway({
    baseHost: 'local', local: () => handle('local'), channels: { retain: async host => handle(host) }, hosts: async () => [],
    descriptor: () => ({ parameters: [{ wire: 'workspaceFileScopeId', source: 'lookup', lookup: 'workspaceFileScope' }], result: {} }),
  });
  const ctx = {
    locale: { bind(ns) { assert.equal(ns, 'fileActions'); return key => key; } },
    contextMenus: { notify: (...args) => notices.push(args) },
    remote: { workspaceFiles: { readBytes: (workspaceFileScopeId, path, options, signal) =>
      gateway.call('workspaceFiles/readBytes', { args: { workspaceFileScopeId, path, options } }, signal, peer) } },
    fileActions: {
      canSaveAs: desktop,
      async save(source, mode) {
        const blob = await source.read(stop.signal);
        saves.push([mode, source.name, blob.type, [...new Uint8Array(await blob.arrayBuffer())]]);
        return desktop ? { status: 'saved', path: `C:\\Downloads\\Report #1 (${saves.length}).docx` } : { status: 'requested' };
      },
    },
  };
  const carrier = {
    baseHost: 'local', canRevealSavedFile: canReveal,
    mediaUrl: (sessionId, path) => 'https://fixture.invalid/?' + new URLSearchParams({ sessionId, path }),
    async revealSavedFile(path, signal) { signal.throwIfAborted(); reveals.push(path); return { ok: true }; },
  };
  return { actions: createPeerFileActions(ctx, carrier, stop.signal, () => platform), ctx, carrier, stop, reads, saves, reveals, notices };
}

test('each file menu captures its Host and keeps original bytes, including when another Session has the same path', async () => {
  const f = fixture();
  const laptopMenu = f.actions.menu(id('laptop'), sourcePath);
  const desktopMenu = f.actions.menu(id('desktop'), sourcePath);
  assert.deepEqual(laptopMenu.map(row => [row.id, row.label, row.icon.key]), [
    ['download', 'menu.download', 'file-actions.download'], ['saveAs', 'menu.saveAs', 'file-actions.save'],
  ]);
  const blocked = Promise.withResolvers(), started = Promise.withResolvers();
  const read = f.ctx.remote.workspaceFiles.readBytes;
  f.ctx.remote.workspaceFiles.readBytes = async (...args) => {
    if (args[0] === id('laptop')) { started.resolve(); await blocked.promise; }
    return read(...args);
  };
  const first = laptopMenu[0].run();
  await started.promise;
  try { await desktopMenu[1].run(); }
  finally { blocked.resolve(); await first; }
  assert.deepEqual(f.reads, [['desktop', 'same', sourcePath], ['laptop', 'same', sourcePath]]);
  assert.deepEqual(f.saves, [
    ['saveAs', 'Report #1.docx', 'application/x-dsh-original', [2, 255, 0]],
    ['download', 'Report #1.docx', 'application/x-dsh-original', [1, 255, 0]],
  ]);
  assert.deepEqual(f.notices.map(([text, success]) => [text, success]), [['menu.saved', true], ['menu.downloaded', true]]);
  assert.equal(f.notices[1][2].label, 'menu.reveal');
  assert.equal(f.notices[1][2].failureLabel, 'path.revealError');
  assert.deepEqual(f.reveals, [], 'writing a file must not open the file manager automatically');
  await f.notices[1][2].run();
  assert.deepEqual(f.reveals, ['C:\\Downloads\\Report #1 (2).docx']);
});

test('Web uses browser download without claiming a native destination', async () => {
  const f = fixture({ desktop: false });
  assert.deepEqual(f.actions.menu(id('laptop'), sourcePath).map(row => row.id), ['download']);
  await f.actions.save(id('laptop'), sourcePath);
  assert.deepEqual(f.notices, [['menu.downloadStarted', true]]);
  await assert.rejects(f.actions.save(id('laptop'), sourcePath, 'saveAs'), /menu.saveFailed/);
  assert.equal(f.saves.length, 1);
});

test('save cancellation is silent and failed remote reads never produce success feedback', async () => {
  const f = fixture(), save = f.ctx.fileActions.save;
  f.ctx.fileActions.save = async () => ({ status: 'cancelled' });
  await f.actions.save(id('laptop'), sourcePath, 'saveAs');
  assert.deepEqual(f.notices, []);
  f.ctx.fileActions.save = save;
  f.ctx.remote.workspaceFiles.readBytes = async () => ({ ok: false, error: { code: 'unavailable', message: 'Source unavailable' } });
  const [download] = f.actions.menu(id('laptop'), sourcePath);
  assert.equal(download.failureLabel, 'menu.saveFailed');
  await assert.rejects(download.run(), { code: 'unavailable' });
  await assert.rejects(f.actions.save('same', sourcePath), /menu.saveFailed/, 'local files keep native menus');
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.saves, []);
});

test('desktop feedback uses its own platform and cannot reveal after plugin unload', async () => {
  const f = fixture({ platform: 'darwin' });
  await f.actions.save(id('laptop'), sourcePath);
  const action = f.notices[0][2];
  assert.equal(action.label, 'menu.finder');
  f.stop.abort();
  await action.run();
  await f.actions.save(id('laptop'), sourcePath);
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.reveals, []);
});

test('unloading during a read aborts it and does not publish a save notice', async () => {
  const f = fixture(), started = Promise.withResolvers(), read = Promise.withResolvers();
  let active;
  f.ctx.remote.workspaceFiles.readBytes = async (_id, _path, _options, signal) => {
    active = signal;
    started.resolve();
    return read.promise;
  };
  const pending = f.actions.save(id('desktop'), sourcePath);
  await started.promise;
  f.stop.abort();
  assert.equal(active.aborted, true);
  read.resolve({ ok: true, value: { data: Uint8Array.of(1) } });
  await pending;
  assert.deepEqual(f.saves, []);
  assert.deepEqual(f.notices, []);
});

test('a missing native reveal capability leaves an ordinary completion notice', async () => {
  const f = fixture({ canReveal: false });
  await f.actions.save(id('laptop'), sourcePath);
  assert.deepEqual(f.notices, [['menu.downloaded', true, undefined]]);
});
