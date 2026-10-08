/**
 * EXACT targets in `codegraph_explore`: a qualified name (`SQLCompiler.as_sql`)
 * or a line anchor (`compiler.py:776`, `compiler.py lines 900-1003`).
 *
 * The originating gap (django, measured 2026-09-27 on main and on every branch
 * since): `SQLCompiler.as_sql pre_sql_setup get_select` returned `get_select`
 * and `pre_sql_setup` in full and `SQLCompiler.as_sql` — the qualified name,
 * step 1 of the rendered Flow, 226 lines — as ONE signature line. compiler.py
 * is a base+subclasses "family" file, so it renders as a per-symbol focused
 * view, and that view chose bodies in SOURCE order within a tier: the unnamed
 * bridge `get_qualify_sql` and `get_select` sit above `as_sql` in the file, took
 * the cap, and the method the agent asked for collapsed. Its follow-ups
 * (`SQLCompiler.as_sql full body compiler.py:776`, `compiler.py lines 900-1003`)
 * pinned the file but dropped the line numbers, so they returned other methods'
 * clusters — and every agent run ended in a Read of compiler.py.
 *
 * The fixture is that file in miniature (Python, like django): `SQLCompiler`
 * with `get_select` and `get_qualify_sql` above a larger `as_sql`, three
 * subclasses overriding `as_sql`, and a second family file with a base method
 * too big for any budget.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler } from '../src/mcp/tools';
import CodeGraph from '../src/index';

/** Line numbers rendered for `file` in an explore response. */
function renderedLines(text: string, file: string): Set<number> {
  const out = new Set<number>();
  let current: string | null = null;
  let inFence = false;
  for (const line of text.split('\n')) {
    const header = /^\*\*`([^`]+)`\*\*/.exec(line);
    if (header && !inFence) { current = header[1]!; continue; }
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence && current === file) {
      const m = /^(\d+)\t/.exec(line);
      if (m) out.add(Number(m[1]));
    }
  }
  return out;
}

/** The `**`<file>`**` section, header through the line before the next file header. */
function sectionFor(text: string, file: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`**\`${file}\`**`));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('**`')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** `n` filler statements, each a distinct line so nothing dedups or folds. */
function filler(tag: string, n: number, indent = '        '): string {
  return Array.from({ length: n }, (_, i) =>
    `${indent}${tag}_${i} = self.query.alias_refcount.get("${tag}_${i}", 0) + len(self.query.select)`,
  ).join('\n');
}

/**
 * Unrelated methods, so compiler.py is a real family file's size (django's is
 * 2,291 lines): small enough to ship WHOLE, the file would answer every
 * question by accident and hide the gap.
 */
function helpers(n: number): string {
  return Array.from({ length: n }, (_, i) => `
    def helper_${i}(self, value):
        """Unrelated helper ${i}."""
        first = self.query.alias_map.get(value)
        second = self.query.alias_refcount.get(value, 0)
        third = self.query.external_aliases.get(value, False)
        return first, second, third`).join('\n');
}

const COMPILER = 'compiler.py';
const PLANNER = 'planner.py';

