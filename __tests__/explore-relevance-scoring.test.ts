/**
 * Relevance scoring for `codegraph_explore` — CG-10 / #1500.
 *
 * The failure this pins: a file that merely NAME-COLLIDES with the query used to
 * score the same per match as the file that answers it, because every match in a
 * tier counted the same regardless of what was matched. Three
 * `scripts/agent-eval/*.mjs` harnesses took 63% of this repo's own "how does
 * explore allocate its output budget across files" response on nothing but a
 * local `const explore` and a `const BUDGET`.
 *
 * Four levers, one fixture family each:
 *   1. KIND WEIGHT     — a match on a function/class outweighs one on a
 *                        variable/constant/parameter.
 *   2. ISOLATION       — a weak-kind symbol nothing calls or references is a
 *                        pure collision and is demoted much harder.
 *   3. RELATIVE FLOOR  — admission scales with the best file's score instead of
 *                        an absolute `>= 3`, capped so one direct match always
 *                        gets in and floored so a diffuse query keeps its spread.
 *   4. RANK PENALTY    — generated and test/i18n files are discounted on BOTH
 *                        the score and the graph mass (the sort's primary key),
 *                        not merely tie-broken at equal score.
 *
 * Each fixture is a whole indexed project because the scoring reads the graph
 * (usage edges, RWR mass, the generated flag) — there is no seam to unit-test
 * the comparator against, and mocking one would pin the mock, not the behavior.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, RELEVANCE_KIND_WEIGHT } from '../src/mcp/tools';
import { attributeSourceBytes } from '../src/mcp/explore-diagnostics';

/** Build + index a throwaway project from a `{ relPath: source }` map. */
async function buildProject(
  prefix: string,
  files: Record<string, string>,
): Promise<{ dir: string; cg: CodeGraph; handler: ToolHandler }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.trimStart());
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg, handler: new ToolHandler(cg) };
}

const cleanup = (dir: string, cg?: CodeGraph) => {
  if (cg) cg.destroy();
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
};

/**
 * Where a file's source section appears in the response. Sections are emitted in
 * final rank order, so this is the ranking assertion — which is what CG-10 owns.
 * How many BYTES each ranked file then gets is CG-12's (`maxCharsPerFile` and the
 * render loop still spend by file size, so a large low-ranked file can still
 * out-byte a small high-ranked one).
 */
const rankOf = (text: string, filePath: string): number => {
  const at = text.indexOf('**`' + filePath + '`**');
  if (at < 0) return Number.POSITIVE_INFINITY;
  return text.slice(0, at).split('**`').length;
};

describe('RELEVANCE_KIND_WEIGHT', () => {
  it('ranks callables and types above members, and members above locals', () => {
    const callables = ['function', 'method', 'class', 'struct', 'interface', 'route', 'component'];
    for (const kind of callables) expect(RELEVANCE_KIND_WEIGHT[kind]).toBe(1);

    for (const member of ['property', 'field', 'enum_member']) {
      expect(RELEVANCE_KIND_WEIGHT[member]!).toBeLessThan(RELEVANCE_KIND_WEIGHT.function!);
      expect(RELEVANCE_KIND_WEIGHT[member]!).toBeGreaterThan(RELEVANCE_KIND_WEIGHT.parameter!);
    }

    // The #1500 kinds: incidental until the graph corroborates them.
    for (const weak of ['constant', 'variable', 'parameter']) {
      expect(RELEVANCE_KIND_WEIGHT[weak]!).toBeLessThan(0.5);
    }
    expect(RELEVANCE_KIND_WEIGHT.parameter!).toBeLessThan(RELEVANCE_KIND_WEIGHT.variable!);
  });
});

