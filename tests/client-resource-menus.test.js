import test from 'node:test';
import assert from 'node:assert/strict';
import { installPeerMenuSafety } from '../client-resource-menus.js';
import { peerFileAddress } from '../client-resources.js';
const id = 'dsh-peer:' + JSON.stringify(['pc', 'session', 's']);

function fixture(baseHost = 'local') {
  const registrations = [], calls = [], nativeRows = [{ id: 'open-in-app.file/reveal' }, { id: 'file-actions.file/saveAs' }, { id: 'session/archive' }];
  const original = () => ({ source: { getSnapshot: () => nativeRows, subscribe: () => () => {} }, select: id => calls.push(['native', id]) });
  const nativeCommand = { resolve: () => ({ status: 'handled' }) };
  const ctx = { contextMenus: { resolve: original, register(value) { registrations.push(value); return () => {}; } }, sessions: { list: { getSnapshot: () => ({ byId: { [id]: { sessionId: id, retainedBy: { mainView: 1 } } } }) } }, shortcuts: { registry: { commands: new Map([['workspace.openLocal', nativeCommand]]) } } };
  const fileActions = { menu: (sessionId, path) => ['download', 'saveAs'].map(id => ({ id, run: () => calls.push([id, sessionId, path]) })) };
  const safety = installPeerMenuSafety(ctx, baseHost, (...args) => calls.push(['open', ...args]), fileActions, key => key);
  return { ctx, safety, nativeRows, original, nativeCommand, calls, menu: (kind, target) => registrations.find(row => row.target === kind).resolve(target) };
}

test('remote file menus offer native save entries, preserving local menus and unrelated actions', () => {
  const f = fixture();
  try {
    const target = { kind: 'file', value: { sessionId: id, path: 'C:/same.txt', line: 3 } };
    const resolved = f.ctx.contextMenus.resolve(target);
    assert.deepEqual(resolved.source.getSnapshot(), [{ id: 'session/archive' }]);
    resolved.select('open-in-app.file/reveal'); resolved.select('file-actions.file/saveAs'); resolved.select('session/archive');
    assert.equal(f.ctx.contextMenus.resolve({ ...target, value: { ...target.value, sessionId: 's' } }).source.getSnapshot(), f.nativeRows);
    const actions = f.menu('file', target.value);
    assert.deepEqual(actions.map(row => row.id), ['open', 'download', 'saveAs', 'copy']);
    actions[0].run(); actions[1].run(); actions[2].run();
    assert.deepEqual(f.calls, [['native', 'session/archive'], ['open', id, 'C:/same.txt', { line: 3 }], ['download', id, 'C:/same.txt'], ['saveAs', id, 'C:/same.txt']]);
    assert.deepEqual(f.menu('directory', target.value).map(row => row.id), ['open', 'copy']);
    assert.equal(f.nativeCommand.resolve({}).status, 'blocked');
  } finally { f.safety.dispose(); }
  assert.equal(f.ctx.contextMenus.resolve, f.original); assert.equal(f.nativeCommand.resolve({}).status, 'handled');
});

test('URL-only images retain native actions and pathful images use their Session', () => {
  const f = fixture();
  try {
    const value = { sessionId: id, url: 'https://example.invalid/image.png' };
    const nativeRows = [{ id: 'file-actions.image/copy' }, { id: 'file-actions.image/download' }, { id: 'open-in-app.image/reveal' }];
    assert.deepEqual(f.safety.filter(nativeRows, { kind: 'image', value }), nativeRows.slice(0, 2));
    assert.deepEqual(f.menu('image', value), []);
    const pathful = { ...value, path: 'C:/ordinary.png' };
    assert.deepEqual(f.safety.filter(nativeRows, { kind: 'image', value: pathful }), []);
    const row = f.menu('image', pathful).find(row => row.id === 'download');
    row.run();
    assert.deepEqual(f.calls, [['download', id, pathful.path]]);
  } finally { f.safety.dispose(); }
});

test('file tab actions use the address owner, including ordinary files in another pane', () => {
  const f = fixture();
  try {
    const path = 'C:/Ordinary project/report #1 %.docx';
    const tab = { contentId: peerFileAddress(id, path) + '?line=9' };
    const value = { sessionId: 's', tab };
    assert.deepEqual(f.safety.filter(f.nativeRows, { kind: 'tab', value }), [{ id: 'session/archive' }]);
    for (const row of f.menu('tab', value)) row.run();
    assert.deepEqual(f.calls, [['download', id, path], ['saveAs', id, path]]);
    for (const contentId of [peerFileAddress('s', path), 'dsh-resource://file/absolute/C:/ordinary.txt', 'dsh-resource://file/session/%GG/test.txt', 'https://example.com/file']) {
      assert.deepEqual(f.menu('tab', { sessionId: id, tab: { contentId } }), []);
    }
  } finally { f.safety.dispose(); }
});
