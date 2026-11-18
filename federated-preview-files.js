import { randomUUID } from 'node:crypto';

function ordinaryAbsolutePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return false;
  // Browser proposals cannot name a device, UNC share, drive-relative path,
  // alternate stream or parent traversal. The native Session still checks IO.
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    if (/[<>:"|?*]/.test(value.slice(2))) return false;
    return value.slice(3).split(/[\\/]/).every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
  }
  return value.startsWith('/') && !value.startsWith('//') && value.split('/').slice(1).every(part => part && part !== '.' && part !== '..');
}

// A webpage can propose only. No file IO, capability acquisition or remote OS
// action occurs here; the authenticated DSH surface must consume each proposal.
export class PreviewFileActions {
  constructor(sessionId) { this.sessionId = sessionId; this.listeners = new Set(); this.closed = false; }
  publish() { for (const listener of this.listeners) listener(); }
  clear() { clearTimeout(this.timer); this.pending = undefined; this.publish(); }
  propose(value) {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['path', 'kind'].includes(key))
      || !ordinaryAbsolutePath(value.path) || !['file', 'folder'].includes(value.kind)) return { status: 400, error: '文件路径无效，请在 DSH 中重新打开。' };
    if (this.closed || !this.listeners.size) return { status: 503, error: 'DSH 文件预览未连接，请回到 DSH 开启本机预览。' };
    if (this.pending && (this.pending.path !== value.path || this.pending.kind !== value.kind)) return { status: 429, error: '请先处理 DSH 上方的文件请求。' };
    if (!this.pending) {
      this.pending = { id: randomUUID(), path: value.path, kind: value.kind };
      this.timer = setTimeout(() => this.clear(), 120000); this.timer.unref(); this.publish();
    }
    // The existing page uses response.ok to say Windows opened the file. Keep
    // that false and tell it where confirmation actually happens instead.
    return { status: 409, error: '请在 DSH 浏览器上方选择预览或下载。' };
  }
  claim(id) {
    if (this.closed || !this.listeners.size || typeof id !== 'string' || this.pending?.id !== id) throw new Error('文件请求已失效，请重新点击文件。');
    const { path, kind } = this.pending; this.clear();
    return { sessionId: this.sessionId, path, kind };
  }
  async *follow(signal) {
    signal.throwIfAborted(); let revision = 0, wake;
    const changed = () => { revision++; wake?.(); };
    const aborted = () => wake?.();
    this.listeners.add(changed); signal.addEventListener('abort', aborted, { once: true });
    try {
      while (!this.closed && !signal.aborted) {
        const observed = revision;
        yield { pending: this.pending || null };
        if (this.closed || signal.aborted) return;
        if (revision === observed) await new Promise(resolve => { wake = resolve; });
      }
    } finally {
      this.listeners.delete(changed); signal.removeEventListener('abort', aborted);
      if (!this.listeners.size) this.clear();
    }
  }
  close() { this.closed = true; this.clear(); }
}
