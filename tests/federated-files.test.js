import test from 'node:test';
import assert from 'node:assert/strict';
import { readRemoteFile, renderRemoteOffice } from '../federated-files.js';
const signal = new AbortController().signal;
function file(data, change = false) {
  let count = 0;
  return { hostId: 'pc', calls: [], async call(endpoint, payload) {
    this.calls.push([endpoint, payload]); count++;
    if (endpoint === 'workspaceFiles/stat') return { ok: true, value: { absolutePath: 'C:/same.docx', version: 'v1', bytes: data.length } };
    const { offset, length } = payload.args.options.range;
    return { ok: true, value: { absolutePath: 'C:/same.docx', version: change && count > 1 ? 'v2' : 'v1', bytes: data.length, offset, data: data.subarray(offset, offset + length), eof: offset + length >= data.length } };
  } };
}
test('full remote download consumes all bounded windows without truncation', async () => {
  const source = new Uint8Array(5 * 1024 * 1024 + 13).map((_, i) => i % 251), channel = file(source);
  const result = await readRemoteFile(channel, { workspaceFileScopeId: 's', path: 'same.docx' }, signal);
  assert.deepEqual(result.value.data, source); assert.equal(result.value.eof, true); assert.equal(channel.calls.length, 6);
});
test('ranged remote file reads preserve exact offset and EOF', async () => {
  const channel = file(new Uint8Array(30));
  const result = await readRemoteFile(channel, { options: { range: { offset: 8, length: 4 } } }, signal);
  assert.equal(result.value.offset, 8); assert.equal(result.value.data.length, 4); assert.equal(result.value.eof, false);
});
test('remote file change, overflow and cancellation never return partial success', async () => {
  await assert.rejects(readRemoteFile(file(new Uint8Array(2 * 1024 * 1024), true), {}, signal), { code: 'FILE_CHANGED' });
  await assert.rejects(readRemoteFile(file(new Uint8Array(200)), {}, signal, 100), { code: 'FILE_TOO_LARGE' });
  const stop = new AbortController(); stop.abort();
  await assert.rejects(readRemoteFile(file(new Uint8Array(5)), {}, stop.signal), { name: 'AbortError' });
});
test('missing and denied files keep their original Host failure', async () => {
  const failure = { ok: false, error: { code: 'WORKSPACE_PATH_DENIED', message: 'denied' } };
  assert.equal(await readRemoteFile({ call: async () => failure }, {}, signal), failure);
});
test('remote Office preview uses authorized source bytes and computer-specific identity', async () => {
  const channel = file(new Uint8Array([1, 2, 3]));
  let captured;
  const converter = { generation: 'local-kit', async convert(request, active) {
    captured = request; assert.deepEqual((await request.source.read(active, 100)).bytes, new Uint8Array([1, 2, 3]));
    return { pdf: new Uint8Array([37, 80, 68, 70]), missingFonts: ['fixture-font'], generation: this.generation };
  } };
  const result = await renderRemoteOffice(channel, { workspaceFileScopeId: 's', path: 'same.docx' }, signal, converter);
  assert.equal(result.value.generation, 'local-kit'); assert.equal(result.value.bytes, 4);
  assert.equal(result.value.absolutePath, 'C:/same.docx'); assert.ok(captured.source.key.includes('pc'));
  assert.ok(channel.calls.every(([endpoint]) => endpoint.startsWith('workspaceFiles/')));
});
