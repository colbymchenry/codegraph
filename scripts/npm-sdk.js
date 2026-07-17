'use strict';
//
// Programmatic / embedded SDK entry for @colbymchenry/codegraph (issue #354).
//
// The CLI/MCP `bin` (npm-shim.js) execs the per-platform bundle's OWN Node 24 so
// the tool never depends on the user's runtime. Embedded library consumers are
// the opposite case: they already run their own Node and just want the compiled
// API — `require("@colbymchenry/codegraph")` returning the CodeGraph class et al.
//
// The compiled library + its production dependencies (web-tree-sitter,
// tree-sitter-wasms, …) ship INSIDE the per-platform bundle, at
//   @colbymchenry/codegraph-<platform>-<arch>/lib/dist/index.js
// (with the deps in the sibling lib/node_modules). Re-exporting that bundle keeps
// the main package thin — no second 50 MB copy of the grammars — while making the
// SDK work in the consumer's process. Types are a separate concern: the main
// package ships its own dist/**/*.d.ts tree (pointed at by `types`), built from
// the same release so it can never skew from the runtime it re-exports.
//
// node:sqlite (Node >= 22.5) is required to OPEN a graph, but only lazily inside
// the SQLite adapter — so loading this module is safe on older Node, and the
// node:sqlite requirement surfaces with an actionable error only when a DB is
// actually opened. Heavy extraction additionally wants the bundled launcher's
// --liftoff-only flag (the WASM Zone-OOM guard, issues #293/#298); an embedded
// host that drives large indexing should pass that flag to its own Node.

var path = require('path');
var os = require('os');
var fs = require('fs');

var target = process.platform + '-' + process.arch; // e.g. darwin-arm64, linux-x64
var pkg = '@colbymchenry/codegraph-' + target;

module.exports = require(resolveLibrary());

// Locate the compiled library entry inside the installed per-platform bundle.
// Throws an actionable error (rather than a bare MODULE_NOT_FOUND) when no bundle
// is present, so an embedded consumer knows exactly what to install.
function resolveLibrary() {
  // 1) The npm-installed optional dependency — the normal case.
  try {
    return require.resolve(pkg + '/lib/dist/index.js');
  } catch (e) {
    /* fall through to the self-healed cache */
  }

  // 2) A bundle the CLI shim self-healed from GitHub Releases into the cache
  //    (issue #303). Same node/lib/bin layout as the npm package. We only REUSE a
  //    cached bundle here — unlike the CLI shim we never trigger a network
  //    download from inside require(), which must stay synchronous and cheap.
  var cached = cachedLibrary();
  if (cached) return cached;

  throw new Error(
    'codegraph: the programmatic API is unavailable because the platform bundle\n' +
    '(' + pkg + ') is not installed.\n' +
    'The compiled library ships inside that per-platform optional dependency.\n' +
    'Fixes:\n' +
    '  - install from the official npm registry so the matching bundle is fetched:\n' +
    '      npm i @colbymchenry/codegraph --registry=https://registry.npmjs.org\n' +
    '  - or run the CLI once (e.g. `npx @colbymchenry/codegraph status`) to\n' +
    '    self-heal the bundle into ~/.codegraph, then require() will find it.'
  );
}

function cachedLibrary() {
  try {
    var version = require(path.join(__dirname, 'package.json')).version;
    var base = process.env.CODEGRAPH_INSTALL_DIR || path.join(os.homedir(), '.codegraph');
    var lib = path.join(base, 'bundles', target + '-' + version, 'lib', 'dist', 'index.js');
    if (fs.existsSync(lib)) return lib;
  } catch (e) {
    /* no readable cache → caller reports the install guidance */
  }
  return null;
}
