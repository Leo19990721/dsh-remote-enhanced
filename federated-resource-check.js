import { randomUUID } from 'node:crypto';
import { FederatedGateway } from './federated-gateway.js';
import { loopbackTarget, SessionPreviews } from './federated-previews.js';
import { request } from 'node:http';

// Reusable, owner-only acceptance probe. Never returns filenames, source bytes,
// response bodies or header values; never changes ports, files or global target.
export async function checkSessionResources(options, input, signal, peer) {
  const gateway = new FederatedGateway({ ...options, baseHost: 'local' });
  gateway.owner(peer);
  if (typeof input.hostId !== 'string' || !input.hostId || typeof input.sessionId !== 'string' || !input.sessionId) throw new Error('Host and Session are required.');
  const id = gateway.identities.encode(input.hostId, 'session', input.sessionId);
  const output = { hostId: input.hostId, sessionId: input.sessionId };
  const failed = error => ({ ok: false, code: /^[A-Za-z0-9_./-]{1,100}$/.test(error?.code || '') ? error.code : 'UNAVAILABLE' });
  if (typeof input.path === 'string') {
    try {
      const list = await gateway.call('workspaceFiles/list', { args: { workspaceFileScopeId: id, path: input.path } }, signal, peer);
      if (list.ok) output.file = { ok: true, kind: 'directory', entries: list.value.entries.length, truncated: list.value.truncated };
      else {
        const file = await gateway.call('workspaceFiles/stat', { args: { workspaceFileScopeId: id, path: input.path } }, signal, peer);
        output.file = file.ok ? { ok: true, kind: 'file', bytes: file.value.bytes } : failed(file.error);
      }
    } catch (error) { signal.throwIfAborted(); output.file = failed(error); }
  }
  if (typeof input.url === 'string') {
    const target = loopbackTarget(input.url);
    if (!target || input.hostId === 'local') throw new Error('A remote localhost HTTP address is required.');
    let channel, requestId;
    try {
      channel = await gateway.channel(input.hostId, peer, signal);
      const call = payload => channel.query((remote, active) => remote.client.rpc('loopback.call', payload, active), signal);
      const policy = await call({ op: 'describe' });
      output.page = { port: target.port, allowed: policy.ports.includes(target.port) };
      if (output.page.allowed) {
        requestId = randomUUID();
        let result = await call({ op: 'http.open', id: requestId, port: target.port, path: target.url.pathname + target.url.search, method: 'HEAD', headers: [] });
        if ([404, 405, 501].includes(result.status)) {
          // Some local viewers only implement GET. Ask for response headers
          // without consuming or returning any of the page's private content.
          await call({ op: 'close', id: requestId }); requestId = randomUUID();
          result = await call({ op: 'http.open', id: requestId, port: target.port, path: target.url.pathname + target.url.search, method: 'GET', headers: [] });
          output.page.method = 'GET';
        }
        output.page = { ...output.page, ok: true, httpStatus: result.status };
      } else output.page = { ...output.page, ok: false, code: 'LOOPBACK_PORT_DENIED' };
    } catch (error) { signal.throwIfAborted(); output.page = { ...output.page, ...failed(error) }; }
    finally {
      if (requestId) await channel.query((remote, active) => remote.client.rpc('loopback.call', { op: 'close', id: requestId }, active), AbortSignal.timeout(3000)).catch(() => {});
      await channel?.release?.();
    }
    if (output.page?.allowed && options.createPreview) {
      const active = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      const transfer = { bytes: 0, chunks: 0 };
      const previews = new SessionPreviews(gateway, peer, client => options.createPreview({ rpc: async (method, payload, current) => {
        try {
          const value = await client.rpc(method, payload, current);
          if (payload.op === 'http.open') {
            const length = value.headers.find(([name]) => name.toLowerCase() === 'content-length')?.[1];
            if (/^\d+$/.test(length || '') && Number.isSafeInteger(Number(length))) transfer.expectedBytes = Number(length);
          }
          if (payload.op === 'http.read') { transfer.bytes += Buffer.byteLength(value.data, 'base64'); transfer.chunks++; }
          return value;
        } catch (error) { if (payload.op !== 'close') transfer.failureCode = failed(error).code; throw error; }
      } }), active);
      try {
        const forwarded = await previews.open(id, input.url, randomUUID(), active);
        const result = await previewResponse(forwarded.url, active);
        output.page.preview = { ok: true, ...result };
      } catch (error) { signal.throwIfAborted(); output.page.preview = { ...failed(error), transfer }; }
      finally { await previews.close(); }
    }
  }
  return output;
}
function previewResponse(value, signal) {
  const url = new URL(value);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: url.port, path: url.pathname + url.search,
      method: 'GET', headers: { host: url.host }, signal, agent: false }, response => {
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) response.destroy(Object.assign(new Error('Preview response limit'), { code: 'RESPONSE_TOO_LARGE' }));
      });
      response.on('end', () => resolve({ method: 'GET', httpStatus: response.statusCode, bytes, complete: response.complete }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}
