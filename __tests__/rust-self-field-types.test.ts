/**
 * A Rust call on a field of the impl's own type — `self.store.save()` — is a
 * call on the type the struct declares for the field, read as a written
 * type: the struct's own parameter by the bounds the impl gives it, a trait
 * object by its trait, a pointer's own methods its own (`Arc::clone`), a
 * type name by the `use` that brings it into the struct's file.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const config = [
  'pub struct Config;',
  '',
  'impl Config {',
  '    pub fn load(&self) {}',
  '}',
  '',
].join('\n');

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-self-field-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nsemverlib = "1"\n',
    'src/main.rs': 'mod config_a;\nmod config_b;\nmod model;\nmod proc;\nmod range;\nmod use_range;\nmod ver;\nmod worker;\n\nfn main() {}\n',
    'src/range.rs': '/// The project\'s own `Range`, a namesake of the dependency\'s.\npub struct Range;\n',
    'src/ver.rs': [
      'pub trait Lowest {',
      '    fn lowest(&self) -> u32;',
      '}',
      '',
      'impl Lowest for semverlib::Range {',
      '    fn lowest(&self) -> u32 {',
      '        0',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/use_range.rs': [
      'use semverlib::Range;',
      '',
      'use crate::ver::Lowest;',
      '',
      'pub fn check(r: Range) -> u32 {',
      '    r.lowest()',
      '}',
      '',
    ].join('\n'),
    'src/proc.rs': [
      'pub trait Kill {',
      '    fn kill(&mut self) -> bool;',
      '}',
      '',
      '/// The project\'s own `Child`, holding std\'s.',
      'pub struct Child {',
      '    child: std::process::Child,',
      '}',
      '',
      'impl Kill for Child {',
      '    fn kill(&mut self) -> bool {',
      '        self.child.kill().is_ok()',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/config_a.rs': config,
    'src/config_b.rs': config,
    'src/model.rs': [
      'pub trait Store {',
      '    fn save(&self);',
      '}',
      '',
      'pub trait Render {',
      '    fn render(&self);',
      '}',
      '',
      'pub struct State;',
      '',
      'impl Clone for State {',
      '    fn clone(&self) -> Self {',
      '        State',
      '    }',
      '}',
      '',
      'pub struct Inner;',
      '',
      'impl Inner {',
      '    pub fn run(&self) {}',
      '}',
      '',
      '// Namesakes, which a guess by name alone may take.',
      'pub struct Decoy;',
      '',
      'impl Decoy {',
      '    pub fn save(&self) {}',
      '    pub fn run(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/worker.rs': [
      'use std::sync::Arc;',
      '',
      'use crate::config_b::Config;',
      'use crate::model::{Inner, Render, State, Store};',
      '',
      'pub struct Worker<S: Store> {',
      '    store: S,',
      '    shared: Arc<State>,',
      '    cfg: Config,',
      '    view: Box<dyn Render>,',
      '}',
      '',
      'impl<S: Store> Worker<S> {',
      '    pub fn tick(&self) {',
      '        self.store.save();',
      '        let _ = self.shared.clone();',
      '        self.cfg.load();',
      '        self.view.render();',
      '    }',
      '}',
      '',
    ].join('\n'),
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** What the `calls` edges out of `fn`, declared in `file`, reach, as `file@line`, sorted. */
const callsFrom = (file: string, fn: string): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file).filter((n) => n.name === fn)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'calls') continue;
      const target = cg.getNode(edge.target)!;
      out.push(`${target.filePath}@${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a Rust call on a field of `self`', () => {
  it('is the method of the type the struct declares for the field', () => {
    // `S: Store` → `Store::save`; `Arc<State>`'s `clone` is the `Arc`'s;
    // `Config` is the one `config_b` declares, which the file uses;
    // `Box<dyn Render>` → `Render::render`.
    expect(callsFrom('src/worker.rs', 'tick')).toEqual(['src/config_b.rs@4', 'src/model.rs@2', 'src/model.rs@6']);
  });

  it('is no project impl for a project type that only shares the std type\'s name', () => {
    // `std::process::Child::kill` is std's; the project's `impl Kill for
    // Child` is for its own `Child`, so the call is no self-loop. (The
    // trait's `kill` declaration links to that impl on its own.)
    const impl = cg.getNodesInFile('src/proc.rs').find((n) => n.name === 'kill' && n.startLine === 11)!;
    expect(cg.getOutgoingEdges(impl.id).filter((e) => e.kind === 'calls')).toEqual([]);
  });
});

describe('a Rust call on a dependency\'s type', () => {
  it('is a project trait\'s impl for that type, read by the path the impl writes', () => {
    // `impl Lowest for semverlib::Range`, though the project has a `Range` of its own.
    expect(callsFrom('src/use_range.rs', 'check')).toEqual(['src/ver.rs@6']);
  });
});
