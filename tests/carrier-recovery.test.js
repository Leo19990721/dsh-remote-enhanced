import test from 'node:test';
import assert from 'node:assert/strict';
import { installSessionCarrier } from '../client-carrier.js';
import { carrierRegistry } from './carrier-fixture.js';

// Deterministic idle-view eviction, no real clock wait or user connection.
test('expired browser view reacquires once and preserves its original Host identity', { timeout: 1500 }, async () => {
  let current = 'view-1', attachments = 0; const calls = [];
  const original = async (_channel, method, payload) => {
    if (method === 'attach') { attachments++; return { ok: true, value: { viewId: current, baseHost: 'local' } }; }
    if (method === 'close') return { ok: true };
    calls.push([method, payload.viewId]);
    if (payload.viewId !== current) return { ok: false, error: { code: 'session-hosts/view-expired', message: 'VIEW_UNAVAILABLE', details: {} } };
    return { ok: true, value: { groups: [], failures: [] } };
  };
  const ctx = { typert: carrierRegistry(), connection: { rpc: { call: original } } };
  const carrier = await installSessionCarrier(ctx);
  try {
    current = 'view-2';
    const results = await Promise.all([
      ctx.connection.rpc.call('/api', 'session/list', { args: {} }),
      carrier.modelCatalog('s'),
    ]);
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    assert.equal(attachments, 2, 'one single-flight replacement attach');
    assert.equal(carrier.viewId, 'view-2'); assert.equal(carrier.baseHost, 'local');
    assert.ok(calls.some(([, id]) => id === 'view-2'));
  } finally { await carrier.dispose(); }
});

test('unacknowledged mutating calls are never replayed after transport failure', async () => {
  let attempts = 0;
  const original = async (_channel, method) => {
    if (method === 'attach') return { ok: true, value: { viewId: 'v', baseHost: 'local' } };
    if (method === 'close') return { ok: true };
    attempts++; throw new Error('connection lost after send');
  };
  const ctx = { typert: carrierRegistry(), connection: { rpc: { call: original } } }, carrier = await installSessionCarrier(ctx);
  try { await assert.rejects(ctx.connection.rpc.call('/api', 'session/prompt', { args: {} }), /connection lost/); assert.equal(attempts, 1); }
  finally { await carrier.dispose(); }
});
