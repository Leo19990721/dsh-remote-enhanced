// Installed Remote adapter in a separate fixture, on synthetic terminals only.
const assert = require('node:assert/strict');
(async () => {
  const { loadTerminalAdapter, openHostStream } = await import('../federated-terminal.js');
  const { StreamInput } = await import('../federated-input.js');
  assert.ok(process.env.DSH_REMOTE_FIXTURE_DIR, 'DSH_REMOTE_FIXTURE_DIR must point to an isolated fixture containing ds-harness-remote');
  const attach = await loadTerminalAdapter(process.env.DSH_REMOTE_FIXTURE_DIR);
  const stop = new AbortController(), input = new StreamInput(), writes = [];
  let followed;
  const target = {
    async open(endpoint, payload, signal) {
      assert.equal(endpoint, 'terminal/follow'); followed = payload.args;
      return (async function* () {
        yield { type: 'snapshot', sequence: 0, screen: '', info: { controllerId: followed.attachmentId } };
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      })();
    },
    async dispatch(endpoint, payload) { writes.push([endpoint, payload]); return { ok: true, value: { ok: true } }; },
  };
  const source = await openHostStream(target, 'terminal/attach', { args: { agentId: 'fixture-root', id: 'fixture-terminal' } }, stop.signal, input, { terminalAdapter: async () => attach });
  const iterator = source[Symbol.asyncIterator]();
  try {
    assert.equal((await iterator.next()).value.writable, true);
    input.push({ type: 'write', sequence: 1, data: 'typed-input', typed: true });
    assert.deepEqual((await iterator.next()).value, { type: 'ack', sequence: 1 });
    input.push({ type: 'resize', sequence: 2, cols: 100, rows: 35 });
    assert.deepEqual((await iterator.next()).value, { type: 'ack', sequence: 2 });
    assert.deepEqual(writes.map(([endpoint]) => endpoint), ['terminal/write', 'terminal/resize']);
    assert.equal(writes[0][1].args.attachmentId, followed.attachmentId);
    assert.equal(writes[0][1].args.data, 'typed-input');
  } finally { stop.abort(); input.close(); await iterator.return(); }
  assert.equal(writes.length, 2);
  console.log('PASS installed Remote terminal adapter: typed writes, ordered resize, ownership, no replay');
})().catch(error => { console.error(error); process.exitCode = 1; });
