/**
 * The doc tier's naming path: a query that IS a document's name.
 *
 * `collectDocSeeds` honoured `named` at the file gate and ignored it at the
 * section gate, so `CONTRIBUTING.md` found the file and then dropped it for
 * want of a scoring line — the user typed a filename and got nothing. Three
 * rules combined to make every section score 0 for such a query: a term
 * appearing in the file path is weighted 0 (and for a bare filename that is
 * the only term), `lineScore` needs two distinct terms on one line, and
 * `coveredHeading` needs a term of non-zero weight.
 *
 * A fourth rule made some headings unreachable by any query at all:
 * `coveredHeading` demanded every significant heading word be covered, but
 * DOC_QUERY_NOISE words are stripped from the query, so a heading containing
 * "repo" could never be covered.
 *
 * These are retrieval assertions, not extraction ones — the misses that
 * motivated them were found by querying a real 84-file repo, which is exactly
 * what no unit test here was doing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

let dir: string;
let cg: CodeGraph;

async function explore(query: string): Promise<string> {
  const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
  return res.content?.[0]?.text ?? '';
}

/** The response renders a source section for `file`. */
const hasSection = (response: string, file: string): boolean =>
  response.includes('**`' + file + '`');

const CONTRIBUTING = `# Project Contributing Guide

Some preamble that names no section.

## Repo Setup

Clone it and install dependencies.

## Cloning the repo on Windows

Enable symlinks and long paths before cloning.

## Ignoring commits when running git blame

Use the ignore-revs file.
`;

const README = `# Widget

A widget.

## Installation

Install the widget.

## Usage

Use the widget.
`;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-doc-named-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CONTRIBUTING.md'), CONTRIBUTING);
  fs.writeFileSync(path.join(dir, 'README.md'), README);
  // A fixture copy, which DOC_LOW_PATH exists to keep out of results.
  fs.writeFileSync(path.join(dir, 'test', 'fixtures', 'README.md'), README);
  // Code, so the index is not markdown-only and code queries have somewhere to go.
  fs.writeFileSync(
    path.join(dir, 'src', 'widget.ts'),
    `export function createWidget(size: number): number { return size * 2; }\n` +
      `export function resizeWidget(w: number): number { return createWidget(w); }\n`
  );
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}, 180_000);

afterAll(() => {
  cg?.destroy();
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a query that names a markdown file', () => {
  it('renders the file it names, spelled with the extension', async () => {
    const out = await explore('CONTRIBUTING.md');
    expect(hasSection(out, 'CONTRIBUTING.md')).toBe(true);
  });

  it('renders the file it names, spelled as the bare stem', async () => {
    const out = await explore('readme');
    expect(hasSection(out, 'README.md')).toBe(true);
  });

  it('does not let a bare stem surface a fixture copy', async () => {
    // The stem match unlocks the two-hit gate and the section fallback, but
    // deliberately not the DOC_LOW_PATH bypass — that stays the privilege of
    // an explicitly spelled path.
    const out = await explore('readme');
    expect(hasSection(out, 'test/fixtures/README.md')).toBe(false);
  });
});

describe('a heading containing a DOC_QUERY_NOISE word', () => {
  it('is reachable, though "repo" can never appear among the query terms', async () => {
    const out = await explore('the contributing guide for windows');
    expect(hasSection(out, 'CONTRIBUTING.md')).toBe(true);
    expect(out).toContain('Cloning the repo on Windows');
  });
});

describe('the DOC_WORD gate still declines what it should', () => {
  it('a question with no doc word pulls no markdown', async () => {
    const out = await explore('how do i resize a widget');
    expect(hasSection(out, 'CONTRIBUTING.md')).toBe(false);
    expect(hasSection(out, 'README.md')).toBe(false);
  });
});
