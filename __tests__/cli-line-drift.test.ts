/**
 * `codegraph callers`, `callees` and `impact` print line numbers from the
 * index. After a file is edited and before a sync, those lines can point at
 * other code, and `node` and `explore` already said so while these three
 * printed the old lines as if current (#3260). They now name the files that
 * changed on disk since they were indexed: in the text, or on stderr plus a
 * `changedOnDisk` field under `--json`, so stdout stays parseable.
 *
 * The check is shared with the MCP tools (src/graph/file-drift.ts), and the
 * read commands must stay light to load, so they never pull in the MCP tools.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { fileDrift, filesChangedSinceIndexed } from '../src/graph/file-drift';

const DIST = path.resolve(__dirname, '../dist');
const BIN = path.join(DIST, 'bin', 'codegraph.js');

const HELPER = 'export function plainHelper(m: { name: string }) { return m.name; }\n';
const DIRECT =
  "import { plainHelper } from './helper';\n" +
  'export function direct(m: { name: string }) { return plainHelper(m); }\n' +
  "export function main() { return direct({ name: 'a' }); }\n";

describe('callers, callees and impact flag files edited since the last index (#3260)', () => {
  let root: string;
  let dir: string;
  let hook: string;
  let loadedList: string;

  /** Run the built CLI in-process (no relaunch), recording which dist files it loaded. */
  function cli(args: string[]): { status: number | null; stdout: string; stderr: string; loaded: string[] } {
    const r = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, '--require', hook, BIN, ...args, '-p', dir], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1', DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0' },
      timeout: 60_000,
    });
    const loaded = (JSON.parse(fs.readFileSync(loadedList, 'utf-8')) as string[])
      .filter((f) => f.startsWith(DIST))
      .map((f) => path.relative(DIST, f).split(path.sep).join('/'));
    // Node's own experimental-SQLite notice isn't ours to assert on.
    const stderr = r.stderr.split(/\r?\n/).filter((line) => !/ExperimentalWarning|--trace-warnings/.test(line)).join('\n');
    return { status: r.status, stdout: r.stdout, stderr, loaded };
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-line-drift-'));
    dir = path.join(root, 'project');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/helper.ts'), HELPER);
    fs.writeFileSync(path.join(dir, 'src/direct.ts'), DIRECT);
    const cg = await CodeGraph.init(dir, { index: true });
    cg.destroy();
    loadedList = path.join(root, 'loaded.json');
    hook = path.join(root, 'hook.cjs');
    fs.writeFileSync(
      hook,
      `process.on('exit', () => require('fs').writeFileSync(${JSON.stringify(loadedList)}, JSON.stringify(Object.keys(require.cache))));\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const COMMANDS: Array<[string, string[]]> = [
    ['callers', ['callers', 'plainHelper']],
    ['callees', ['callees', 'direct']],
    ['impact', ['impact', 'plainHelper']],
  ];

  it.each(COMMANDS)('`%s` says nothing about a file nobody touched', (_name, args) => {
    const text = cli(args);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).not.toContain('changed on disk');
    const json = cli([...args, '--json']);
    expect(json.stderr).not.toContain('changed on disk');
    expect(JSON.parse(json.stdout)).not.toHaveProperty('changedOnDisk');
  });

  it.each(COMMANDS)('`%s` names a file whose lines moved since the last index', (_name, args) => {
    // Shift every line of the caller's file down by three, without syncing.
    fs.writeFileSync(path.join(dir, 'src/direct.ts'), '// a\n// b\n// c\n' + DIRECT);
    const text = cli(args);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('src/direct.ts changed on disk after it was last indexed');
    expect(text.stdout).toContain('codegraph sync');

    const json = cli([...args, '--json']);
    expect(json.status, json.stderr).toBe(0);
    expect(json.stderr).toContain('src/direct.ts changed on disk after it was last indexed');
    const answer = JSON.parse(json.stdout) as { changedOnDisk?: string[] };
    expect(answer.changedOnDisk).toEqual(['src/direct.ts']);
  });

  it('does not flag a file rewritten with the same bytes, and flags one deleted', () => {
    const direct = path.join(dir, 'src/direct.ts');
    fs.writeFileSync(direct, DIRECT);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(direct, later, later);
    expect(cli(['callers', 'plainHelper']).stdout).not.toContain('changed on disk');

    fs.rmSync(direct);
    expect(cli(['callers', 'plainHelper']).stdout).toContain('src/direct.ts changed on disk after it was last indexed');
  });

  it('keeps the read commands off the MCP tools module', () => {
    for (const [, args] of COMMANDS) {
      expect(cli(args).loaded, args[0]).not.toContain('mcp/tools.js');
    }
  });

  it('reads current, changed, missing and unknown the way the MCP tools need', async () => {
    const cg = await CodeGraph.open(dir, { readOnly: true });
    try {
      expect(fileDrift(cg, 'src/helper.ts')).toBe('current');
      expect(fileDrift(cg, 'src/not-indexed.ts')).toBe('unknown');
      fs.writeFileSync(path.join(dir, 'src/helper.ts'), HELPER + '// more\n');
      expect(fileDrift(cg, 'src/helper.ts')).toBe('changed');
      // Text the caller already holds is hashed in place of a read.
      expect(fileDrift(cg, 'src/helper.ts', HELPER)).toBe('current');
      fs.rmSync(path.join(dir, 'src/direct.ts'));
      expect(fileDrift(cg, 'src/direct.ts')).toBe('missing');
      expect(filesChangedSinceIndexed(cg, ['src/helper.ts', 'src/direct.ts', 'src/helper.ts'])).toEqual(['src/helper.ts', 'src/direct.ts']);
    } finally {
      cg.destroy();
    }
  });
});
