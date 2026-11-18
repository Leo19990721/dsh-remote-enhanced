import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { request } from 'node:http';
import { once } from 'node:events';
import { LoopbackPreview } from '../federated-preview-transport.js';
function get(url, headers = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port: parsed.port, path: parsed.pathname + parsed.search, headers: { host: parsed.host, ...headers } }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  }); req.on('error', reject); req.end(); });
}
test('preview HTTP assets, redirects and WebSocket keep isolated origin and dispose all sockets', { timeout: 5000 }, async () => {
  const calls = [], requests = new Map(), pending = new Map();
  const client = { async rpc(method, value, signal) {
    calls.push([method, value]);
    if (value.op === 'describe') return { ports: [41788] };
    if (value.op === 'http.open') { requests.set(value.id, value); return { status: value.path === '/redirect' ? 302 : 200, headers: value.path === '/redirect' ? [['location', 'http://127.0.0.1:41788/map?q=1']] : [['content-type', 'text/plain']] }; }
    if (value.op === 'http.read') return { data: Buffer.from(requests.get(value.id).path).toString('base64'), done: true };
    if (value.op === 'ws.open') return { protocol: '' };
    if (value.op === 'ws.send') { pending.get(value.id)?.({ messages: [{ data: value.data, binary: value.binary }], closed: false }); return {}; }
    if (value.op === 'ws.read') return new Promise((resolve, reject) => { pending.set(value.id, resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    if (value.op === 'close') { pending.get(value.id)?.({ messages: [], closed: true }); pending.delete(value.id); return {}; }
  } };
  const preview = new LoopbackPreview(client, WebSocketServer);
  let socket;
  try {
    const { url } = await preview.open(41788), parsed = new URL(url);
    assert.equal((await get(new URL('/map/assets/style.css?q=1', url))).text, '/map/assets/style.css?q=1');
    assert.equal((await get(url, { host: 'evil.localhost' })).status, 403);
    assert.equal((await get(url, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await get(url, { 'service-worker': 'script' })).status, 403);
    const redirect = await get(new URL('/redirect', url)); assert.equal(redirect.headers.location, parsed.origin + '/map?q=1');
    socket = new WebSocket(`ws://127.0.0.1:${parsed.port}/live`, { headers: { host: parsed.host, origin: parsed.origin } });
    await once(socket, 'open');
    const response = once(socket, 'message'); socket.send('synthetic-live'); assert.equal(String((await response)[0]), 'synthetic-live');
    assert.ok(calls.some(([, value]) => value.op === 'ws.open' && value.port === 41788));
  } finally { socket?.terminate(); await preview.close(); }
  assert.equal(preview.servers.size, 0); assert.equal(preview.sockets.size, 0);
});

test('preview records a safe failure stage and transferred bytes when upstream truncates', { timeout: 5000 }, async () => {
  const failures = []; let reads = 0;
  const client = { async rpc(_method, value) {
    if (value.op === 'describe') return { ports: [41788] };
    if (value.op === 'http.open') return { status: 200, headers: [['content-type', 'text/html']] };
    if (value.op === 'http.read') {
      if (!reads++) return { data: Buffer.from('synthetic').toString('base64'), done: false };
      throw Object.assign(new Error('private upstream body or path'), { code: 'LOOPBACK_READ_FAILED' });
    }
    return {};
  } };
  const preview = new LoopbackPreview(client, WebSocketServer, { onFailure: value => failures.push(value) });
  try {
    const { url } = await preview.open(41788);
    await assert.rejects(new Promise((resolve, reject) => {
      const parsed = new URL(url), req = request({ hostname: '127.0.0.1', port: parsed.port, headers: { host: parsed.host } }, res => {
        res.resume(); res.on('end', resolve); res.on('error', reject);
      }); req.on('error', reject); req.end();
    }));
    assert.equal(failures.length, 1); assert.equal(failures[0].phase, 'http.read');
    assert.equal(failures[0].code, 'LOOPBACK_READ_FAILED'); assert.equal(failures[0].bytes, 9);
    assert.doesNotMatch(JSON.stringify(failures), /private|upstream body|path|dsh-/);
  } finally { await preview.close(); }
});

test('unavailable authorized service gives a precise startup hint without claiming Host offline', { timeout: 5000 }, async () => {
  let attempts = 0;
  const preview = new LoopbackPreview({ async rpc(_method, value) {
    if (value.op === 'describe') return { ports: [41788] };
    if (value.op === 'http.open') { attempts++; throw Object.assign(new Error('private low-level network error'), { code: 'LOOPBACK_UNAVAILABLE' }); }
    return {};
  } }, WebSocketServer);
  try {
    const { url } = await preview.open(41788), result = await get(url);
    assert.equal(result.status, 502); assert.match(result.text, /41788/); assert.match(result.text, /启动/);
    assert.doesNotMatch(result.text, /离线|在线|private|low-level/); assert.equal(attempts, 1);
  } finally { await preview.close(); }
});

test('same-origin JSON posts preserve app authorization and never replay a rejected action', { timeout: 5000 }, async () => {
  const requests = new Map(); let currentKey = 'synthetic-key-one', posts = 0;
  const client = { async rpc(_method, value) {
    if (value.op === 'describe') return { ports: [41788] };
    if (value.op === 'http.open') {
      const headers = Object.fromEntries(value.headers), post = value.method === 'POST';
      if (post) {
        posts++;
        assert.equal(value.path, '/open');
        assert.equal(headers.origin, 'http://127.0.0.1:41788');
        assert.equal(headers['content-type'], 'application/json');
        assert.equal(headers.referer, undefined);
        assert.equal(Buffer.from(value.body, 'base64').toString(), JSON.stringify({ path: 'synthetic.txt', kind: 'file' }));
      }
      const accepted = !post || headers['x-overview-key'] === currentKey;
      requests.set(value.id, post ? accepted ? 'accepted' : 'reopen page' : currentKey);
      return { status: accepted ? 200 : 403, headers: [['content-type', 'text/plain'], ['cache-control', 'no-store']] };
    }
    if (value.op === 'http.read') return { data: Buffer.from(requests.get(value.id)).toString('base64'), done: true };
    if (value.op === 'close') { requests.delete(value.id); return {}; }
  } };
  const preview = new LoopbackPreview(client, WebSocketServer);
  try {
    const { url } = await preview.open(41788), parsed = new URL(url);
    const oldPage = await get(url);
    const post = key => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: parsed.port, path: '/open', method: 'POST', headers: {
        host: parsed.host, origin: parsed.origin, referer: url, 'content-type': 'application/json', 'x-overview-key': key,
      } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
      }); req.on('error', reject); req.end(JSON.stringify({ path: 'synthetic.txt', kind: 'file' }));
    });
    assert.deepEqual(await post(oldPage.text), { status: 200, text: 'accepted' });
    currentKey = 'synthetic-key-two'; // A service restart invalidates an already-open page.
    assert.deepEqual(await post(oldPage.text), { status: 403, text: 'reopen page' });
    assert.equal(posts, 2, 'the proxy must not fetch a new credential and replay the action');
    const freshPage = await get(url);
    assert.deepEqual(await post(freshPage.text), { status: 200, text: 'accepted' });
    assert.equal(posts, 3);
  } finally { await preview.close(); }
  assert.equal(requests.size, 0);
});

