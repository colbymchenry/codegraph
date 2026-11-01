/**
 * `codegraph orphans`' unresolved-reference and text-mention checks: a
 * candidate with no incoming edge is only a suspicion, so orphans checks the
 * failed unresolved references and then the indexed files' text itself before
 * calling it orphaned. Run on a real CodeGraph index of a fixture git repo
 * through `runOrphans`.
 *
 * One repo: commit C1 (tagged), then C2 adds every symbol below in new files,
 * so each is added by rule 1. Indexed once at C2 in beforeAll.
 *
 *   - Unresolved reference: `pub fn cross_target()` in crate a (a/src/lib.rs), called as
 *     `other_crate::cross_target()` from crate b's main (b/src/main.rs). No
 *     crate is named other_crate, so the resolver leaves that reference failed
 *     with name_tail `cross_target`: guessed with unresolved evidence.
 *   - Text mention: `mentionedOnly` (src/m.ts), named only in a comment in src/n.ts (no
 *     edge, no unresolved row): guessed with a mention at src/n.ts:1.
 *   - Language and order: `crossLang` (src/cl.ts, TypeScript) is called only from Rust
 *     (`other_crate::crossLang()` in b/src/cl.rs), a failed rust row. Another
 *     language's row is no evidence, so `unresolved` is empty and the text
 *     mention of that line guesses it. `Bx::bx_open` (a/src/bx.rs) has failed
 *     Rust refs from b/src/a0.rs (`other_crate::bx_open()`), its own file
 *     (the same call in `use_other`) and b/src/o1.rs
 *     (`other_crate::Bx::bx_open()`): listed container-qualified first, then
 *     own file, then the rest, where path order alone would put o1 last.
 *   - Controls: `nowhereElse` (src/solo.ts), named nowhere else, and
 *     `selfNamed` (src/self.ts), named only in a comment inside its own span,
 *     stay orphaned.
 *   - Evidence caps: a synthetic report with 25 mentions renders 3 in text
 *     then `+22 more`, and 20 in JSON with mentionCount 25.
 *
 * The "fixture:" tests assert the index facts a case depends on first, so a
 * change in extraction or resolution fails there rather than at the orphans
 * assertion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { runOrphans, type OrphansArgs } from '../src/graph/orphans-run';
import { jsonReport, textReport } from '../src/graph/orphans-render';

/** The report text of a run that must succeed. */
async function output(root: string, args: OrphansArgs): Promise<string> {
  const r = await runOrphans(root, args);
  if (!r.ok) throw new Error(`orphans failed: ${r.message}`);
  return r.output;
}

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=orphans-test', '-c', 'user.email=orphans-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

interface Unresolved { name: string; kind: string; path: string; line: number }
interface Mention { path: string; line: number }
interface Entry { id: string; name: string; kind: string; path: string; span: string }
interface Guessed extends Entry {
  edges: unknown[];
  unresolved: Unresolved[];
  mentions: Mention[];
  unresolvedCount: number;
  mentionCount: number;
}
interface OrphansJson { added: number; orphans: Entry[]; guessed: Guessed[] }

const C1_FILES: Record<string, string> = {
  'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n',
  'a/Cargo.toml': '[package]\nname = "a_crate"\nversion = "0.1.0"\nedition = "2021"\n',
  'a/src/lib.rs': 'pub fn existing_a() -> u32 {\n    1\n}\n',
  'b/Cargo.toml': '[package]\nname = "b_crate"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/base.ts': 'export function base(): number {\n  return 0;\n}\n',
};

const C2_FILES: Record<string, string> = {
  'a/src/cross.rs': 'pub fn cross_target() -> u32 {\n    2\n}\n',
  'b/src/main.rs': 'fn main() {\n    let v = other_crate::cross_target();\n    println!("{}", v);\n}\n',
  'src/m.ts': 'export function mentionedOnly(): number {\n  return 1;\n}\n',
  'src/n.ts': '// mentionedOnly is wired in by the plugin loader\nexport const N = 1;\n',
  'src/solo.ts': 'export function nowhereElse(): number {\n  return 2;\n}\n',
  'src/self.ts': 'export function selfNamed(): number {\n  // selfNamed returns three\n  return 3;\n}\n',
  'src/cl.ts': 'export function crossLang(): number {\n  return 4;\n}\n',
  'b/src/cl.rs': 'pub fn call_cl() -> u32 {\n    other_crate::crossLang()\n}\n',
  'a/src/bx.rs':
    'pub struct Bx;\n\nimpl Bx {\n    pub fn bx_open() -> u32 {\n        5\n    }\n}\n\n' +
    'pub fn use_other() -> u32 {\n    other_crate::bx_open()\n}\n',
  'b/src/a0.rs': 'pub fn a0() -> u32 {\n    other_crate::bx_open()\n}\n',
  'b/src/o1.rs': 'pub fn o1() -> u32 {\n    other_crate::Bx::bx_open()\n}\n',
};

