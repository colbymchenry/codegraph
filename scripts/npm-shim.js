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
var isWindows = process.platform === 'win32';

// On Windows the bundle's launcher is a .cmd batch file. Modern Node refuses to
// spawn .cmd/.bat directly — spawnSync throws EINVAL (the CVE-2024-27980
// hardening, observed on Node 24). So on Windows we skip the .cmd and invoke the
// bundled node.exe against the app entry point directly. On unix the bin launcher
// is a shell script that spawns cleanly.
var command, args;
try {
  if (isWindows) {
    command = require.resolve(pkg + '/node.exe');
    var entry = require.resolve(pkg + '/lib/dist/bin/codegraph.js');
    args = [entry].concat(process.argv.slice(2));
  } else {
    command = require.resolve(pkg + '/bin/codegraph');
    args = process.argv.slice(2);
  }
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

var res = childProcess.spawnSync(command, args, { stdio: 'inherit' });
if (res.error) {
  process.stderr.write('codegraph: ' + res.error.message + '\n');
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