describe('codegraph_explore — exact targets (qualified names, line anchors)', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  const lineOf: Record<string, number> = {};

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-exact-'));

    // compiler.py — get_select and get_qualify_sql ABOVE as_sql, as in django.
    const compiler = `
class SQLCompiler:
    def pre_sql_setup(self, with_col_aliases=False):
        # PRE_SQL_SETUP_BODY
        self.setup_query(with_col_aliases=with_col_aliases)
        order_by = self.get_order_by()
        return order_by

    def setup_query(self, with_col_aliases=False):
        self.select = self.get_select(with_col_aliases=with_col_aliases)
        return self.select

    def get_order_by(self):
        return []

    def get_select(self, with_col_aliases=False):
        # GET_SELECT_BODY
${filler('sel', 34)}
        return []

    def get_qualify_sql(self):
        # GET_QUALIFY_BODY
${filler('qual', 34)}
        inner = self.get_select()
        return inner

    def as_sql(self, with_limits=True, with_col_aliases=False):
        # AS_SQL_HEAD
        order_by = self.pre_sql_setup(with_col_aliases=with_col_aliases)
${filler('head', 30)}
        result = self.get_qualify_sql()
${filler('tail', 30)}
        return result  # AS_SQL_TAIL_MARKER

    def execute_sql(self):
        sql = self.as_sql()
        return sql


${helpers(40)}

def render_sql(compiler):
    return SQLCompiler.as_sql(compiler)


class SQLInsertCompiler(SQLCompiler):
    def as_sql(self):
        # INSERT_AS_SQL_BODY
        return super().as_sql()

    def execute_sql(self):
        sql = self.as_sql()
        return sql


class SQLUpdateCompiler(SQLCompiler):
    def as_sql(self):
        # UPDATE_AS_SQL_BODY
        return super().as_sql()

    def pre_sql_setup(self):
        # UPDATE_PRE_SQL_SETUP_BODY
        return super().pre_sql_setup()


class SQLDeleteCompiler(SQLCompiler):
    def as_sql(self):
        # DELETE_AS_SQL_BODY
        return super().as_sql()
`.trimStart();
    fs.writeFileSync(path.join(testDir, COMPILER), compiler);
    const compilerLines = compiler.split('\n');
    const find = (lines: string[], needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
    lineOf.asSqlDef = find(compilerLines, 'def as_sql(self, with_limits');
    lineOf.asSqlTail = find(compilerLines, 'AS_SQL_TAIL_MARKER');
    lineOf.asSqlTailStart = find(compilerLines, 'result = self.get_qualify_sql()') + 1;

    // planner.py — a family whose base method is too big for ANY budget. It
    // calls `stage()` (the spine's next hop) near its END, so a head-only cut
    // would lose the very line the flow runs through.
    const planner = `
class Planner:
    def plan(self, query):
        # PLAN_HEAD
${filler('plan', 420)}
        staged = self.stage(query)  # PLAN_CALLS_STAGE
${filler('post', 6)}
        return staged

    def stage(self, query):
        return self.finalize(query)

    def finalize(self, query):
        # FINALIZE_BODY
        return query

    def explain_plan(self, query):
        # EXPLAIN_PLAN_BODY
        return str(query)


class HashPlanner(Planner):
    def plan(self, query):
        return super().plan(query)


class MergePlanner(Planner):
    def plan(self, query):
        return super().plan(query)


class NestedPlanner(Planner):
    def plan(self, query):
        return super().plan(query)
`.trimStart();
    fs.writeFileSync(path.join(testDir, PLANNER), planner);
    lineOf.planCallsStage = find(planner.split('\n'), 'PLAN_CALLS_STAGE');

    // Other `as_sql`s, so the bare name is a family (as django's 110 are).
    fs.writeFileSync(path.join(testDir, 'lookups.py'), `
class Exact:
    def as_sql(self, compiler, connection):
        return "%s = %s"


class IExact:
    def as_sql(self, compiler, connection):
        return "UPPER(%s) = UPPER(%s)"
`.trimStart());

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.py'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const explore = async (query: string): Promise<string> => {
    const result = await handler.execute('codegraph_explore', { query });
    return result.content?.[0]?.text ?? '';
  };

  it('fixture sanity: the flow runs as_sql → get_qualify_sql → get_select and compiler.py goes focused', async () => {
    const text = await explore('SQLCompiler.as_sql pre_sql_setup get_select');
    expect(text).toContain('**Flow (call path among the symbols you queried)');
    expect(text).toMatch(/1\. as_sql \(compiler\.py:\d+\)[\s\S]*2\. get_qualify_sql[\s\S]*3\. get_select/);
    expect(sectionFor(text, COMPILER), 'the family file renders as a per-symbol view').toContain('· focused');
  });

  it('returns the qualified method\'s WHOLE body, not its signature line', async () => {
    const text = await explore('SQLCompiler.as_sql pre_sql_setup get_select');
    const section = sectionFor(text, COMPILER);
    const lines = renderedLines(text, COMPILER);
    for (let ln = lineOf.asSqlDef!; ln <= lineOf.asSqlTail!; ln++) {
      expect(lines.has(ln), `as_sql line ${ln} rendered`).toBe(true);
    }
    expect(section).toContain('AS_SQL_TAIL_MARKER');
    // The other named step still gets its body too.
    expect(section).toContain('GET_SELECT_BODY');
  });

  it('keeps the family skeleton for the subclasses: their as_sql overrides stay signatures', async () => {
    const text = await explore('SQLCompiler.as_sql pre_sql_setup get_select');
    const section = sectionFor(text, COMPILER);
    expect(section).not.toContain('INSERT_AS_SQL_BODY');
    expect(section).not.toContain('DELETE_AS_SQL_BODY');
  });

  it('leads the blast radius with the qualified method, not a same-named override', async () => {
    const text = await explore('SQLCompiler.as_sql pre_sql_setup get_select');
    const blast = text.slice(text.indexOf('**Blast radius'), text.indexOf('**Relationships**'));
    const first = blast.split('\n').find((l) => l.startsWith('- `'));
    expect(first).toContain(`\`as_sql\` (${COMPILER}:${lineOf.asSqlDef})`);
  });

  it('a `file:line` anchor returns the method enclosing that line, whole', async () => {
    // No symbol named — the line alone has to say which method.
    const text = await explore(`${COMPILER}:${lineOf.asSqlDef! + 40} full body`);
    const lines = renderedLines(text, COMPILER);
    for (let ln = lineOf.asSqlDef!; ln <= lineOf.asSqlTail!; ln++) {
      expect(lines.has(ln), `as_sql line ${ln} rendered`).toBe(true);
    }
  });

  it('a `lines A-B` range returns exactly that span of the pinned file', async () => {
    // The tail of `as_sql` — the span a windowed render elides and the agent
    // then asks for by number (django's `lines 900-1003 as_sql tail`).
    const a = lineOf.asSqlTailStart!;
    const b = lineOf.asSqlTail!;
    const text = await explore(`${COMPILER} lines ${a}-${b} tail`);
    const lines = renderedLines(text, COMPILER);
    for (let ln = a; ln <= b; ln++) expect(lines.has(ln), `line ${ln} rendered`).toBe(true);
  });

  it('windows an exact body too big for the budget — head AND the call the flow runs through — and names the rest by range', async () => {
    const text = await explore('Planner.plan finalize explain_plan');
    expect(text).toContain('**Flow (call path among the symbols you queried)');
    const section = sectionFor(text, PLANNER);
    const lines = renderedLines(text, PLANNER);
    expect(section).toContain('PLAN_HEAD');
    // The spine's next-hop call sits ~420 lines into the body: a head-only cut
    // would drop it.
    expect(lines.has(lineOf.planCallsStage!), 'the call into stage() is rendered').toBe(true);
    // Windowed, not dumped: most of the 430-line body is elided...
    expect(lines.size).toBeLessThan(300);
    // ...and each hole is named with the explore query that returns it.
    expect(section).toMatch(/lines \d+-\d+ of `plan` elided — codegraph_explore `planner\.py:\d+-\d+` returns them/);
    // Steered to explore, never to Read (the tag's own "do NOT Read" aside).
    expect(section.replace(/do NOT Read/g, '')).not.toMatch(/\bRead\b/);
  });
});