interface UnresolvedRow { reference_name: string; reference_kind: string; file_path: string; line: number; status: string; name_tail: string; language: string }
interface EdgeRow { source: string; target: string; kind: string }
interface NodeRow { id: string; name: string; file_path: string }

let root = '';
let report: OrphansJson;
let text = '';
let unresolved: UnresolvedRow[] = [];
let edges: EdgeRow[] = [];
let nodes: NodeRow[] = [];

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-evidence-')));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(C1_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C1');
  git(root, 'tag', 'C1');
  for (const [rel, content] of Object.entries(C2_FILES)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'C2: add symbols');

  const cg = await CodeGraph.init(root);
  await cg.indexAll();
  cg.close();

  const conn = DatabaseConnection.open(getDatabasePath(root), { readOnly: true });
  try {
    const db = conn.getDb();
    unresolved = db.prepare('SELECT reference_name, reference_kind, file_path, line, status, name_tail, language FROM unresolved_refs').all() as unknown as UnresolvedRow[];
    edges = db.prepare("SELECT source, target, kind FROM edges WHERE kind NOT IN ('contains','exports')").all() as unknown as EdgeRow[];
    nodes = db.prepare("SELECT id, name, file_path FROM nodes WHERE kind NOT IN ('file','import','parameter')").all() as unknown as NodeRow[];
  } finally {
    conn.close();
  }

  report = JSON.parse(await output(root, { base: 'C1', format: 'json' })) as OrphansJson;
  text = await output(root, { base: 'C1', format: 'text' });
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const incoming = (name: string): EdgeRow[] => {
  const ids = new Set(nodes.filter((n) => n.name === name).map((n) => n.id));
  return edges.filter((e) => ids.has(e.target));
};
const guessed = (name: string): Guessed | undefined => report.guessed.find((g) => g.name === name);
const orphanNames = (): string[] => report.orphans.map((o) => o.name);

describe('orphans unresolved references', () => {
  it('fixture: cross_target has no incoming edge and a failed unresolved ref with that name_tail from b/src/main.rs', () => {
    expect(nodes.some((n) => n.name === 'cross_target' && n.file_path === 'a/src/cross.rs')).toBe(true);
    expect(incoming('cross_target')).toEqual([]);
    const rows = unresolved.filter((u) => u.status === 'failed' && u.name_tail === 'cross_target');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((u) => u.file_path === 'b/src/main.rs' && u.line === 2)).toBe(true);
  });

  it('a candidate named by a failed unresolved reference is guessed with that evidence, not orphaned', () => {
    expect(orphanNames()).not.toContain('cross_target');
    const g = guessed('cross_target');
    expect(g).toBeDefined();
    expect(g!.edges).toEqual([]);
    expect(g!.unresolvedCount).toBeGreaterThanOrEqual(1);
    expect(g!.unresolved.length).toBe(Math.min(20, g!.unresolvedCount));
    expect(g!.unresolved).toContainEqual(expect.objectContaining({ path: 'b/src/main.rs', line: 2 }));
    const ev = g!.unresolved.find((u) => u.path === 'b/src/main.rs')!;
    expect(ev.name).toMatch(/cross_target$/);
    expect(typeof ev.kind).toBe('string');
    expect(g!.mentions).toEqual([]);
    expect(g!.mentionCount).toBe(0);
  });

  it('text marks the evidence line as unresolved', () => {
    expect(text).toMatch(/^\s+unresolved\b.*cross_target.*b\/src\/main\.rs:2/m);
  });
});

