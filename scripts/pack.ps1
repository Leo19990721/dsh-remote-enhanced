#requires -Version 7.0
param([string]$NodePath, [string]$PnpmPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = if ($NodePath) { (Resolve-Path -LiteralPath $NodePath).Path } else { (Get-Command node -ErrorAction Stop).Source }

function Invoke-Node([string[]]$NodeArgs) {
  $start = [System.Diagnostics.ProcessStartInfo]::new($node)
  $start.WorkingDirectory = $root
  foreach ($argument in $NodeArgs) { $start.ArgumentList.Add($argument) }
  $null = $start.Environment.Remove('DSH_PROFILE_DIR')
  $start.Environment['npm_config_ignore_scripts'] = 'true'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($start)
  $stderr = $process.StandardError.ReadToEndAsync()
  $stdout = $process.StandardOutput.ReadToEnd()
  $process.WaitForExit()
  [Console]::Out.Write($stdout)
  [Console]::Error.Write($stderr.Result)
  if ($process.ExitCode -ne 0) { throw "Node command failed ($($process.ExitCode)): $($NodeArgs -join ' ')" }
}

# Deliberately never builds the Client or installs dependencies. The source
# owner must finish the generated Client before running this release check.
Invoke-Node -NodeArgs @('-e', "if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');")
Invoke-Node -NodeArgs @('--test', 'tests/*.test.js')
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$stem = $manifest.name -replace '^@[^/]+/', ''
$tarball = Join-Path $root ".local-install/$stem-$($manifest.version).tgz"
$packArgs = @('--dir', $root, '--config.ignore-pnpmfile=true', '--config.ignore-scripts=true', 'pack', '--out', $tarball)
if ($PnpmPath) {
  $pnpm = (Resolve-Path -LiteralPath $PnpmPath).Path
  Invoke-Node -NodeArgs (@($pnpm) + $packArgs)
} else {
  $oldIgnoreScripts = $env:npm_config_ignore_scripts
  Push-Location $root
  try {
    $env:npm_config_ignore_scripts = 'true'
    & pnpm @packArgs
    if ($LASTEXITCODE -ne 0) { throw 'pnpm pack failed' }
  } finally {
    $env:npm_config_ignore_scripts = $oldIgnoreScripts
    Pop-Location
  }
}

# Read the actual archive without extracting or installing it. Check its
# allowlist and every relative runtime import, including newly added modules.
$verify = @'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const archive = zlib.gunzipSync(fs.readFileSync(process.argv[1]));
const files = new Map();
const text = value => value.toString('utf8').replace(/\0.*$/s, '');
for (let offset = 0; offset + 512 <= archive.length;) {
  const header = archive.subarray(offset, offset + 512);
  if (header.every(byte => byte === 0)) break;
  const prefix = text(header.subarray(345, 500));
  const name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
  const size = parseInt(text(header.subarray(124, 136)).trim(), 8) || 0;
  const type = text(header.subarray(156, 157));
  assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= archive.length, 'Invalid tar entry');
  assert.ok(name.startsWith('package/') && !name.split('/').includes('..'), 'Unsafe tar path: ' + name);
  if (!type || type === '0') files.set(name.slice(8), archive.subarray(offset + 512, offset + 512 + size).toString('utf8'));
  else assert.equal(type, '5', 'Unexpected tar entry type: ' + name);
  offset += 512 + Math.ceil(size / 512) * 512;
}
const manifest = JSON.parse(files.get('package.json'));
assert.equal(manifest.name, '@local/dsh-unified-sessions');
assert.equal(manifest.version, process.argv[2]);
assert.equal(manifest.private, true);
assert.equal(manifest.license, 'MIT');
assert.equal(manifest.engines.dsh, '>=0.2.2-rc.3');
assert.equal(manifest.engines.node, '>=24');
assert.deepEqual(manifest.dependencies, { semver: '7.8.6', ws: '8.18.3' });
assert.equal(manifest.peerDependencies['ds-harness-remote'], '0.6.5');
const allowed = /^(?:(?:native-host|native-client|catalog|owner-route|remote-adapter|host-channels|rpc-binary|federated-[a-z-]+)\.js|package\.json|cordis\.patch\.yml|locale\/[a-z-]+\.json|icon\.svg|LICENSE|REMOTE-LICENSE\.txt|README\.md)$/;
for (const filename of files.keys()) assert.match(filename, allowed, 'Unexpected packed file: ' + filename);
for (const filename of ['native-host.js', 'native-client.js', 'remote-adapter.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'LICENSE', 'REMOTE-LICENSE.txt', 'README.md']) assert.ok(files.has(filename), 'Missing packed file: ' + filename);
for (const [filename, source] of files) {
  if (!filename.endsWith('.js')) continue;
  const check = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8', windowsHide: true });
  assert.equal(check.status, 0, filename + ': ' + check.stderr);
  const imports = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(imports)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
      assert.ok(files.has(target), `${filename} imports missing runtime file ${target}`);
    } else if (filename !== 'native-client.js' && !specifier.startsWith('node:')) {
      assert.ok(manifest.dependencies[specifier] || manifest.peerDependencies[specifier], 'Undeclared runtime dependency: ' + specifier);
    }
  }
}
function verifyExport(value) {
  if (typeof value === 'object') { for (const child of Object.values(value)) verifyExport(child); return; }
  assert.equal(typeof value, 'string');
  const target = value.replace(/^\.\//, '');
  if (target.includes('*')) {
    const [prefix, suffix] = target.split('*');
    assert.ok([...files.keys()].some(name => name.startsWith(prefix) && name.endsWith(suffix)), 'Missing export: ' + target);
  } else assert.ok(files.has(target), 'Missing export: ' + target);
}
verifyExport(manifest.exports);
assert.ok(files.has(manifest.dsh.bundle.patch.replace(/^\.\//, '')));
assert.match(files.get('cordis.patch.yml'), /filePreviewTargets:\s*\[\]/);
assert.doesNotMatch(files.get('cordis.patch.yml'), /profileDirectory|hostId:|port:/);
assert.doesNotMatch(files.get('native-client.js'), /\/\* (?:STREAMS|CARRIER|MODELS|RESIDENCY|BROWSER|RESOURCE_MENUS|RESOURCES|DICTIONARIES) \*\//);
assert.match(files.get('REMOTE-LICENSE.txt'), /Copyright \(c\) 2026 DSH Remote contributors/);
console.log(`Verified ${files.size} packed files, syntax, exports and runtime import closure.`);
'@
Invoke-Node -NodeArgs @('-e', $verify, $tarball, $manifest.version)
$hash = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($tarball + '.sha256') -Value ($hash + '  ' + [System.IO.Path]::GetFileName($tarball)) -Encoding utf8NoBOM
Write-Output "Candidate ready: $tarball"
Write-Output "SHA-256: $hash"
