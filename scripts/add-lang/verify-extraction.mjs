#!/usr/bin/env node
// Sanity-check that codegraph extracted REAL symbols (not just file/import nodes)
// from a repo for a given language. Exits non-zero on a critical failure so it
// can drive a write-extractor -> build -> re-check loop.
//
// Usage: node scripts/add-lang/verify-extraction.mjs <repo-path> <lang>
// Reads `codegraph status <repo> --json` using whatever codegraph is on PATH,
// so it reflects the binary that built the index. Set CODEGRAPH_BIN to a
// specific binary (or to dist/bin/codegraph.js) to bypass the PATH lookup —
// on Windows, npm installs codegraph as a .cmd shim that execFileSync can't
// launch by bare name, so the lookup below resolves the shim itself.
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

function resolveCodegraphBin() {
  if (process.env.CODEGRAPH_BIN) return process.env.CODEGRAPH_BIN;
  if (process.platform !== 'win32') return 'codegraph';
  // Windows: find the npm shim on PATH ourselves. The extensionless shim is a
  // sh script (Git Bash only); .cmd/.exe are what a Node child can run.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['.cmd', '.exe', '.bat']) {
      const candidate = path.join(dir, `codegraph${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'codegraph';
}

function runCodegraph(args) {
  const bin = resolveCodegraphBin();
  const ext = path.extname(bin).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  }
  if (ext === '.cmd' || ext === '.bat') {
    // Batch shims only run through cmd.exe (shell:true). Node doesn't escape
    // when shell is enabled, so quote every token ourselves.
    const q = (s) => (/[\s"^&|<>()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return execFileSync(q(bin), args.map(q), { encoding: 'utf8', shell: true });
  }
  return execFileSync(bin, args, { encoding: 'utf8' });
}

let status;
try {
  const out = runCodegraph(['status', repo, '--json']);
  status = JSON.parse(out);
} catch (e) {
  console.error(`[verify] could not read codegraph status for ${repo}: ${e.message}`);
  console.error('[verify] hint: set CODEGRAPH_BIN to the codegraph binary or dist/bin/codegraph.js');
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
