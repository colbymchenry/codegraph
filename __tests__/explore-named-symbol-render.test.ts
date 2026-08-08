/**
 * Standing gate for THE GUARANTEE (task CG-38): if the agent names a symbol and
 * that symbol's file is admitted to the response, the symbol's DEFINITION renders.
 *
 * This is the measurement the CG-24 epic never had. Its probes all score the
 * response in aggregate — envelope share, per-file spend, source totals, file
 * counts — and every one of them is green on a response that returns 25K of
 * source from the right file and still omits the function the agent asked for by
 * name. That is what CG-38 was: on a 1,414-line Svelte store, `queueMessage`
 * (L1087) and `flushQueuedMessages` (L1102) never rendered even though their file
 * won rank #1 with 67% of the envelope; the agent got the same-stem
 * `QueuedMessage` INTERFACE at L70 and had to Read the file to find the
 * functions. Longstanding, not an epic regression — the controlled bisect (index
 * held fixed, engine varied across every epic merge point) found it at every
 * build including pre-epic.
 *
 * Two independent causes, and the fixture below fails on either:
 *
 *   1. `buildFlowFromNamedSymbols` returned EMPTY — throwing away the NAMED-SYMBOL
 *      IDENTITY along with the narrative — whenever the named symbols happened not
 *      to form a call chain. Two sibling closures in one factory produce no chain,
 *      no synthesized hop and no dispatch boundary, so both defs lost the
 *      importance-9 rank that the named-def injection exists to give them.
 *   2. The ceiling trim cut in SOURCE ORDER, so whatever survived the shrink at
 *      the END of a large file was always the first thing dropped.
 *
 * The fixture mirrors the reported file's geometry deliberately: a decoy
 * same-stem interface at L70, a factory closure at L104 spanning ~92% of the file
 * (so every symbol merges into ONE cluster), the target functions past L1000, and
 * a 2,500-line generated `.d.ts` for the ranker to penalise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

const FIXTURE = 'tail-render-ts';
const TARGET = 'src/lib/session-store.ts';

let dir: string;
let cg: CodeGraph;

/** Every `<n>\t<text>` line number the response actually sent. */
function renderedLines(response: string): Set<number> {
  const out = new Set<number>();
  for (const m of response.matchAll(/^(\d+)\t/gm)) out.add(Number(m[1]));
  return out;
}

async function explore(query: string): Promise<string> {
  const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
  return res.content?.[0]?.text ?? '';
}

function defLineOf(name: string): number {
  const node = cg.getNodesByName(name).find((n) => n.filePath === TARGET && n.startLine > 0);
  expect(node, `${name} is not indexed in ${TARGET}`).toBeDefined();
  return node!.startLine;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg38-'));
  fs.cpSync(path.join(__dirname, 'fixtures', FIXTURE), dir, { recursive: true });
  fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}, 180_000);

afterAll(() => {
  cg?.destroy();
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CG-38 fixture shape — if this rots, the gate below means nothing', () => {
  it('puts the target functions past L1000 of a ~1,400-line file', () => {
    const lines = fs.readFileSync(path.join(dir, TARGET), 'utf-8').split('\n');
    expect(lines.length).toBeGreaterThan(1300);
    expect(defLineOf('queueMessage')).toBeGreaterThan(1000);
    expect(defLineOf('flushQueuedMessages')).toBeGreaterThan(1000);
  });

  it('wraps them in a closure spanning most of the file, so they all cluster as one', () => {
    const lines = fs.readFileSync(path.join(dir, TARGET), 'utf-8').split('\n');
    const factory = cg.getNodesByName('createSessionStore')
      .find((n) => n.filePath === TARGET)!;
    expect(factory).toBeDefined();
    expect(factory.endLine - factory.startLine + 1).toBeGreaterThan(lines.length * 0.5);
  });

  it('carries the same-stem decoy near the top', () => {
    const decoy = cg.getNodesByName('QueuedMessage').find((n) => n.filePath === TARGET)!;
    expect(decoy).toBeDefined();
    expect(decoy.kind).toBe('interface');
    expect(decoy.startLine).toBeLessThan(100);
  });

  it('carries a generated declaration file for the ranker to penalise', () => {
    const dts = path.join(dir, 'types/worker-configuration.d.ts');
    expect(fs.existsSync(dts)).toBe(true);
    expect(fs.readFileSync(dts, 'utf-8').split('\n').length).toBeGreaterThan(2000);
  });

  it('neither target calls the other — that absence is what produced no flow', () => {
    const queue = cg.getNodesByName('queueMessage').find((n) => n.filePath === TARGET)!;
    const flush = cg.getNodesByName('flushQueuedMessages').find((n) => n.filePath === TARGET)!;
    const between = [...cg.getCallees(queue.id), ...cg.getCallees(flush.id)]
      .filter(({ node }) => node.id === queue.id || node.id === flush.id);
    expect(between).toHaveLength(0);
  });
});

