import test from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedCatalog, targetKey } from '../catalog.js';

function fixture() {
  let status = { mode: 'local', deviceName: 'This PC', backend: 'harness' };
  const calls = [];
  const local = [{ sessionId: 'same', projections: { values: { title: 'Local title' } }, updatedAt: 2 }, { sessionId: 'archived' }, { sessionId: 'child', parentSessionId: 'same' }, { sessionId: 'other', origin: 'subagent' }];
  const workspace = { id: 'w', path: 'C:/project', title: 'Project', sessionIds: local.map(row => row.sessionId) };
  const client = {
    status: () => status,
    devices: async () => [{ deviceId: 'remote', name: 'Other PC', online: true }],
    discoverToolWorkspaces: async () => ({ workspaces: [{ workspaceId: 'rw', backend: 'harness', title: 'Remote project' }, { workspaceId: 'c1', backend: 'codex', title: 'CodeX one' }, { workspaceId: 'c2', backend: 'codex', title: 'CodeX two' }], unavailable: [] }),
    setMode: async (mode, hostId) => { calls.push(['setMode', mode, hostId]); status = { mode, target: { deviceId: hostId }, backend: 'harness' }; },
    openCodexWorkspace: async (hostId, workspaceId) => { calls.push(['codex', hostId, workspaceId]); status = { mode: 'remote', target: { deviceId: hostId }, backend: 'codex', workspaceSelection: { targetDeviceId: hostId, workspaceId, backend: 'codex' } }; },
    openCursorWorkspace: async (...args) => calls.push(['acp', ...args]),
    runSessionTool: async (_op, args) => ({ sessions: [{ sessionId: 'same', title: 'Remote title' }], nextOffset: null }),
  };
  const ctx = { get: () => client, workspaceRegistry: { list: () => [workspace], get: id => id === 'w' ? workspace : undefined, archivedSessionIds: ['archived'] }, sessionController: { list: async () => ({ items: local }) } };
  const readRemote = async () => ({ workspaces: [{ workspaceId: 'rw', sessionIds: ['same', 'archived', 'child'] }], archivedSessionIds: ['archived'], sessions: [{ sessionId: 'same', projections: { values: { title: 'Remote projected title' } }, updatedAt: 2, running: true }, { sessionId: 'archived', title: 'Hidden' }, { sessionId: 'child', parentSessionId: 'same' }] });
  return { service: new UnifiedCatalog(ctx, { readRemote }), calls, client, setStatus: value => { status = value; } };
}
test('composite identity includes machine and backend', () => {
  assert.notEqual(targetKey({ hostId: 'local', workspaceId: 'w', sessionId: 'same' }), targetKey({ hostId: 'remote', workspaceId: 'w', sessionId: 'same' }));
});
test('local listing excludes archived/subagent and keeps projection titles', async () => {
  const { service, calls } = fixture();
  const result = await service.run('sessions', { hostId: 'local', workspaceId: 'w' });
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].title, 'Local title'); assert.deepEqual(calls, []);
});
test('remote listing excludes archives and extracts current title projection', async () => {
  const { service, calls } = fixture();
  const result = await service.run('sessions', { hostId: 'remote', workspaceId: 'rw' });
  assert.deepEqual(result.sessions.map(row => row.sessionId), ['same']);
  assert.equal(result.sessions[0].title, 'Remote projected title'); assert.deepEqual(calls, []);
});
test('discovery does not switch the active computer', async () => {
  const { service, calls } = fixture();
  await service.run('hosts'); await service.run('workspaces', { hostId: 'remote' });
  assert.deepEqual((await service.run('status')).current, { hostId: 'local', backend: 'harness' }); assert.deepEqual(calls, []);
});
test('retired select rejects local and remote targets without changing the active computer', async () => {
  const { service, calls } = fixture();
  for (const hostId of ['local', 'remote']) {
    await assert.rejects(service.run('select', { hostId, workspaceId: 'w', sessionId: 'same' }), /INDEPENDENT_SESSION_ROUTING_REQUIRED/);
  }
  assert.deepEqual(calls, []);
});
test('retired select cannot switch alternative backends or offline hosts', async () => {
  const { service, client, calls } = fixture(); client.devices = async () => [{ deviceId: 'remote', online: false }];
  for (const backend of ['harness', 'codex', 'opencode']) {
    await assert.rejects(service.run('select', { hostId: 'remote', backend, workspaceId: 'w', sessionId: 'same' }), /INDEPENDENT_SESSION_ROUTING_REQUIRED/);
  }
  assert.deepEqual(calls, []);
});
test('cancelled queued request never switches', async () => {
  const { service, calls } = fixture(); const stop = new AbortController(); stop.abort();
  await assert.rejects(service.run('select', { hostId: 'remote', workspaceId: 'rw', sessionId: 'same' }, stop.signal)); assert.deepEqual(calls, []);
});
test('combined snapshot contains only navigation metadata and never switches', async () => {
  const { service, calls } = fixture();
  const rows = (await service.ctx.sessionController.list({}, new AbortController().signal)).items;
  rows[0].projections.values.secret = 'not navigation metadata';
  rows[0].messages = ['private conversation'];
  const result = await service.run('snapshot');
  assert.equal(result.computers[0].sessions[0].title, 'Local title');
  assert.equal(result.computers[0].sessions[0].messages, undefined);
  assert.equal(result.computers[0].sessions[0].projections, undefined);
  assert.equal(result.computers[1].sessions[0].title, 'Remote projected title');
  assert.ok(!result.computers[0].sessions.some(row => row.origin === 'subagent' || row.parentSessionId));
  assert.deepEqual(calls, []);
});
test('offline snapshot supplies stable empty metadata arrays', async () => {
  const { service, client } = fixture();
  client.devices = async () => [{ deviceId: 'remote', name: 'Other PC', online: false }];
  const result = await service.run('snapshot');
  assert.deepEqual(result.computers[1].sessions, []);
  assert.deepEqual(result.computers[1].archivedSessionIds, []);
});
test('metadata snapshots contain lossless JSON without undefined fields', async () => {
  const { service } = fixture();
  const value = await service.run('snapshot');
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
});

test('bad page size rejected; failed request does not poison later reads', async () => {
  const { service } = fixture();
  await assert.rejects(service.run('sessions', { hostId: 'local', workspaceId: 'w', limit: 101 }), /INVALID_PAGE/);
  assert.equal((await service.run('sessions', { hostId: 'local', workspaceId: 'w', limit: 1 })).sessions.length, 1);
});
