import { StreamInput } from './federated-input.js';

// Plugin-owned owner-authenticated multiplexed socket. All native Session
// streams share it; a logical cancellation never closes its sibling streams.
export function registerSessionMux(ctx, options, viewOf, lifetime) {
  const server = new options.WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const sockets = new Set(), tasks = new Set();
  const route = { path: '/dsh-session-hosts/mux', handler(request, socket, head) {
    const admission = ctx.connection.admit(request);
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const peer = admission.peer;
    let view;
    try { view = viewOf(new URL(request.url, 'http://dsh.internal').searchParams.get('viewId'), peer); }
    catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    server.handleUpgrade(request, socket, head, websocket => {
      sockets.add(websocket); view.sockets = (view.sockets || 0) + 1;
      const stop = new AbortController(), streams = new Map();
      const signal = AbortSignal.any([stop.signal, peer.signal, lifetime, view.stop.signal]);
      const terminate = () => websocket.terminate(); signal.addEventListener('abort', terminate, { once: true });
      const heartbeat = setInterval(() => {
        if (websocket.waiting) { websocket.terminate(); return; }
        websocket.waiting = true; websocket.ping();
      }, 15000); heartbeat.unref();
      websocket.on('pong', () => { websocket.waiting = false; });
      websocket.on('error', terminate);
      websocket.once('close', () => {
        clearInterval(heartbeat); signal.removeEventListener('abort', terminate);
        sockets.delete(websocket); view.sockets--; view.touched = Date.now(); stop.abort();
      });
      websocket.on('message', (bytes, binary) => {
        let frame;
        try {
          if (binary) throw new Error('Text frames required');
          frame = JSON.parse(bytes.toString());
          if (typeof frame.streamId !== 'string' || !frame.streamId || !['open', 'cancel', 'input', 'inputEnd'].includes(frame.type)) throw new Error('Invalid stream frame');
          if (frame.type === 'cancel') { streams.get(frame.streamId)?.control.abort(); return; }
          if (frame.type === 'input' || frame.type === 'inputEnd') {
            const entry = streams.get(frame.streamId);
            if (!entry) return; // Cancellation may overtake the last input frame.
            try {
              if (!entry.input) throw new Error('STREAM_INPUT_UNAVAILABLE');
              if (frame.type === 'inputEnd') entry.input.end(); else entry.input.push(frame.value);
            } catch (error) {
              entry.control.abort(error); entry.input?.close();
              void write(websocket, { type: 'error', streamId: frame.streamId, error: { code: 'session-hosts/input-rejected', message: error.message, details: {} } }, signal).catch(() => {});
            }
            return;
          }
          if (streams.has(frame.streamId) || typeof frame.endpoint !== 'string') throw new Error('Invalid stream open');
        } catch { websocket.close(1008, 'Invalid Session stream'); return; }
        const control = new AbortController(), active = AbortSignal.any([signal, control.signal]);
        const input = options.descriptor(frame.endpoint)?.uplink ? new StreamInput({ consumed: () => {
          if (!active.aborted) void write(websocket, { type: 'inputAccepted', streamId: frame.streamId }, active).catch(() => control.abort());
        } }) : undefined;
        active.addEventListener('abort', () => input?.close(), { once: true });
        streams.set(frame.streamId, { control, input });
        const task = (async () => {
          try {
            for await (const value of frame.endpoint === '$previewFiles' ? view.previews.fileActions(frame.payload?.leaseId, active) : view.gateway.open(frame.endpoint, frame.payload, active, peer, input)) await write(websocket, { type: 'item', streamId: frame.streamId, value }, active);
            if (!active.aborted) await write(websocket, { type: 'end', streamId: frame.streamId }, active);
          } catch (error) {
            if (!active.aborted && websocket.readyState === 1) await write(websocket, { type: 'error', streamId: frame.streamId, error: { code: error.code || 'session-hosts/unavailable', message: String(error.message || 'Session connection unavailable'), details: error.details || {} } }, active).catch(() => {});
          } finally { streams.delete(frame.streamId); control.abort(); }
        })();
        tasks.add(task); void task.finally(() => tasks.delete(task));
      });
    });
  } };
  return ctx.effect(function* () {
    yield async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled(tasks);
    };
    yield ctx.webServer.registerUpgrade(route);
  }, 'remote-workspaces: multiplexed native Session streams');
}
async function write(socket, frame, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => socket.send(JSON.stringify(frame), error => error ? reject(error) : resolve()));
  signal.throwIfAborted();
}
