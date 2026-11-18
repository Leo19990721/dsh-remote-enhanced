import { PreviewFileActions } from './federated-preview-files.js';

export function loopbackTarget(value) {
  let url; try { url = new URL(value); } catch { throw new Error('网页地址无效。'); }
  if (url.username || url.password || value.length > 16384) throw new Error('网页地址包含不允许的内容。');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined;
  if (url.protocol !== 'http:') throw new Error('远端本地网页目前支持 http:// 地址。');
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('远端网页端口应在 1024 到 65535 之间。');
  return { url, port };
}

// A preview remains at one isolated origin across carrier reconnections. Every
// RPC borrows the current authorized Host channel, so it cannot retain a stale
// connection or ever fall back to this computer. App WS messages are not replayed.
export class SessionPreviews {
  constructor(gateway, peer, createPreview, signal, { filePreviewTargets = [] } = {}) {
    Object.assign(this, { gateway, peer, createPreview, signal, filePreviewTargets });
    this.entries = new Map(); this.leases = new Map(); this.requests = new Map(); this.closed = false;
    this.abort = () => { void this.close().catch(() => {}); };
    signal.addEventListener('abort', this.abort, { once: true });
  }
  async open(sessionId, value, leaseId, signal, { fileMode = false } = {}) {
    this.gateway.owner(this.peer); this.signal.throwIfAborted(); signal.throwIfAborted();
    if (this.closed || typeof leaseId !== 'string' || !leaseId || leaseId.length > 1024) throw new Error('网页标签已关闭。');
    const target = this.gateway.identities.decode(sessionId, 'session');
    if (target.hostId === 'local') return { url: value, originalUrl: value };
    const parsed = loopbackTarget(value);
    if (!parsed) throw new Error('只有远端 localhost 网页需要转发。');
    if (typeof fileMode !== 'boolean') throw new Error('网页文件预览模式无效。');
    const filePreviewAvailable = this.filePreviewTargets.some(item => item.hostId === target.hostId && item.port === parsed.port && item.path === parsed.url.pathname);
    if (fileMode && !filePreviewAvailable) throw new Error('此网页未配置整理地图文件预览。');
    // Each tab owns its origin even in ordinary mode. Revoking that occurrence
    // must also revoke its old transparent /open URL in native browser history;
    // no sibling tab may keep that URL alive after file mode is enabled.
    const key = JSON.stringify([target.hostId, parsed.port, sessionId, leaseId, fileMode ? value : '', fileMode]);
    const previous = this.leases.get(leaseId);
    if (previous && previous !== key) await this.release(leaseId);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 16) throw new Error('打开的远端网页过多，请先关闭不用的网页标签。');
      const rpc = async (method, payload, requestSignal) => {
        // Cleanup may outlive view cancellation, but remains owner-authorized
        // and deadline-bound. Only the idempotent close command can do so.
        this.gateway.owner(this.peer);
        const closing = method === 'loopback.call' && payload?.op === 'close';
        const active = AbortSignal.any([...[closing ? this.peer.signal : this.signal].filter(Boolean), ...requestSignal ? [requestSignal] : []]);
        const channel = await this.gateway.channel(target.hostId, this.peer, active);
        try { return await channel.query((remote, current) => remote.client.rpc(method, payload, current), active); }
        finally { await channel.release?.(); }
      };
      const files = fileMode ? new PreviewFileActions(sessionId) : undefined;
      entry = { preview: this.createPreview({ rpc }, files ? { onFileRequest: value => files.propose(value) } : undefined), files, leases: new Set() };
      this.entries.set(key, entry);
    }
    entry.leases.add(leaseId); this.leases.set(leaseId, key);
    const request = {}; this.requests.set(leaseId, request);
    try {
      const result = await entry.preview.open(parsed.port);
      signal.throwIfAborted(); this.signal.throwIfAborted();
      if (this.leases.get(leaseId) !== key || this.requests.get(leaseId) !== request) throw new Error('网页导航已更新。');
      const url = new URL(result.url);
      url.pathname = parsed.url.pathname; url.search = parsed.url.search; url.hash = parsed.url.hash;
      return { url: url.href, originalUrl: parsed.url.href, hostId: target.hostId, filePreviewAvailable };
    } catch (error) {
      if (this.requests.get(leaseId) === request) await this.release(leaseId); throw error;
    }
  }
  fileActions(leaseId, signal) {
    this.gateway.owner(this.peer); this.signal.throwIfAborted();
    const entry = this.entries.get(this.leases.get(leaseId));
    if (!entry?.files) throw new Error('网页文件预览未开启。');
    return entry.files.follow(AbortSignal.any([this.signal, signal]));
  }
  claimFileAction(leaseId, id) {
    this.gateway.owner(this.peer); this.signal.throwIfAborted();
    const entry = this.entries.get(this.leases.get(leaseId));
    if (!entry?.files) throw new Error('文件请求已失效，请重新点击文件。');
    return entry.files.claim(id);
  }
  async release(leaseId) {
    const key = this.leases.get(leaseId); if (!key) return;
    this.leases.delete(leaseId); this.requests.delete(leaseId); const entry = this.entries.get(key);
    entry?.leases.delete(leaseId);
    if (entry && !entry.leases.size) { this.entries.delete(key); entry.files?.close(); await entry.preview.close(); }
  }
  close() {
    if (this.closing) return this.closing; this.closed = true;
    this.signal.removeEventListener('abort', this.abort);
    const entries = [...this.entries.values()]; this.entries.clear(); this.leases.clear(); this.requests.clear();
    this.closing = Promise.all(entries.map(entry => { entry.files?.close(); return entry.preview.close(); })).then(() => undefined);
    return this.closing;
  }
}
