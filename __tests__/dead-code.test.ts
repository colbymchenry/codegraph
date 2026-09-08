/**
 * Dead code and islands (CG-59).
 *
 * Two halves, both against a real indexed fixture: the derivation in
 * `src/graph/dead-code.ts`, and the `/api/deadcode` endpoint that renders it
 * over a real loopback server, like the rest of the viewer's API suite.
 *
 * The fixture is shaped to produce, deliberately, one of each thing the report
 * has to get RIGHT BY NOT CLAIMING IT:
 *
 * - a genuinely unreferenced helper (the only row that should survive);
 * - a same-name pair where the resolver attaches the call to the wrong one —
 *   the mis-resolution that makes a used method look unreached;
 * - a method that overrides a base's, reached only through the base;
 * - a decorated method, registered by a framework the graph cannot see;
 * - a helper only a template mentions, so no edge records the use but the file
 *   text does;
 * - an exported function nothing here calls, which an outside caller may.
 *
 * Every one of those must be OFF the list, and the reason must be counted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import {
  buildDeadCodeReport,
  isHeaderFile,
  isImplicitEntryName,
  isTestScope,
  isVendoredPath,
  mentionCount,
  DEAD_CODE_KINDS,
} from '../src/graph/dead-code';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';

let server: UiServerHandle;
let api: GraphApi;
let tempDir: string;
let projectRoot: string;
let cg: CodeGraph;

function write(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function request(requestPath: string): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: requestPath,
        method: 'GET',
        headers: { Host: `127.0.0.1:${server.port}` },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            type: res.headers['content-type'],
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getDeadCode(query = ''): Promise<any> {
  const res = await request(`/api/deadcode${query}`);
  expect(res.type).toBe('application/json; charset=utf-8');
  expect(res.status).toBe(200);
  return JSON.parse(res.body);
}

const names = (report: { entries: Array<{ node: { name: string } }> }): string[] =>
  report.entries.map((entry) => entry.node.name);

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deadcode-'));
  projectRoot = path.join(tempDir, 'project');

  // The one genuinely dead symbol, plus a live one beside it so the file is
  // reached and the island rule does not swallow the whole thing.
  write(
    projectRoot,
    'src/util.ts',
    `export function used(value: string): string {
  return value.trim();
}

function neverCalledAnywhere(value: string): string {
  return value.toUpperCase();
}

function alsoDeadButSmaller(): number {
  return 1;
}

// Exported and never called here — an outside caller may import it, so the
// default list must not claim it. It lives in a REACHED file on purpose: an
// unreached file is an island, which is a different exclusion.
export function publicEntryPoint(): string {
  return 'hello';
}
`
  );

  // The mis-resolution: \`Facade.load\` calls \`this.inner.load()\`, and the
  // resolver prefers a same-name definition in the call site's own file. One of
  // the two ends up with no incoming edge and neither is unreferenced.
  write(
    projectRoot,
    'src/inner.ts',
    `export class Inner {
  load(): string {
    return 'inner';
  }
}
`
  );

  // A base and an override: calls land on \`Base.run\`, never on \`Child.run\`.
  write(
    projectRoot,
    'src/base.ts',
    `export class Base {
  run(): string {
    return 'base';
  }
}
`
  );
  write(
    projectRoot,
    'src/child.ts',
    `import { Base } from './base';

export class Child extends Base {
  run(): string {
    return 'child';
  }
}
`
  );

  write(
    projectRoot,
    'src/facade.ts',
    `import { Inner } from './inner';
import { Base } from './base';
import { Child } from './child';
import { used } from './util';

function register(target: unknown, key: string): void {
  void target;
  void key;
}

export class Facade {
  inner = new Inner();
  child = new Child();

  load(): string {
    return this.inner.load();
  }

  go(): string {
    const base: Base = this.child;
    return used(base.run()) + this.load();
  }

  @register
  onEvent(): void {
    void 0;
  }
}
`
  );

  // Mentioned in a template but never called anywhere the graph can see: the
  // corroboration pass has to find the second mention in this file's own text.
  write(
    projectRoot,
    'src/handlers.ts',
    `export function mountHandlers(): string {
  return TEMPLATE;
}

function onSubmit(): void {
  void 0;
}

const TEMPLATE = '<form onsubmit="onSubmit()"></form>';
`
  );

  // Nothing imports this file at all: its symbols' zero fan-in describes the
  // file, not the symbol. That is the island rule, and it is the Map's job.
  write(
    projectRoot,
    'src/orphan.ts',
    `function strandedHelper(): string {
  return 'nobody imports this file';
}

function alsoStranded(): number {
  return strandedHelper().length;
}
`
  );

  write(
    projectRoot,
    'src/index.ts',
    `import { Facade } from './facade';
import { mountHandlers } from './handlers';

export function start(): string {
  return new Facade().go() + mountHandlers();
}
`
  );

  // A test helper file with a dependent, so `includeTests` is what decides
  // whether its dead symbol shows — not the island rule.
  write(
    projectRoot,
    'tests/helpers.ts',
    `export function sharedHelper(): string {
  return 'shared';
}

function helperNothingCalls(): void {
  void 0;
}
`
  );
  write(
    projectRoot,
    'tests/facade.test.ts',
    `import { Facade } from '../src/facade';
import { sharedHelper } from './helpers';

export function testFacade(): string {
  return new Facade().go() + sharedHelper();
}
`
  );

  const init = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts', 'tests/**/*.ts'], exclude: [] },
  });
  await init.indexAll();
  init.resolveReferences();
  init.close();

  cg = CodeGraph.openSync(projectRoot);

  const viewerDir = path.join(tempDir, 'viewer');
  fs.mkdirSync(viewerDir, { recursive: true });
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><div id="app"></div>');

  api = createGraphApi({ projectRoot });
  server = await startUiServer({ projectRoot, viewerDir, port: 0, api: api.handler });
}, 120_000);

