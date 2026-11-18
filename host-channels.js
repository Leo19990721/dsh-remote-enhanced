import { openHostStream } from './federated-terminal.js';
import { connectionIssue } from './federated-connection.js';

// One held Remote callback owns one encrypted carrier. Keeping it pending
// lets independent consumers share that carrier without selecting the UI Host.
export class HostChannels {
  constructor(runtime, { connectTimeoutMs = 45000, healthIntervalMs = 20000, healthTimeoutMs = 8000, terminalAdapter, terminalWatchIntervalMs } = {}) {
    this.runtime = runtime; this.acquire = runtime.withToolRemote.bind(runtime); this.entries = new Map(); this.closed = false;
    Object.assign(this, { connectTimeoutMs, healthIntervalMs, healthTimeoutMs, terminalAdapter, terminalWatchIntervalMs });
    this.lastFailures = new Map();
  }
  diagnostics() {
    return { entries: [...this.entries.values()].map(entry => ({ hostId: entry.hostId, state: entry.stop.signal.aborted ? 'disconnected' : entry.gateway ? 'connected' : 'connecting', references: entry.references, ageMs: Date.now() - entry.createdAt, lastHealthAt: entry.lastHealthAt || null })), failures: [...this.lastFailures].map(([hostId, value]) => ({ hostId, at: value.at, code: typeof value.code === 'string' && /^[A-Za-z0-9_.:/-]{1,100}$/.test(value.code) ? value.code : 'CONNECT_FAILED', issue: connectionIssue(value) })) };
  }
  async watchHealth(entry) {
    if (!entry.remote?.client?.rpc) return;
    while (!entry.stop.signal.aborted) {
      await waitDelay(this.healthIntervalMs, entry.stop.signal);
      if (entry.stop.signal.aborted) return;
      const deadline = AbortSignal.timeout(this.healthTimeoutMs), active = AbortSignal.any([deadline, entry.stop.signal]);
      try {
        await waitFor(entry.remote.client.rpc('harness.transport.describe', {}, active), active);
        entry.lastHealthAt = Date.now();
      } catch (error) {
        if (!entry.stop.signal.aborted) {
          this.lastFailures.set(entry.hostId, { at: Date.now(), code: error?.code || (deadline.aborted ? 'HEALTH_TIMEOUT' : 'TRANSPORT_FAILED') });
          entry.stop.abort(error); entry.hold.resolve();
        }
        return;
      }
    }
  }

  // Remote 0.6.5 permits one Control connection per identity. Its ordinary
  // read tools must borrow this pool instead of replacing a live session link.
  shareTools() {
    const runtime = this.runtime, original = runtime.withToolRemote, pool = this;
    async function shared(hostId, signal, query) {
      const lease = await pool.retain(hostId, signal);
      try { return await lease.query(query, signal); } finally { await lease.release(); }
    }
    runtime.withToolRemote = shared;
    return () => { if (runtime.withToolRemote === shared) runtime.withToolRemote = original; };
  }

