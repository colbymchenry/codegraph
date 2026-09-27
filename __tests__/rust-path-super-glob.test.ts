/**
 * Regression: #[path]-included test modules with `use super::*` must resolve
 * bare callees through the declaring parent module, not a same-named symbol
 * elsewhere in the workspace (ContextualWisdomLab/fast-mlsirm#1837).
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root: string;
let cg: CodeGraph | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-path-super-'));
});

afterEach(() => {
  cg?.close();
  cg = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

async function indexWorkspace(layout: Record<string, string>) {
  fs.writeFileSync(
    path.join(root, 'Cargo.toml'),
    '[workspace]\nmembers = ["crates/core", "crates/py"]\nresolver = "2"\n'
  );
  fs.mkdirSync(path.join(root, 'crates/core/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'crates/py/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests/unit'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'crates/core/Cargo.toml'),
    '[package]\nname = "core-crate"\nversion = "0.1.0"\nedition = "2021"\n'
  );
  fs.writeFileSync(
    path.join(root, 'crates/py/Cargo.toml'),
    '[package]\nname = "py-crate"\nversion = "0.1.0"\nedition = "2021"\n'
  );
  for (const [file, text] of Object.entries(layout)) {
    const dest = path.join(root, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }
  cg = await CodeGraph.init(root, { index: true });
}

function callTargets(testFn: string): string[] {
  const caller = cg!
    .getNodesByKind('function')
    .find((n) => n.filePath === 'tests/unit/scaling_tests.rs' && n.name === testFn);
  expect(caller).toBeDefined();
  return cg!
    .getOutgoingEdges(caller!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const target = cg!.getNode(e.target)!;
      return `${target.filePath}:${target.qualifiedName ?? target.name}`;
    });
}

it('resolves use super::* callee through #[path] parent, not a same-named decoy (#1837)', async () => {
  await indexWorkspace({
    'crates/core/src/lib.rs': 'pub mod scaling;',
    'crates/core/src/scaling.rs': `pub fn predict_rating_multi(x: i32) -> i32 { x + 1 }

#[cfg(test)]
#[path = "../../../tests/unit/scaling_tests.rs"]
mod tests;
`,
    'crates/py/src/lib.rs': 'pub fn predict_rating_multi(x: i32) -> i32 { x + 99 }',
    'tests/unit/scaling_tests.rs': `use super::*;

#[test]
fn pr_elom_rowmean() {
    let _ = predict_rating_multi(1);
}
`,
  });

  expect(callTargets('pr_elom_rowmean')).toEqual([
    'crates/core/src/scaling.rs:predict_rating_multi',
  ]);
});
