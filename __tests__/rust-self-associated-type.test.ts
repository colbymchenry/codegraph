/**
 * In Rust, `Self::Error` in a signature is the enclosing impl's (or trait's)
 * own associated type, and `V::Value` an associated type of a generic's bound
 * — never a struct of that name. serde's `Self::Error`s went to
 * `de::value::Error`, the one `struct Error` the crate defines.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-self-assoc-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "serde"\n',
    'src/de/value.rs': `pub struct Error {
    msg: String,
}

pub struct Value;
`,
    'src/private/de.rs': `use crate::de::value::{Error, Value};

pub trait Deserializer {
    type Error;
}

pub struct ContentDeserializer<E> {
    err: E,
}

impl<E> Deserializer for ContentDeserializer<E> {
    type Error = E;

    fn deserialize_any<V: Visitor>(self, visitor: V) -> Result<V::Value, Self::Error> {
        todo!()
    }
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Rust Self:: and generic-parameter paths', () => {
  it('name the impl’s associated type, never a struct of that name', () => {
    const ids = cg.getNodesInFile('src/private/de.rs').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'references' && e.line === 14)
      .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.filePath}:${t.startLine}`);
    expect(targets).toContain('type_alias src/private/de.rs:12');
    expect(targets.filter((t) => t.includes('src/de/value.rs'))).toEqual([]);
  });
});
