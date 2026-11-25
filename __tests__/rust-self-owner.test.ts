import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root: string;
let cg: CodeGraph | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-self-owner-')); });
afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); });
async function index(files: Record<string, string>) {
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="owners"\nversion="0.1.0"\nedition="2021"\n');
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'src', file), text);
  cg = await CodeGraph.init(root, { index: true });
}
function targets(file: string) {
  const caller = cg!.getNodesByKind('method').find(n => n.filePath === `src/${file}` && n.qualifiedName === 'Target::run');
  expect(caller).toBeDefined();
  return cg!.getOutgoingEdges(caller!.id).filter(e => e.kind === 'calls').map(e => {
    const target = cg!.getNode(e.target)!;
    return `${target.filePath}:${target.qualifiedName}`;
  });
}

it('does not borrow a missing method from a same-named type in another module (#1861)', async () => {
  await index({
    'lib.rs': 'pub mod caller; pub mod decoy;',
    'caller.rs': 'pub struct Target;\nimpl Target { pub fn run(&self) { self.reset(); } }',
    'decoy.rs': 'pub struct Target;\nimpl Target { pub fn reset(&self) {} }',
  });
  expect(targets('caller.rs')).toEqual([]);
});

it('keeps a proven local owner despite a same-named type and method in another module (#1861)', async () => {
  await index({
    'lib.rs': 'pub mod caller; pub mod decoy;',
    'caller.rs': 'pub struct Target;\nimpl Target { pub fn reset(&self) {} }\nimpl Target { pub fn run(&self) { self.reset(); } }',
    'decoy.rs': 'pub struct Target;\nimpl Target { pub fn reset(&self) {} }',
  });
  expect(targets('caller.rs')).toEqual(['src/caller.rs:Target::reset']);
  fs.writeFileSync(path.join(root, 'src/caller.rs'), 'pub struct Target;\nimpl Target { pub fn run(&self) { self.reset(); } }');
  await cg!.sync();
  expect(targets('caller.rs')).toEqual([]);
  fs.writeFileSync(path.join(root, 'src/caller.rs'), 'pub struct Target;\nimpl Target { pub fn reset(&self) {} }\nimpl Target { pub fn run(&self) { self.reset(); } }');
  await cg!.sync();
  expect(targets('caller.rs')).toEqual(['src/caller.rs:Target::reset']);
});

it('keeps a unique owner whose impl is split across files (#1861)', async () => {
  await index({
    'lib.rs': 'pub mod caller;\npub struct Target;\nimpl Target { pub fn reset(&self) {} }',
    'caller.rs': 'use crate::Target;\nimpl Target { pub fn run(&self) { self.reset(); } }',
  });
  expect(targets('caller.rs')).toEqual(['src/lib.rs:Target::reset']);
});

it('declines indistinguishable inline-module owners instead of claiming one (#1861)', async () => {
  await index({ 'lib.rs': `mod a {
    pub struct Target;
    impl Target { pub fn reset(&self) {} }
  }
  mod b {
    pub struct Target;
    impl Target { pub fn run(&self) { self.reset(); } }
  }` });
  expect(targets('lib.rs')).toEqual([]);
});
