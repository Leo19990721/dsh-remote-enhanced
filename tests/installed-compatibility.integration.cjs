// Opt-in: use the installed DSH evaluator and version, with a synthetic Remote
// manifest only. No DSH launch, real profile, remote connection or browser.
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const manifest = require('../package.json');

(async () => {
  assert.ok(process.env.DSH_INSTALL_DIR, 'DSH_INSTALL_DIR must point to the target CLI package');
  const installAnchor = join(process.env.DSH_INSTALL_DIR, 'package.json');
  const resolve = createRequire(installAnchor);
  const { version: installed } = resolve(installAnchor);
  const boot = await import(pathToFileURL(resolve.resolve('@deepseek-ai/dsh-app-boot')).href);
  assert.equal(boot.getDshRuntimeVersion(), installed);
  assert.equal(boot.evaluatePluginCompatibility(manifest), undefined, 'installed DSH must admit the bundle without an exemption');
  const comparisons = [
    [installed, 'pass'], ['0.2.2-rc.2', 'fail'], ['0.2.2-rc.3', 'pass'], ['0.2.3-alpha.1', 'pass'],
    ['0.3.0-0', 'pass'], ['0.3.0-alpha.1', 'pass'], ['0.3.0-rc.1', 'pass'], ['0.3.0', 'pass'],
    ['1.0.0-rc.1', 'pass'], ['2.0.0', 'pass'],
  ];

  const dir = await mkdtemp(join(tmpdir(), 'dsh-unified-sessions-installed-check-'));
  try {
    const remote = join(dir, 'node_modules', 'ds-harness-remote');
    await mkdir(remote, { recursive: true });
    await writeFile(join(remote, 'package.json'), JSON.stringify({ name: 'ds-harness-remote', version: '0.6.5' }));
    const { assertInstallation, selfCheck } = await import('../federated-health.js');
    let peerVersion = installed;
    const ctx = {
      get: name => name === 'profileContext' ? { dir, installAnchor } : undefined,
      dshRemoteClient: {
        gatewaySwitch: { local() {} }, withToolRemote() {}, remoteTypertGateway() {},
        devices: async () => [{ deviceId: 'fixture', online: true, clientVersion: '0.6.5', harnessVersion: peerVersion }],
      },
    };
    const health = await assertInstallation(ctx);
    assert.deepEqual(health.checks.find(row => row.id === 'dshVersion'), {
      id: 'dshVersion', state: 'pass', expected: manifest.engines.dsh, actual: installed,
    });
    for (const [version, state] of comparisons) {
      const issue = boot.evaluatePluginCompatibility(manifest, {}, version);
      if (state === 'pass') assert.equal(issue, undefined, version);
      else assert.deepEqual(issue, {
        name: manifest.name, version: manifest.version, runtimeVersion: version,
        requirements: { 'engines.dsh': manifest.engines.dsh }, exempted: false,
      });
      peerVersion = version;
      const result = await selfCheck(ctx, {}, {}, new AbortController().signal);
      assert.deepEqual(result.local, health);
      assert.deepEqual(result.hosts[0].checks.find(row => row.id === 'dshVersion'), {
        id: 'dshVersion', state, expected: manifest.engines.dsh, actual: version,
      });
    }
    console.log(`PASS installed DSH ${installed}: launcher and both health checks agree without a version exemption`);
    console.log(comparisons.map(([version, state]) => `${version}=${state}`).join(', '));
  } finally { await rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
