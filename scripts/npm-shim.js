#!/usr/bin/env node
'use strict';
//
// npm thin-installer launcher for CodeGraph.
//
// The heavy artifact (a vendored Node runtime + the app) ships as a per-platform
// optionalDependency: @colbymchenry/codegraph-<platform>-<arch>. npm installs
// only the one matching the host, via each package's `os`/`cpu` fields (the
// esbuild pattern). This shim — run by the user's OWN Node — locates that bundle
// and execs its launcher, so the real work always runs on the bundled Node 24
// (with node:sqlite), regardless of the user's Node version. The user's Node is
// only ever a launcher; even an ancient version can run this file.
//
// Self-heal (issue #303): some registries — notably the npmmirror/cnpm mirrors,
// and some corporate proxies — don't reliably mirror the per-platform
// optionalDependencies. npm treats an unfetchable optional dep as success and
// silently skips it, so the bundle goes missing and every command fails. When
// the installed bundle can't be resolved, this shim falls back to downloading
// the matching bundle straight from GitHub Releases — the very archive
// install.sh uses — into a cache dir, then runs that. Knobs:
//   CODEGRAPH_NO_DOWNLOAD=1     disable the network fallback (print guidance)
//   CODEGRAPH_INSTALL_DIR=DIR   cache location (default: ~/.codegraph)
//   CODEGRAPH_DOWNLOAD_BASE=URL release-download base (for mirrors/air-gapped)
//
// Wired up at release time as the main package's `bin`:
//   "bin": { "codegraph": "npm-shim.js" }
// with the platform packages listed in `optionalDependencies`.

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var target = process.platform + '-' + process.arch; // e.g. darwin-arm64, linux-x64
var pkg = '@colbymchenry/codegraph-' + target;
var isWindows = process.platform === 'win32';
var REPO = 'colbymchenry/codegraph';

main().catch(function (e) {
  process.stderr.write('codegraph: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
});

async function main() {
  // Happy path: the npm-installed optional dependency. Fall back to a download
  // when the registry didn't deliver it.
  var resolved = resolveInstalledBundle() || (await selfHealBundle());
  var res = childProcess.spawnSync(resolved.command, resolved.args, { stdio: 'inherit', windowsHide: true });
  if (res.error) {
    process.stderr.write('codegraph: ' + res.error.message + '\n');
    process.exit(1);
  }
  process.exit(res.status === null ? 1 : res.status);
}

// Resolve the launcher from the installed per-platform optionalDependency.
// Returns {command, args} or null if the package isn't installed.
function resolveInstalledBundle() {
  try {
    if (isWindows) {
      // Modern Node refuses to spawn the bundle's .cmd directly (EINVAL, the
      // CVE-2024-27980 hardening on Node 24), so invoke the bundled node.exe
      // against the app entry point and pass --liftoff-only here.
      var nodeExe = require.resolve(pkg + '/node.exe');
      var entry = require.resolve(pkg + '/lib/dist/bin/codegraph.js');
      return { command: nodeExe, args: liftoff(entry) };
    }
    return { command: require.resolve(pkg + '/bin/codegraph'), args: process.argv.slice(2) };
  } catch (e) {
    return null;
  }
}

// Locate the launcher inside an extracted GitHub bundle directory (same
// node/lib/bin layout as the npm platform package). Returns {command, args} or
// null when the directory doesn't hold a usable bundle yet.
function launcherIn(dir) {
  if (isWindows) {
    var nodeExe = path.join(dir, 'node.exe');
    var entry = path.join(dir, 'lib', 'dist', 'bin', 'codegraph.js');
    if (fs.existsSync(nodeExe) && fs.existsSync(entry)) {
      return { command: nodeExe, args: liftoff(entry) };
    }
  } else {
    var launcher = path.join(dir, 'bin', 'codegraph');
    if (fs.existsSync(launcher)) return { command: launcher, args: process.argv.slice(2) };
  }
  return null;
}

// --liftoff-only keeps tree-sitter's WASM grammars off V8's turboshaft tier to
// avoid the Zone OOM on Node >= 22 (issues #293/#298). The unix bin/codegraph
// launcher already passes it; on Windows we invoke node.exe directly so add it.
function liftoff(entry) {
  return ['--liftoff-only', entry].concat(process.argv.slice(2));
}

// Download + cache the platform bundle from GitHub Releases. Returns
// {command, args}; exits the process with guidance if it can't.
async function selfHealBundle() {
  var version = readVersion();
  var bundlesDir = path.join(process.env.CODEGRAPH_INSTALL_DIR || path.join(os.homedir(), '.codegraph'), 'bundles');
  var dest = path.join(bundlesDir, target + '-' + version);

  // Already downloaded by a previous run? Use it even when downloads are
  // disabled — CODEGRAPH_NO_DOWNLOAD blocks fetching, not a cached bundle.
  var cached = launcherIn(dest);
  if (cached) { pruneOldBundles(bundlesDir, dest); return cached; }

  if (process.env.CODEGRAPH_NO_DOWNLOAD) {
    fail('the network fallback is disabled (CODEGRAPH_NO_DOWNLOAD is set).');
  }

  var asset = 'codegraph-' + target + (isWindows ? '.zip' : '.tar.gz');
  var base = process.env.CODEGRAPH_DOWNLOAD_BASE || ('https://github.com/' + REPO + '/releases/download');
  var url = base + '/v' + version + '/' + asset;

  process.stderr.write(
    'codegraph: platform bundle missing (registry did not provide ' + pkg + ').\n' +
    'codegraph: downloading ' + asset + ' from GitHub Releases (' + version + ')...\n'
  );

  // Stage inside bundlesDir so the final rename is on the same filesystem (atomic,
  // no EXDEV across tmpfs). Strip the archive's top-level codegraph-<target>/ dir.
  fs.mkdirSync(bundlesDir, { recursive: true });
  var stage = fs.mkdtempSync(path.join(bundlesDir, '.dl-'));
  try {
    var archivePath = path.join(stage, asset);
    await download(url, archivePath, 6);
    await verifyChecksum(archivePath, asset, base, version);
    var extracted = path.join(stage, 'bundle');
    fs.mkdirSync(extracted);
    extract(archivePath, extracted);

    var raced = launcherIn(dest); // another process may have finished meanwhile
    if (raced) { rmrf(stage); return raced; }
    try {
      fs.renameSync(extracted, dest);
    } catch (e) {
      var other = launcherIn(dest); // lost the race but theirs is valid
      if (other) { rmrf(stage); return other; }
      throw e;
    }
  } catch (e) {
    rmrf(stage);
    fail('download failed (' + e.message + ').\n  URL: ' + url);
  }
  rmrf(stage);

  var ready = launcherIn(dest);
  if (!ready) fail('downloaded bundle is missing its launcher under ' + dest + '.');
  pruneOldBundles(bundlesDir, dest);
  process.stderr.write('codegraph: bundle ready.\n');
  return ready;
}

function readVersion() {
  try {
    return require(path.join(__dirname, 'package.json')).version;
  } catch (e) {
    fail('could not read this package\'s version to locate a matching release.');
  }
}

// GET with manual redirect following (GitHub release URLs redirect to a CDN).
function download(url, dest, redirectsLeft) {
  return new Promise(function (resolve, reject) {
    var https = require('https');
    // timeout is an idle/inactivity timeout — it won't kill a slow-but-progressing
    // download, only a stalled connection (so a blocked mirror fails fast with
    // guidance instead of hanging the user's command forever).
    var req = https.get(url, { headers: { 'User-Agent': 'codegraph-npm-shim' }, timeout: 30000 }, function (res) {
      var status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
        download(new URL(res.headers.location, url).toString(), dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) { res.resume(); reject(new Error('HTTP ' + status)); return; }
      var file = fs.createWriteStream(dest);
      res.on('error', reject);
      res.pipe(file);
      file.on('error', reject);
      file.on('finish', function () { file.close(function () { resolve(); }); });
    });
    req.on('timeout', function () { req.destroy(new Error('connection timed out')); });
    req.on('error', reject);
  });
}

// Best-effort integrity check. When the release publishes a SHA256SUMS file, the
// downloaded archive MUST match its listed hash or we abort. When that file is
// absent (older releases) or simply unreachable, we proceed — the archive still
// arrived from GitHub over TLS. So tampering/corruption is caught, while a
// missing checksum never breaks an install.
async function verifyChecksum(archivePath, asset, base, version) {
  var sumsPath = archivePath + '.SHA256SUMS';
  try {
    await download(base + '/v' + version + '/SHA256SUMS', sumsPath, 6);
  } catch (e) {
    return; // not published / unreachable → skip
  }
  var expected = null;
  var lines = fs.readFileSync(sumsPath, 'utf8').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && path.basename(m[2].trim()) === asset) { expected = m[1].toLowerCase(); break; }
  }
  if (!expected) return; // asset not listed → nothing to check
  var actual = require('crypto').createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  if (actual !== expected) {
    throw new Error('checksum mismatch for ' + asset +
      ' (expected ' + expected.slice(0, 12) + '…, got ' + actual.slice(0, 12) + '…)');
  }
  process.stderr.write('codegraph: checksum verified.\n');
}

