/**
 * `codegraph cycles`: circular imports between files, end to end against the
 * built binary. Exit 1 when there are any is the command's contract: it is what
 * makes `codegraph cycles || exit 1` a pre-commit or CI check.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(cwd: string, ...args: string[]) {
  const res = spawnSync(process.execPath, [BIN, 'cycles', cwd, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function indexProject(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  cg.close();
}

/** `count` files in one import ring: each imports the next, the last the first. */
function ring(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    files[`src/f${String(i).padStart(2, '0')}.ts`] =
      `import { f${next} } from './f${String(next).padStart(2, '0')}';\nexport function f${i}() { return f${next}(); }\n`;
  }
  return files;
}

describe('codegraph cycles', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cycles-cli-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists the files of a circular import and exits 1', async () => {
    await indexProject(dir, {
      'src/a.ts': "import { b } from './b';\nexport function a() { return b(); }\n",
      'src/b.ts': "import { a } from './a';\nexport function b() { return a(); }\n",
      'src/plain.ts': "import { a } from './a';\nexport const plain = a;\n",
    });

    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('Circular imports: 1 group, 2 files');
    expect(res.stdout).toContain('src/a.ts');
    expect(res.stdout).toContain('src/b.ts');
    expect(res.stdout).not.toContain('src/plain.ts');
  });

  it('prints the whole report as JSON and still exits 1', async () => {
    await indexProject(dir, {
      'src/a.ts': "import { b } from './b';\nexport function a() { return b(); }\n",
      'src/b.ts': "import { a } from './a';\nexport function b() { return a(); }\n",
    });

    const res = run(dir, '--json');
    expect(res.status).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({ count: 1, cycles: [['src/a.ts', 'src/b.ts']] });
  });

  it('says so and exits 0 when the project has none', async () => {
    await indexProject(dir, {
      'src/a.ts': 'export function a() { return 1; }\n',
      'src/b.ts': "import { a } from './a';\nexport function b() { return a(); }\n",
    });

    const res = run(dir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No circular imports found');

    const json = run(dir, '--json');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ count: 0, cycles: [] });
  });

  it('shows the first files of a long group, and --json all of them', async () => {
    await indexProject(dir, ring(14));

    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('1. 14 files');
    expect(res.stdout).toContain('src/f11.ts');
    expect(res.stdout).not.toContain('src/f12.ts');
    expect(res.stdout).toContain('... and 2 more (--json lists them all)');

    const parsed = JSON.parse(run(dir, '--json').stdout) as { cycles: string[][] };
    expect(parsed.cycles).toHaveLength(1);
    expect(parsed.cycles[0]).toHaveLength(14);
  });

  it('fails plainly on a project with no index', () => {
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain('not initialized');
  });
});
