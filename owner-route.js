// Connection.rpc.handle in DSH 0.2.2-rc.3 captures the provider's context,
// which has no webServer injection. Own the WebRoute in this plugin's context
// and keep Connection's unchanged authentication/Host fence and owner check.
export function registerOwnerRoute(ctx, channel, operate) {
  const connection = ctx.connection;
  const route = {
    kind: 'prefix', path: channel,
    async handler(request, response) {
      const admission = connection.admit(request);
      if ('rejection' in admission) {
        response.writeHead(admission.rejection); response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return;
      }
      if (admission.peer.principal.kind !== 'owner') { response.writeHead(403); response.end('forbidden'); return; }
      const endpoint = new URL(request.url || '/', 'http://dsh.internal').pathname.slice(channel.length + 1);
      if (request.method !== 'POST' || !['snapshot', 'hosts', 'status', 'workspaces', 'sessions', 'select', 'diagnostics', 'selfCheck', 'resourceCheck'].includes(endpoint)) { response.writeHead(404); response.end('not found'); return; }
      if (String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') { response.writeHead(415); response.end('application/json required'); return; }
      let message;
      try {
        let length = 0; const chunks = [];
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.length;
          if (length > 16384) { response.writeHead(413); response.end('request too large'); return; }
          chunks.push(bytes);
        }
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { response.writeHead(400); response.end('invalid JSON'); return; }
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) { response.writeHead(400); response.end('invalid RPC envelope'); return; }
      const stop = new AbortController();
      const closed = () => { if (!response.writableEnded) stop.abort(); };
      response.once('close', closed);
      let result;
      try { result = await operate(endpoint, message.payload, stop.signal, admission.peer); }
      finally { response.removeListener('close', closed); }
      if (stop.signal.aborted || response.destroyed) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }));
    },
  };
  return ctx.effect(() => ctx.webServer.register(route), 'remote-workspaces: owner RPC route');
}
