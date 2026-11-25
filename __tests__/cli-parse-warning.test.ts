import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const COLLAPSE_WARNING = 'parse produced no symbols (tree has errors)';
const SOURCE = `const char* kTemplate = R"FILE_TEMPLATE_V1(
struct Ignored { int v; };
)FILE_TEMPLATE_V1";

int after_the_raw_string(int x) {
  return x + 1;
}
`;

describe('CLI parse warnings (#1522)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parse-warning-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(args: string[]) {
    const result = spawnSync(process.execPath, [BIN, ...args], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 20_000,
      env: {
        ...process.env,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_WASM_RELAUNCHED: '1',
        CODEGRAPH_TELEMETRY: '0',
        NO_COLOR: '1',
      },
    });
    return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
  }

  it('shows a collapsed parse without failing, then stays quiet after a healthy re-index', () => {
    const sourcePath = path.join(root, 'min.cpp');
    fs.writeFileSync(sourcePath, SOURCE);

    const collapsed = run(['init', '--yes']);
    expect(collapsed.status, collapsed.out).toBe(0);
    expect(collapsed.out).toContain('Indexed 1 files');
    expect(collapsed.out).toContain(`min.cpp: ${COLLAPSE_WARNING}`);

    fs.writeFileSync(sourcePath, SOURCE.replaceAll('FILE_TEMPLATE_V1', 'FILE_TEMPLATE_V'));
    const healthy = run(['index']);
    expect(healthy.status, healthy.out).toBe(0);
    expect(healthy.out).not.toContain(COLLAPSE_WARNING);

    const query = run(['query', 'after_the_raw_string']);
    expect(query.status, query.out).toBe(0);
    expect(query.out).toMatch(/function\s+after_the_raw_string/);
  }, 30_000);
});
