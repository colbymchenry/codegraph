import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../scripts/check-ui-build.mjs');
const GATE_GRAMMARS = [
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-swift.wasm',
  'tree-sitter-c_sharp.wasm',
  'tree-sitter-ruby.wasm',
  'tree-sitter-php.wasm',
  'tree-sitter-haskell.wasm',
];

describe('staged UI/build artifact check', () => {
  let root: string;
  let wasmDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-check-ui-build-'));
    const viewerDir = path.join(root, 'dist', 'viewer');
    wasmDir = path.join(root, 'dist', 'extraction', 'wasm');
    fs.mkdirSync(path.join(viewerDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist', 'ui'), { recursive: true });
    fs.mkdirSync(wasmDir, { recursive: true });

    const padding = '<!-- built viewer padding -->'.repeat(12);
    fs.writeFileSync(
      path.join(viewerDir, 'index.html'),
      `<!doctype html><html><body><div id="app"></div><script src="assets/app.js"></script>${padding}</body></html>`,
    );
    fs.writeFileSync(path.join(viewerDir, 'assets', 'app.js'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'dist', 'bin', 'codegraph.js'), '');
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), '');
    fs.writeFileSync(path.join(root, 'dist', 'ui', 'shimmer-progress.js'), '');
    const wasm = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d]), Buffer.alloc(10_000)]);
    for (const grammar of GATE_GRAMMARS) fs.writeFileSync(path.join(wasmDir, grammar), wasm);
    fs.writeFileSync(path.join(wasmDir, 'tree-sitter-haskell.LICENSE'), 'MIT\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function check() {
    return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  }

  it('accepts a staged bundle containing the Haskell grammar and license', () => {
    const result = check();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('11 grammars + 1 required license notice');
  });

  it('rejects a staged bundle without the Haskell grammar', () => {
    fs.rmSync(path.join(wasmDir, 'tree-sitter-haskell.wasm'));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tree-sitter-haskell.wasm');
  });

  it('rejects a staged bundle with a truncated Haskell grammar', () => {
    fs.writeFileSync(path.join(wasmDir, 'tree-sitter-haskell.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tree-sitter-haskell.wasm');
  });

  it('rejects a staged bundle without the Haskell license notice', () => {
    fs.rmSync(path.join(wasmDir, 'tree-sitter-haskell.LICENSE'));
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tree-sitter-haskell.LICENSE');
  });
});