describe('orphans unresolved-reference language and ordering', () => {
  it('fixture: crossLang (TypeScript) has no incoming edge and a failed rust ref named crossLang from b/src/cl.rs', () => {
    expect(nodes.some((n) => n.name === 'crossLang' && n.file_path === 'src/cl.ts')).toBe(true);
    expect(incoming('crossLang')).toEqual([]);
    const rows = unresolved.filter((u) => u.status === 'failed' && u.name_tail === 'crossLang');
    expect(rows).toContainEqual(expect.objectContaining({ file_path: 'b/src/cl.rs', line: 2, language: 'rust' }));
    expect(rows.every((u) => u.language === 'rust')).toBe(true);
  });

  it('a failed ref from another language is no unresolved evidence; the text mention still guesses it', () => {
    expect(orphanNames()).not.toContain('crossLang');
    const g = guessed('crossLang');
    expect(g).toBeDefined();
    expect(g!.unresolved).toEqual([]);
    expect(g!.unresolvedCount).toBe(0);
    expect(g!.mentions).toEqual([{ path: 'b/src/cl.rs', line: 2 }]);
  });

  it('fixture: Bx::bx_open has no incoming edge and failed rust refs from a/src/bx.rs, b/src/a0.rs and b/src/o1.rs', () => {
    expect(incoming('bx_open')).toEqual([]);
    const rows = unresolved.filter((u) => u.status === 'failed' && u.name_tail === 'bx_open');
    expect(rows.map((u) => u.file_path).sort()).toEqual(['a/src/bx.rs', 'b/src/a0.rs', 'b/src/o1.rs']);
    expect(rows.find((u) => u.file_path === 'b/src/o1.rs')!.reference_name).toMatch(/Bx::bx_open$/);
  });

  it('unresolved evidence leads with the container-qualified ref, then the own-file ref, then the rest', () => {
    const g = guessed('bx_open');
    expect(g).toBeDefined();
    expect(g!.unresolved.map((u) => u.path)).toEqual(['b/src/o1.rs', 'a/src/bx.rs', 'b/src/a0.rs']);
  });
});

describe('orphans text mentions', () => {
  it('fixture: mentionedOnly has no incoming edge and no unresolved ref', () => {
    expect(incoming('mentionedOnly')).toEqual([]);
    expect(unresolved.filter((u) => u.name_tail === 'mentionedOnly' || u.reference_name.endsWith('mentionedOnly'))).toEqual([]);
  });

  it('a candidate named only in a comment elsewhere is guessed with a mention at that file:line', () => {
    expect(orphanNames()).not.toContain('mentionedOnly');
    const g = guessed('mentionedOnly');
    expect(g).toBeDefined();
    expect(g!.edges).toEqual([]);
    expect(g!.unresolved).toEqual([]);
    expect(g!.unresolvedCount).toBe(0);
    expect(g!.mentions).toEqual([{ path: 'src/n.ts', line: 1 }]);
    expect(g!.mentionCount).toBe(1);
  });

  it('text marks the evidence line as mention', () => {
    expect(text).toMatch(/^\s+mention\b.*src\/n\.ts:1/m);
  });
});

describe('orphans evidence controls', () => {
  it('a candidate named nowhere else stays orphaned', () => {
    expect(orphanNames()).toContain('nowhereElse');
    expect(guessed('nowhereElse')).toBeUndefined();
  });

  it('a candidate named only inside its own span stays orphaned', () => {
    expect(orphanNames()).toContain('selfNamed');
    expect(guessed('selfNamed')).toBeUndefined();
  });
});

describe('orphans evidence caps', () => {
  const mentions = Array.from({ length: 25 }, (_, i) => ({ path: 'src/z.ts', line: i + 1 }));
  const r = {
    basis: 'C1...HEAD', mergeBase: '0123456789abcdef', added: 1, orphans: [], preImageUnread: 0, searchUnread: 0,
    excluded: { test: 0, implementation: 0, constructor: 0, entry: 0 },
    guessed: [{
      id: 'x', name: 'many', kind: 'function', path: 'src/many.ts', span: 'L1-L3',
      edges: [], unresolved: [], mentions, edgeCount: 0, unresolvedCount: 0, mentionCount: 25,
    }],
  };

  it('text prints at most 3 mentions, then +N more', () => {
    const lines = textReport(r).split('\n').filter((l) => /^\s+mention\b/.test(l));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/src\/z\.ts:1$/);
    expect(lines[3]).toMatch(/\+22 more$/);
  });

  it('json carries at most 20 mentions and the full count', () => {
    const j = JSON.parse(jsonReport(r)) as { guessed: Guessed[] };
    expect(j.guessed[0].mentions).toHaveLength(20);
    expect(j.guessed[0].mentionCount).toBe(25);
  });
});
