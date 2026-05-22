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
// Wired up at release time as the main package's `bin`:
//   "bin": { "codegraph": "scripts/npm-shim.js" }
// with the platform packages listed in `optionalDependencies`.

var childProcess = require('child_process');

var target = process.platform + '-' + process.arch; // e.g. darwin-arm64, linux-x64
var pkg = '@colbymchenry/codegraph-' + target;

// Invoke the bundled Node binary directly instead of the platform package's
// bin/codegraph[.cmd] wrapper. Node's CVE-2024-27980 mitigation refuses to
// spawn .cmd/.bat files without `shell: true`, so spawning the .cmd launcher
// on Windows returned EINVAL before any CLI logic could run. The wrappers
// themselves just exec `<pkg>/node[.exe] <pkg>/lib/dist/bin/codegraph.js`, so
// we bypass them entirely.
var nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
var entryScript = 'lib/dist/bin/codegraph.js';

var nodePath, scriptPath;
try {
  nodePath = require.resolve(pkg + '/' + nodeBin);
  scriptPath = require.resolve(pkg + '/' + entryScript);
} catch (e) {
  process.stderr.write(
    'codegraph: no prebuilt bundle for ' + target + '.\n' +
    'Expected the optional package ' + pkg + ' to be installed.\n' +
    'Try reinstalling:  npm i -g @colbymchenry/codegraph\n' +
    'Or use the standalone installer (no Node required):\n' +
    '  curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh\n'
  );
  process.exit(1);
}

var res = childProcess.spawnSync(
  nodePath,
  [scriptPath].concat(process.argv.slice(2)),
  { stdio: 'inherit' }
);
if (res.error) {
  process.stderr.write('codegraph: ' + res.error.message + '\n');
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
