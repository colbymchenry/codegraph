import { describe, expect, it } from 'vitest';
import { applyDiff, buildSnapshot, diffGraphs, type SnapshotNodeInput } from '../src/graph/graph-diff';
import { replayCommits } from '../src/graph/rebase';
import { analyzeMerge } from '../src/graph/merge-conflicts';
import { analyzeCherryPick } from '../src/graph/cherry-pick';

let nextId = 0;
function fn(file: string, name: string, line: number, extra: Partial<SnapshotNodeInput> = {}): SnapshotNodeInput {
  nextId += 1;
  return {
    id: `n${nextId}`,
    kind: 'function',
    name,
    qualifiedName: `${file}::${name}`,
    filePath: file,
    startLine: line,
    signature: `${name}()`,
    ...extra,
  };
}
const call = (s: SnapshotNodeInput, t: SnapshotNodeInput) => ({ source: s.id, target: t.id, kind: 'calls' });

describe('diffGraphs', () => {
  it('reports added, removed and changed symbols', () => {
    const before = buildSnapshot([fn('a.ts', 'keep', 1), fn('a.ts', 'gone', 5), fn('a.ts', 'edit', 9)], []);
    const after = buildSnapshot(
      [fn('a.ts', 'keep', 1), fn('a.ts', 'fresh', 5), fn('a.ts', 'edit', 9, { signature: 'edit(x)' })],
      [],
    );
    const d = diffGraphs(before, after);
    expect(d.added.map((n) => n.name)).toEqual(['fresh']);
    expect(d.removed.map((n) => n.name)).toEqual(['gone']);
    expect(d.changed.map((c) => [c.after.name, c.fields])).toEqual([['edit', ['signature']]]);
  });

  it('treats a line shift as a move, not remove + add', () => {
    const before = buildSnapshot([fn('a.ts', 'f', 1), fn('a.ts', 'g', 10)], []);
    const after = buildSnapshot([fn('a.ts', 'f', 1), fn('a.ts', 'g', 14)], []);
    const d = diffGraphs(before, after);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.movedCount).toBe(1);
  });

  it('keeps overloads apart by ordinal', () => {
    const before = buildSnapshot([fn('a.ts', 'f', 1), fn('a.ts', 'f', 5)], []);
    const after = buildSnapshot([fn('a.ts', 'f', 1)], []);
    expect(diffGraphs(before, after).removed).toHaveLength(1);
  });

  it('diffs edges by symbol key, ignoring contains', () => {
    const f1 = fn('a.ts', 'f', 1);
    const g1 = fn('a.ts', 'g', 5);
    const f2 = fn('a.ts', 'f', 1);
    const g2 = fn('a.ts', 'g', 5);
    const before = buildSnapshot([f1, g1], [{ source: f1.id, target: g1.id, kind: 'contains' }]);
    const after = buildSnapshot([f2, g2], [call(f2, g2), { source: f2.id, target: g2.id, kind: 'contains' }]);
    const d = diffGraphs(before, after);
    expect(d.edgesAdded).toHaveLength(1);
    expect(d.edgesRemoved).toHaveLength(0);
  });
});

describe('replayCommits', () => {
  it('lets a later commit use what an earlier one introduced, and names the first break', () => {
    // Base has `run`. Commit 1 adds `helper`; commit 2 calls it; commit 3 calls a symbol that never exists.
    const run = () => fn('a.ts', 'run', 1);
    const base = buildSnapshot([run()], []);
    const h = fn('a.ts', 'helper', 5);
    const s1 = buildSnapshot([run(), h], []);
    const r2 = run();
    const h2 = fn('a.ts', 'helper', 5);
    const s2 = buildSnapshot([r2, h2], [{ source: r2.id, target: h2.id, kind: 'calls' }]);
    const gone = fn('a.ts', 'gone', 9);
    const r3 = run();
    const h3 = fn('a.ts', 'helper', 5);
    const s3 = buildSnapshot([r3, h3, gone], [{ source: r3.id, target: h3.id, kind: 'calls' }]);
    const onto = buildSnapshot([run()], []);
    const ok = replayCommits(base, onto, s2, [
      { sha: 'c1', subject: 'add helper', parent: base, commit: s1 },
      { sha: 'c2', subject: 'use helper', parent: s1, commit: s2 },
    ]);
    expect(ok.steps.map((s) => s.verdict)).toEqual(['safe', 'safe']);
    expect(ok.firstBreaking).toBeNull();

    // Skip commit 1's introduction on the target: commit 2 alone is missing `helper`.
    const broken = replayCommits(base, onto, s3, [{ sha: 'c2', subject: 'use helper', parent: s1, commit: s2 }]);
    expect(broken.firstBreaking?.sha).toBe('c2');
    expect(broken.firstBreaking?.analysis.missing[0]?.kind).toBe('absent');
  });

  it('applyDiff makes the change on top of a snapshot', () => {
    const before = buildSnapshot([fn('a.ts', 'f', 1), fn('a.ts', 'g', 5)], []);
    const after = buildSnapshot([fn('a.ts', 'f', 1, { signature: 'f(x)' }), fn('a.ts', 'h', 9)], []);
    const out = applyDiff(before, diffGraphs(before, after));
    expect([...out.nodes.values()].map((n) => n.name).sort()).toEqual(['f', 'h']);
  });
});

