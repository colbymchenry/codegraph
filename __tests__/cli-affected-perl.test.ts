/**
 * `codegraph affected` must recognize Perl's test-file convention.
 *
 * Perl marks tests by EXTENSION, not by a `test`/`spec` name segment: `prove`
 * runs `t/*.t`. None of the default patterns (`.spec.`, `.test.`, `__tests__/`,
 * `tests?/`, `e2e/`, `spec/`) match `t/sample.t`, so `affected` reported zero
 * affected tests for every Perl project even when the dependency edge was
 * present in the graph.
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

describe('codegraph affected — Perl `t/*.t` test convention', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-perl-'));
    fs.mkdirSync(path.join(tempDir, 'lib'));
    fs.mkdirSync(path.join(tempDir, 't'));
    fs.writeFileSync(
      path.join(tempDir, 'lib/Sample.pm'),
      'package Sample;\n\nsub sample_widget_build { return 42; }\n\n1;\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 't/sample.t'),
      "use Sample;\n\nmy $got = Sample::sample_widget_build();\nprint $got;\n",
    );
    // A helper living under t/ is NOT a test — it has no `.t` extension.
    fs.writeFileSync(
      path.join(tempDir, 't/Helper.pm'),
      'package Helper;\n\nsub helper_noop { return Sample::sample_widget_build(); }\n\n1;\n',
    );
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports a dependent `.t` file as an affected test', () => {
    expect(affected(tempDir, 'lib/Sample.pm')).toContain('t/sample.t');
  });

  it('does not treat a non-`.t` helper module under t/ as a test', () => {
    expect(affected(tempDir, 'lib/Sample.pm')).not.toContain('t/Helper.pm');
  });
});

/**
 * Perl in the wild is full of house-specific test extensions (NetApp ONTAP uses
 * `.thpl` and `.cdefs` for tens of thousands of files). Those don't belong in
 * the shipped EXTENSION_MAP, so they go through the per-project `codegraph.json`
 * `extensions` override — which validates its value with `isLanguageSupported`,
 * meaning `"perl"` was rejected outright before this change. `affected`'s
 * `--filter` is then the escape hatch for a house test-file convention.
 */
describe('codegraph affected — project-configured Perl extension (.thpl)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-thpl-'));
    fs.mkdirSync(path.join(tempDir, 'lib'));
    fs.mkdirSync(path.join(tempDir, 'suites'));
    fs.writeFileSync(
      path.join(tempDir, 'codegraph.json'),
      JSON.stringify({ extensions: { '.thpl': 'perl' }, include: ['**/*.pm', '**/*.thpl'] }, null, 2),
    );
    fs.writeFileSync(
      path.join(tempDir, 'lib/Widget.pm'),
      'package Widget;\n\nsub widget_frobnicate { return 7; }\n\n1;\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'suites/smoke.thpl'),
      "use Widget;\n\nmy $v = Widget::widget_frobnicate();\nprint $v;\n",
    );
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('indexes a .thpl file as Perl and extracts its symbols', () => {
    const cg = CodeGraph.openSync(tempDir);
    try {
      const thpl = cg
        .searchNodes('widget_frobnicate', { limit: 20 })
        .map((r) => r.node)
        .filter((n) => n.filePath.endsWith('.thpl') || n.filePath.endsWith('.pm'));
      expect(thpl.length).toBeGreaterThan(0);
      expect(thpl.every((n) => n.language === 'perl')).toBe(true);
    } finally {
      cg.close();
    }
  });

  it('reports a dependent .thpl file as affected under a custom --filter', () => {
    const out = execFileSync(
      process.execPath,
      [BIN, 'affected', 'lib/Widget.pm', '--filter', '**/*.thpl', '--quiet', '-p', tempDir],
      {
        encoding: 'utf-8',
        env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(out.split('\n').map((s) => s.trim()).filter(Boolean)).toContain('suites/smoke.thpl');
  });
});
