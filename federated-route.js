import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { FederatedGateway } from './federated-gateway.js';
import { rpcResponse, projectBinary } from './rpc-binary.js';
import { uploadForSession } from './federated-uploads.js';
import { registerSessionMux } from './federated-mux.js';
import { SessionPreviews } from './federated-previews.js';
import { sessionMedia } from './federated-media.js';

export const FEDERATED_CHANNEL = '/dsh-session-hosts';

// A separate owner-authenticated channel. The native /api interceptor and
// Remote's global dispatcher remain unchanged. A view fixes the interpretation
// of pre-existing unqualified IDs for its whole lifetime.
export function registerFederatedRoute(ctx, options) {
  const views = new Map(), lifetime = new AbortController();
  const connection = ctx.connection;
  function viewOf(id, peer) {
    const view = views.get(id);
    if (!view || view.peer !== peer || view.stop.signal.aborted) throw Object.assign(new Error('VIEW_UNAVAILABLE'), { code: 'session-hosts/view-expired' });
    view.touched = Date.now();
    return view;
  }
  const route = { kind: 'prefix', path: FEDERATED_CHANNEL, async handler(request, response) {
    const admission = connection.admit(request);
    if ('rejection' in admission) { response.writeHead(admission.rejection); response.end(); return; }
    const peer = admission.peer;
    if (peer.principal.kind !== 'owner') { response.writeHead(403); response.end(); return; }
    const url = new URL(request.url, 'http://dsh.internal');
    const endpoint = url.pathname.slice(FEDERATED_CHANNEL.length + 1);
    if (endpoint === 'upload' && request.method === 'POST') {
      if (String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') { response.writeHead(415); response.end(); return; }
      const stop = new AbortController(), active = AbortSignal.any([stop.signal, peer.signal, lifetime.signal]);
      const closed = () => stop.abort(); response.once('close', closed);
      try {
        const view = viewOf(url.searchParams.get('viewId'), peer);
        const result = await uploadForSession(view.gateway, options.fileUploads, url.searchParams, request, AbortSignal.any([active, view.stop.signal]), peer);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result));
      } catch (error) {
        if (!active.aborted) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: failure(error) })); }
      } finally { response.removeListener('close', closed); }
      return;
    }
    if (endpoint === 'media' && request.method === 'GET') {
      const stop = new AbortController(), signal = AbortSignal.any([stop.signal, peer.signal, lifetime.signal]);
      const closed = () => stop.abort(); response.once('close', closed);
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer' };
      try {
        const view = viewOf(url.searchParams.get('viewId'), peer);
        const result = await sessionMedia(view.gateway, url.searchParams, AbortSignal.any([signal, view.stop.signal]), peer);
        if (!signal.aborted) { response.writeHead(result.status, { ...headers, 'Content-Type': result.type || 'text/plain; charset=utf-8' }); response.end(result.data || result.text); }
      } catch (error) {
        if (!signal.aborted) { response.writeHead(503, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); response.end('图片所在电脑不可用，请检查连接后重试。'); }
      } finally { response.removeListener('close', closed); }
      return;
    }
    if (request.method !== 'POST' || !['attach', 'ping', 'call', 'stream', 'close', 'modelCatalog', 'previewOpen', 'previewClose', 'previewFileClaim'].includes(endpoint)) { response.writeHead(404); response.end(); return; }
    if (String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') { response.writeHead(415); response.end(); return; }
    let message;
    try { message = await readMessage(request); }
    catch { response.writeHead(400); response.end(); return; }
    if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) { response.writeHead(400); response.end(); return; }
    const stop = new AbortController(), signal = AbortSignal.any([stop.signal, peer.signal, lifetime.signal]);
    const closed = () => { stop.abort(); };
    response.once('close', closed);
    try {
      const args = message.payload || {};
      let result;
      if (endpoint === 'attach') {
        const baseHost = typeof args.baseHost === 'string' && args.baseHost ? args.baseHost : options.baseHost();
        const viewId = randomUUID(), viewStop = new AbortController();
        const gateway = new FederatedGateway({ ...options, baseHost, lifetime: AbortSignal.any([viewStop.signal, peer.signal, lifetime.signal]) });
        const previews = options.createPreview ? new SessionPreviews(gateway, peer, options.createPreview, AbortSignal.any([viewStop.signal, peer.signal, lifetime.signal]), { filePreviewTargets: options.filePreviewTargets }) : undefined;
        views.set(viewId, { peer, gateway, previews, stop: viewStop, touched: Date.now(), sockets: 0 });
        result = { ok: true, value: { viewId, baseHost } };
      } else {
        const view = viewOf(args.viewId, peer);
        if (endpoint === 'close') { views.delete(args.viewId); view.stop.abort(); await view.previews?.close(); result = { ok: true }; }
        else if (endpoint === 'ping') result = { ok: true };
        else if (endpoint === 'previewOpen') {
          if (!view.previews || typeof args.sessionId !== 'string' || typeof args.url !== 'string') throw new Error('网页预览服务不可用。');
          result = { ok: true, value: await view.previews.open(args.sessionId, args.url, args.leaseId, AbortSignal.any([signal, view.stop.signal]), { fileMode: args.fileMode ?? false }) };
        }
        else if (endpoint === 'previewClose') { await view.previews?.release(args.leaseId); result = { ok: true }; }
        else if (endpoint === 'previewFileClaim') {
          if (!view.previews) throw new Error('网页文件预览不可用。');
          result = { ok: true, value: view.previews.claimFileAction(args.leaseId, args.actionId) };
        }
        else if (endpoint === 'modelCatalog') result = await view.gateway.modelCatalog(args.sessionId, AbortSignal.any([signal, view.stop.signal]), peer);
        else {
          if (typeof args.endpoint !== 'string' || !/^(\$events(?:\/result)?|\$hostStatus|\$previewFiles|[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_$.-]+)$/.test(args.endpoint)) throw new Error('ENDPOINT_REQUIRED');
          const active = AbortSignal.any([signal, view.stop.signal]);
          if (endpoint === 'call') {
            // Preserve the authenticated desktop submission only around dispatch to this Host.
            const dispatchLocal = (endpoint, next) => ctx.waterfall('session-hosts/local-call',
              { request, peer, endpoint, signal: active }, next);
            result = projectBinary(await view.gateway.call(args.endpoint, args.payload, active, peer, dispatchLocal), options.descriptor(args.endpoint));
          }
          else {
            if (options.descriptor(args.endpoint)?.uplink) throw new Error('DUPLEX_STREAM_UNAVAILABLE');
            response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            for await (const value of args.endpoint === '$previewFiles' ? view.previews.fileActions(args.payload?.leaseId, active) : view.gateway.open(args.endpoint, args.payload, active, peer)) {
              await send(response, { type: 'item', value }, active);
            }
            await send(response, { type: 'end' }, active); response.end(); return;
          }
        }
      }
      if (!signal.aborted) {
        const framed = rpcResponse(message.rpcId, result);
        response.writeHead(200, { 'Content-Type': framed.headers.get('content-type'), 'Cache-Control': 'no-store' });
        for await (const chunk of framed.body) if (!response.write(chunk)) await once(response, 'drain', { signal });
        response.end();
      }
    } catch (error) {
      if (signal.aborted || response.destroyed) return;
      const result = { ok: false, error: failure(error) };
      if (response.headersSent) { await send(response, { type: 'error', error: result.error }, signal); response.end(); }
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result })); }
    } finally { response.removeListener('close', closed); }
  } };
  ctx.effect(function* () {
    const sweep = setInterval(() => {
      for (const [id, view] of views) if (view.peer.signal.aborted || (!view.sockets && Date.now() - view.touched > 120000)) { views.delete(id); view.stop.abort(); }
    }, 30000); sweep.unref();
    yield () => { clearInterval(sweep); lifetime.abort(); for (const view of views.values()) view.stop.abort(); views.clear(); };
    yield ctx.webServer.register(route);
    if (options.WebSocketServer) yield registerSessionMux(ctx, options, viewOf, lifetime.signal);
  }, 'remote-workspaces: independent Session carrier');
  // Owner-only diagnostics expose arrival/counts, never identifiers or content
  // from individual Sessions. Read the actual view, not a separate tool catalog.
  return () => [...views.values()].filter(view => !view.stop.signal.aborted).map(view => ({
    sockets: view.sockets,
    hosts: [...new Set([...view.gateway.statuses.keys(), ...view.gateway.catalogs.keys(), ...view.gateway.catalogReads.keys(), ...view.gateway.catalogErrors.keys()])].filter(id => id !== 'local').map(hostId => ({
      hostId, eventReady: view.gateway.statuses.get(hostId) === true,
      catalogReady: view.gateway.catalogs.has(hostId), rows: view.gateway.catalogs.get(hostId)?.length || 0,
      reading: view.gateway.catalogReads.has(hostId), ...view.gateway.catalogErrors.get(hostId),
      workspaceRows: view.gateway.workspaceStates.get(hostId)?.items.length || 0,
      workspaceSessions: view.gateway.workspaceStates.get(hostId)?.items.reduce((total, row) => total + row.sessionIds.length, 0) || 0,
      streams: Object.fromEntries(view.gateway.streamStates.get(hostId) || []),
    })),
  }));
}
async function readMessage(request) {
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('REQUEST_TOO_LARGE'); chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function send(response, value, signal) {
  signal.throwIfAborted();
  if (!response.write(JSON.stringify(value) + '\n')) await once(response, 'drain', { signal });
}
function failure(error) {
  return { code: typeof error.code === 'string' ? error.code : 'session-hosts/unavailable', message: String(error.message || 'Session connection unavailable').slice(0, 500), details: error.details && typeof error.details === 'object' ? error.details : {} };
}
