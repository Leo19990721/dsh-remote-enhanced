// A single logical stream owns this bounded input queue. Closing discards
// unaccepted input; reconnect always starts empty and never replays writes.
export class StreamInput {
  constructor({ maxBytes = 256 * 1024, maxItems = 16, consumed = () => {} } = {}) {
    Object.assign(this, { maxBytes, maxItems, consumed }); this.items = []; this.bytes = 0; this.closed = false;
  }
  push(value) {
    if (this.closed) throw new Error('STREAM_INPUT_CLOSED');
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes || this.bytes + bytes > this.maxBytes || this.items.length >= this.maxItems) throw new Error('STREAM_INPUT_OVERFLOW');
    this.items.push({ value, bytes }); this.bytes += bytes; this.wake?.();
  }
  end() { this.closed = true; this.wake?.(); }
  close() { this.items.length = 0; this.bytes = 0; this.end(); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const item = this.items.shift();
      if (item) { this.bytes -= item.bytes; this.consumed(); yield item.value; }
      else if (this.closed) return;
      else await new Promise(resolve => { this.wake = resolve; });
    }
  }
}
