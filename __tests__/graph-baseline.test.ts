/**
 * End-to-end graph baseline: index a checked-in fixture and compare the resulting graph against a
 * committed golden file.
 *
 * What this catches that nothing else does. The kernel↔wasm parity suite compares two live
 * extractors to each other, so it stays green when both drop the same edge; the parser and
 * resolver unit tests assert on snippets, not on what actually landed in the database. After an
 * upstream sync or a parser upgrade, the question "which relationships did we lose, and which
 * wrong ones appeared" had no answer that did not involve reading a diff by hand.
 *
 * The fixture is deliberately small and deliberately adversarial: two same-named methods that a
 * bare name match would confuse, a callback reachable only through a parameter, and a file whose
 * every line looks like a call site and is not one.
 *
 * Line numbers are part of the snapshot. Editing the fixture without regenerating the golden is a
 * failure, and that is intended: a moved symbol is exactly the kind of change worth seeing.
 *
 * Regenerate with (this file only — not a full test run):
 *
 *   CODEGRAPH_UPDATE_GRAPH_GOLDEN=1 npx vitest run --project engine __tests__/graph-baseline.test.ts
 *
 * then read the diff before committing it. A regeneration that grows the file is a review
 * question, not a chore.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { readGraphSnapshot, serializeSnapshot, type GraphSnapshot } from './graph-baseline-utils';

const FIXTURE = path.join(__dirname, 'fixtures', 'graph-baseline', 'project');
const GOLDEN = path.join(__dirname, 'fixtures', 'graph-baseline', 'golden', 'graph.json');
const UPDATE = process.env.CODEGRAPH_UPDATE_GRAPH_GOLDEN === '1';

const SECTIONS = ['nodes', 'edges', 'unresolvedRefs', 'files'] as const;

interface EdgeLine {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  provenance: string | null;
}

interface RefLine {
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  file_path: string;
  status: string;
  name_tail: string | null;
}

/** True for a natural node key that names something in the given file. */
function keyInFile(key: string, file: string): boolean {
  return key.split('|')[1] === file;
}

function keyName(key: string): string {
  return key.split('|')[2] ?? '';
}

function jsonLines<T>(lines: string[]): T[] {
  return lines.map((line) => JSON.parse(line) as T);
}

/**
 * The first place two sorted line lists disagree, as a sentence a reader can act on.
 *
 * A plain string compare of the whole file prints thousands of lines and hides the one that
 * changed. The count mismatch is reported separately because "one edge too many" and "one edge
 * became another" are different bugs.
 */
function firstDifference(section: string, expected: string[], actual: string[]): string | null {
  if (expected.length !== actual.length) {
    const only = actual.filter((line) => !expected.includes(line));
    const gone = expected.filter((line) => !actual.includes(line));
    return [
      `${section}: ${expected.length} line(s) in the golden, ${actual.length} in this run.`,
      ...only.slice(0, 5).map((line) => `  + ${line}`),
      ...gone.slice(0, 5).map((line) => `  - ${line}`),
      only.length > 5 || gone.length > 5 ? '  (more differences omitted)' : '',
    ].filter(Boolean).join('\n');
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) {
      return `${section}: line ${index} differs.\n  golden: ${expected[index]}\n  actual: ${actual[index]}`;
    }
  }
  return null;
}

