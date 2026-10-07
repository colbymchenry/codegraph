/**
 * Whether a JS function binds a name itself (jsFunctionLocalScope, #2226) is
 * read off the function's comment-stripped code with a parameter-list regex.
 * Its `(?<!\b(?:if|while|for|switch|with)\s*)` lookbehind is cheap only while
 * V8 optimizes the regex, and Node 22's V8 stops optimizing new regexes once a
 * process has generated about a megabyte of regex code — which a resolver pool
 * worker does early, compiling patterns per receiver and per name. Unoptimized,
 * the lookbehind runs at every position and reads back through each whitespace
 * run before it, so a long blanked comment cost time in its length squared.
 *
 * go-ethereum's bundled `graphiql.min.js` is one 980 KB line, and the
 * stripper, which doesn't know regex literals, read the `//` that ends
 * `/Trident\//` as a comment and blanked the remaining 962 KB of it. Two pool
 * workers sat on one such check each until the run was killed (`codegraph
 * init` never finished resolving).
 *
 * The cost lives inside one regex execution, where there is nothing to count,
 * so this is timed — with V8's unoptimized mode forced, on any Node version,
 * and a bound far above the fix's cost and far below the quadratic one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v8 from 'v8';
import { CodeGraph } from '../src';

describe('JS local-binding check on a long comment (go-ethereum graphiql.min.js)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    tmpDir = undefined;
  });

  const callees = (graph: CodeGraph, name: string): string[] => {
    const from = graph.getNodesByName(name).find((n) => n.kind === 'function')!;
    return graph.getOutgoingEdges(from.id).filter((e) => e.kind === 'calls')
      .map((e) => graph.getNode(e.target)!.name);
  };

  it('stays linear when V8 stops optimizing regexes', async () => {
    // Blanked by the comment stripper into one 60,000-character run of spaces.
    const comment = `/* ${'word '.repeat(12_000)} */`;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-lookbehind-'));
    fs.writeFileSync(path.join(tmpDir, 'paint.js'), [
      'function paintWidget() {\n  return 1;\n}',
      // Calls the file's own paintWidget: the check scans all of host's code and finds no binding.
      `function host() {\n  ${comment}\n  return paintWidget();\n}`,
      // Calls its parameter, which shadows the file's paintWidget.
      `function shadow(paintWidget) {\n  ${comment}\n  return paintWidget();\n}`,
      '',
    ].join('\n'));

    v8.setFlagsFromString('--no-regexp-optimization');
    const started = Date.now();
    try {
      cg = CodeGraph.initSync(tmpDir);
      await cg.indexAll();
    } finally {
      v8.setFlagsFromString('--regexp-optimization');
    }
    const elapsed = Date.now() - started;

    expect(callees(cg, 'host')).toEqual(['paintWidget']);
    expect(callees(cg, 'shadow')).toEqual([]);
    // About a second with the fix; minutes when the lookbehind reads back through the run at every position.
    expect(elapsed).toBeLessThan(20_000);
  }, 300_000);
});
