import test from 'node:test';
import assert from 'node:assert/strict';
import { registerChildControl, stopRemoteChild } from '../federated-child-control.js';

test('remote child stop resolves only subagent ancestry and submits one native command on the ordinary root', async () => {
  const calls = [], signal = new AbortController().signal;
  const channel = { async call(endpoint, payload) {
    calls.push([endpoint, payload]);
    if (endpoint === 'session/list') return { ok: true, value: { items: [{ sessionId: 'root', parentSessionId: 'fork-source' }, { sessionId: 'child', parentSessionId: 'root', origin: 'subagent' }, { sessionId: 'grand', parentSessionId: 'child', origin: 'subagent' }] } };
    return { ok: true, value: { result: { kind: 'success' } } };
  } };
  assert.deepEqual(await stopRemoteChild(channel, 'grand', signal), { ok: true, value: { accepted: true } });
  assert.deepEqual(calls.at(-1), ['commands/execute', { args: { agentId: 'root', line: '/remote-stop-child grand', submittedAttachments: [] } }]);
  assert.equal(calls.some(([endpoint]) => endpoint === 'session/cancel' || endpoint.includes('interruptByParent')), false);
});

test('remote child stop rejects missing/cyclic ancestry and an absent Host command', async () => {
  const signal = new AbortController().signal;
  for (const items of [[{ sessionId: 'child', origin: 'subagent', parentSessionId: 'absent' }], [{ sessionId: 'child', origin: 'subagent', parentSessionId: 'child' }]]) {
    await assert.rejects(stopRemoteChild({ call: async () => ({ ok: true, value: { items } }) }, 'child', signal), /ROOT_UNAVAILABLE|INVALID_SUBAGENT_ANCESTRY/);
  }
  const channel = { call: async endpoint => ({ ok: true, value: endpoint === 'session/list' ? { items: [{ sessionId: 'root' }, { sessionId: 'child', origin: 'subagent', parentSessionId: 'root' }] } : undefined }) };
  assert.equal((await stopRemoteChild(channel, 'child', signal)).error.code, 'session-hosts/child-stop-unavailable');
});

test('Host command uses exact ancestor authority, refuses unrelated targets and honors late cancellation', async () => {
  let command; const calls = [], stop = new AbortController(), agent = { id: 'root' };
  const subagents = { listDescendants: async () => [{ kind: 'child', id: 'child' }], interrupt: (...args) => calls.push(args) };
  registerChildControl({ get: key => key === 'commands' ? { register: value => { command = value; } } : subagents });
  assert.equal((await command.handler({ agent, rawInput: ' child ', signal: stop.signal })).kind, 'success');
  assert.deepEqual(calls, [['child', { kind: 'ancestor', agent }]]);
  assert.equal((await command.handler({ agent, rawInput: 'unrelated', signal: stop.signal })).kind, 'error');
  subagents.listDescendants = async () => { stop.abort(); return [{ kind: 'child', id: 'child' }]; };
  await assert.rejects(command.handler({ agent, rawInput: 'child', signal: stop.signal }), /abort/i);
  assert.equal(calls.length, 1);
});
