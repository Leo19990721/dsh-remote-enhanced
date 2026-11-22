import { SurfaceIdentities, mapInput, mapSchema, schemaOf } from './federated-identities.js';
import { combineBaselines, StreamQueue, pause } from './federated-streams.js';
import { FederatedEvents } from './federated-events.js';
import { readRemoteFile, renderRemoteOffice } from './federated-files.js';
import { stopRemoteChild } from './federated-child-control.js';
import { hostConnectionError, retryableHostError, connectionIssue } from './federated-connection.js';

const EMPTY = () => new AbortController().signal;
export class FederatedGateway {
  constructor({ local, channels, hosts, descriptor, officeKit, baseHost = 'local', lifetime = EMPTY() }) {
    Object.assign(this, { local, channels, hosts, descriptor, officeKit, baseHost, lifetime });
    this.identities = new SurfaceIdentities(baseHost);
    this.events = new FederatedEvents(this);
    this.hostNames = new Map();
    this.workspaceStates = new Map();
    this.streamStates = new Map();
    this.statuses = new Map(); this.statusListeners = new Set();
    this.catalogs = new Map(); this.catalogInflight = undefined; this.catalogReads = new Map(); this.catalogErrors = new Map();
  }
  owner(peer) { if (peer?.principal?.kind !== 'owner') throw new Error('OWNER_REQUIRED'); peer.signal?.throwIfAborted(); }
  input(endpoint, payload) {
    if (!payload || !payload.args || typeof payload.args !== 'object') throw new Error('INVALID_PAYLOAD');
    const descriptor = this.descriptor(endpoint);
    if (!descriptor) throw new Error('UNKNOWN_ENDPOINT');
    const fields = (descriptor?.parameters || []).map(parameter => ({
      wire: parameter.wire,
      ...parameter.source === 'lookup' && ['session', 'agent', 'workspaceFileScope'].includes(parameter.lookup) ? { kind: 'session' } : { schema: schemaOf(parameter.codec) },
    }));
    if (descriptor?.invocation?.kind === 'context' && ['session', 'agent'].includes(descriptor.invocation.context)) fields.push({ wire: descriptor.invocation.wire, kind: 'session' });
    const result = mapInput(this.identities, payload.args, fields);
    return { hostId: result.hostId, payload: { ...payload, args: result.args }, descriptor };
  }
  status(hostId, online) {
    if (this.statuses.get(hostId) === online) return;
    this.statuses.set(hostId, online);
    for (const listener of this.statusListeners) listener({ hostId, online });
  }
  async *statusStream(signal) {
    const queue = new StreamQueue(), listener = value => queue.push(value);
    this.statusListeners.add(listener);
    for (const [hostId, online] of this.statuses) queue.push({ hostId, online });
    try { yield* queue.iterate(signal); } finally { this.statusListeners.delete(listener); }
  }
  async directory(signal) {
    try {
      const hosts = await this.hosts(AbortSignal.any([signal, AbortSignal.timeout(3000)]));
      for (const host of hosts) this.hostNames.set(host.hostId, host.name);
      return hosts;
    } catch { signal.throwIfAborted(); return []; }
  }
  refreshCatalog(hostId, payload, peer) {
    this.owner(peer);
    if (this.catalogReads.has(hostId)) return this.catalogReads.get(hostId);
    const signal = AbortSignal.any([this.lifetime, peer.signal, AbortSignal.timeout(30000)]);
    const job = (async () => {
      let channel;
      try {
        channel = await this.channel(hostId, peer, signal);
        const result = await channel.call('session/list', payload, signal);
        if (!result.ok) throw Object.assign(new Error('Session catalog unavailable'), { code: result.error?.code });
        if (!Array.isArray(result.value?.items)) throw new Error('Invalid Session catalog');
        this.catalogs.set(hostId, result.value.items); this.catalogErrors.delete(hostId);
        for (const row of result.value.items) this.events.emit({ type: 'emit', event: 'api-session/added', args: [this.summary(hostId, row)] });
        return true;
      } catch (error) {
        // Counts and fixed failure categories only; never retain session content.
        const previous = this.catalogErrors.get(hostId);
        this.catalogErrors.set(hostId, { attempts: (previous?.attempts || 0) + 1, failure: signal.aborted ? 'interrupted' : 'read-failed', issue: connectionIssue(error) });
        return false;
      } finally { await channel?.release?.(); }
    })().finally(() => { if (this.catalogReads.get(hostId) === job) this.catalogReads.delete(hostId); });
    this.catalogReads.set(hostId, job); return job;
  }
  async recoverCatalog(hostId, peer, signal) {
    let delay = 500;
    while (!signal.aborted) {
      let abort;
      const cancelled = new Promise(resolve => { abort = () => resolve(false); signal.addEventListener('abort', abort, { once: true }); });
      try {
        // One metadata read may also serve session/list. Cancelling this event
        // generation must stop its retry loop without cancelling that reader.
        if (await Promise.race([this.refreshCatalog(hostId, { args: { _request: {} } }, peer), cancelled])) return;
      } finally { signal.removeEventListener('abort', abort); }
      await pause(delay, signal); delay = Math.min(delay * 2, 10000);
    }
  }
  refreshCatalogs(payload, peer) {
    if (this.catalogInflight) return this.catalogInflight;
    const signal = AbortSignal.any([this.lifetime, peer.signal]);
    const job = (async () => {
      const hosts = await this.directory(signal);
      // Catalog presence may lag a live authenticated event carrier.
      const known = new Set([...hosts.filter(host => host.online).map(host => host.hostId), ...[...this.statuses].filter(([, online]) => online).map(([id]) => id)]);
      known.delete('local');
      await Promise.all([...known].map(hostId => this.refreshCatalog(hostId, payload, peer)));
    })().catch(() => {}).finally(() => { if (this.catalogInflight === job) this.catalogInflight = undefined; });
    this.catalogInflight = job; return job;
  }
  async list(payload, signal, peer) {
    const refreshing = this.refreshCatalogs(payload, peer);
    const channel = await this.channel('local', peer, signal);
    const local = await channel.call('session/list', payload, signal);
    // Fast authorized Hosts join the first response. A slow Host completes in
    // the background and publishes native added events, never blocking local.
    await Promise.race([refreshing, pause(75, signal)]); signal.throwIfAborted();
    const rows = [...this.catalogs].map(([hostId, items]) => ({ hostId, items }));
    if (local.ok) rows.unshift({ hostId: 'local', items: local.value.items });
    rows.sort((a, b) => Number(b.hostId === this.baseHost) - Number(a.hostId === this.baseHost));
    if (!rows.length) return local;
    return { ok: true, value: { items: rows.flatMap(({ hostId, items }) => items.map(row => this.summary(hostId, row))) } };
  }
  async *participants(signal) {
    yield { hostId: 'local', online: true };
    const seen = new Set(['local']);
    while (!signal.aborted) {
      for (const host of await this.directory(signal)) if (!seen.has(host.hostId)) { seen.add(host.hostId); yield host; }
      await pause(5000, signal);
    }
  }
  async channel(hostId, peer, signal) {
    this.owner(peer); signal.throwIfAborted();
    if (hostId === 'local') return { hostId, ...this.local(peer) };
    // Presence is for the device catalog, not authorization or live IO health.
    // Remote authenticates a new carrier; the pool checks its lifetime and
    // authorization on every operation. Re-querying server presence per chunk
    // can reject a healthy carrier halfway through a response.
    try { return { hostId, name: this.hostNames.get(hostId), ...await this.channels.retain(hostId, signal) }; }
    catch (error) { signal.throwIfAborted(); throw hostConnectionError(error, hostId, this.hostNames.get(hostId), true); }
  }
  async call(endpoint, payload, signal = EMPTY(), peer, dispatchLocal) {
    this.owner(peer); signal.throwIfAborted();
    if (endpoint === '$events/result') return this.events.answer(payload, signal, peer);
    if (endpoint === 'session/list') return this.list(payload, signal, peer);
    if (endpoint === 'session/search') {
      const hosts = [{ hostId: 'local', online: true }, ...(await this.directory(signal)).filter(host => host.online)];
      hosts.sort((a, b) => Number(b.hostId === this.baseHost) - Number(a.hostId === this.baseHost));
      const results = await Promise.all(hosts.map(async host => {
        let channel;
        const active = host.hostId === 'local' ? signal : AbortSignal.any([signal, AbortSignal.timeout(5000)]);
        try {
          channel = await this.channel(host.hostId, peer, active);
          return { hostId: host.hostId, result: await channel.call(endpoint, payload, active) };
        } catch { signal.throwIfAborted(); return undefined; }
        finally { await channel?.release?.(); }
      }));
      const available = results.filter(row => row?.result.ok);
      const local = results.find(row => row?.hostId === 'local');
      if (!available.length) return local?.result || { ok: false, error: { code: 'session-hosts/unavailable', message: 'No session catalog is available.', details: {} } };
      const items = available.flatMap(({ hostId, result }) => result.value.items.map(row => endpoint === 'session/list' ? this.summary(hostId, row) : { ...row, sessionId: this.identities.encode(hostId, 'session', row.sessionId) }));
      return { ok: true, value: { ...available[0].result.value, items: endpoint === 'session/search' ? items.slice(0, 20) : items, ...(endpoint === 'session/search' ? { hasMore: items.length > 20 || available.some(row => row.result.value.hasMore) } : {}) } };
    }
    const target = this.input(endpoint, payload);
    const channel = await this.channel(target.hostId, peer, signal);
    try {
      const result = target.hostId !== 'local' && endpoint === 'subagents/interruptByUser'
        ? await stopRemoteChild(channel, target.payload.args.childSessionId, signal)
        : target.hostId !== 'local' && endpoint === 'workspaceFiles/readBytes'
        ? await readRemoteFile(channel, target.payload.args, signal)
        : target.hostId !== 'local' && endpoint === 'officeKit/render'
          ? await renderRemoteOffice(channel, target.payload.args, signal, this.officeKit)
          : await (target.hostId === 'local' && dispatchLocal
            ? dispatchLocal(endpoint, () => channel.call(endpoint, target.payload, signal))
            : channel.call(endpoint, target.payload, signal));
      if (!result.ok) {
        const error = hostConnectionError(result.error, target.hostId, this.hostNames.get(target.hostId));
        return error === result.error ? result : { ok: false, error: { code: error.code, message: error.message, details: error.details } };
      }
      let value = this.result(target.hostId, endpoint, result.value, target.descriptor);
      if (endpoint.startsWith('workspace/') && value) {
        for (const key of ['archivedSessionIds', 'pinnedSessionIds', 'workspaceIds']) {
          if (!Array.isArray(value[key])) continue;
          const others = [...this.workspaceStates].filter(([id]) => id !== target.hostId).flatMap(([, state]) => key === 'workspaceIds' ? state.items.map(row => row.workspaceId) : state[key]);
          const merged = target.hostId === this.baseHost ? [...value[key], ...others] : [...others, ...value[key]];
          value = { ...value, [key]: merged };
        }
      }
      return { ...result, value };
    } catch (error) { signal.throwIfAborted(); throw hostConnectionError(error, target.hostId, this.hostNames.get(target.hostId)); }
    finally { await channel.release?.(); }
  }
  open(endpoint, payload, signal = EMPTY(), peer, uplink) {
    const owner = this;
    return { async *[Symbol.asyncIterator]() {
      owner.owner(peer); signal.throwIfAborted();
      if (endpoint === '$hostStatus') { yield* owner.statusStream(signal); return; }
      if (endpoint === '$events') { yield* owner.events.open(signal, peer); return; }
      if (endpoint === 'workspace/follow' || endpoint === 'session/control') {
        const participants = async function* (active) {
          for await (const host of owner.participants(active)) yield {
            ...host,
            open(_endpoint, _payload, streamSignal) { return owner.openHost(host, _endpoint, _payload, streamSignal, peer); },
          };
        };
        yield* combineBaselines(participants, endpoint, payload, signal, {
          map: (host, frame) => owner.frame(host, endpoint, frame),
          changed: endpoint === 'workspace/follow' ? (hostId, state) => owner.workspaceStates.set(hostId, state) : undefined,
          merge: values => endpoint === 'workspace/follow'
            ? { items: values.flatMap(value => value.items), archivedSessionIds: values.flatMap(value => value.archivedSessionIds), pinnedSessionIds: values.flatMap(value => value.pinnedSessionIds) }
            : { projections: Object.assign({}, ...values.map(value => value.projections)) },
        });
        return;
      }
      const target = owner.input(endpoint, payload);
      const channel = await owner.channel(target.hostId, peer, signal);
      try {
        for await (const frame of await channel.open(endpoint, target.payload, signal, uplink)) yield target.hostId === owner.baseHost ? frame : owner.frame(channel, endpoint, frame, target.descriptor);
      } catch (error) { signal.throwIfAborted(); throw hostConnectionError(error, target.hostId, owner.hostNames.get(target.hostId)); }
      finally { await channel.release?.(); }
    } };
  }
  async *openHost(host, endpoint, payload, signal, peer) {
    let delay = 500;
    const states = this.streamStates.get(host.hostId) || new Map();
    this.streamStates.set(host.hostId, states);
    const publish = (state, code, frame) => {
      const previous = states.get(endpoint);
      const type = ['baseline', 'replace', 'upsert', 'remove', 'order', 'archived', 'pinned', 'projection'].includes(frame?.type) ? frame.type : undefined;
      const recentFrames = endpoint === 'workspace/follow'
        ? [...previous?.recentFrames || [], ...(type ? [{ at: Date.now(), type, ...(Array.isArray(frame?.value?.items) ? { rows: frame.value.items.length } : {}), ...(Array.isArray(frame?.workspaceIds) ? { rows: frame.workspaceIds.length } : {}) }] : [])].slice(-8)
        : undefined;
      states.set(endpoint, { state, at: Date.now(), ...(code === undefined ? {} : { code: String(code).slice(0, 100), issue: connectionIssue({ code }) }), ...(type ? { frame: type } : {}), ...(recentFrames ? { recentFrames } : {}) });
    };
    while (!signal.aborted) {
      let channel;
      try {
        publish('connecting');
        channel = await this.channel(host.hostId, peer, signal);
        for await (const frame of await channel.open(endpoint, payload, signal)) { publish('ready', undefined, frame); delay = 500; yield frame; }
        if (!signal.aborted) throw new Error('Host stream ended');
      } catch (error) {
        if (signal.aborted) return;
        const terminal = host.hostId === 'local' || !retryableHostError(error);
        publish(terminal ? 'failed' : 'reconnecting', error?.code || 'STREAM_ENDED');
        if (terminal) throw error;
        this.status(host.hostId, false);
      } finally { await channel?.release?.(); }
      await pause(delay, signal); delay = Math.min(delay * 2, 10000);
    }
  }
  summary(hostId, row) {
    const result = { ...row, sessionId: this.identities.encode(hostId, 'session', row.sessionId) };
    if (row.parentSessionId !== undefined) result.parentSessionId = this.identities.encode(hostId, 'session', row.parentSessionId);
    if (row.projections !== undefined) result.projections = this.projection(hostId, row.projections);
    return result;
  }
  workspace(host, row) {
    const name = host.name || this.hostNames.get(host.hostId) || host.hostId;
    if (host.name) this.hostNames.set(host.hostId, host.name);
    return { ...row, workspaceId: this.identities.encode(host.hostId, 'workspace', row.workspaceId), title: host.hostId === 'local' ? row.title : `${row.title}（${name}）`, sessionIds: row.sessionIds.map(id => this.identities.encode(host.hostId, 'session', id)) };
  }
  result(hostId, endpoint, value, descriptor = this.descriptor(endpoint)) {
    const mapped = mapSchema(value, schemaOf(descriptor?.result), (kind, id) => this.identities.encode(hostId, kind, id));
    if (['session/page', 'session/history'].includes(endpoint) && value?.header) return { ...mapped, records: value.records, header: { ...value.header, id: this.identities.encode(hostId, 'session', value.header.id), ...(value.header.parentSession === undefined ? {} : { parentSession: this.identities.encode(hostId, 'session', value.header.parentSession) }) } };
    if (endpoint.startsWith('workspace/') && value?.workspace) return { ...mapped, workspace: this.workspace({ hostId }, value.workspace) };
    return mapped;
  }
  projection(hostId, value) {
    const mapped = this.result(hostId, 'session/projections', value);
    const catalog = value?.values?.subagentCatalog;
    if (!Array.isArray(catalog)) return mapped;
    return { ...mapped, values: { ...mapped.values, subagentCatalog: catalog.map(child => child.mode === 'external' ? child : { ...child, id: this.identities.encode(hostId, 'session', child.id), ...(child.sessionId === undefined ? {} : { sessionId: this.identities.encode(hostId, 'session', child.sessionId) }) }) } };
  }
  async modelCatalog(sessionId, signal, peer) {
    this.owner(peer);
    const target = this.identities.decode(sessionId, 'session');
    const channel = await this.channel(target.hostId, peer, signal);
    try { return await channel.call('session/modelCatalog', { args: {} }, signal); }
    finally { await channel.release?.(); }
  }
  frame(host, endpoint, frame, descriptor) {
    if (host.hostId === this.baseHost && host.hostId === 'local') return frame;
    const sessionId = id => this.identities.encode(host.hostId, 'session', id);
    const workspaceId = id => this.identities.encode(host.hostId, 'workspace', id);
    if (endpoint === 'workspace/follow') {
      if (frame.type === 'baseline' || frame.type === 'replace') return { ...frame, value: { ...frame.value, items: frame.value.items.map(row => this.workspace(host, row)), archivedSessionIds: frame.value.archivedSessionIds.map(sessionId), pinnedSessionIds: frame.value.pinnedSessionIds.map(sessionId) } };
      if (frame.type === 'upsert') return { ...frame, workspace: this.workspace(host, frame.workspace) };
      if (frame.type === 'remove') return { ...frame, workspaceId: workspaceId(frame.workspaceId) };
      if (frame.type === 'order') return { ...frame, workspaceIds: frame.workspaceIds.map(workspaceId) };
      if (frame.type === 'archived') return { ...frame, archivedSessionIds: frame.archivedSessionIds.map(sessionId) };
      if (frame.type === 'pinned') return { ...frame, pinnedSessionIds: frame.pinnedSessionIds.map(sessionId) };
    }
    if (endpoint === 'session/control') {
      if (frame.type === 'baseline') return { ...frame, value: { projections: Object.fromEntries(Object.entries(frame.value.projections).map(([id, value]) => [sessionId(id), this.projection(host.hostId, value)])) } };
      if (frame.type === 'projection') return { ...frame, sessionId: sessionId(frame.sessionId), changes: frame.changes.map(change => ({ ...change, val: this.projection(host.hostId, { values: { [change.key]: change.val } }).values[change.key] })) };
    }
    if (endpoint === 'session/follow') {
      if (frame.type !== 'snapshot') return frame;
      return { ...frame, header: { ...frame.header, id: sessionId(frame.header.id), ...frame.header.parentSession === undefined ? {} : { parentSession: sessionId(frame.header.parentSession) } }, ...(frame.projections ? { projections: this.projection(host.hostId, frame.projections) } : {}) };
    }
    return this.result(host.hostId, endpoint, frame, descriptor);
  }
}