  async retain(hostId, signal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Host channels disposed');
    if (typeof hostId !== 'string' || !hostId || hostId === 'local') throw new Error('Remote Host identity required');
    let entry = this.entries.get(hostId);
    if (entry?.stop.signal.aborted) {
      await waitFor(entry.finished, signal);
      signal?.throwIfAborted();
      return this.retain(hostId, signal);
    }
    if (!entry) {
      const ready = Promise.withResolvers();
      const hold = Promise.withResolvers();
      entry = { hostId, stop: new AbortController(), references: 0, ready: ready.promise, hold, finished: undefined, gateway: undefined, signal: undefined, createdAt: Date.now() };
      this.entries.set(hostId, entry);
      const connectTimer = setTimeout(() => {
        if (entry.gateway || entry.stop.signal.aborted) return;
        const error = Object.assign(new Error('Remote connection did not become ready in time'), { code: 'CONNECT_TIMEOUT' });
        this.lastFailures.set(hostId, { at: Date.now(), code: error.code });
        ready.reject(error); entry.stop.abort(error); hold.resolve();
      }, this.connectTimeoutMs); connectTimer.unref?.();
      entry.finished = Promise.resolve().then(() => this.acquire(hostId, entry.stop.signal, async (remote, active) => {
        if (!remote.features.remoteGateway) throw new Error('Harness Gateway unavailable');
        entry.remote = remote;
        entry.gateway = this.runtime.remoteTypertGateway(remote);
        // This independent channel has no global Remote selection to trigger
        // recovery. Surface transport loss to this Host's consumers immediately.
        entry.gateway.deferStreamDisconnect = false;
        entry.signal = active;
        const disconnected = remote.client?.onClose?.(error => {
          entry.stop.abort(error || new Error('Remote Host disconnected')); hold.resolve();
        });
        const ended = () => { entry.stop.abort(active.reason || new Error('Remote authorization ended')); hold.resolve(); };
        active.addEventListener('abort', ended, { once: true });
        if (active.aborted) ended();
        clearTimeout(connectTimer);
        this.lastFailures.delete(hostId);
        ready.resolve();
        const health = this.watchHealth(entry);
        try { await hold.promise; } finally { entry.stop.abort(); await health; active.removeEventListener('abort', ended); disconnected?.(); }
      })).catch(error => {
        this.lastFailures.set(hostId, { at: Date.now(), code: error?.code || 'CONNECT_FAILED' });
        ready.reject(error); entry.stop.abort(error);
      }).finally(() => {
        clearTimeout(connectTimer);
        entry.stop.abort(new Error('Remote Host channel ended'));
        if (this.entries.get(hostId) === entry) this.entries.delete(hostId);
      });
    }
    entry.references += 1;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', aborted);
      entry.references -= 1;
      if (entry.references === 0) {
        entry.hold.resolve();
        entry.stop.abort(new Error('Remote Host channel released'));
        await entry.finished;
      }
    };
    const aborted = () => { void release(); };
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      await waitFor(entry.ready, AbortSignal.any([entry.stop.signal, ...signal ? [signal] : []]));
      signal?.throwIfAborted();
      entry.stop.signal.throwIfAborted();
      if (released) throw new Error('Remote Host reference released');
      const active = operationSignal => {
        if (released || this.closed) throw new Error('Remote Host reference released');
        this.runtime.assertHostAuthorizationForDeviceDiscovery?.();
        const combined = AbortSignal.any([entry.stop.signal, entry.signal, ...[signal, operationSignal].filter(Boolean)]);
        combined.throwIfAborted();
        return combined;
      };
      const streamOptions = { terminalAdapter: this.terminalAdapter, terminalWatchIntervalMs: this.terminalWatchIntervalMs };
      return {
        query: async (operation, operationSignal) => {
          const current = active(operationSignal);
          const result = await operation(entry.remote, current);
          active(operationSignal); return result;
        },
        call: async (endpoint, payload, operationSignal) => entry.gateway.dispatch(endpoint, payload, active(operationSignal)),
        open: (endpoint, payload, operationSignal, uplink) => ({
          async *[Symbol.asyncIterator]() {
            const stop = new AbortController();
            const streamSignal = AbortSignal.any([active(operationSignal), stop.signal]);
            let iterator;
            try {
              const source = await openHostStream(entry.gateway, endpoint, payload, streamSignal, uplink, streamOptions);
              iterator = source[Symbol.asyncIterator]();
              for (;;) {
                const next = await iterator.next();
                if (streamSignal.aborted) {
                   if (!signal?.aborted && !operationSignal?.aborted && !stop.signal.aborted) throw entry.stop.signal.reason || new Error('Remote Host disconnected');
                   return;
                 }
                 if (next.done) return;
                yield next.value;
              }
            } finally {
              stop.abort();
              await iterator?.return?.();
            }
          },
        }),
        release,
      };
    } catch (error) { await release(); throw error; }
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.entries.values()]; this.entries.clear();
    for (const entry of entries) { entry.hold.resolve(); entry.stop.abort(new Error('Host channels disposed')); }
    await Promise.all(entries.map(entry => entry.finished));
  }
}

async function waitDelay(ms, signal) {
  if (signal.aborted) return;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); timer.unref?.(); signal.addEventListener('abort', done, { once: true });
  });
}
async function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort;
  const interrupted = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([promise, interrupted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
