#!/usr/bin/env bash
# RED/GREEN repro for #[path] + use super::* callee resolution (fast-mlsirm#1837).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build --silent
node --input-type=module -e "
import { CodeGraph } from './dist/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repro-1837-'));
const write = (rel, text) => {
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
};
write('Cargo.toml', '[workspace]\\nmembers = [\"crates/core\", \"crates/py\"]\\nresolver = \"2\"\\n');
write('crates/core/Cargo.toml', '[package]\\nname = \"core-crate\"\\nversion = \"0.1.0\"\\nedition = \"2021\"\\n');
write('crates/py/Cargo.toml', '[package]\\nname = \"py-crate\"\\nversion = \"0.1.0\"\\nedition = \"2021\"\\n');
write('crates/core/src/lib.rs', 'pub mod scaling;');
write('crates/core/src/scaling.rs', 'pub fn predict_rating_multi(x: i32) -> i32 { x + 1 }\\n\\n#[cfg(test)]\\n#[path = \"../../../tests/unit/scaling_tests.rs\"]\\nmod tests;\\n');
write('crates/py/src/lib.rs', 'pub fn predict_rating_multi(x: i32) -> i32 { x + 99 }');
write('tests/unit/scaling_tests.rs', 'use super::*;\\n\\n#[test]\\nfn pr_elom_rowmean() { let _ = predict_rating_multi(1); }\\n');

const cg = await CodeGraph.init(root, { index: true });
const caller = cg.getNodesByKind('function').find(n => n.filePath === 'tests/unit/scaling_tests.rs' && n.name === 'pr_elom_rowmean');
const edges = cg.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => {
  const t = cg.getNode(e.target);
  return t.filePath + ':' + (t.qualifiedName ?? t.name);
});
const want = 'crates/core/src/scaling.rs:predict_rating_multi';
if (!edges.includes(want)) {
  console.error('FAIL: expected callee', want, 'got', edges);
  process.exit(1);
}
console.log('OK:', edges.join(', '));
cg.close();
fs.rmSync(root, { recursive: true, force: true });
"
