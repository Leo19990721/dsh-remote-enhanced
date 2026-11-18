import test from 'node:test';
import assert from 'node:assert/strict';
import { createFederatedRuntime } from '../federated-runtime.js';
import { FederatedGateway } from '../federated-gateway.js';

test('local native uplink survives runtime and federated owner routing unchanged', async () => {
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal }, uplink = { async *[Symbol.asyncIterator]() { yield { type: 'write', data: 'local', sequence: 1, typed: true }; } };
  let observed;
  const descriptor = { uplink: {}, parameters: [{ wire: 'agentId', source: 'lookup', lookup: 'agent' }] };
  const runtime = createFederatedRuntime({ dshRemoteClient: { withToolRemote: async () => {}, gatewaySwitch: { local(owner) { assert.equal(owner, peer); return { open(endpoint, payload, signal, input) { observed = { endpoint, payload, signal, input }; return input; } }; } } }, get: () => undefined, typert: { local: { get: () => descriptor }, remotes: { get() {} } } });
  const gateway = new FederatedGateway({ ...runtime, baseHost: 'local' });
  try {
    const values = await Array.fromAsync(gateway.open('terminal/attach', { args: { agentId: 'session-local', id: 't' } }, peer.signal, peer, uplink));
    assert.deepEqual(values, [{ type: 'write', data: 'local', sequence: 1, typed: true }]);
    assert.equal(observed.input, uplink); assert.equal(observed.payload.args.agentId, 'session-local');
  } finally { await runtime.dispose(); }
});
