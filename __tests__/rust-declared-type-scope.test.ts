/**
 * The type a Rust value is declared with — read for `reader.as_mut().m()` and
 * calls through a `Pin` — is its binding's in scope at the call: a `let`
 * in a block the call is outside of is not it, and neither is a struct
 * literal's `reader: …` field. A backward line scan took the nearest line
 * naming `reader:` above the call, whatever it was.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-declared-scope-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(root, 'src', 'main.rs'), [
    'use std::pin::Pin;',
    '',
    'pub struct Reader;',
    '',
    'impl Reader {',
    '    pub fn poll_read(self: Pin<&mut Self>) {}',
    '}',
    '',
    'pub struct Other;',
    '',
    'impl Other {',
    '    pub fn poll_read(self: Pin<&mut Self>) {}',
    '}',
    '',
    'pub struct Holder {',
    '    reader: Pin<Box<Other>>,',
    '}',
    '',
    'pub fn literal_field(mut reader: Pin<&mut Reader>) {',
    '    let _h = Holder {',
    '        reader: Box::pin(Other),',
    '    };',
    '    reader.as_mut().poll_read();',
    '}',
    '',
    'pub fn inner_block(mut reader: Pin<&mut Reader>, mut other: Other) {',
    '    {',
    '        let reader: Pin<&mut Other> = Pin::new(&mut other);',
    '        let _ = reader;',
    '    }',
    '    reader.as_mut().poll_read();',
    '}',
    '',
    'fn main() {}',
    '',
  ].join('\n'));
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.destroy();
  fs.rmSync(root, { recursive: true, force: true });
});

function callees(name: string): string[] {
  const fn = cg.getNodesByName(name).find((n) => n.kind === 'function');
  expect(fn).toBeDefined();
  return cg.getOutgoingEdges(fn!.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.qualifiedName);
}

describe('Rust declared types are read from the binding in scope', () => {
  it("a struct literal's field named like the value is no declaration of it", () => {
    expect(callees('literal_field')).toContain('Reader::poll_read');
    expect(callees('literal_field')).not.toContain('Other::poll_read');
  });

  it('a let in a block the call is outside of does not shadow it', () => {
    expect(callees('inner_block')).toContain('Reader::poll_read');
    expect(callees('inner_block')).not.toContain('Other::poll_read');
  });
});
