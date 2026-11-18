import test from 'node:test';
import assert from 'node:assert/strict';
import { FederatedGateway } from '../federated-gateway.js';

const signal = new AbortController().signal;
const owner = { principal: { kind: 'owner' }, signal };
const remoteId = 'dsh-peer:' + JSON.stringify(['pc', 'session', 's']);

test('native file scope lookup routes all preview reads to the owning computer', async () => {
  const calls = [];
  const raw = host => ({ call: async (endpoint, payload) => { calls.push({ host, endpoint, payload }); return { ok: true, value: { absolutePath: 'C:/a.docx', version: 'v', bytes: 1, offset: payload.args.options?.range?.offset || 0, data: new Uint8Array([1]), eof: true } }; }, release: async () => {} });
  const officeKit = { async convert(request, active) { await request.source.read(active, 10); return { pdf: new Uint8Array([1]), missingFonts: [], generation: 'g' }; } };
  const gateway = new FederatedGateway({ officeKit, baseHost: 'local', local: () => raw('local'), channels: { retain: async () => raw('pc') }, hosts: async () => [{ hostId: 'pc', name: 'PC', online: true }], descriptor: () => ({ parameters: [{ source: 'lookup', lookup: 'workspaceFileScope', wire: 'workspaceFileScopeId' }, { source: 'json', wire: 'path' }], result: {} }) });
  for (const endpoint of ['workspaceFiles/stat', 'workspaceFiles/read', 'workspaceFiles/readBytes', 'workspaceFiles/list', 'workspaceFiles/search', 'officeKit/render']) {
    await gateway.call(endpoint, { args: { workspaceFileScopeId: remoteId, path: 'a.docx' } }, signal, owner);
    assert.equal(calls.at(-1).host, 'pc', endpoint);
    assert.equal(calls.at(-1).payload.args.workspaceFileScopeId, 's', endpoint);
  }
  await gateway.call('workspaceFiles/readBytes', { args: { workspaceFileScopeId: 's', path: 'a.docx' } }, signal, owner);
  assert.equal(calls.at(-1).host, 'local');
});
