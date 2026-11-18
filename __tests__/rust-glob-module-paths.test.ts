/**
 * A Rust path whose first segment is a module that a glob `use` brings in —
 * `gzip::write()` in a `mod tests { use super::*; }` whose parent declares
 * `pub mod gzip;` (issue #3253) — walks to that module, as Rust looks the
 * name up: the module's own items, then its `use`s, then its globs. A glob
 * sees everything of a module it is written inside (`use super::*`), and only
 * the `pub` part of any other. A `use` written in a function binds the module
 * there alone, ahead of the file's own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

async function index(files: Record<string, string>, manifest = ''): Promise<CodeGraph> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-glob-mod-'));
  const all: Record<string, string> = {
    'Cargo.toml': `[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n${manifest}`,
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** The `calls` targets of function `fn` in `file`, as `<file>:<qualified name>`, sorted. */
function callsOf(graph: CodeGraph, file: string, fn: string): string[] {
  const node = graph.getNodesInFile(file).find((n) => n.name === fn && (n.kind === 'function' || n.kind === 'method'));
  expect(node, `${file}:${fn}`).toBeDefined();
  return graph.getOutgoingEdges(node!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const t = graph.getNode(e.target)!;
      return `${t.filePath}:${t.qualifiedName}`;
    })
    .sort();
}

const GZIP = 'pub fn read() -> u8 {\n    1\n}\n\npub fn write() {}\n';

describe('Rust: a module path through a glob use (#3253)', () => {
  it('links gzip::write() in an inline mod tests whose use super::* brings the module in (the issue repro)', async () => {
    const graph = await index({
      'src/lib.rs': 'pub mod store;\n',
      'src/store/mod.rs': `pub mod gzip;

pub fn load() -> u8 {
    gzip::read()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes() {
        gzip::write();
        let _ = load();
    }
}
`,
      'src/store/gzip.rs': GZIP,
    });
    expect(callsOf(graph, 'src/store/mod.rs', 'load')).toEqual(['src/store/gzip.rs:read']);
    expect(callsOf(graph, 'src/store/mod.rs', 'writes')).toEqual(['src/store/gzip.rs:write', 'src/store/mod.rs:load']);
  });

  it('links it from a test module in a file of its own, from a private module, and through an inline module', async () => {
    const graph = await index({
      'src/lib.rs': 'pub mod store;\n',
      'src/store/mod.rs': `mod gzip;

pub mod helper {
    pub fn run() {}
}

#[cfg(test)]
mod tests;
`,
      'src/store/gzip.rs': GZIP,
      'src/store/tests.rs': `use super::*;

#[test]
fn writes_from_file() {
    gzip::write();
    helper::run();
}
`,
    });
    expect(callsOf(graph, 'src/store/tests.rs', 'writes_from_file')).toEqual([
      'src/store/gzip.rs:write',
      'src/store/mod.rs:run',
    ]);
  });

  it('links it through a glob of another module, but only to what that module makes public', async () => {
    const graph = await index({
      'src/lib.rs': 'pub mod store;\npub mod other;\n',
      'src/store/mod.rs': 'pub mod gzip;\nmod hidden;\n',
      'src/store/gzip.rs': GZIP,
      'src/store/hidden.rs': 'pub fn reveal() {}\n',
      // `hidden` here is the dependency crate: store's private module is not
      // what `use crate::store::*` passes on.
      'src/other.rs': `use crate::store::*;

pub fn outside() {
    gzip::write();
    hidden::reveal();
}
`,
    }, '\n[dependencies]\nhidden = "1"\n');
    expect(callsOf(graph, 'src/other.rs', 'outside')).toEqual(['src/store/gzip.rs:write']);
  });

  it('links a module a use inside the function binds, ahead of the file\'s own use of that name', async () => {
    const graph = await index({
      'src/lib.rs': 'pub mod a;\npub mod b;\npub mod store;\npub mod c;\n',
      'src/a.rs': 'pub fn write() {}\n',
      'src/b.rs': 'pub fn write() {}\n',
      'src/store/mod.rs': 'pub mod gzip;\n',
      'src/store/gzip.rs': GZIP,
      'src/c.rs': `use crate::a as m;

pub fn explicit() {
    use crate::store::gzip;
    gzip::write();
}

pub fn shadowed() {
    use crate::b as m;
    m::write();
}

pub fn file_level() {
    m::write();
}
`,
    });
    expect(callsOf(graph, 'src/c.rs', 'explicit')).toEqual(['src/store/gzip.rs:write']);
    expect(callsOf(graph, 'src/c.rs', 'shadowed')).toEqual(['src/b.rs:write']);
    expect(callsOf(graph, 'src/c.rs', 'file_level')).toEqual(['src/a.rs:write']);
  });

  it('ends a walk through modules that glob each other, and links nothing a glob does not bring in', async () => {
    const graph = await index({
      'src/lib.rs': 'pub mod store;\n',
      'src/store/mod.rs': `pub use self::inner::*;

pub mod inner {
    pub use super::*;

    pub fn run() {
        missing::call();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing() {
        absent::call();
    }
}
`,
    });
    expect(callsOf(graph, 'src/store/mod.rs', 'run')).toEqual([]);
    expect(callsOf(graph, 'src/store/mod.rs', 'nothing')).toEqual([]);
  });
});
