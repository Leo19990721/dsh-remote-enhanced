import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from '../native-model.js';

const local = { hostId: 'local', name: 'Home', online: true, workspaces: [{ workspaceId: 'w', path: 'C:/Desktop', title: 'Desktop', sessionIds: ['same'], createdAt: '2026-01-01T00:00:00Z' }], sessions: [{ sessionId: 'same', title: 'Local', running: false }], archivedSessionIds: [], pinnedSessionIds: [] };
const remote = { hostId: 'r', name: 'Remote-PC', online: true, workspaces: [{ workspaceId: 'w', path: 'C:/Desktop', title: 'Desktop', sessionIds: ['same', 'hidden', 'child'], createdAt: '2026-01-01T00:00:00Z' }], sessions: [{ sessionId: 'same', title: 'Remote', running: true }, { sessionId: 'hidden', title: 'Hidden' }, { sessionId: 'child', origin: 'subagent' }], archivedSessionIds: ['hidden'], pinnedSessionIds: ['same'] };
const active = { ids: ['same'], byId: { same: { id: 'same', title: 'Live title', retainedBy: { mainView: 1 }, running: true } }, projectionsBySession: {}, phase: 'ready' };
const workspaces = { items: local.workspaces, archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'ready' };

test('original local folder is unchanged and remote folder adds computer suffix', () => {
  const value = createProjection([local, remote], { hostId: 'local', backend: 'harness' }, workspaces, active);
  assert.equal(value.workspaces.items[0].title, 'Desktop');
  assert.equal(value.workspaces.items[1].title, 'Desktop（Remote-PC）');
  assert.notEqual(value.workspaces.items[0].workspaceId, value.workspaces.items[1].workspaceId);
  assert.equal(value.sessions.byId.same.title, 'Live title');
});
test('same IDs on separate computers never collide and virtual target retains exact identity', () => {
  const value = createProjection([local, remote], { hostId: 'local', backend: 'harness' }, workspaces, active);
  const remoteWorkspace = value.workspaces.items[1], id = remoteWorkspace.sessionIds[0];
  assert.notEqual(id, 'same'); assert.equal(value.sessions.byId[id].title, 'Remote');
  assert.deepEqual(value.targets[id], { hostId: 'r', backend: 'harness', workspaceId: 'w', sessionId: 'same' });
  assert.ok(value.workspaces.archivedSessionIds.includes(remoteWorkspace.sessionIds[1]));
  assert.equal(value.sessions.ids.length, 3);
});
test('remote active folder keeps suffix and local folder stays visible for returning', () => {
  const value = createProjection([local, remote], { hostId: 'r', backend: 'harness' }, { ...workspaces, items: remote.workspaces }, active);
  assert.equal(value.workspaces.items[0].title, 'Desktop'); assert.equal(value.workspaces.items[1].title, 'Desktop（Remote-PC）');
  assert.equal(value.workspaces.items[1].workspaceId, 'w');
  assert.equal(value.sessions.byId.same.retainedBy.mainView, 1);
  assert.equal(value.targets[value.workspaces.items[0].sessionIds[0]].hostId, 'local');
});
test('unassigned foreign sessions cannot fall through to the active Host', () => {
  const foreign = { ...remote, sessions: [...remote.sessions, { sessionId: 'loose', title: 'Unassigned' }] };
  const value = createProjection([local, foreign], { hostId: 'local', backend: 'harness' }, workspaces, active);
  assert.ok(!Object.values(value.sessions.byId).some(row => row.title === 'Unassigned'));
});
test('selected native rows remain intact while disconnected catalog rows stay isolated', () => {
  const native = { ...active, ids: ['same', 'loose'], byId: { ...active.byId, loose: { id: 'loose', title: 'Local loose', retainedBy: {}, blank: false, running: false, updatedAt: 2 } } };
  const value = createProjection([local, remote], { hostId: 'local', backend: 'harness' }, workspaces, native);
  assert.equal(value.sessions.byId.same, native.byId.same);
  assert.equal(value.sessions.byId.loose, native.byId.loose);
});
test('projected title wins over stale summary title and empty metadata is safe', () => {
  const foreign = { ...remote, sessions: [{ sessionId: 'same', title: 'Stale', projections: { values: { title: 'Latest' } } }] };
  const value = createProjection([local, foreign, { hostId: 'off', name: 'Offline', online: false }], { hostId: 'local', backend: 'harness' }, workspaces, active);
  assert.equal(value.sessions.byId[value.workspaces.items[1].sessionIds[0]].title, 'Latest');
});
test('offline remote remains visible but is marked offline', () => {
  const value = createProjection([local, { ...remote, online: false }], { hostId: 'local', backend: 'harness' }, workspaces, active);
  const row = value.workspaces.items[1]; assert.equal(row.title, 'Desktop（Remote-PC） · 离线');
  assert.equal(value.targets[row.sessionIds[0]].hostId, 'r');
});
