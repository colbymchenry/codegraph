/**
 * A Rust file is read as a module its parent declares only by a name Rust
 * could declare: a file named like no identifier (`odd(name.rs`, a copy's
 * `x).rs`) is no module, and its name never becomes part of a pattern — it
 * stopped `codegraph_explore` with an invalid regular expression (#3265
 * follow-up). A raw-identifier declaration (`mod r#type;`) loads `type.rs`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { inCfgTestFile } from '../src/graph/test-code';

const reader = (files: Record<string, string>) => (p: string): string | undefined => files[p];

describe('inCfgTestFile on file names that are no identifier', () => {
  it('answers false for them instead of throwing', () => {
    const read = reader({ 'src/store.rs': '#[cfg(test)]\nmod tests;\n' });
    for (const odd of ['src/store/odd(name.rs', 'src/store/x).rs', 'src/store/[x.rs', 'src/store/+x.rs', 'src/store/a.b.rs', 'src/store/my-mod/mod.rs']) {
      expect(() => inCfgTestFile(odd, read), odd).not.toThrow();
      expect(inCfgTestFile(odd, read), odd).toBe(false);
    }
  });

  it('reads a raw-identifier declaration of the module', () => {
    expect(inCfgTestFile('src/store/type.rs', reader({ 'src/store.rs': '#[cfg(test)]\nmod r#type;\n' }))).toBe(true);
  });
});

describe('codegraph_explore with a Rust file named like no identifier', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('still answers, with the blast radius', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-odd-name-'));
    const files: Record<string, string> = {
      'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub mod store;\n',
      'src/store.rs': 'pub fn create_note() -> u32 { 1 }\n\n#[cfg(test)]\nmod tests;\n',
      'src/store/tests.rs': 'use super::*;\n#[test]\nfn checks_create_note() { let n = create_note(); assert_eq!(n, 1); }\n',
      'src/store/odd(name.rs': 'use crate::store::create_note;\npub fn odd_caller() -> u32 { create_note() }\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    }
    cg = await CodeGraph.init(root, { index: true });

    // A query naming one symbol gets its callers and its test sites apart (#3407).
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'create_note' });
    expect(res.isError ?? false).toBe(false);
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/\*\*Called by\*\*[^\n]*\n- `odd_caller` — `src\/store\/odd\(name\.rs:2`/);
    expect(text).toMatch(/\*\*In tests\*\*[^\n]*\n- `src\/store\/tests\.rs`: 3/);

    // The ranked answer's blast radius, which a one-name query still reaches
    // when the name has several definitions, reads them the same way.
    const before = process.env.CODEGRAPH_EXPLORE_ONE_SYMBOL;
    process.env.CODEGRAPH_EXPLORE_ONE_SYMBOL = '0';
    let ranked: string;
    try {
      const r = await new ToolHandler(cg).execute('codegraph_explore', { query: 'create_note' });
      expect(r.isError ?? false).toBe(false);
      ranked = r.content[0]!.text as string;
    } finally {
      if (before === undefined) delete process.env.CODEGRAPH_EXPLORE_ONE_SYMBOL;
      else process.env.CODEGRAPH_EXPLORE_ONE_SYMBOL = before;
    }
    const line = ranked.split('\n').find((l) => l.startsWith('- `create_note`')) ?? '';
    expect(line).toMatch(/tests: `src\/store\/tests\.rs`/);
    expect(line).toMatch(/`src\/store\/odd\(name\.rs`/);
  });
});
