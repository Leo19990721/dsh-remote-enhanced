// One authenticated socket carries every independently cancellable logical
// stream. Separate long-lived HTTP fetches would exhaust Chromium's per-origin
// connection pool and block ordinary Session commands.
export class SessionStreams {
  constructor(openSocket, viewId) { this.openSocket = openSocket; this.viewId = viewId; this.streams = new Map(); this.closed = false; }
  connect(signal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Session carrier disposed');
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket);
    if (!this.connecting) {
      const socket = this.openSocket('/dsh-session-hosts/mux?viewId=' + encodeURIComponent(this.viewId));
      this.socket = socket;
      this.connecting = new Promise((resolve, reject) => {
        const failed = () => {
          const error = carrierError('Session connection closed');
          if (this.socket === socket) {
            this.socket = undefined; this.connecting = undefined;
            for (const stream of this.streams.values()) stream.fail(error);
          }
          reject(error);
        };
        socket.addEventListener('open', () => resolve(socket), { once: true });
        socket.addEventListener('close', failed, { once: true });
        socket.addEventListener('error', failed, { once: true });
        socket.addEventListener('message', event => {
          try {
            const frame = JSON.parse(event.data), stream = this.streams.get(frame.streamId);
            if (!stream) return;
            if (frame.type === 'item') stream.push(frame.value);
            else if (frame.type === 'inputAccepted') stream.inputAccepted?.();
            else if (frame.type === 'end') stream.end();
            else if (frame.type === 'error') stream.fail(Object.assign(new Error(frame.error.message), frame.error, { isDSHRemoteError: true }));
            else throw new Error('Invalid Session stream frame');
          } catch { socket.close(4002, 'Invalid stream frame'); }
        });
      });
      void this.connecting.catch(() => {});
    }
    return waitForSignal(this.connecting, signal);
  }
  open(endpoint, payload, signal, uplink) {
    const owner = this;
    return { async *[Symbol.asyncIterator]() {
      const id = crypto.randomUUID(), inbox = new StreamInbox(), inputStop = new AbortController();
      let socket, ended = false, input, credit;
      const abort = () => { inbox.fail(signal.reason); inputStop.abort(); credit?.(); };
      signal.addEventListener('abort', abort, { once: true });
      inbox.inputAccepted = () => { credit?.(); credit = undefined; };
      owner.streams.set(id, inbox);
      try {
        socket = await owner.connect(signal); signal.throwIfAborted();
        socket.send(JSON.stringify({ type: 'open', streamId: id, endpoint, payload }));
        if (uplink) {
          input = uplink[Symbol.asyncIterator]();
          void (async () => {
            try {
              while (!inputStop.signal.aborted) {
                const next = await waitForSignal(input.next(), inputStop.signal);
                inputStop.signal.throwIfAborted();
                if (next.done) { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'inputEnd', streamId: id })); break; }
                const frame = JSON.stringify({ type: 'input', streamId: id, value: next.value });
                if (new TextEncoder().encode(frame).byteLength > 256 * 1024) throw new Error('Terminal input is too large');
                const accepted = new Promise(resolve => { credit = resolve; });
                socket.send(frame);
                await waitForSignal(accepted, inputStop.signal);
              }
            } catch (error) { if (!inputStop.signal.aborted) inbox.fail(error); }
          })();
        }
        for (;;) {
          const next = await inbox.next();
          if (next.done) { ended = true; return; }
          yield next.value;
        }
      } finally {
        inputStop.abort(); credit?.();
        void input?.return?.().catch(() => {});
        signal.removeEventListener('abort', abort); owner.streams.delete(id);
        if (!ended && socket?.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', streamId: id }));
      }
    } };
  }
  dispose() {
    this.closed = true;
    for (const stream of this.streams.values()) stream.fail(carrierError('Session carrier disposed'));
    this.streams.clear(); this.socket?.close(1000, 'View closed');
  }
}
class StreamInbox {
  constructor() { this.items = []; this.waiter = undefined; this.done = false; }
  push(value) { if (this.done) return; this.items.push(value); this.wake(); }
  end() { this.done = true; this.wake(); }
  fail(error) { this.error = error; this.end(); }
  wake() { this.waiter?.(); this.waiter = undefined; }
  async next() {
    while (!this.items.length && !this.done) await new Promise(resolve => { this.waiter = resolve; });
    if (this.error) throw this.error;
    if (this.items.length) return { value: this.items.shift(), done: false };
    return { done: true };
  }
}
function carrierError(message) { return Object.assign(new Error(message), { dshRemoteStreamFailure: { kind: 'carrier' } }); }
async function waitForSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted(); let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}
