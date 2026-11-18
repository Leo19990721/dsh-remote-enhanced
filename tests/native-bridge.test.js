import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptBrowserProps } from '../native-bridge.js';
import { isVirtual, virtualId } from '../native-model.js';
function fixture() {
  const calls = [];
  const record = name => (...args) => { calls.push([name, ...args]); return true; };
  const props = { open: record('native-open'), startSession: record('start'), requestSessionRename: record('rename'), useSessionAccess: record('session-access'), useWorkspaceAccess: record('workspace-access'), renderSlot: record('slot'), renderFactorySlot: record('factory'), insertWorkspaceBefore: record('move'), useContextMenu: () => ({ getTriggerProps: record('trigger') }), useStore: selector => selector({ groupBy: 'workspace-tree' }) };
  const target = { hostId: 'r', workspaceId: 'w', sessionId: 'same', backend: 'harness' };
  let busy = false;
  const controls = { isVirtual, busy: () => busy, target: id => id === virtualId('r', 'harness', 'session', 'same') ? target : undefined, open: record('remote-open'), unavailable: record('unavailable'), useWorkspaces: () => {}, useSessions: () => {} };
  return { calls, value: adaptBrowserProps(props, controls), setBusy: value => { busy = value; }, target };
}
test('native session opening stays original, foreign open uses exact composite target', () => {
  const { value, calls, target } = fixture();
  value.open('same'); value.open(virtualId('r', 'harness', 'session', 'same'));
  assert.deepEqual(calls, [['native-open', 'same'], ['remote-open', target]]);
});
test('unknown virtual identity never falls through to current Host', () => {
  const { value, calls } = fixture(); value.open(virtualId('r', 'harness', 'session', 'missing'));
  assert.deepEqual(calls, [['unavailable']]);
});
test('foreign management never sends synthetic IDs to native commands', async () => {
  const { value, calls } = fixture(), id = virtualId('r', 'harness', 'session', 'same');
  value.startSession(id); value.requestSessionRename(id, 'title');
  assert.equal(value.useSessionAccess(id, 'session/rename'), false);
  assert.equal(value.useWorkspaceAccess(id, 'session/create'), false);
  value.renderSlot('row', { sessionId: id });
  value.renderFactorySlot('contextMenu.button', { target: { kind: 'session', value: { sessionId: id } } });
  value.useContextMenu().getTriggerProps({ kind: 'session', value: { sessionId: id } }, { keyboard: true });
  await value.insertWorkspaceBefore('native', id);
  assert.deepEqual(calls, [['session-access', id, undefined], ['workspace-access', id, undefined], ['trigger', undefined, { keyboard: true }]]);
});
test('busy navigation ignores later clicks and original folder grouping remains peers', () => {
  const { value, calls, setBusy } = fixture(); setBusy(true); value.open('same');
  assert.deepEqual(calls, []); assert.equal(value.useStore(row => row.groupBy), 'workspace');
});
