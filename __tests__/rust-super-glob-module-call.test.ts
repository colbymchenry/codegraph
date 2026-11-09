import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-super-glob-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
    'src/lib.rs': `pub mod archive;
pub mod inline_parent;
`,
    'src/archive/mod.rs': `pub mod gzip;

#[cfg(test)]
mod tests {
    use super::*;

    fn test_write() -> usize {
        gzip::write()
    }
}

#[cfg(test)]
mod file_tests;
`,
    'src/archive/gzip.rs': `pub fn write() -> usize {
    42
}
`,
    'src/archive/file_tests.rs': `use super::*;

pub fn test_from_file_submod() -> usize {
    gzip::write()
}
`,
    'src/inline_parent.rs': `pub mod helper {
    pub fn run() -> usize {
        100
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_inline() -> usize {
        helper::run()
    }
}
`,
  };
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(root, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function callsFrom(file: string, fnName: string): string[] {
  const node = cg.getNodesInFile(file).find((n) => n.name === fnName);
  expect(node, `${file}:${fnName}`).toBeDefined();
  const callees = cg.getCallees(node!.id);
  return callees.map((c) => `${c.node.kind} ${c.node.name} ${c.node.filePath}:${c.node.startLine}`);
}

describe('Rust use super::* glob brings in declared modules (#3253)', () => {
  it('resolves a call through a file module brought in by use super::* in an inline submodule', () => {
    expect(callsFrom('src/archive/mod.rs', 'test_write')).toEqual(['function write src/archive/gzip.rs:1']);
  });

  it('resolves a call through a file module brought in by use super::* in a file submodule', () => {
    expect(callsFrom('src/archive/file_tests.rs', 'test_from_file_submod')).toEqual(['function write src/archive/gzip.rs:1']);
  });

  it('resolves a call through an inline module brought in by use super::*', () => {
    expect(callsFrom('src/inline_parent.rs', 'test_inline')).toEqual(['function run src/inline_parent.rs:2']);
  });
});