describe('explore relevance scoring — incidental name collisions (#1500)', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  // Shape: one file DEFINES the dispatch mechanism; three unrelated scripts each
  // declare a lone unused `dispatch`/`registry` binding. Before CG-10 all four
  // cleared the floor and the three small scripts, shipping whole, took most of
  // the envelope from the large real file, which got clipped.
  beforeAll(async () => {
    const noise = (n: number) => `
const dispatch = ${n};
const registry = 'unused-${n}';

function unrelated${n}Helper(value) {
  return value + ${n};
}
`;
    ({ dir, cg, handler } = await buildProject('codegraph-cg10-collide-', {
      'src/dispatcher.js': `
import { lookupHandler } from './registry.js';

export function dispatch(event) {
  const handler = lookupHandler(event.type);
  if (!handler) return null;
  return runHandler(handler, event);
}

export function runHandler(handler, event) {
  return handler(event.payload);
}
`,
      'src/registry.js': `
const handlers = new Map();

export function registerHandler(type, fn) {
  handlers.set(type, fn);
}

export function lookupHandler(type) {
  return handlers.get(type);
}
`,
      'scripts/report-a.js': noise(1),
      'scripts/report-b.js': noise(2),
      'scripts/report-c.js': noise(3),
    }));
  }, 120_000);

  afterAll(() => cleanup(dir, cg));

  const explore = async (query: string) => {
    const result = await handler.execute('codegraph_explore', { query });
    const text = result.content?.[0]?.text ?? '';
    return { text, bytes: attributeSourceBytes(text) };
  };

  it('keeps files whose only match is an unused local out of the response', async () => {
    const { bytes } = await explore('how does dispatch route an event to its handler');
    for (const noiseFile of ['scripts/report-a.js', 'scripts/report-b.js', 'scripts/report-c.js']) {
      expect(bytes.get(noiseFile) ?? 0, `${noiseFile} must not reach the envelope`).toBe(0);
    }
  });

  it('spends every delivered source byte on the files that define the mechanism', async () => {
    const { bytes } = await explore('how does dispatch route an event to its handler');
    let answer = 0;
    let noise = 0;
    for (const [file, n] of bytes) {
      if (file.startsWith('src/')) answer += n;
      else noise += n;
    }
    expect(answer).toBeGreaterThan(0);
    expect(noise).toBe(0);
    expect(bytes.get('src/dispatcher.js') ?? 0).toBeGreaterThan(0);
  });

  it('still answers when the collision is the ONLY thing that matched', async () => {
    // Guard against over-correction: querying the noise term alone must not
    // produce an empty response. Under-serving costs the agent a round-trip, so
    // the floor's backfill has to keep the best of what matched.
    const { text } = await explore('unrelated2Helper');
    expect(text).not.toContain('No relevant code found');
    expect(text).toContain('unrelated2Helper');
  });
});

