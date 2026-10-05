/**
 * COBOL copybooks are findable by name in explore (#2342).
 *
 * `COPY X` and `EXEC SQL INCLUDE X` are indexed as `import` nodes, and the
 * context builder's default kind filter drops imports (for JavaScript an
 * import statement is noise). So `codegraph_explore "MYCOPYBOOK"` — and the
 * CLI `explore`, which runs the same handler — answered "No relevant code
 * found" while `query`/`node` found the include at once. A copybook name with
 * a digit in it (`CVACT01Y`) fared worse: the text search fell through to its
 * fuzzy fallback and answered with an unrelated program one edit away.
 *
 * Now a query that names a copybook gets the copybook's own source (pinned,
 * first) and every statement that includes it; a member whose source is not
 * indexed says so. Other languages' imports stay out of explore.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

let dir: string;
let cg: CodeGraph;

async function index(files: Record<string, string>): Promise<void> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cobol-copybook-'));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), source);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}

async function explore(query: string): Promise<string> {
  const result = await new ToolHandler(cg).execute('codegraph_explore', { query });
  expect(result.isError).toBeFalsy();
  return result.content[0]!.text;
}

afterEach(() => {
  cg?.destroy();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const lines = (...l: string[]): string => l.join('\n') + '\n';

/** The issue's reproduction, verbatim: an EXEC SQL INCLUDE whose member is not indexed. */
const TESTPROG = lines(
  '       IDENTIFICATION DIVISION.',
  '       PROGRAM-ID. TESTPROG.',
  '       PROCEDURE DIVISION.',
  '       UP-INCLUDE-COPYBOOK SECTION.',
  '       UP-INCLUDE-COPYBOOK-10.',
  '           EXEC SQL INCLUDE MYCOPYBOOK END-EXEC.',
);

/** An indexed data copybook, COPY'd by two programs. */
const COPYBOOK_PROJECT = {
  'cpy/CVACT01Y.cpy': lines(
    '       01  ACCOUNT-RECORD.',
    '           05  ACCT-ID          PIC 9(11).',
    '           05  ACCT-CURR-BAL    PIC S9(10)V99.',
  ),
  'cbl/ACCTUPDT.cbl': lines(
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. ACCTUPDT.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       COPY CVACT01Y.',
    '       01  WS-COUNT    PIC 9(4) VALUE 0.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           MOVE 1 TO ACCT-ID',
    '           STOP RUN.',
  ),
  'cbl/ACCTVIEW.cbl': lines(
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. ACCTVIEW.',
    '       DATA DIVISION.',
    '       WORKING-STORAGE SECTION.',
    '       COPY CVACT01Y.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           DISPLAY ACCT-CURR-BAL',
    '           STOP RUN.',
  ),
  // One edit away from the copybook's name, and includes nothing: the
  // program the fuzzy fallback used to answer `CVACT01Y` with.
  'cbl/CBACT01C.cbl': lines(
    '       IDENTIFICATION DIVISION.',
    '       PROGRAM-ID. CBACT01C.',
    '       PROCEDURE DIVISION.',
    '       MAIN-PARA.',
    '           DISPLAY "BATCH"',
    '           STOP RUN.',
  ),
};

describe('explore finds COBOL copybooks by name (#2342)', () => {
  it('surfaces an EXEC SQL INCLUDE whose copybook is not indexed (the issue repro)', async () => {
    await index({ 'TESTPROG.cbl': TESTPROG });
    const text = await explore('MYCOPYBOOK');
    expect(text).not.toContain('No relevant code found');
    // The include site, listed and rendered.
    expect(text).toContain('`TESTPROG.cbl:6` — EXEC SQL INCLUDE');
    expect(text).toMatch(/6\t\s+EXEC SQL INCLUDE MYCOPYBOOK END-EXEC\./);
    // And the honest note that there is no copybook source here to look for.
    expect(text).toContain('no indexed source');
  });

  it('pins an indexed copybook ahead of every include site, and lists all of them', async () => {
    await index(COPYBOOK_PROJECT);
    const text = await explore('CVACT01Y');
    expect(text).not.toContain('No relevant code found');
    expect(text).toContain('source `cpy/CVACT01Y.cpy`; included at 2 sites');
    expect(text).toContain('`cbl/ACCTUPDT.cbl:5` — COPY');
    expect(text).toContain('`cbl/ACCTVIEW.cbl:5` — COPY');
    // The copybook's own source renders, before any including program.
    const copybookAt = text.indexOf('**`cpy/CVACT01Y.cpy`**');
    expect(copybookAt).toBeGreaterThan(-1);
    expect(text).toContain('01  ACCOUNT-RECORD.');
    for (const program of ['cbl/ACCTUPDT.cbl', 'cbl/ACCTVIEW.cbl']) {
      const at = text.indexOf(`**\`${program}\`**`);
      expect(at).toBeGreaterThan(copybookAt);
    }
    expect(text).toContain('COPY CVACT01Y.');
    expect(text).toContain('1 file pinned from the query');
    // Not the program one edit away from the copybook's name.
    expect(text).not.toContain('CBACT01C');
  });

  it('feeds the same entry points to codegraph context (buildContext)', async () => {
    await index({ 'TESTPROG.cbl': TESTPROG, ...COPYBOOK_PROJECT });
    const missing = await cg.buildContext('MYCOPYBOOK', { format: 'markdown' });
    expect(missing).toContain('EXEC SQL INCLUDE MYCOPYBOOK END-EXEC');
    const indexed = await cg.buildContext('CVACT01Y', { format: 'markdown' });
    expect(indexed).toContain('ACCOUNT-RECORD');
    expect(indexed).toContain('COPY CVACT01Y.');
    expect(indexed).not.toContain('CBACT01C');
  });

  it('leaves the copybook out when an explicit kind filter excludes imports', async () => {
    await index({ 'TESTPROG.cbl': TESTPROG });
    const subgraph = await cg.findRelevantContext('MYCOPYBOOK', { nodeKinds: ['function'] });
    expect([...subgraph.nodes.values()].some((n) => n.kind === 'import')).toBe(false);
  });

  it('keeps imports of other languages out of explore', async () => {
    await index({
      'main.ts': "import { CVACT01Y } from './lib';\nexport function run() { return CVACT01Y; }\n",
      'lib.ts': 'export const CVACT01Y = 1;\n',
    });
    const subgraph = await cg.findRelevantContext('CVACT01Y ./lib');
    expect([...subgraph.nodes.values()].some((n) => n.kind === 'import')).toBe(false);
    const text = await explore('CVACT01Y');
    expect(text).not.toContain('COBOL copybook');
    expect(text).toContain('export const CVACT01Y = 1;');
  });
});

describe('copybook member tokens (#2342)', () => {
  // Imported lazily so the behavioural cases above load (and fail) on a build
  // that predates the module.
  const tokens = async (query: string): Promise<string[]> =>
    (await import('../src/graph/cobol-copybooks')).copybookMemberTokens(query);

  it('keeps COBOL-shaped words and skips plain lowercase English', async () => {
    expect(await tokens('where is CVACT01Y included from cust-rec and dfh$aid'))
      .toEqual(['CVACT01Y', 'cust-rec', 'dfh$aid']);
  });

  it('dedupes case-insensitively and drops short or digit-only tokens', async () => {
    expect(await tokens('SQLCA sqlca IO 0042 Sqlca')).toEqual(['SQLCA']);
  });

  it('takes a one-word query as a name whatever its case', async () => {
    expect(await tokens('lgpolicy')).toEqual(['lgpolicy']);
    expect(await tokens('the lgpolicy')).toEqual([]);
  });
});