describe('analyzeCherryPick', () => {
  it('reports a symbol the commit uses that the target lacks', () => {
    const helper = fn('lib.ts', 'helper', 1);
    const user0 = fn('app.ts', 'run', 1);
    const parent = buildSnapshot([helper, user0], []);
    const h2 = fn('lib.ts', 'helper', 1);
    const u2 = fn('app.ts', 'run', 1);
    const commit = buildSnapshot([h2, u2, fn('app.ts', 'more', 9)], []);
    // The commit adds a call from `more` to `helper`.
    const m = fn('app.ts', 'more', 9);
    const commit2 = buildSnapshot([h2, u2, m], [{ source: m.id, target: h2.id, kind: 'calls' }]);
    const onto = buildSnapshot([fn('app.ts', 'run', 1)], []); // no helper
    const r = analyzeCherryPick(parent, commit2, onto);
    expect(r.missing.map((x) => [x.kind, x.usedBy.length])).toEqual([['absent', 1]]);
    expect(commit.nodes.size).toBe(3);
  });

  it('does not count symbols the commit introduces itself', () => {
    const parent = buildSnapshot([fn('a.ts', 'x', 1)], []);
    const nx = fn('a.ts', 'x', 1);
    const ny = fn('a.ts', 'y', 5);
    const commit = buildSnapshot([nx, ny], [{ source: nx.id, target: ny.id, kind: 'calls' }]);
    const onto = buildSnapshot([fn('a.ts', 'x', 1)], []);
    expect(analyzeCherryPick(parent, commit, onto).missing).toEqual([]);
  });

  it('flags a dependency whose signature differs on the target', () => {
    const parent = buildSnapshot([fn('l.ts', 'f', 1), fn('a.ts', 'g', 1)], []);
    const f = fn('l.ts', 'f', 1);
    const g = fn('a.ts', 'g', 1);
    const commit = buildSnapshot([f, g], [{ source: g.id, target: f.id, kind: 'calls' }]);
    const onto = buildSnapshot([fn('l.ts', 'f', 1, { signature: 'f(extra)' }), fn('a.ts', 'g', 1)], []);
    expect(analyzeCherryPick(parent, commit, onto).missing.map((x) => x.kind)).toEqual(['contract-changed']);
  });

  it('flags editing a symbol the target does not have, and is safe otherwise', () => {
    const parent = buildSnapshot([fn('a.ts', 'f', 1)], []);
    const commit = buildSnapshot([fn('a.ts', 'f', 1, { signature: 'f(x)' })], []);
    expect(analyzeCherryPick(parent, commit, buildSnapshot([], [])).missing.map((x) => x.kind)).toEqual(['edits-absent']);
    const same = buildSnapshot([fn('a.ts', 'f', 1)], []);
    expect(analyzeCherryPick(parent, commit, same).missing).toEqual([]);
  });
});

describe('analyzeMerge', () => {
  const baseNodes = () => [fn('lib.ts', 'compute', 1), fn('app.ts', 'main', 1)];

  it('flags a caller added on one side to a symbol the other renamed', () => {
    const bn = baseNodes();
    const base = buildSnapshot(bn, []);
    // A renames compute -> calculate.
    const a = buildSnapshot([fn('lib.ts', 'calculate', 1), fn('app.ts', 'main', 1)], []);
    // B adds a new function that calls compute.
    const b1 = [fn('lib.ts', 'compute', 1), fn('app.ts', 'main', 1), fn('app.ts', 'extra', 9)];
    const b = buildSnapshot(b1, [call(b1[2]!, b1[0]!)]);
    const m = analyzeMerge(base, a, b);
    const broken = m.conflicts.filter((c) => c.kind === 'broken-caller');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.side).toBe('a');
    expect(broken[0]!.dependents[0]).toContain('extra');
  });

  it('flags a symbol edited differently on both sides, not identically', () => {
    const base = buildSnapshot([fn('a.ts', 'f', 1)], []);
    const a = buildSnapshot([fn('a.ts', 'f', 1, { signature: 'f(a)' })], []);
    const b = buildSnapshot([fn('a.ts', 'f', 1, { signature: 'f(b)' })], []);
    const same = buildSnapshot([fn('a.ts', 'f', 1, { signature: 'f(a)' })], []);
    expect(analyzeMerge(base, a, b).conflicts.map((c) => c.kind)).toContain('both-changed');
    expect(analyzeMerge(base, a, same).conflicts.filter((c) => c.kind === 'both-changed')).toEqual([]);
  });

  it('flags delete-vs-edit', () => {
    const base = buildSnapshot([fn('a.ts', 'f', 1)], []);
    const deleted = buildSnapshot([], []);
    const edited = buildSnapshot([fn('a.ts', 'f', 1), fn('a.ts', 'h', 9)], []);
    const kinds = analyzeMerge(base, deleted, edited).conflicts.map((c) => c.kind);
    expect(kinds).toContain('delete-vs-edit');
  });

  it('does not call an identical rename on both sides a delete-vs-edit', () => {
    const base = buildSnapshot([fn('lib.ts', 'compute', 1)], []);
    const renamed = () => buildSnapshot([fn('lib.ts', 'calculate', 1)], []);
    expect(analyzeMerge(base, renamed(), renamed()).conflicts).toEqual([]);
  });

  it('reports no conflicts for independent changes', () => {
    const base = buildSnapshot([fn('a.ts', 'f', 1), fn('b.ts', 'g', 1)], []);
    const a = buildSnapshot([fn('a.ts', 'f', 1, { signature: 'f(x)' }), fn('b.ts', 'g', 1)], []);
    const b = buildSnapshot([fn('a.ts', 'f', 1), fn('b.ts', 'g', 1), fn('b.ts', 'k', 7)], []);
    expect(analyzeMerge(base, a, b).conflicts).toEqual([]);
  });
});
