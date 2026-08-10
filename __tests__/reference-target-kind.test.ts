/**
 * Reference target-kind gate — `extends`/`implements` and `imports`.
 *
 * The name-matcher treats node kind as a scoring BONUS, never a filter, and
 * awards no bonus at all for inheritance refs. When exactly one same-named
 * node exists, the single-candidate shortcut adopts it unconditionally at
 * confidence 0.9. So a supertype that lives OUTSIDE the repo — imported by a
 * bare name — bound to whatever local symbol happened to share that name,
 * asserting an inheritance relationship absent from the source:
 *
 *   use std::error::Error;        // the supertype is out-of-repo
 *   impl Error for MapperError {} // ...but `MapperError::Error` is a variant
 *   → implements: enum MapperError -> enum_member Error
 *
 * The gate drops any inheritance resolution whose target cannot be a
 * supertype. It only ever removes edges, so the tests below pin BOTH
 * directions: the false edge is gone, and every legitimate supertype kind
 * (in-repo trait, interface, class, and TS object-type alias) still resolves.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('reference target-kind gate', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inh-kind-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  type InhEdge = { src: string; srcKind: string; tgt: string; tgtKind: string; kind: string };

  const load = async (): Promise<{ edges: InhEdge[]; failed: { name: string; kind: string }[] }> => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges: InhEdge[] = db
      .prepare(
        `SELECT s.name src, s.kind srcKind, t.name tgt, t.kind tgtKind, e.kind kind
           FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE e.kind IN ('extends', 'implements')`
      )
      .all();
    const failed: { name: string; kind: string }[] = db
      .prepare(
        `SELECT reference_name name, reference_kind kind
           FROM unresolved_refs
          WHERE reference_kind IN ('extends', 'implements')`
      )
      .all();
    cg.close?.();
    return { edges, failed };
  };

  const has = (edges: InhEdge[], src: string, tgt: string, tgtKind: string) =>
    edges.some((e) => e.src === src && e.tgt === tgt && e.tgtKind === tgtKind);

  it('drops an out-of-repo Rust supertype that name-matched a local enum member', async () => {
    write(
      'src/lib.rs',
      `use std::error::Error;\n\n` +
        `pub enum MapperError {\n    Error,\n    Missing,\n}\n\n` +
        `impl Error for MapperError {}\n`
    );
    const { edges, failed } = await load();
    expect(has(edges, 'MapperError', 'Error', 'enum_member')).toBe(false);
    // The reference is not silently forgotten — it stays on record as failed,
    // which is the honest outcome for a supertype the repo does not contain.
    expect(failed.some((r) => r.name === 'Error')).toBe(true);
  });

  it('does not relocate the false edge onto a same-named local type alias', async () => {
    // The kind filter alone would have moved this edge from the enum member to
    // `type Error`, which IS a legal supertype kind — still false data, and
    // harder for a consumer to reject. Locality is what removes it.
    write('src/alias.rs', `pub type Error = String;\n`);
    write(
      'src/lib.rs',
      `mod alias;\n\nuse std::error::Error;\n\n` +
        `pub enum MapperError {\n    Missing,\n}\n\n` +
        `impl Error for MapperError {}\n`
    );
    const { edges, failed } = await load();
    expect(edges.filter((e) => e.tgt === 'Error')).toEqual([]);
    expect(failed.some((r) => r.name === 'Error')).toBe(true);
  });

  it('keeps a supertype imported by an in-repo `use` path', async () => {
    write('src/ports.rs', `pub trait Sha256Port {\n    fn hash(&self) -> String;\n}\n`);
    write(
      'src/lib.rs',
      `mod ports;\n\nuse crate::ports::Sha256Port;\n\n` +
        `pub struct Hasher {\n    salt: String,\n}\n\n` +
        `impl Sha256Port for Hasher {\n    fn hash(&self) -> String { String::new() }\n}\n`
    );
    const { edges } = await load();
    expect(has(edges, 'Hasher', 'Sha256Port', 'trait')).toBe(true);
  });

  it('keeps a trait reached through a re-exported sibling-crate module', async () => {
    // `crate::ports` here is a re-export of ANOTHER crate's module, so no
    // `src/ports.rs` exists to walk to. Treating "module path does not resolve
    // to a file" as proof of out-of-repo deleted 13 real trait implementations
    // on the reference fixture — hence the rule keys on stdlib roots only.
    write('Cargo.toml', `[workspace]\nmembers = ["core", "app"]\n`);
    write('core/Cargo.toml', `[package]\nname = "pupil_core"\nversion = "0.1.0"\n`);
    write('core/src/lib.rs', `pub mod ports;\n`);
    write('core/src/ports.rs', `pub trait CacheStore {\n    fn get(&self);\n}\n`);
    write('app/Cargo.toml', `[package]\nname = "app"\nversion = "0.1.0"\n`);
    write('app/src/lib.rs', `pub use pupil_core::ports;\n\npub mod platform;\n`);
    write(
      'app/src/platform.rs',
      `use crate::ports::CacheStore;\n\npub struct SafStorage {\n    root: String,\n}\n\n` +
        `impl CacheStore for SafStorage {\n    fn get(&self) {}\n}\n`
    );
    const { edges } = await load();
    expect(has(edges, 'SafStorage', 'CacheStore', 'trait')).toBe(true);
  });

  it('still resolves an in-repo Rust trait (the gate is not a blanket block)', async () => {
    write(
      'src/lib.rs',
      `pub trait Mapper {\n    fn map(&self) -> u32;\n}\n\n` +
        `pub enum MapperError {\n    Mapper,\n}\n\n` +
        `pub struct Real {\n    n: u32,\n}\n\n` +
        `impl Mapper for Real {\n    fn map(&self) -> u32 { 1 }\n}\n`
    );
    const { edges } = await load();
    expect(has(edges, 'Real', 'Mapper', 'trait')).toBe(true);
    expect(has(edges, 'Real', 'Mapper', 'enum_member')).toBe(false);
  });

  it('keeps a TypeScript class implementing an object-type alias', async () => {
    write(
      'src/api.ts',
      `export type SearchApi = { query(q: string): string };\n\n` +
        `export class LocalSearch implements SearchApi {\n` +
        `  query(q: string): string { return q; }\n}\n`
    );
    const { edges } = await load();
    expect(has(edges, 'LocalSearch', 'SearchApi', 'type_alias')).toBe(true);
  });

  it('does not resolve an import to a type member that shares its name', async () => {
    // `import * as path from 'node:path'` is unresolvable — the module is
    // external — so the name-matcher looked for any node called `path` and
    // found a class property. No language lets you import a type's member.
    write('src/types.ts', `export class Request {\n  path = '';\n  url = '';\n}\n`);
    write(
      'src/run.ts',
      `import * as path from 'node:path';\n\nexport function run() {\n  return path.join('a', 'b');\n}\n`
    );
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows: { tgt: string; tgtKind: string }[] = db
      .prepare(
        `SELECT t.name tgt, t.kind tgtKind
           FROM edges e JOIN nodes t ON t.id = e.target
          WHERE e.kind = 'imports'`
      )
      .all();
    cg.close?.();
    expect(rows.filter((r) => r.tgtKind === 'property' || r.tgtKind === 'field')).toEqual([]);
  });

  it('keeps class extends class and class implements interface', async () => {
    write(
      'src/base.ts',
      `export interface Runner { run(): void }\n` +
        `export class Base { run(): void {} }\n` +
        `export class Child extends Base implements Runner { run(): void {} }\n`
    );
    const { edges } = await load();
    expect(has(edges, 'Child', 'Base', 'class')).toBe(true);
    expect(has(edges, 'Child', 'Runner', 'interface')).toBe(true);
  });
});
