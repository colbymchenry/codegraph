/**
 * Same-named symbols across monorepo apps (#764).
 *
 * A NestJS-style monorepo has one `UserService` (and friends) per app. The
 * graph keeps them as distinct nodes (import + proximity resolution), but the
 * MCP tools used to AGGREGATE them: callers/callees returned one merged list
 * and impact merged both blast radii — the conflation agents warned about.
 *
 * Now: multiple DISTINCT definitions (different file/qualified-name) render
 * one section per definition, and `file` narrows to a single definition.
 * Same-file overloads still merge (that's the overload feature).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let tmpDir: string;
let cg: CodeGraph;
let handler: ToolHandler;
const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

const text = async (tool: string, args: Record<string, unknown>): Promise<string> => {
  const res = await handler.execute(tool, args);
  return res.content?.[0]?.text ?? '';
};

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-764-'));
  const mk = (rel: string, content: string) => {
    const p = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  for (const app of ['billing', 'admin']) {
    mk(
      `apps/${app}/src/users/user.service.ts`,
      [
        "import { UserRepository } from './user.repository';",
        'export class UserService {',
        '  constructor(private readonly repo: UserRepository) {}',
        '  findAll(): string[] {',
        `    return this.repo.load_${app}();`,
        '  }',
        '}',
      ].join('\n')
    );
    mk(
      `apps/${app}/src/users/user.repository.ts`,
      `export class UserRepository {\n  load_${app}(): string[] { return []; }\n}\n`
    );
    mk(
      `apps/${app}/src/users/user.controller.ts`,
      [
        "import { UserService } from './user.service';",
        'export class UserController {',
        '  constructor(private readonly users: UserService) {}',
        '  list(): string[] { return this.users.findAll(); }',
        '}',
      ].join('\n')
    );
  }

  mk(
    'src/lambdas.cpp',
    [
      'int firstLeaf() { return 1; }',
      'int secondLeaf() { return 2; }',
      'void record() {',
      '  {',
      '    auto bufferResource = []() { return firstLeaf(); };',
      '    bufferResource();',
      '  }',
      '  {',
      '    auto bufferResource = []() { return secondLeaf(); };',
      '    bufferResource();',
      '  }',
      '}',
    ].join('\n')
  );

  cg = CodeGraph.initSync(tmpDir);
  await cg.indexAll();
  handler = new ToolHandler(cg);
}, 120_000);

afterAll(() => {
  cg?.destroy();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('same-named symbols across apps (#764)', () => {
  it('graph keeps the apps apart: no cross-app edges at all', () => {
    const billing = new Set(
      cg.getNodesByName('findAll').filter((n) => n.filePath.includes('billing')).map((n) => n.id)
    );
    for (const id of billing) {
      for (const e of cg.getIncomingEdges(id)) {
        const src = cg.getNode(e.source);
        expect(src?.filePath.includes('admin')).toBe(false);
      }
    }
  });

  it('callers: one section per distinct definition, each with only its own callers', async () => {
    const out = await text('codegraph_callers', { symbol: 'findAll' });
    expect(out).toContain('2 distinct definitions');
    // Section per definition…
    expect(out).toContain('apps/admin/src/users/user.service.ts');
    expect(out).toContain('apps/billing/src/users/user.service.ts');
    // …and the billing section must list the billing controller, not admin's.
    const billingSection = out.slice(out.indexOf('apps/billing/src/users/user.service.ts'));
    // The next definition heading is a line-start bold label (issue #778: ATX `###`
    // headings became `**…**`); billingSection starts mid-heading, so `\n**` finds it.
    const nextDef = billingSection.indexOf('\n**');
    const billingBody = billingSection.slice(0, nextDef > 0 ? nextDef : undefined);
    expect(billingBody).toContain('apps/billing/src/users/user.controller.ts');
    expect(billingBody).not.toContain('apps/admin/src/users/user.controller.ts');
  });

  it('callers: `file` narrows to one definition (flat list, no stale aggregation note)', async () => {
    const out = await text('codegraph_callers', {
      symbol: 'findAll',
      file: 'apps/billing/src/users/user.service.ts',
    });
    expect(out).not.toContain('distinct definitions');
    expect(out).toContain('apps/billing/src/users/user.controller.ts');
    expect(out).not.toContain('apps/admin/');
    expect(out).not.toContain('Aggregated results');
  });

  it('callers: a non-matching `file` falls back to all definitions with a note', async () => {
    const out = await text('codegraph_callers', { symbol: 'findAll', file: 'apps/nonexistent/x.ts' });
    expect(out).toContain('no definition of "findAll" matches file');
    expect(out).toContain('2 distinct definitions');
  });

  it('impact: separate blast radius per definition, never a merged one', async () => {
    const out = await text('codegraph_impact', { symbol: 'UserService' });
    expect(out).toContain('2 distinct definitions');
    // Each section's count covers ONE app (service + ctor + findAll +
    // controller side), not the union of both.
    const counts = [...out.matchAll(/affects (\d+) symbols/g)].map((m) => Number(m[1]));
    expect(counts).toHaveLength(2);
    for (const c of counts) expect(c).toBeLessThanOrEqual(7);
  });

  it('callees: grouped the same way', async () => {
    const out = await text('codegraph_callees', { symbol: 'list' });
    expect(out).toContain('2 distinct definitions');
  });

  it('line narrows repeated same-name lambdas within one file and scope', async () => {
    const lambdas = cg.getNodesByName('bufferResource');
    expect(lambdas.map((node) => node.startLine).sort((a, b) => a - b)).toEqual([5, 9]);
    expect(new Set(lambdas.map((node) => node.qualifiedName)).size).toBe(1);
    expect(lambdas.every((node) => node.decorators?.includes('cpp:lambda'))).toBe(true);

    const fileOnly = await text('codegraph_impact', {
      symbol: 'bufferResource',
      file: 'src/lambdas.cpp',
    });
    expect(fileOnly).toContain('2 distinct definitions');
    expect(fileOnly).toContain('src/lambdas.cpp:5');
    expect(fileOnly).toContain('src/lambdas.cpp:9');

    const callees = await text('codegraph_callees', {
      symbol: 'bufferResource',
      file: 'src/lambdas.cpp',
      line: 5,
    });
    expect(callees).toContain('firstLeaf');
    expect(callees).not.toContain('secondLeaf');

    const impact = await text('codegraph_impact', {
      symbol: 'bufferResource',
      file: 'src/lambdas.cpp',
      line: 5,
    });
    expect(impact).toContain('bufferResource');
    expect(impact).not.toContain(':9');
  });

  it('CLI impact accepts --line to select one same-file definition', () => {
    const output = execFileSync(process.execPath, [
      BIN,
      'impact',
      'bufferResource',
      '--file',
      'src/lambdas.cpp',
      '--line',
      '5',
      '--path',
      tmpDir,
      '--json',
    ], {
      encoding: 'utf8',
      env: { ...process.env, CODEGRAPH_WASM_RELAUNCHED: '1' },
    });
    const result = JSON.parse(output) as { line: number; affected: Array<{ name: string; startLine?: number }> };
    expect(result.line).toBe(5);
    expect(result.affected).toContainEqual(expect.objectContaining({ name: 'bufferResource', startLine: 5 }));
    expect(result.affected).not.toContainEqual(expect.objectContaining({ name: 'bufferResource', startLine: 9 }));
  });

  it('line misses are success-shaped and do not fall back to another definition', async () => {
    const out = await text('codegraph_callers', {
      symbol: 'bufferResource',
      file: 'src/lambdas.cpp',
      line: 99,
    });
    expect(out).toContain('not found at file "src/lambdas.cpp" at line 99');
  });
});
