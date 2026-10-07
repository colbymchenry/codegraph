import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';

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
