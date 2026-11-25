import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { ReferenceResolver } from '../src/resolution';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';

// Pass-through, so a test can count how often a file's text is stripped.
vi.mock('../src/resolution/strip-comments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/resolution/strip-comments')>();
  return { ...actual, stripCommentsForRegex: vi.fn(actual.stripCommentsForRegex) };
});

/**
 * #2332: resolving Python does a bounded amount of work per file and per call.
 * The cross-module write scan for a module global read every Python file once
 * per global; the local-binding check stripped the calling file once per
 * function, and looked up the function around a call once per same-named
 * candidate. On CPython that was minutes of CPU. Counted, never timed.
 */
describe('Python resolution work (#2332)', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(stripCommentsForRegex).mockClear();
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    tmpDir = undefined;
  });

  /** Index `files`, counting per file what resolution reads, strips and looks up. */
  async function indexCounting(files: Record<string, string>) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-work-'));
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, file)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, file), content);
    }
    cg = CodeGraph.initSync(tmpDir);
    const context = (cg as unknown as { resolver: ReferenceResolver }).resolver.getResolutionContext();
    const reads = vi.spyOn(context, 'readFile');
    const lookups = vi.spyOn(context, 'getNodesInFile');
    await cg.indexAll();
    return {
      graph: cg,
      reads: (file: string) => reads.mock.calls.filter(([f]) => f === file).length,
      lookups: (file: string) => lookups.mock.calls.filter(([f]) => f === file).length,
      strips: (file: string) => vi.mocked(stripCommentsForRegex).mock.calls.filter(([text]) => text === files[file]).length,
    };
  }

  it('reads no file once per module global, and strips no file once per function', async () => {
    const SCALE = 16;
    const conns = Array.from({ length: SCALE }, (_, i) => `conn${i}`);
    const files: Record<string, string> = {
      // Globals typed by their own module's writes: each one's type also
      // depends on what every other module writes to it.
      'store.py': 'class Store:\n    def fetch(self, ids):\n        return ids\n',
      'settings.py': `from store import Store\n${conns.map(c => `${c} = None\n`).join('')}\n` +
        `def init():\n    global ${conns.join(', ')}\n${conns.map(c => `    ${c} = Store()\n`).join('')}`,
      'consumer.py': `import settings\n${conns.map((c, i) => `\ndef cb${i}(pool):\n    pool.submit(settings.${c}.fetch)\n`).join('')}`,
      // A bare call in every function: each asks whether its function binds the name.
      'helpers.py': 'def helper():\n    return 1\n',
      'callers.py': Array.from({ length: SCALE }, (_, i) => `def f${i}():\n    return helper()\n\n`).join('') +
        'def shadowed(make):\n    helper = make()\n    return helper()\n',
    };
    // Files no reference touches.
    const fillers = Array.from({ length: 20 }, (_, i) => `pkg/filler${i}.py`);
    fillers.forEach((file, i) => { files[file] = `def filler${i}(x):\n    return x + ${i}\n`; });
    const { graph, reads, strips } = await indexCounting(files);

    // Both paths ran: every global's method value reached Store.fetch, and the
    // function that binds `helper` itself calls its own value.
    const fetch = graph.getNodesByName('fetch').find(n => n.qualifiedName === 'Store::fetch')!;
    expect(graph.getIncomingEdges(fetch.id).filter(e => e.metadata?.fnRef === true)
      .map(e => graph.getNode(e.source)?.name).sort()).toEqual(conns.map((_, i) => `cb${i}`).sort());
    const helper = graph.getNodesByName('helper').find(n => n.kind === 'function')!;
    expect(graph.getIncomingEdges(helper.id).filter(e => e.kind === 'calls')
      .map(e => graph.getNode(e.source)?.name).sort()).toEqual(Array.from({ length: SCALE }, (_, i) => `f${i}`).sort());
    // A few whole-project passes read each file once; the write scan read every
    // file once more per global.
    expect(Math.max(...fillers.map(reads))).toBeLessThan(SCALE / 2);
    // Stripped once for the pass, not once per function.
    expect(strips('callers.py')).toBeLessThan(SCALE / 2);
  });

  it('finds the function around a call once, however many functions share its name', async () => {
    const CANDIDATES = 16;
    const CALLS = 8;
    const files: Record<string, string> = {
      'callers.py': Array.from({ length: CALLS }, (_, i) => `def f${i}():\n    return helper()\n\n`).join(''),
    };
    for (let k = 0; k < CANDIDATES; k++) files[`lib${k}/helpers.py`] = 'def helper():\n    return 1\n';
    const { lookups } = await indexCounting(files);
    // Each same-named candidate asks whether the caller binds `helper`; the
    // answer is the call's, so the caller's nodes are read per call.
    expect(lookups('callers.py')).toBeLessThanOrEqual(2 * CALLS);
  });
});