test('opted-in map file requests never reach remote open and only return a pending notice', { timeout: 5000 }, async () => {
  const calls = [], proposals = [];
  const preview = new LoopbackPreview({ async rpc(_method, value) {
    calls.push(value);
    if (value.op === 'describe') return { ports: [41788] };
    if (value.op === 'http.open') return { status: 200, headers: [['content-type', 'text/plain']] };
    if (value.op === 'http.read') return { data: Buffer.from('ordinary app response').toString('base64'), done: true };
    return {};
  } }, WebSocketServer, { onFileRequest: value => { proposals.push(value); return { status: 409, error: 'Confirm in DSH' }; } });
  try {
    const { url } = await preview.open(41788), parsed = new URL(url);
    const post = (body, headers = {}, method = 'POST') => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: parsed.port, path: '/open', method, headers: {
        host: parsed.host, origin: parsed.origin, 'content-type': 'application/json', ...headers,
      } }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text })); });
      req.on('error', reject); req.end(body);
    });
    const value = { path: 'D:\\Synthetic\\a.pdf', kind: 'file' };
    assert.deepEqual(await post(JSON.stringify(value)), { status: 409, text: JSON.stringify({ error: 'Confirm in DSH' }) });
    assert.deepEqual(proposals, [value]);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify(value), { 'content-type': 'text/plain' })).status, 403);
    assert.equal((await post(JSON.stringify(value), { origin: '' })).status, 403);
    assert.equal((await post('', {}, 'GET')).status, 403);
    assert.equal((await post('x'.repeat(8193))).status, 413);
    assert.equal(calls.filter(value => value.op === 'http.open').length, 0);
    assert.equal((await get(new URL('/assets/app.js', url))).text, 'ordinary app response');
    assert.equal(calls.filter(value => value.op === 'http.open').length, 1);
  } finally { await preview.close(); }
});

test('closing an active preview releases the remote WebSocket handle immediately', { timeout: 5000 }, async () => {
  const handles = new Set(), closes = [];
  const client = { async rpc(_method, value, signal) {
    if (value.op === 'describe') return { ports: [41788] };
    if (value.op === 'ws.open') { handles.add(value.id); return { protocol: '' }; }
    if (value.op === 'ws.read') return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
    if (value.op === 'close') { closes.push(value.id); handles.delete(value.id); return {}; }
  } };
  const preview = new LoopbackPreview(client, WebSocketServer); let socket;
  try {
    const { url } = await preview.open(41788), parsed = new URL(url);
    socket = new WebSocket(`ws://127.0.0.1:${parsed.port}/live`, { headers: { host: parsed.host, origin: parsed.origin } });
    await once(socket, 'open'); assert.equal(handles.size, 1);
    await preview.close();
    assert.equal(handles.size, 0, 'remote handle must be closed rather than left for the Host idle timer');
    assert.equal(closes.length, 1);
  } finally { socket?.terminate(); await preview.close(); }
});
