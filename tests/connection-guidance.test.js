import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionIssue, hostConnectionError, retryableHostError } from '../federated-connection.js';
import { FederatedGateway } from '../federated-gateway.js';

test('connection failures return fixed Host-specific guidance without upstream details', () => {
  for (const [code, reason, retryable] of [['RATE_LIMITED', 'rateLimited', true], ['CONNECTION_FAILED', 'connectionFailed', true], ['HOST_OFFLINE', 'hostOffline', true], ['CONNECT_TIMEOUT', 'connectionTimeout', true], ['AUTHORIZATION_REVOKED', 'authorizationRequired', false], ['gateway/forbidden', 'authorizationRequired', false], ['gateway/cancelled', 'connectionInterrupted', true]]) {
    const error = Object.assign(new Error('SECRET upstream token /user/private'), { code, details: { secret: 'SECRET' } });
    const issue = connectionIssue(error);
    assert.equal(issue.reason, reason); assert.equal(issue.retryable, retryable);
    const friendly = hostConnectionError(error, 'pc', 'Remote-PC');
    assert.match(friendly.message, /Remote-PC/); assert.equal(friendly.code, code);
    assert.equal(friendly.details.hostId, 'pc'); assert.equal(friendly.details.reason, reason);
    assert.doesNotMatch(JSON.stringify(friendly), /SECRET|private|token/);
    assert.equal(retryableHostError(error), retryable);
  }
  assert.equal(connectionIssue({ code: 'HTTP_ERROR', status: 503 }).reason, 'serviceUnavailable');
  const file = Object.assign(new Error('file not found'), { code: 'workspace-file/not-found' });
  assert.equal(hostConnectionError(file, 'pc'), file);
});

test('remote gateway soft cancellation reconnects its workspace feed without replaying calls', { timeout: 1800 }, async () => {
  const stop = new AbortController(), peer = { principal: { kind: 'owner' }, signal: stop.signal };
  let opens = 0, calls = 0, releases = 0;
  const gateway = new FederatedGateway({ baseHost: 'local', hosts: async () => [], descriptor: () => ({}), local: () => ({}), channels: { async retain() { return {
    call: async () => { calls++; throw new Error('Writes must not be retried'); },
    open() { return (async function* () { if (++opens === 1) throw Object.assign(new Error('SECRET'), { code: 'gateway/cancelled', isDSHRemoteError: true }); yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }; })(); },
    release: async () => { releases++; },
  }; } } });
  const stream = gateway.openHost({ hostId: 'pc', name: 'Remote-PC' }, 'workspace/follow', { args: {} }, stop.signal, peer);
  try { assert.equal((await stream.next()).value.type, 'baseline'); assert.equal(opens, 2); assert.equal(calls, 0); assert.equal(releases, 1); }
  finally { stop.abort(); await stream.return(); }
});
