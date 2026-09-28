#!/usr/bin/env node
/** Compare syntax acceptance with std.zig.Ast. Requires the pinned Zig 0.16.0.
 * Default: strict positive/negative fixtures. Optional: source-path JSON array.
 * --recovery-contract checks named, documented differences without hiding them.
 * Reports counts only; private corpus paths and source never enter the report.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Parser, Language } from 'web-tree-sitter';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zig = process.env.ZIG_COMPILER || 'zig';
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
assert.equal(run(zig, ['version']), '0.16.0', 'Use Zig 0.16.0 for this oracle');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-ast-'));
let parser;
try {
  let files;
  let expected;
  let recovery;
  if (process.argv[2] === '--recovery-contract') {
    recovery = JSON.parse(fs.readFileSync(path.join(root, '__tests__/fixtures/zig-recovery-cases.json'), 'utf8'));
    assert.ok(recovery.length > 0 && new Set(recovery.map(f => f.name)).size === recovery.length);
    files = recovery.map((fixture, i) => {
      assert.equal(fixture.astAccepted, false, 'Recovery fixtures must be compiler-invalid');
      assert.equal(typeof fixture.wasmAccepted, 'boolean');
      const file = path.join(dir, `${i}.zig`);
      fs.writeFileSync(file, fixture.source);
      return file;
    });
  } else if (process.argv[2]) {
    files = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    assert.ok(Array.isArray(files) && files.length > 0 && files.every(f => typeof f === 'string'));
    files = files.map(f => path.resolve(f));
  } else {
    const fixtures = JSON.parse(fs.readFileSync(path.join(root, '__tests__/fixtures/zig-static-cases.json'), 'utf8'));
    const sources = fixtures.flatMap(f => Object.values(f.files));
    expected = sources.map(() => true);
    // Negative controls catch an oracle accidentally reporting all inputs valid.
    sources.push('pub fn broken( {', 'const broken = struct {');
    expected.push(false, false);
    files = sources.map((source, i) => {
      const file = path.join(dir, `${i}.zig`);
      fs.writeFileSync(file, source);
      return file;
    });
  }
  const oracle = path.join(dir, process.platform === 'win32' ? 'oracle.exe' : 'oracle');
  run(zig, ['build-exe', path.join(root, 'scripts/zig-ast-oracle.zig'), '-femit-bin=' + oracle, '--cache-dir', path.join(dir, 'cache')]);
  await Parser.init();
  parser = new Parser();
  parser.setLanguage(await Language.load(path.join(root, 'dist/extraction/wasm/tree-sitter-zig.wasm')));
  const report = { files: files.length, acceptedByBoth: 0, rejectedByBoth: 0, compilerRejectOnly: 0, grammarRejectOnly: 0 };
  for (let start = 0; start < files.length; start += 64) {
    const batch = files.slice(start, start + 64);
    const results = run(oracle, batch).split('\n');
    assert.equal(results.length, batch.length, 'Incomplete oracle response');
    for (let i = 0; i < batch.length; i++) {
      const match = /^(\d+):(\d+)$/.exec(results[i]);
      assert.ok(match && Number(match[1]) === i, 'Invalid oracle response');
      const nativeAccepted = Number(match[2]) === 0;
      const tree = parser.parse(fs.readFileSync(batch[i], 'utf8'));
      assert.ok(tree, 'Tree-sitter returned no tree');
      const grammarAccepted = !tree.rootNode.hasError;
      tree.delete();
      if (expected) assert.equal(nativeAccepted, expected[start + i], `Invalid syntax control ${start + i}`);
      if (recovery) {
        const fixture = recovery[start + i];
        assert.equal(nativeAccepted, fixture.astAccepted, `${fixture.name}: Ast contract changed`);
        assert.equal(grammarAccepted, fixture.wasmAccepted, `${fixture.name}: WASM contract changed; review the recovery baseline`);
      }
      report[nativeAccepted ? (grammarAccepted ? 'acceptedByBoth' : 'grammarRejectOnly') : (grammarAccepted ? 'compilerRejectOnly' : 'rejectedByBoth')]++;
    }
  }
  console.log(JSON.stringify(report));
  if (recovery) console.log(JSON.stringify({ mode: 'recovery-contract', passed: recovery.map(f => f.name), strictSyntaxParity: report.grammarRejectOnly + report.compilerRejectOnly === 0 }));
  else assert.equal(report.grammarRejectOnly + report.compilerRejectOnly, 0, 'Syntax acceptance differs');
} finally {
  parser?.delete();
  fs.rmSync(dir, { recursive: true, force: true });
}