afterAll(async () => {
  cg?.close();
  api?.close();
  await server?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('buildDeadCodeReport', () => {
  it('finds the symbol nothing references', () => {
    const report = buildDeadCodeReport(cg);
    expect(names(report)).toContain('neverCalledAnywhere');
  });

  it('leaves nothing on the list that anything reaches', () => {
    const report = buildDeadCodeReport(cg);
    // `used`, `start`, `go` and `mountHandlers` are all called; `Inner.load`
    // and `Facade.load` are the same-name pair; `Child.run` is an override.
    for (const name of ['used', 'start', 'go', 'mountHandlers', 'load', 'run']) {
      expect(names(report)).not.toContain(name);
    }
  });

  it('excludes a symbol only its own file mentions, and counts it', () => {
    const report = buildDeadCodeReport(cg);
    expect(names(report)).not.toContain('onSubmit');
    expect(report.excluded.mentioned).toBeGreaterThan(0);
    expect(report.corroborated).toBe(true);
  });

  it('makes the claim when corroboration is switched off', () => {
    // The rule that catches `onSubmit` is the only one that reads a file, so
    // turning it off has to be visible in BOTH the list and the flag.
    const report = buildDeadCodeReport(cg, { readSource: null });
    expect(report.corroborated).toBe(false);
    expect(report.excluded.mentioned).toBe(0);
    expect(names(report)).toContain('onSubmit');
  });

  it('excludes exported symbols by default and includes them on request', () => {
    const strict = buildDeadCodeReport(cg);
    expect(names(strict)).not.toContain('publicEntryPoint');
    expect(strict.excluded.exported).toBeGreaterThan(0);
    expect(strict.includeExported).toBe(false);

    const wide = buildDeadCodeReport(cg, { includeExported: true });
    expect(names(wide)).toContain('publicEntryPoint');
    expect(wide.includeExported).toBe(true);
    expect(wide.excluded.exported).toBe(0);
  });

  it('excludes test files by default and includes them on request', () => {
    expect(names(buildDeadCodeReport(cg))).not.toContain('helperNothingCalls');
    expect(buildDeadCodeReport(cg).excluded.tests).toBeGreaterThan(0);
    expect(names(buildDeadCodeReport(cg, { includeTests: true }))).toContain(
      'helperNothingCalls'
    );
  });

  it('says nothing about a file nothing in the index reaches', () => {
    // An island's symbols have zero fan-in because the FILE is unreached, which
    // is a fact about the file — the Map draws it, this list does not claim it.
    const report = buildDeadCodeReport(cg, { includeExported: true });
    expect(names(report)).not.toContain('strandedHelper');
    expect(report.excluded.unreachableFile).toBeGreaterThan(0);
  });

  it('excludes a decorated member — a framework registers it', () => {
    const report = buildDeadCodeReport(cg);
    expect(names(report)).not.toContain('onEvent');
    expect(report.excluded.decorated).toBeGreaterThan(0);
  });

  it('ranks by size and reports the real total when capped', () => {
    const full = buildDeadCodeReport(cg);
    const sizes = full.entries.map((entry) => entry.lines);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);

    const capped = buildDeadCodeReport(cg, { limit: 1 });
    expect(capped.entries).toHaveLength(1);
    expect(capped.total).toBe(full.total);
    // The cap trims the tail, not the head: the biggest finding survives.
    expect(capped.entries[0]?.node.name).toBe(full.entries[0]?.node.name);
  });

  it('every exclusion count is a number of candidates, and they add up', () => {
    const report = buildDeadCodeReport(cg);
    const excluded = Object.values(report.excluded).reduce((sum, n) => sum + n, 0);
    expect(report.candidates).toBeGreaterThan(0);
    expect(excluded + report.entries.length).toBeLessThanOrEqual(report.candidates);
    expect(report.bounded).toBe(false);
  });

  it('restricts to the kinds asked for, and ignores nonsense', () => {
    const classesOnly = buildDeadCodeReport(cg, { kinds: ['class'] });
    expect(classesOnly.kinds).toEqual(['class']);
    for (const entry of classesOnly.entries) expect(entry.node.kind).toBe('class');

    // An unknown kind is not a 500 and not an empty list: it falls back to the
    // default set, which is the answer the caller meant.
    const nonsense = buildDeadCodeReport(cg, { kinds: ['banana' as never] });
    expect(nonsense.kinds).toEqual([...DEAD_CODE_KINDS]);
  });
});

describe('the rules that are pure', () => {
  it('counts whole-identifier mentions only', () => {
    expect(mentionCount('const load = 1; loader(); reload();', 'load')).toBe(1);
    expect(mentionCount('a.load(); load();', 'load')).toBe(2);
    expect(mentionCount('nothing here', 'load')).toBe(0);
    // Stops early: the caller only ever needs to know "one, or more than one".
    expect(mentionCount('x x x x x', 'x', 2)).toBe(2);
  });

  it('matches vendored directories as whole segments', () => {
    expect(isVendoredPath('vendor/lib/a.go')).toBe(true);
    expect(isVendoredPath('a/node_modules/b/c.js')).toBe(true);
    expect(isVendoredPath('src/vendored-parser.ts')).toBe(false);
  });

  it('recognises headers as declaration surfaces', () => {
    expect(isHeaderFile('src/tree_sitter/parser.h')).toBe(true);
    expect(isHeaderFile('types/global.d.ts')).toBe(true);
    expect(isHeaderFile('src/parser.c')).toBe(false);
  });

  it('recognises a test scope inside a file', () => {
    expect(isTestScope('tests::row_sizes_match')).toBe(true);
    expect(isTestScope('Fixtures.Tests.Helper')).toBe(true);
    expect(isTestScope('Latest.value')).toBe(false);
  });

  it('recognises names the language calls by itself', () => {
    expect(isImplicitEntryName('constructor')).toBe(true);
    expect(isImplicitEntryName('__enter__')).toBe(true);
    expect(isImplicitEntryName('ToString')).toBe(true);
    expect(isImplicitEntryName('mainHandler')).toBe(false);
  });
});

describe('GET /api/deadcode', () => {
  it('groups the rows by file and keeps the totals honest', async () => {
    const payload = await getDeadCode();
    expect(payload.rows.total).toBe(payload.rows.items.length);
    expect(payload.rows.shown).toBe(payload.rows.items.length);

    // Every count equals a list length in the same payload.
    const grouped = payload.groups.reduce((sum: number, g: any) => sum + g.rows.length, 0);
    expect(grouped).toBe(payload.rows.shown);

    const files = payload.groups.map((g: any) => g.file);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toContain('src/util.ts');
  });

  it('carries the exclusions with their own wording', async () => {
    const payload = await getDeadCode();
    expect(payload.excluded.length).toBeGreaterThan(0);
    for (const entry of payload.excluded) {
      expect(entry.count).toBeGreaterThan(0);
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
    }
    const sum = payload.excluded.reduce((n: number, e: any) => n + e.count, 0);
    expect(payload.excludedTotal).toBe(sum);
    expect(payload.candidates).toBeGreaterThanOrEqual(payload.excludedTotal);
    expect(payload.corroborated).toBe(true);
  });

  it('widens on ?exported=1 and says which list it answered', async () => {
    const strict = await getDeadCode();
    const wide = await getDeadCode('?exported=1');
    expect(strict.includeExported).toBe(false);
    expect(wide.includeExported).toBe(true);
    expect(wide.rows.total).toBeGreaterThan(strict.rows.total);
    expect(wide.rows.items.some((r: any) => r.name === 'publicEntryPoint')).toBe(true);
  });

  it('honours ?limit= without lying about the total', async () => {
    const full = await getDeadCode();
    const capped = await getDeadCode('?limit=1');
    expect(capped.rows.items).toHaveLength(1);
    expect(capped.rows.total).toBe(full.rows.total);
    expect(capped.rows.truncated).toBe(full.rows.total > 1);
  });

  it('is listed on the API index', async () => {
    const res = await request('/api');
    const body = JSON.parse(res.body);
    expect(body.endpoints.some((e: any) => e.path === '/api/deadcode')).toBe(true);
  });
});

describe('GET /api/map — generated files and islands', () => {
  it('reports how many of a module’s files are tool-generated', async () => {
    const res = await request('/api/map');
    const payload = JSON.parse(res.body);
    for (const module of payload.modules) {
      expect(typeof module.generated).toBe('number');
      expect(module.generated).toBeLessThanOrEqual(module.files);
      // The dimmed rows are drawn from `fileList.items`, so the generated
      // subset has to be a subset of exactly that list.
      for (const file of module.generatedFiles) {
        expect(module.fileList.items).toContain(file);
      }
    }
  });
});
