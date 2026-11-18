import { randomUUID } from 'node:crypto';
import { StreamQueue, pause } from './federated-streams.js';

// One native Client generation, separate upstream correlations for each Host.
// Replies remain on the caller's owner Peer and original open upstream carrier.
export class FederatedEvents {
  constructor(gateway) { this.gateway = gateway; this.clients = new Map(); }
  emit(frame) { for (const client of this.clients.values()) if (!client.active.aborted) client.queue.push(frame); }
  async *open(signal, peer) {
    const clientId = randomUUID(), queue = new StreamQueue(), stop = new AbortController();
    const active = AbortSignal.any([signal, peer.signal, stop.signal]);
    const client = { peer, pending: new Map(), active, queue };
    this.clients.set(clientId, client);
    const tasks = [];
    const pump = host => (async () => {
      let delay = 500;
      while (!active.aborted) {
      let channel, catalogRecovery;
      const generation = new AbortController(), current = AbortSignal.any([active, generation.signal]);
      try {
        channel = await this.gateway.channel(host.hostId, peer, active);
        let upstreamId;
        for await (const frame of await channel.open('$events', { args: {} }, active)) {
          if (!upstreamId) {
            if (frame.type !== 'ready' || typeof frame.clientId !== 'string') throw new Error('EVENT_READY_REQUIRED');
            upstreamId = frame.clientId;
            this.gateway.status(host.hostId, true); delay = 500;
            if (host.hostId !== 'local') catalogRecovery = this.gateway.recoverCatalog(host.hostId, peer, current);
            if (host.hostId === 'local') queue.push({ type: 'ready', clientId, host: frame.host });
            continue;
          }
          if (frame.type === 'waterfall') {
            const eventId = JSON.stringify([host.hostId, upstreamId, frame.eventId]);
            client.pending.set(eventId, { channel, clientId: upstreamId, eventId: frame.eventId });
            queue.push({ ...frame, eventId, agentId: this.gateway.identities.encode(host.hostId, 'session', frame.agentId) });
          } else if (frame.type === 'cancel') {
            const eventId = JSON.stringify([host.hostId, upstreamId, frame.eventId]);
            client.pending.delete(eventId); queue.push({ ...frame, eventId });
          } else if (frame.type === 'emit') {
            const mapped = this.notification(host.hostId, frame);
            if (mapped) queue.push(mapped);
          }
        }
        if (!active.aborted) throw new Error('Host event stream ended');
      } catch (error) {
        if (!active.aborted && host.hostId === 'local') { queue.end(error); return; }
        if (!active.aborted) this.gateway.status(host.hostId, false);
      } finally {
        generation.abort();
        await catalogRecovery;
        for (const [id, pending] of client.pending) if (pending.channel === channel) { client.pending.delete(id); queue.push({ type: 'cancel', eventId: id }); }
        await channel?.release?.();
      }
      if (host.hostId === 'local') return;
      await pause(delay, active); delay = Math.min(delay * 2, 10000);
      }
    })();
    const discovery = (async () => { for await (const host of this.gateway.participants(active)) { if (active.aborted) return; tasks.push(pump(host)); } })().catch(error => { if (!active.aborted) queue.end(error); });
    try {
      // Upstreams can deliver waterfalls immediately. Buffer until the one
      // native opening frame has been published, then keep original ordering.
      const early = []; let ready = false;
      for await (const frame of queue.iterate(active)) {
        if (!ready && frame.type !== 'ready') { early.push(frame); continue; }
        if (frame.type === 'ready') {
          if (ready) continue;
          ready = true; yield frame; for (const item of early.splice(0)) yield item;
        } else yield frame;
      }
    } finally { stop.abort(); queue.end(); this.clients.delete(clientId); await discovery; await Promise.allSettled(tasks); }
  }
  notification(hostId, frame) {
    if (['llm/adapters-updated', 'llm/models-updated', 'settings/document-updated', 'credentials/record-updated', 'credentials/reference-updated'].includes(frame.event)) for (const listener of this.gateway.statusListeners) listener({ hostId, online: true, catalogChanged: true });
    if (frame.event === 'api-session/added') return { ...frame, args: [this.gateway.summary(hostId, frame.args[0])] };
    if (frame.event.startsWith('api-session/')) return { ...frame, args: [this.gateway.identities.encode(hostId, 'session', frame.args[0]), ...frame.args.slice(1)] };
    return hostId === this.gateway.baseHost ? frame : undefined;
  }
  async answer(payload, signal, peer) {
    const args = payload?.args, client = this.clients.get(args?.clientId);
    if (!client || client.peer !== peer || client.active.aborted) throw new Error('EVENT_CLIENT_UNAVAILABLE');
    const pending = client.pending.get(args.eventId);
    if (!pending) throw new Error('EVENT_RESULT_UNAVAILABLE');
    client.pending.delete(args.eventId);
    return pending.channel.call('$events/result', { args: { ...args, clientId: pending.clientId, eventId: pending.eventId } }, signal);
  }
}
