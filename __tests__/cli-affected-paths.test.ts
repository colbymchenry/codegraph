/**
 * `codegraph affected` input-path normalization (#825).
 *
 * The index stores project-relative, forward-slash paths. A user (or a wrapping
 * script) may pass a `./`-prefixed path or an absolute path; before #825 those
 * silently matched nothing and reported 0 affected tests. All three spellings
 * must now resolve the same affected test file.
 *
 * Exercised end-to-end against the built binary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function affected(cwd: string, arg: string): string[] {
  const out = execFileSync(process.execPath, [BIN, 'affected', arg, '--quiet', '-p', cwd], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('codegraph affected — input path normalization (#825)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-paths-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    // util.ts <- helper.ts <- helper.test.ts (transitive test dependency)
    fs.writeFileSync(path.join(tempDir, 'src/util.ts'), 'export function util(x: number){ return x + 1; }\n');
    fs.writeFileSync(
      path.join(tempDir, 'src/helper.ts'),
      "import { util } from './util';\nexport function helper(){ return util(1); }\n",
    );
    fs.writeFileSync(
      path.join(tempDir, 'src/helper.test.ts'),
      "import { helper } from './helper';\ntest('t', () => helper());\n",
    );
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('bare-relative, ./-prefixed, and absolute paths all resolve the same affected test', () => {
    const expected = ['src/helper.test.ts'];
    // Baseline that always worked.
    expect(affected(tempDir, 'src/util.ts')).toEqual(expected);
    // Both of these returned [] before the normalization fix.
    expect(affected(tempDir, './src/util.ts')).toEqual(expected);
    expect(affected(tempDir, path.join(tempDir, 'src/util.ts'))).toEqual(expected);
  });
});