describe('explore relevance scoring — generated source is penalized, not tie-broken', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  // The #1500 shape in miniature: the generated layer collides on every query
  // term AND carries more call-graph mass than the hand-written use-case, so a
  // generated-as-tiebreak-only rule leaves it ranked first.
  beforeAll(async () => {
    ({ dir, cg, handler } = await buildProject('codegraph-cg10-generated-', {
      'go.mod': 'module example.com/billing\n\ngo 1.22\n',
      'internal/usecase/billing/invoice.go': `
package billing

// Service runs the month-end invoicing workflow.
type Service struct {
	store Store
}

// RunInvoiceCycle is the hand-written business rule the question is about.
func (s *Service) RunInvoiceCycle(month string) error {
	lines := s.CollectInvoiceLines(month)
	total := s.CalculateInvoiceTotal(lines)
	return s.store.Save(month, total)
}

func (s *Service) CollectInvoiceLines(month string) []int {
	return []int{1, 2, 3}
}

func (s *Service) CalculateInvoiceTotal(lines []int) int {
	sum := 0
	for _, l := range lines {
		sum += l
	}
	return sum
}
`,
      'internal/usecase/billing/store.go': `
package billing

type Store interface {
	Save(month string, total int) error
}
`,
      // Ordinary filename — ONLY the content banner betrays it (the CG-5 case).
      'internal/gen/billing/invoice.go': `
// Code generated by billingkit. DO NOT EDIT.

package gen

type InvoiceRow struct {
	Month string
	Total int
}

type InvoiceCreateRequest struct {
	Month string
}

func CreateInvoice(req InvoiceCreateRequest) InvoiceRow {
	return BuildInvoice(req.Month, 0)
}

func BuildInvoice(month string, total int) InvoiceRow {
	return InvoiceRow{Month: month, Total: total}
}

func CalculateInvoiceTotal(rows []InvoiceRow) int {
	sum := 0
	for _, r := range rows {
		sum += r.Total
	}
	return sum
}

func ListInvoices(month string) []InvoiceRow {
	return []InvoiceRow{BuildInvoice(month, 0)}
}

func CollectInvoiceLines(month string) []InvoiceRow {
	return ListInvoices(month)
}

func RunInvoiceCycle(month string) InvoiceRow {
	rows := CollectInvoiceLines(month)
	return BuildInvoice(month, CalculateInvoiceTotal(rows))
}
`,
    }));
  }, 120_000);

  afterAll(() => cleanup(dir, cg));

  it('indexes the ordinary-named generated file via its content banner', () => {
    expect(cg.getFile('internal/gen/billing/invoice.go')?.generated).toBe(true);
    expect(cg.getFile('internal/usecase/billing/invoice.go')?.generated).toBe(false);
  });

  it('ranks the hand-written workflow above its generated twin', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'how does the invoice cycle collect lines and calculate the total',
    });
    const text = result.content?.[0]?.text ?? '';

    // The generated file collides on EVERY query term and carries call-graph
    // mass of its own, so with generated status as a mere tiebreak-at-equal-score
    // it ranked first. The penalty scales its score AND its graph mass, which is
    // the key the comparator actually sorts on.
    const handWritten = rankOf(text, 'internal/usecase/billing/invoice.go');
    const generated = rankOf(text, 'internal/gen/billing/invoice.go');
    expect(handWritten).toBeLessThan(generated);
    expect(attributeSourceBytes(text).get('internal/usecase/billing/invoice.go') ?? 0)
      .toBeGreaterThan(0);
  });
});

describe('explore relevance scoring — test files never buy the envelope', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  // A repo-ROOT `test/` directory — the shape express and most of npm/Go use.
  // The old detector anchored on a leading `/`, so `test/x.js` never matched it
  // and express's routing question spent 59% of its envelope on three test files.
  beforeAll(async () => {
    const spec = (n: number) => `
const { parseRoute } = require('../lib/router.js');

describe('parseRoute ${n}', () => {
  it('parses a route ${n}', () => {
    parseRoute('/a/${n}');
  });
  it('parses another route ${n}', () => {
    parseRoute('/b/${n}');
  });
});
`;
    ({ dir, cg, handler } = await buildProject('codegraph-cg10-lowvalue-', {
      'lib/router.js': `
exports.parseRoute = function parseRoute(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  return { segments, matched: matchRoute(segments) };
};

function matchRoute(segments) {
  return segments.length > 0;
}
`,
      'lib/dispatch.js': `
const { parseRoute } = require('./router.js');

exports.dispatchRoute = function dispatchRoute(pathname) {
  return parseRoute(pathname);
};
`,
      'test/router.raw.js': spec(1),
      'test/router.json.js': spec(2),
      'test/router.text.js': spec(3),
    }));
  }, 120_000);

  afterAll(() => cleanup(dir, cg));

  it('excludes a repo-root test/ directory from the envelope', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'how does the router parse and dispatch a route',
    });
    const bytes = attributeSourceBytes(result.content?.[0]?.text ?? '');
    for (const [file, n] of bytes) {
      expect(n === 0 || !file.startsWith('test/'), `${file} took ${n} chars`).toBe(true);
    }
    expect(bytes.get('lib/router.js') ?? 0).toBeGreaterThan(0);
  });

  it('still returns tests when the query is about them', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'which tests cover parseRoute',
    });
    const text = result.content?.[0]?.text ?? '';
    expect(text).not.toContain('No relevant code found');
  });
});
