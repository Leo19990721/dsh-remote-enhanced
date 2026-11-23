import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('the workspace sidebar stays native and does not mount or run a health check', async () => {
  for (const file of ['native-client.template.js', 'native-client.js']) {
    const client = await source(file);
    assert.doesNotMatch(client, /createHealthState|healthComponent|Remote 自检|Remote check|\bselfCheck\b/, file);
    assert.match(client, /return React\.createElement\(Native, \{ \.\.\.props, useStore\b/, file);
    assert.match(client, /entry\.component = saved\.original/, file);
  }
});

test('the Host still exposes on-demand selfCheck without a Client button', async () => {
  const host = await source('native-host.js');
  assert.match(host, /if \(action === 'selfCheck'\) return selfCheck\(/);
  assert.match(host, /name: 'remote_workspaces'/);
  assert.match(host, /'diagnostics', 'selfCheck', 'resourceCheck'/);
  for (const file of ['locale/zh.json', 'locale/en.json']) {
    const messages = JSON.parse(await source(file)).ui;
    assert.equal(Object.keys(messages).some(key => key.startsWith('check')), false, file);
    assert.ok(messages.connectionHostOffline, file);
    assert.ok(messages.connectionAuthorizationRequired, file);
  }
});