// Extract via the system tar — present on macOS, Linux, and Windows 10+
// (bsdtar reads .zip too). No third-party dependency in the shim.
function extract(archive, destDir) {
  var args = isWindows
    ? ['-xf', archive, '-C', destDir, '--strip-components=1']
    : ['-xzf', archive, '-C', destDir, '--strip-components=1'];
  var res = childProcess.spawnSync('tar', args, { stdio: 'ignore', windowsHide: true });
  if (res.error) throw new Error('tar unavailable: ' + res.error.message);
  if (res.status !== 0) throw new Error('tar exited ' + res.status);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

// Drop sibling bundles for OTHER versions of this same platform target, keeping
// only keepDir. The self-heal cache otherwise accumulates a full ~50 MB bundle
// per version forever (issue #1074). Best-effort: a locked/busy dir (a
// concurrent run still mapping an older node.exe on Windows) just stays — rmrf
// already swallows its own errors, and the readdir is guarded — so cleanup can
// never break a working command. Only this target's "<target>-<version>" dirs
// are touched; other platforms' bundles and the ".dl-*" staging dirs are left
// alone.
function pruneOldBundles(bundlesDir, keepDir) {
  var keep = path.basename(keepDir);
  try {
    var names = fs.readdirSync(bundlesDir);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (name === keep) continue;
      if (name.indexOf(target + '-') !== 0) continue;
      rmrf(path.join(bundlesDir, name));
    }
  } catch (e) { /* best effort — never break a working run over cleanup */ }
}

function fail(reason) {
  process.stderr.write(
    'codegraph: no prebuilt bundle for ' + target + '.\n' +
    (reason ? 'codegraph: ' + reason + '\n' : '') +
    'Expected the optional package ' + pkg + ' to be installed.\n' +
    'A registry mirror (e.g. npmmirror/cnpm) that did not mirror the per-platform\n' +
    'package is the usual cause. Fixes:\n' +
    '  - install from the official registry:\n' +
    '      npm i -g @colbymchenry/codegraph --registry=https://registry.npmjs.org\n' +
    '  - or use the standalone installer (no Node required):\n' +
    '      curl -fsSL https://raw.githubusercontent.com/' + REPO + '/main/install.sh | sh\n'
  );
  process.exit(1);
}
