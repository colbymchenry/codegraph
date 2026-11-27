/**
 * A source file over the size limit is tracked and never parsed, so the graph
 * holds none of its symbols. That is on purpose. What was wrong is that nothing
 * said so: `index` printed "Indexed N files", `status` printed "Index is up to
 * date", and a file's symbol map read "No indexed symbols in this file", for a
 * file of 37,000 lines of hand-written source. A search, a caller list or an
 * impact report over such a project is missing whatever that file holds, and
 * silence reads as "not there".
 *
 * These pin where it is now said: the index health the engine reports, the
 * `status` text and JSON, the line `index` prints, and the symbol map of the
 * file itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';
import { ToolHandler } from '../src/mcp/tools';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

// These index a project and spawn the real CLI.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SMALL = 'export function alpha(): number { return 1; }\n';
/** Real source, with a symbol, a little over the limit. */
const BIG = `// ${'x'.repeat(MAX_SOURCE_FILE_SIZE_BYTES)}\nexport function hidden(): number { return 2; }\n`;

describe('files left out of the graph for their size are said to be', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-oversize-reported-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(files: Record<string, string>): void {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  function cli(...args: string[]): { code: number | null; stdout: string; stderr: string } {
    const run = spawnSync(process.execPath, [BIN, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', NO_COLOR: '1', CODEGRAPH_TELEMETRY: '0' },
    });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  it('lists them in the index health, with their size, and nothing else as oversize', async () => {
    write({ 'src/small.ts': SMALL, 'src/big.ts': BIG, 'data/big.json': `{"k":"${'y'.repeat(MAX_SOURCE_FILE_SIZE_BYTES)}"}` });
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    try {
      const health = cg.getIndexHealth();
      expect(health.oversize).toEqual([{ path: 'src/big.ts', size: Buffer.byteLength(BIG) }]);
      // Left out on purpose: not something a sync would repair, not a parse error.
      expect(health.needsReindex).toEqual([]);
      expect(health.parseErrors).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('reports none for a project whose files are all within the limit', async () => {
    write({ 'src/small.ts': SMALL });
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    try {
      expect(cg.getIndexHealth().oversize).toEqual([]);
    } finally {
      cg.close();
    }
    const text = cli('status', dir).stdout;
    expect(text).toContain('Index is up to date');
    expect(text).not.toContain('size limit');
    expect(JSON.parse(cli('status', dir, '--json').stdout).index.filesOverSizeLimit).toBe(0);
  });

  it('status names them and still says the index is up to date', async () => {
    write({ 'src/small.ts': SMALL, 'src/big.ts': BIG });
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    cg.close();

    const { code, stdout } = cli('status', dir);
    expect(code).toBe(0);
    // Nothing is stale and nothing needs a sync: the file is left out by design.
    expect(stdout).toContain('Index is up to date');
    expect(stdout).toMatch(/1 source file is over the 1\.0 MB size limit and not in the graph/);
    expect(stdout).toContain('src/big.ts (1.0 MB)');

    const json = JSON.parse(cli('status', dir, '--json').stdout);
    expect(json.index.filesOverSizeLimit).toBe(1);
    expect(json.index.oversizeFiles).toEqual([{ path: 'src/big.ts', size: Buffer.byteLength(BIG) }]);
    expect(json.index.sizeLimitBytes).toBe(MAX_SOURCE_FILE_SIZE_BYTES);
    // `--strict` is about an unfinished or stale index. This is neither.
    expect(cli('status', dir, '--strict').code).toBe(0);
  });

  it('index says so when it leaves a file out, the smallest first', async () => {
    const bigger = `${BIG}// ${'z'.repeat(300_000)}\n`;
    write({ 'src/small.ts': SMALL, 'src/big.ts': BIG, 'src/bigger.ts': bigger });
    const { code, stdout, stderr } = cli('init', dir);
    expect(code).toBe(0);
    const said = `${stdout}\n${stderr}`;
    expect(said).toMatch(/2 source files are over the 1\.0 MB size limit and not in the graph/);
    // The file nearest the limit is the likeliest to be hand-written source.
    expect(said).toMatch(/src\/big\.ts \(1\.0 MB\), src\/bigger\.ts \(1\.3 MB\)/);
  });

  it('sync says so too, for a file that grew past the limit and for one already left out', async () => {
    write({ 'src/small.ts': SMALL, 'src/big.ts': SMALL });
    expect(cli('init', dir).code).toBe(0);
    write({ 'src/big.ts': BIG });
    const grew = cli('sync', dir);
    expect(grew.code).toBe(0);
    expect(`${grew.stdout}\n${grew.stderr}`).toMatch(/1 source file is over the 1\.0 MB size limit and not in the graph/);
    // Nothing changed this time; the file is still left out, and sync still says so.
    const again = cli('sync', dir);
    expect(`${again.stdout}\n${again.stderr}`).toContain('src/big.ts (1.0 MB)');
  });

  it('the symbol map of such a file says it was not indexed, not that it is empty', async () => {
    write({ 'src/small.ts': SMALL, 'src/big.ts': BIG });
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    try {
      const handler = new ToolHandler(cg);
      const map = async (file: string): Promise<string> =>
        (await handler.execute('codegraph_node', { file, symbolsOnly: true })).content.map((c) => c.text).join('\n');
      const big = await map('src/big.ts');
      expect(big).toContain('_Not indexed: at 1.0 MB this file is over the size limit for source files');
      expect(big).not.toContain('No indexed symbols in this file');
      expect(await map('src/small.ts')).toContain('`alpha`');
    } finally {
      cg.close();
    }
  });
});
