import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthState, healthRows } from '../client-health.js';

test('self-check opens on demand, deduplicates clicks, handles retry and cancels on close', async () => {
  const pending = Promise.withResolvers(), calls = [];
  const store = createHealthState(async (args, signal) => { calls.push([args, signal]); return calls.length === 1 ? pending.promise : { local: { checks: [] }, hosts: [] }; });
  assert.equal(calls.length, 0); assert.equal(store.getSnapshot().open, false);
  const first = store.run(); const second = store.run();
  assert.equal(calls.length, 1); assert.equal(store.getSnapshot().busy, true);
  pending.reject(new Error('unavailable')); await Promise.all([first, second]);
  assert.equal(store.getSnapshot().error, true); assert.equal(store.getSnapshot().busy, false);
  await store.run({ hostId: 'pc' }); assert.equal(calls.length, 2); assert.deepEqual(calls[1][0], { hostId: 'pc' });
  await store.run(); assert.equal(calls.length, 3); assert.deepEqual(calls[2][0], { hostId: 'pc' });
  store.close(); assert.equal(store.getSnapshot().open, false); assert.equal(calls[2][1].aborted, true);
  store.dispose();
});
test('late self-check responses cannot reopen or overwrite a closed panel', async () => {
  const pending = Promise.withResolvers(), store = createHealthState(() => pending.promise);
  const running = store.run(); store.close(); pending.resolve({ hosts: [{ name: 'obsolete' }] }); await running;
  assert.deepEqual(store.getSnapshot(), { open: false, busy: false });
});
test('health presentation exposes each computer and actionable missing capabilities', () => {
  const report = { local: { checks: [{ id: 'remoteVersion', state: 'pass', actual: '0.6.5', expected: '0.6.5' }] }, hosts: [{ hostId: 'pc', name: 'Remote-PC', checks: [{ id: 'terminal', state: 'warn' }, { id: 'childStop', state: 'unknown' }, { id: 'connection', state: 'fail', issue: { reason: 'rateLimited' } }] }] };
  const rows = healthRows(report, (key, args) => key + (args ? JSON.stringify(args) : ''));
  assert.equal(rows.length, 4); assert.equal(rows[1].computer, 'Remote-PC');
  assert.match(rows[1].hint, /checkTerminalHint/); assert.match(rows[2].hint, /checkChildStopHint/); assert.match(rows[3].hint, /connectionRateLimited/);
});
