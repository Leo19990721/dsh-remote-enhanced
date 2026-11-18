import test from 'node:test';
import assert from 'node:assert/strict';
import { installPeerMenuSafety } from '../client-resource-menus.js';
const id = 'dsh-peer:' + JSON.stringify(['pc', 'session', 's']);
test('remote menus remove wrong-machine app actions but preserve local and non-file commands', () => {
  const registrations = [], nativeRows = [{ id: 'open-in-app.file/reveal' }, { id: 'file-actions.file/saveAs' }, { id: 'session/archive' }];
  const original = () => ({ source: { getSnapshot: () => nativeRows, subscribe: () => () => {} }, select() {} });
  const nativeCommand = { resolve: () => ({ status: 'handled' }) };
  const ctx = { contextMenus: { resolve: original, register(value) { registrations.push(value); return () => {}; } }, sessions: { list: { getSnapshot: () => ({ byId: { [id]: { sessionId: id, retainedBy: { mainView: 1 } } } }) } }, shortcuts: { registry: { commands: new Map([['workspace.openLocal', nativeCommand]]) } } };
  const safety = installPeerMenuSafety(ctx, 'local', async () => {}, async () => {}, key => key);
  const target = { kind: 'file', value: { sessionId: id, path: 'C:/same.txt' } };
  assert.deepEqual(ctx.contextMenus.resolve(target).source.getSnapshot(), [{ id: 'session/archive' }]);
  assert.equal(ctx.contextMenus.resolve({ ...target, value: { ...target.value, sessionId: 'local' } }).source.getSnapshot(), nativeRows);
  assert.equal(registrations.find(row => row.target === 'file').resolve(target.value).length, 3);
  assert.equal(nativeCommand.resolve({}).status, 'blocked');
  safety.dispose(); assert.equal(ctx.contextMenus.resolve, original); assert.equal(nativeCommand.resolve({}).status, 'handled');
});
