import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { matchCollapsedObjectCall } from '../src/resolution/name-matcher';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

// Pass-through, so a test can count how often text is stripped.
vi.mock('../src/resolution/strip-comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/resolution/strip-comments')>();
  return { ...actual, stripCommentsForRegex: vi.fn(actual.stripCommentsForRegex) };
});

/**
 * #2334: resolving JS/TS does a bounded amount of work per file. In a file
 * with destructuring, the check for a call through a destructured name
 * stripped and scanned every line above each bare call; the check for a name
 * the calling function binds itself stripped that function's lines above each
 * reference again. A bundled library took time in the square of its size.
 * Counted, never timed.
 */
describe('JS resolution work (#2334)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    vi.mocked(stripCommentsForRegex).mockClear();
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    tmpDir = undefined;
  });

  async function index(files: Record<string, string>): Promise<CodeGraph> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-work-'));
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, file)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, file), content);
    }
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    return cg;
  }

  /** How often a non-empty start of `text` was stripped as `lang`. */
  const strips = (lang: string, text: string) => vi.mocked(stripCommentsForRegex).mock.calls
    .filter(([stripped, as]) => as === lang && stripped.length > 0 && text.startsWith(stripped)).length;

  const callers = (graph: CodeGraph, file: string, name: string) => {
    const target = graph.getNodesByName(name).find((n) => n.filePath === file && n.kind === 'function')!;
    return [...new Set(graph.getIncomingEdges(target.id).filter((e) => e.kind === 'calls')
      .map((e) => graph.getNode(e.source)?.name))];
  };

  it('reads a file with destructuring once, not once per call', async () => {
    const CALLS = 40;
    const app = `import { useAuth } from './auth';\n` +
      `const { login } = useAuth();\n` +
      Array.from({ length: CALLS }, (_, i) => `function step${i}() { return ${i}; }\n`).join('') +
      `export function run() {\n` +
      Array.from({ length: CALLS }, (_, i) => `  step${i}();\n`).join('') +
      // A division the blanking reads as a regex literal around the call.
      `  return (${CALLS}) / login() / 2;\n}\n`;
    const graph = await index({
      'auth.js': 'export function useAuth() {\n  function login() {\n    return 1;\n  }\n  return { login };\n}\n',
      'app.js': app,
    });
    // The call through the destructured name reaches the function the hook returns.
    expect(callers(graph, 'auth.js', 'login')).toEqual(['run']);
    expect(callers(graph, 'app.js', 'step7')).toEqual(['run']);
    // Each bare call was checked; the file was stripped for that once, not once per call.
    expect(strips('typescript', app)).toBeLessThan(CALLS / 4);
  });

  it("strips a function's lines once, not once per reference", async () => {
    const LINES = 40;
    const host = `export function host() {\n` +
      Array.from({ length: LINES }, (_, i) => `  helper(${i});\n`).join('') + `}\n`;
    const graph = await index({ 'lib.js': `export function helper(n) {\n  return n;\n}\n${host}` });
    // Each call resolved, so each asked whether `host` binds `helper` itself.
    expect(callers(graph, 'lib.js', 'helper')).toEqual(['host']);
    expect(strips('javascript', host)).toBeLessThan(LINES / 4);
  });
});

/**
 * A call the extractor records by its bare name has its receiver read back
 * from the source, from the ref's column on. A minified bundle is one long
 * line, and joining it with the lines after it copied all of it for every
 * call on it: about 1 MB per call on go-ethereum's graphiql.min.js. Counted,
 * never timed.
 */
describe('a receiver read back from a minified line', () => {
  /** How many characters arrays were joined into while `run` ran. */
  function joinedDuring(run: () => void): number {
    const join = Array.prototype.join;
    let chars = 0;
    Array.prototype.join = function (this: unknown[], separator?: string): string {
      const text = join.call(this, separator);
      chars += text.length;
      return text;
    };
    try {
      run();
    } finally {
      Array.prototype.join = join;
    }
    return chars;
  }

  /**
   * Runs `refs` through the check for a call written on `window.App…`, which
   * looks up the object the receiver it read back names.
   */
  function readBack(source: string, refs: UnresolvedRef[]): { holders: string[]; joined: number } {
    const lines = source.split('\n');
    const holders: string[] = [];
    const context: ResolutionContext = {
      getNodesInFile: () => [],
      getNodesByName: (name) => {
        holders.push(name);
        return [];
      },
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      fileExists: () => false,
      readFile: () => source,
      getFileLines: () => lines,
      getProjectRoot: () => '',
      getAllFiles: () => [],
      getImportMappings: () => [],
    };
    const joined = joinedDuring(() => {
      for (const ref of refs) matchCollapsedObjectCall(ref, context);
    });
    return { holders, joined };
  }

  const call = (name: string, line: number, column: number): UnresolvedRef => ({
    fromNodeId: 'bundle', referenceName: name, referenceKind: 'calls', line, column,
    filePath: 'bundle.min.js', language: 'javascript',
  });

  it('reads every receiver on the line without copying the line once per call', () => {
    const CALLS = 300;
    const refs: UnresolvedRef[] = [];
    let line = '!function(){';
    for (let i = 0; i < CALLS; i++) {
      refs.push(call(`m${i}`, 2, line.length));
      line += `window.App${i}.m${i}(${i});`;
    }
    line += '}();';
    const { holders, joined } = readBack(`/*! bundle */\n${line}\n//# sourceMappingURL=bundle.min.js.map`, refs);
    // Each call's receiver was read back...
    expect(holders).toEqual(refs.map((_, i) => `App${i}`));
    // ...and all of them together copied less than the line once.
    expect(joined).toBeLessThan(line.length);
  });

  it('reads on past the line when the line alone does not settle the call', () => {
    // The call continues on the next lines.
    expect(readBack('window.App\n  .go\n  (1);', [call('go', 1, 0)]).holders).toEqual(['App']);
    // The line holds `foo(`, but the call is `foo[…](3)`, whose subscript runs onto the next line.
    expect(readBack('window.App.foo[foo(1),\n2](3);', [call('foo', 1, 0)]).holders).toEqual(['App']);
    // A column past the end of its line reads on from the next one.
    expect(readBack('x\nwindow.App.go(1);', [call('go', 1, 2)]).holders).toEqual(['App']);
  });
});