describe('end-to-end graph baseline', () => {
  let dir: string;
  let project: CodeGraph;
  let snapshot: GraphSnapshot;
  let edges: EdgeLine[];
  let refs: RefLine[];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-graph-baseline-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    // A stray index in the checked-in tree would be copied in and reused.
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });

    project = CodeGraph.initSync(dir);
    await project.indexAll();
    project.resolveReferences();

    snapshot = readGraphSnapshot(dir);
    edges = jsonLines<EdgeLine>(snapshot.edges);
    refs = jsonLines<RefLine>(snapshot.unresolvedRefs);
  }, 180_000);

  afterAll(async () => {
    await project?.close();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* Windows keeps a handle for a moment; the temp dir is not worth failing over. */
      }
    }
  });

  it('indexes the fixture at all, calls included', () => {
    // Before the golden compare, so an extractor that produced nothing fails as "the index came
    // out empty" instead of as a diff of several thousand lines.
    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(snapshot.files.length).toBe(6);
    const calls = edges.filter((edge) => edge.kind === 'calls');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('matches the committed golden', () => {
    if (UPDATE) {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, serializeSnapshot(snapshot));
      return;
    }
    expect(fs.existsSync(GOLDEN)).toBe(true);
    const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as GraphSnapshot;
    for (const section of SECTIONS) {
      expect(firstDifference(section, expected[section], snapshot[section])).toBeNull();
    }
  });

  it('resolves the same-named method to the right class', () => {
    // `beta.ts` calls `registry.load(...)`. `Alpha.load` exists too, in another file, and a
    // resolver that fell back to matching the bare name would attach the call to it.
    const beta = jsonLines<EdgeLine>(snapshot.edges).filter(
      (edge) => keyInFile(edge.source, 'src/features/beta.ts') && keyName(edge.target) === 'load'
    );
    expect(beta.length).toBeGreaterThan(0);
    expect(beta.every((edge) => keyInFile(edge.target, 'src/core/registry.ts'))).toBe(true);

    const wrong = beta.filter((edge) => keyInFile(edge.target, 'src/features/alpha.ts'));
    expect(wrong).toEqual([]);
  });

  it('has exactly one implements edge, from Alpha to Greeter', () => {
    const implementsEdges = edges.filter((edge) => edge.kind === 'implements');
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]!.source).toContain('src/features/alpha.ts');
    expect(implementsEdges[0]!.target).toContain('src/core/types.ts');
  });

  it('records no edge for anything in not-a-call.ts that only looks like a call', () => {
    const fromFile = edges.filter((edge) => keyInFile(edge.source, 'src/features/not-a-call.ts'));
    // `heldOnly` and `passedAlong` take a `Registry` and hand it back without calling it; the
    // import itself is a real relationship, so only call-like edges are forbidden here.
    const callLike = fromFile.filter(
      (edge) => edge.kind === 'calls' && keyInFile(edge.target, 'src/core/registry.ts')
    );
    expect(callLike).toEqual([]);
  });

  it('leaves the untyped receiver unresolved instead of inventing an edge', () => {
    // `unknownReceiver` casts to `{ load(...) }`: a real member name on a type the index cannot
    // know. The honest record is an unresolved reference, not a guessed edge. The reference is
    // recorded under the receiver it was written through, so it is matched on `name_tail`.
    const unresolved = refs.filter(
      (ref) => ref.file_path === 'src/features/not-a-call.ts' && ref.name_tail === 'load'
    );
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every((ref) => ref.status === 'failed')).toBe(true);
    const invented = edges.filter(
      (edge) => keyInFile(edge.source, 'src/features/not-a-call.ts') && keyName(edge.target) === 'load'
    );
    expect(invented).toEqual([]);
  });

  it('records a call through a parameter as unresolved rather than as a call edge', () => {
    // The other half of the same rule: `cb` is called but its target is only known at run time.
    // Guessing one would be worse than saying so.
    const callback = refs.filter(
      (ref) => ref.from_node_id.includes('|withCallback|') && ref.reference_name === 'cb'
    );
    expect(callback).toHaveLength(1);
    expect(callback[0]!.status).toBe('failed');
  });

  it('keeps a cross-module re-export reachable from the entry point', () => {
    // `src/index.ts` names symbols it does not define. Losing the re-export would strand them:
    // nothing would fail, the symbols would just stop being found through the entry point.
    const reexports = edges.filter(
      (edge) => keyInFile(edge.source, 'src/index.ts') && edge.kind === 'imports'
    );
    expect(reexports.map((edge) => keyInFile(edge.target, 'src/features/alpha.ts')).some(Boolean)).toBe(true);
    expect(reexports.map((edge) => keyInFile(edge.target, 'src/features/beta.ts')).some(Boolean)).toBe(true);
  });
});

describe('end-to-end graph baseline: a deleted file leaves nothing behind', () => {
  let dir: string;
  let project: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-graph-baseline-del-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    project = CodeGraph.initSync(dir);
    await project.indexAll();
  }, 180_000);

  afterAll(async () => {
    await project?.close();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* see above */
      }
    }
  });

  it('syncs away the nodes, the edges and the dangling endpoints', async () => {
    fs.rmSync(path.join(dir, 'src', 'features', 'beta.ts'));
    await project.sync();

    const snapshot = readGraphSnapshot(dir);
    expect(snapshot.nodes.some((line) => line.includes('src/features/beta.ts'))).toBe(false);
    expect(snapshot.edges.some((line) => line.includes('src/features/beta.ts'))).toBe(false);

    // An edge whose endpoint no longer exists is invisible to a per-file assertion above: the
    // remaining file keeps its edge and the row points at nothing. The helper renders an unknown
    // endpoint as `unresolved:<id>`, so this is the whole dangling check.
    const dangling = jsonLines<EdgeLine>(snapshot.edges).filter(
      (edge) => edge.source.startsWith('unresolved:') || edge.target.startsWith('unresolved:')
    );
    expect(dangling).toEqual([]);
  }, 180_000);
});
