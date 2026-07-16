/**
 * Regression coverage for #1230 — Python attribute calls on literal
 * receivers (e.g. `", ".join(sorted(unresolved))`) were resolving to
 * unrelated project symbols (the nested local `join`) via bare-name
 * name-matching. Two distinct failures stacked:
 *
 *   1. An attribute call with a literal receiver (`", ".`, `[]`, `{}`,
 *      a number) is calling a builtin — the resolver's name-matcher
 *      finds a same-named project symbol and fabricates a call edge.
 *   2. A nested local function inside a sibling function is
 *      lexically unreachable from a different function, but
 *      same-file proximity was promoting it as a match anyway.
 *
 * The fix is in `src/resolution/name-matcher.ts` `matchByExactName`:
 * drop candidates that are nested locals in a callable that is NOT
 * the caller's container or an ancestor of the caller (#1230).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('lexical-scope filter on bare-name resolution (#1230)', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1230-'));
    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.py'], exclude: [] },
    });
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('a str.join on a literal in report_missing does NOT resolve to a nested local join in format_fields', async () => {
    // Repro from the issue body. Before the fix, callees(report_missing)
    // returned the nested local join; after the fix, the call is left
    // unresolved (the method is a builtin, not a project symbol).
    fs.writeFileSync(
      path.join(testDir, 'repro.py'),
      `def format_fields(values):
        def join(vals):
                return "-".join(sorted(vals))
        return join(values)
def report_missing(unresolved):
        return ", ".join(sorted(unresolved))
`
    );
    await cg.indexAll();

    // Verify the issue's reported failure modes are gone.
    const reportMissingNode = (await cg.getNodesByName('report_missing'))[0]!;
    const reportMissingCallees = await cg.getCallees(reportMissingNode.id);
    const calleeNames = reportMissingCallees.map((c) => c.node.name);

    // The nested local `join` must not surface as a callee of
    // `report_missing` — it's lexically unreachable.
    expect(calleeNames).not.toContain('join');
    // Builtin-only `sorted` likewise (it isn't a project symbol).
    expect(calleeNames).not.toContain('sorted');

    // `join`'s only project caller must be `format_fields` (the one
    // that lexically encloses the local), not `report_missing`.
    const joinNode = (await cg.getNodesByName('join'))[0]!;
    const joinCallers = await cg.getCallers(joinNode.id);
    const callerNames = joinCallers.map((c) => c.node.name);
    expect(callerNames).toContain('format_fields');
    expect(callerNames).not.toContain('report_missing');
  });

  it('a nested local IS reachable from its enclosing function (positive case)', async () => {
    // The lexical-scope filter must NOT block the canonical case:
    // the enclosing function calling its own nested helper.
    fs.writeFileSync(
      path.join(testDir, 'positive.py'),
      `def format_fields(values):
        def join(vals):
                return "-".join(sorted(vals))
        return join(values)
`
    );
    await cg.indexAll();

    const formatFieldsNode = (await cg.getNodesByName('format_fields'))[0]!;
    const callees = await cg.getCallees(formatFieldsNode.id);
    const calleeNames = callees.map((c) => c.node.name);
    expect(calleeNames).toContain('join');
  });

  it('a class method named X in Helper, called from sibling Worker: not resolved to Helper.X', async () => {
    // Same scope rule applies to OOP — a class method owned by
    // Helper is not a callee of Worker's methods, no matter how the
    // line-proximity scorer ranks them.
    fs.writeFileSync(
      path.join(testDir, 'classes.py'),
      `class Helper:
        def join(self, vals):
                return "-".join(vals)
class Worker:
        def report_missing(self, unresolved):
                return ", ".join(unresolved)
`
    );
    await cg.indexAll();

    const reportMissingNode = (await cg.getNodesByName('report_missing'))[0]!;
    const callees = await cg.getCallees(reportMissingNode.id);
    const calleeNames = callees.map((c) => c.node.name);
    expect(calleeNames).not.toContain('join');
  });
});
