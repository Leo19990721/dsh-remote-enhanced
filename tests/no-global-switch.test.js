import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { UnifiedCatalog } from '../catalog.js';

test('retired cross-computer select fails without any global-target access', async () => {
  const calls = [];
  const ctx = { get() { calls.push('get'); throw new Error('global target must remain untouched'); } };
  const catalog = new UnifiedCatalog(ctx);
  for (const hostId of ['local', 'remote']) {
    await assert.rejects(catalog.run('select', { hostId, workspaceId: 'w', sessionId: 's' }), /INDEPENDENT_SESSION_ROUTING_REQUIRED/);
  }
  assert.deepEqual(calls, []);
});

test('browser and host entry contain no global switch or whole-page reload', async () => {
  for (const filename of ['catalog.js', 'native-client.template.js', 'native-client.js']) {
    const text = await readFile(new URL('../' + filename, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\.setMode\s*\(|\.openCodexWorkspace\s*\(|\.openCursorWorkspace\s*\(|location\.reload\s*\(/, filename);
  }
});
