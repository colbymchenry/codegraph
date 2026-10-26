/**
 * The jsx-render pass reads each function's own lines for the component tags
 * it renders. Every function of a minified bundle spans the bundle's one line,
 * so it split, sliced and scanned the whole file once per function: 2,234
 * times over go-ethereum's 980 KB `graphiql.min.js`, 25 of the 28 seconds its
 * linking passes took on Node 22 (9 of 13 on Node 24). Functions that span
 * the same lines render the same tags, so they share one scan. Counted, never
 * timed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

/** The source of the pass's tag pattern, to count its scans by. */
const JSX_TAG_SOURCE = String.raw`<([A-Z][A-Za-z0-9_]*)(?=[\s/><])`;

describe('jsx-render pass work', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;
  const originalExec = RegExp.prototype.exec;

  afterEach(() => {
    RegExp.prototype.exec = originalExec;
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    tmpDir = undefined;
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jsx-work-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"dependencies":{"react":"^18.0.0"}}');
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(tmpDir, file), content);
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    return cg;
  }

  /** What each named function renders, by jsx-render edge. */
  const renders = (graph: CodeGraph, name: string): string[] => {
    const from = graph.getNodesByName(name).find((n) => n.kind === 'function' || n.kind === 'component')!;
    return graph.getOutgoingEdges(from.id)
      .filter((e) => (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'jsx-render')
      .map((e) => graph.getNode(e.target)!.name);
  };

  it('scans a line that many components share once, not once per component', async () => {
    const COMPONENTS = 60;
    const bundle = Array.from({ length: COMPONENTS }, (_, i) => `function Card${i}(){return <Badge/>}`).join('');
    // A scan of the bundle's line: the tag pattern run over it from the start.
    let scans = 0;
    RegExp.prototype.exec = function (this: RegExp, input: string) {
      if (this.source === JSX_TAG_SOURCE && this.lastIndex === 0 && typeof input === 'string' &&
          input.includes(`Card${COMPONENTS - 1}(`)) scans++;
      return originalExec.call(this, input);
    };
    const graph = await index({
      'bundle.jsx': `${bundle}\n`,
      'badge.jsx': 'export function Badge(){return null}\n',
    });
    RegExp.prototype.exec = originalExec;

    for (const i of [0, 31, COMPONENTS - 1]) expect(renders(graph, `Card${i}`)).toEqual(['Badge']);
    expect(scans).toBeGreaterThan(0);
    expect(scans).toBeLessThan(COMPONENTS / 4);
  });

  it('keeps the tags of functions on different lines apart', async () => {
    const graph = await index({
      'page.jsx': [
        'export function Page() { return <Header/>; }',
        'export function Footer() {',
        '  return <Links/>;',
        '}',
        'function Header(){return null} function Links(){return null}',
        '',
      ].join('\n'),
    });
    expect(renders(graph, 'Page')).toEqual(['Header']);
    expect(renders(graph, 'Footer')).toEqual(['Links']);
  });
});
