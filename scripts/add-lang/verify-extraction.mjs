#!/usr/bin/env node
// Sanity-check that codegraph extracted REAL symbols (not just file/import nodes)
// from a repo for a given language. Exits non-zero on a critical failure so it
// can drive a write-extractor -> build -> re-check loop.
//
// Usage: node scripts/add-lang/verify-extraction.mjs <repo-path> <lang>
// Reads `codegraph status <repo> --json` using whatever codegraph is on PATH,
// so it reflects the binary that built the index. Set CODEGRAPH_BIN to read it
// with another one: a binary, or a build's dist/bin/codegraph.js, which runs
// with this node. bench.sh exports CODEGRAPH_BIN when it is given one.
//
// Exit codes: 0 = pass or soft-warn, 1 = critical fail, 2 = could not run.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const [repo, lang] = process.argv.slice(2);
if (!repo || !lang) {
  console.error('usage: verify-extraction.mjs <repo-path> <lang>');
  process.exit(2);
}

// On Windows, npm installs codegraph as a .cmd shim (`npm link` too), and
// execFileSync can neither find a .cmd by bare name nor run one without a
// shell. So look where Windows would: the first PATH folder holding codegraph
// under one of PATHEXT's runnable extensions. Only a .cmd or .bat needs the
// shell; an .exe or .com is found by the plain call below on its own.
function findWindowsShim() {
  const runnable = ['.com', '.exe', '.bat', '.cmd'];
  const exts = (process.env.PATHEXT || runnable.join(';')).toLowerCase().split(';').filter((e) => runnable.includes(e));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, `codegraph${ext}`);
      if (existsSync(file)) return ext === '.bat' || ext === '.cmd' ? file : null;
    }
  }
  return null;
}

// One token of a command line for cmd.exe, which hands it on to node.exe
// through the shim's %*. Double quotes keep it one argument for the C runtime
// that splits node.exe's command line, so a backslash run before the closing
// quote is doubled (or it would escape that quote). Then every cmd
// metacharacter, the quotes included, gets a caret, so cmd neither splits the
// token nor expands a %NAME% inside it. A Windows path can't contain a double
// quote, so a token with one is refused rather than mangled.
function quoteForCmd(token) {
  if (/["\r\n]/.test(token)) throw new Error(`cannot pass ${JSON.stringify(token)} through cmd.exe`);
  return `"${token.replace(/(\\+)$/, '$1$1')}"`.replace(/[()[\]%!^"`<>&|;, *?]/g, '^$&');
}

function runCodegraph(args) {
  const options = { encoding: 'utf8' };
  const bin = process.env.CODEGRAPH_BIN || (process.platform === 'win32' ? findWindowsShim() : null);
  if (!bin) return execFileSync('codegraph', args, options);
  if (/\.[cm]?js$/i.test(bin)) return execFileSync(process.execPath, [bin, ...args], options);
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(bin)) {
    // A single command string with no args array: Node hands it to cmd.exe
    // unchanged, so the quoting above is all there is.
    return execFileSync([bin, ...args].map(quoteForCmd).join(' '), { ...options, shell: true });
  }
  return execFileSync(bin, args, options);
}

let status;
try {
  const out = runCodegraph(['status', repo, '--json']);
  status = JSON.parse(out);
} catch (e) {
  console.error(`[verify] could not read codegraph status for ${repo}: ${e.message}`);
  process.exit(2);
}

// Kinds that prove the extractor mapped AST node types (everything except
// 'file' and 'import', which codegraph creates structurally for any language).
const SYMBOL_KINDS = new Set([
  'module', 'class', 'struct', 'interface', 'trait', 'protocol', 'function',
  'method', 'property', 'field', 'variable', 'constant', 'enum', 'enum_member',
  'type_alias', 'namespace', 'route', 'component',
]);

const byKind = status.nodesByKind || {};
const langs = status.languages || [];
const files = status.fileCount || 0;
const edges = status.edgeCount || 0;
const symbolKinds = Object.keys(byKind).filter((k) => SYMBOL_KINDS.has(k));
const symbolCount = symbolKinds.reduce((s, k) => s + byKind[k], 0);

const checks = [];
const add = (severity, ok, label, detail) => checks.push({ severity, ok, label, detail });

add('critical', status.initialized === true, 'index initialized', `initialized=${status.initialized}`);
add('critical', langs.includes(lang), `language "${lang}" detected`, `languages=[${langs.join(', ')}]`);
add('critical', symbolCount > 0, 'structural symbols extracted', `${symbolCount} symbols (${symbolKinds.join(', ') || 'NONE — only file/import nodes!'})`);
add('soft', symbolCount >= files, 'symbol density >= 1/file', `${symbolCount} symbols across ${files} files`);
add('soft', edges > files, 'edges resolved', `${edges} edges across ${files} files`);

console.log(`\n# Extraction check — ${repo}  (lang=${lang}, backend=${status.backend})`);
console.log(`  files=${files} nodes=${status.nodeCount} edges=${edges}`);
console.log(`  nodesByKind: ${JSON.stringify(byKind)}\n`);
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label} — ${c.detail}`);

const critical = checks.filter((c) => !c.ok && c.severity === 'critical');
const soft = checks.filter((c) => !c.ok && c.severity === 'soft');
console.log();
if (critical.length) {
  console.log(`RESULT: FAIL (${critical.length} critical) — extractor or grammar wiring is broken. Re-run dump-ast.mjs and fix the node-type mappings.`);
  process.exit(1);
}
if (soft.length) {
  console.log(`RESULT: WARN (${soft.length} soft) — extraction works but looks thin; inspect the counts above.`);
  process.exit(0);
}
console.log('RESULT: PASS — extraction looks healthy.');
process.exit(0);
