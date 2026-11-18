import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Reuse the exact adapter shipped by Remote, including attachment ownership,
// ordered input acceptance and its no-replay semantics. No global Host switch.
export async function loadTerminalAdapter(profileDirectory) {
  const require = createRequire(join(profileDirectory, 'package.json'));
  const manifest = require.resolve('ds-harness-remote/package.json');
  if (require(manifest).version !== '0.6.5') throw new Error('Terminal compatibility requires Remote 0.6.5.');
  const { openRemoteTerminal } = await import(pathToFileURL(join(dirname(manifest), 'dist/terminal-carrier-compat.js')).href);
  if (typeof openRemoteTerminal !== 'function') throw new Error('Remote terminal adapter unavailable.');
  return openRemoteTerminal;
}

export async function openHostStream(target, endpoint, payload, signal, uplink, options) {
  if (endpoint === 'terminal/attach') {
    const attach = await options.terminalAdapter();
    signal.throwIfAborted();
    return attach(target, payload, signal, remoteInput(uplink));
  }
  if (endpoint === 'terminal/watch') return watchTerminals(target, payload, signal, options.terminalWatchIntervalMs);
  return target.open(endpoint, payload, signal);
}

// Remote's 0.6.5 strict input predates the native `typed` annotation. Remote
// ownership admits only that device's user-created terminals, so no Agent
// terminal control can be transferred here. Preserve every executable field.
async function* remoteInput(source) {
  if (!source) return;
  for await (const value of source) {
    if (value?.type === 'write' && Object.hasOwn(value, 'typed')) {
      if (typeof value.typed !== 'boolean') throw new Error('INVALID_TERMINAL_INPUT');
      const { typed, ...input } = value; yield input;
    } else yield value;
  }
}

// Remote 0.6.5 exposes the authorized list but predates native watch. Poll only
// while a roster is watched; an error ends this stream and never changes Host.
export async function* watchTerminals(target, payload, signal, interval = 1500) {
  let previous;
  while (!signal.aborted) {
    const result = await target.dispatch('terminal/list', payload, signal);
    signal.throwIfAborted();
    if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
    const key = JSON.stringify(result.value);
    if (key !== previous) { previous = key; yield result.value; }
    try { await delay(interval, undefined, { signal }); } catch (error) { if (!signal.aborted) throw error; }
  }
}
