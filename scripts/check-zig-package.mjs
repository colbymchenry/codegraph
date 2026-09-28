#!/usr/bin/env node
/** Exercise a staged package, including its own grammar/runtime and SQLite. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(process.argv[2] ?? '.');
const require = createRequire(path.join(root, 'package.json'));
const { CodeGraph } = require(path.join(root, 'dist', 'index.js'));
assert.match(fs.readFileSync(path.join(root, 'dist/extraction/wasm/LICENSE.tree-sitter-zig'), 'utf8'), /Amaan Qureshi/);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-zig-package-'));
let graph;
try {
  fs.writeFileSync(path.join(dir, 'main.zig'), 'const api=@import("api.zig"); pub fn entry() void { @call(.auto, // argument\n api.run, .{}); }');
  fs.writeFileSync(path.join(dir, 'api.zig'), 'const lib=@import("lib.zig");pub const run=lib.@"two words";');
  fs.writeFileSync(path.join(dir, 'lib.zig'), 'pub fn @"two words"() void {} pub fn @"export"() void {} pub fn next() void {} pub const Failure=error{Failed};');
  graph = await CodeGraph.init(dir, { index: true });
  const targets = () => {
    const caller = graph.getNodesByKind('function').find(n => n.name === 'entry');
    assert.ok(caller);
    return graph.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => graph.getNode(e.target).name);
  };
  assert.deepEqual(targets(), ['@"two words"']);
  assert.equal(graph.getNodesByKind('enum_member').find(n => n.qualifiedName === 'Failure::Failed')?.visibility, 'public');
  fs.writeFileSync(path.join(dir, 'api.zig'), 'const lib=@import("lib.zig");pub const run=lib.@"export";');
  await graph.sync();
  assert.deepEqual(targets(), ['@"export"']);
  fs.writeFileSync(path.join(dir, 'api.zig'), 'const lib=@import("lib.zig");pub const run=lib.next;');
  await graph.sync();
  assert.deepEqual(targets(), ['next']);
  graph.close(); graph = await CodeGraph.open(dir);
  assert.deepEqual(targets(), ['next']);
  console.log('[check-zig-package] grammar, notice, aliases, incremental rebind and reopen passed');
} finally {
  graph?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
