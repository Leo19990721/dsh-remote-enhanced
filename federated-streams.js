// Small fan-in for independent domain streams. A remote failure ends only its
// own pump; local failure still reaches the native Connection recovery loop.
export class StreamQueue {
  constructor() { this.items = []; this.waiter = undefined; this.ended = false; this.error = undefined; }
  push(value) { if (this.ended) return; this.items.push(value); this.wake(); }
  wake() { this.waiter?.(); this.waiter = undefined; }
  end(error) { this.error = error; this.ended = true; this.wake(); }
  async *iterate(signal) {
    const abort = () => this.wake(); signal.addEventListener('abort', abort, { once: true });
    try {
      while (!signal.aborted) {
        if (this.items.length) { yield this.items.shift(); continue; }
        if (this.ended) { if (this.error) throw this.error; return; }
        await new Promise(resolve => { this.waiter = resolve; });
      }
    } finally { signal.removeEventListener('abort', abort); }
  }
}

export async function* combineBaselines(participants, endpoint, payload, signal, { map, merge, changed = () => {}, failed = () => {} }) {
  const stop = new AbortController(), active = AbortSignal.any([signal, stop.signal]);
  const queue = new StreamQueue(), states = new Map(), joined = [], tasks = []; let published = false;
  const current = () => joined.flatMap(host => states.has(host.hostId) ? [states.get(host.hostId)] : []);
  const pump = participant => (async () => {
    let iterator, opened = false;
    try {
      const source = participant.open(endpoint, payload, active);
      iterator = source[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        if (!opened && next.value?.type !== 'baseline') throw new Error('DOMAIN_BASELINE_REQUIRED');
        opened = true;
        const frame = map(participant, next.value);
        states.set(participant.hostId, reduceState(endpoint, states.get(participant.hostId), frame));
        changed(participant.hostId, states.get(participant.hostId));
        if (!published) {
          if (!states.has('local')) continue;
          published = true; queue.push({ type: 'baseline', value: merge(current()) });
        } else if (endpoint === 'workspace/follow') queue.push({ type: 'replace', value: merge(current()) });
        else if (frame.type === 'baseline') {
          for (const [sessionId, block] of Object.entries(frame.value.projections)) if (block.asOfSeq >= 0) queue.push({ type: 'projection', sessionId, seq: block.asOfSeq, changes: Object.entries(block.values).map(([key, val]) => ({ key, val })) });
        } else queue.push(frame);
      }
      if (!active.aborted) throw new Error('DOMAIN_STREAM_ENDED');
    } catch (error) {
      if (!active.aborted) {
        if (participant.hostId === 'local') queue.end(error);
        else failed(participant.hostId, error);
      }
    } finally { await iterator?.return?.(); await participant.release?.(); }
  })();
  const enroll = async () => {
    const source = typeof participants === 'function' ? participants(active) : participants;
    for await (const participant of source) {
      if (active.aborted) return;
      if (joined.some(host => host.hostId === participant.hostId)) continue;
      joined.push(participant); tasks.push(pump(participant));
    }
  };
  const discovery = enroll().catch(error => { if (!active.aborted) queue.end(error); });
  try { yield* queue.iterate(active); }
  finally { stop.abort(); queue.end(); await discovery; await Promise.allSettled(tasks); }
}

export function pause(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
  });
}

function reduceState(endpoint, previous, frame) {
  if (frame.type === 'baseline' || frame.type === 'replace') return frame.value;
  if (endpoint !== 'workspace/follow') return previous;
  switch (frame.type) {
    case 'upsert': return { ...previous, items: [...previous.items.filter(row => row.workspaceId !== frame.workspace.workspaceId), frame.workspace] };
    case 'remove': return { ...previous, items: previous.items.filter(row => row.workspaceId !== frame.workspaceId) };
    case 'order': {
      // Match the native model: order is a rank update, never a deletion.
      // A late order can omit a workspace already present in a newer baseline.
      const rank = new Map(frame.workspaceIds.map((id, index) => [id, index]));
      return { ...previous, items: [...previous.items].sort((left, right) => (rank.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER)) };
    }
    case 'archived': return { ...previous, archivedSessionIds: frame.archivedSessionIds };
    case 'pinned': return { ...previous, pinnedSessionIds: frame.pinnedSessionIds };
    default: throw new Error('DOMAIN_FRAME_INVALID');
  }
}