describe('CG-38 — an agent-named symbol renders its definition', () => {
  /**
   * Both reported query shapes. They fail for different reasons — the symbol bag
   * never built a flow at all, the prose question built one and then lost the
   * tail to the ceiling trim — so a fix for one does not imply the other.
   */
  const CASES: Array<{ shape: string; query: string; symbols: string[] }> = [
    {
      shape: 'symbol bag',
      query: 'queueMessage flushQueuedMessages',
      symbols: ['queueMessage', 'flushQueuedMessages'],
    },
    {
      shape: 'prose question',
      query: 'how does queueMessage hand its entries to flushQueuedMessages',
      symbols: ['queueMessage', 'flushQueuedMessages'],
    },
    {
      shape: 'three siblings, with the decoy interface competing',
      query: 'explain queueMessage, removeQueuedMessage and flushQueuedMessages',
      symbols: ['queueMessage', 'removeQueuedMessage', 'flushQueuedMessages'],
    },
  ];

  for (const { shape, query, symbols } of CASES) {
    it(`renders every named definition — ${shape}`, async () => {
      const response = await explore(query);
      const lines = renderedLines(response);
      for (const name of symbols) {
        const line = defLineOf(name);
        // The NAME alone proves nothing: it appears in the section header's
        // symbol list and at call sites whether or not the body was sent. Only
        // the definition LINE being among the rendered lines counts.
        expect(lines.has(line), `${name} (${TARGET}:${line}) did not render for "${query}"`)
          .toBe(true);
      }
    }, 120_000);
  }

  it('never steers the agent to Read', async () => {
    const response = await explore('queueMessage flushQueuedMessages');
    expect(response).not.toMatch(/\buse Read\b|\bRead the file\b/i);
  }, 120_000);
});

describe('CG-38 — a penalty on one file cannot shrink an unrelated file\'s render', () => {
  /**
   * The issue's sharpest lead: on an index where the generated `.d.ts` was NOT
   * flagged, the target file rendered ~581 lines including both symbols; on an
   * index where it WAS flagged, the same engine rendered 12. `rankPenalty` scales
   * `fileGraphScore`, which moves the relevance gate (6% of max) and so reshuffles
   * the admitted set — a demotion of one file must not cost an unrelated
   * top-ranked file its source.
   *
   * Flipping `files.generated` on that one row holds the INDEX constant and
   * attributes any delta to the ranker alone (the CG-25 method).
   */
  const DTS = 'types/worker-configuration.d.ts';
  const QUERY = 'queueMessage flushQueuedMessages';

  it('renders the same named definitions with the .d.ts flagged and unflagged', async () => {
    const setGenerated = (value: number) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (cg as any).db?.getDatabase?.() ?? (cg as any).db?.db;
      db.prepare('UPDATE files SET generated = ? WHERE path = ?').run(value, DTS);
    };
    const linesFor = async () => renderedLines(await explore(QUERY));

    const flagged = await linesFor();
    setGenerated(0);
    try {
      const unflagged = await linesFor();
      for (const name of ['queueMessage', 'flushQueuedMessages']) {
        const line = defLineOf(name);
        expect(flagged.has(line), `${name} missing with the .d.ts FLAGGED`).toBe(true);
        expect(unflagged.has(line), `${name} missing with the .d.ts UNFLAGGED`).toBe(true);
      }
      // The guarantee is about the named defs, not byte equality — the penalty is
      // supposed to move bytes around. What it must never do is cost the
      // top-ranked file the source the agent asked for.
      expect(unflagged.size).toBeGreaterThan(0);
    } finally {
      setGenerated(1);
    }
  }, 180_000);
});
