import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only a package manifest is needed by the version-scoped adapter. No real
// Remote package, credentials, profile settings or profile-hoisted ws is used.
export async function remoteProfile(t, { version = '0.6.5' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-unified-sessions-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'synthetic-remote-profile', private: true }));
  const remote = join(directory, 'node_modules', 'ds-harness-remote');
  await mkdir(remote, { recursive: true });
  await writeFile(join(remote, 'package.json'), JSON.stringify({
    name: 'ds-harness-remote', version, exports: { '.': './index.cjs', './package.json': './package.json' },
  }));
  await writeFile(join(remote, 'index.cjs'), "throw new Error('Synthetic Remote runtime must never be loaded.');\n");
  return directory;
}
