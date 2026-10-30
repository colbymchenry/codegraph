/**
 * scripts/add-lang/verify-extraction.mjs reads `codegraph status --json` from
 * the codegraph that built an index. It used to call `codegraph` by bare name,
 * which never works on Windows: npm installs codegraph there as a .cmd shim,
 * and Node can neither find a .cmd by bare name nor run one without a shell.
 * /add-lang's bench.sh then skipped its A/B as if extraction had failed.
 *
 * A stand-in for codegraph prints a healthy status and records the arguments
 * it received, so each test can check what reached it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.resolve('scripts/add-lang/verify-extraction.mjs');
const roots: string[] = [];

const FAKE_CODEGRAPH = `
const fs = require('fs');
fs.writeFileSync(process.env.CG_TEST_ARGV, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({
  initialized: true, backend: 'node-sqlite', fileCount: 2, nodeCount: 9, edgeCount: 7,
  languages: ['lua'], nodesByKind: { file: 2, function: 5, variable: 2 },
}));
`;

function kit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-verify-extraction-'));
  roots.push(root);
  const fake = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(fake, FAKE_CODEGRAPH);
  // A folder name like npm's prefix under "Program Files (x86)".
  const bin = path.join(root, 'bin (x86)');
  fs.mkdirSync(bin);
  return { root, fake, bin, argv: path.join(root, 'argv.json') };
}

// The script's environment, with PATH limited to `dirs` plus what node needs,
// so no codegraph installed on the machine running the tests can answer.
function envWith(k: ReturnType<typeof kit>, dirs: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'PATH' && key !== 'CODEGRAPH_BIN') env[key] = value;
  }
  const system = process.platform === 'win32' ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
  env.PATH = [...dirs, path.dirname(process.execPath), ...system].join(path.delimiter);
  env.CG_TEST_ARGV = k.argv;
  return { ...env, ...extra };
}

function verify(k: ReturnType<typeof kit>, repo: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(process.execPath, [SCRIPT, repo, 'lua'], { encoding: 'utf8', timeout: 60_000, env });
  const received = fs.existsSync(k.argv) ? JSON.parse(fs.readFileSync(k.argv, 'utf8')) : null;
  return { status: r.status, output: `${r.stdout}${r.stderr}`, received };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('add-lang verify-extraction: which codegraph it asks', () => {
  it('reads the status through CODEGRAPH_BIN, running a .js path with node', () => {
    const k = kit();
    const repo = path.join(k.root, 'some repo');
    const r = verify(k, repo, envWith(k, [], { CODEGRAPH_BIN: k.fake }));
    expect(r.output).toContain('RESULT: PASS');
    expect(r.status).toBe(0);
    expect(r.received).toEqual(['status', repo, '--json']);
  });

  it.runIf(process.platform === 'win32')('finds the npm .cmd shim on PATH and passes an awkward repo path through cmd.exe intact', () => {
    const k = kit();
    // The shape of npm's shim: cmd.exe runs it and %* hands the arguments on.
    fs.writeFileSync(path.join(k.bin, 'codegraph.cmd'), '@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\n"%_prog%" "%~dp0..\\fake-codegraph.cjs" %*\r\n');
    // Spaces, & and parentheses, a defined %NAME%, a lone %, and a trailing
    // backslash that must not escape the closing quote.
    const repo = path.join(k.root, 'repo & co (x86) %CG_TEST_PCT% 50%') + '\\';
    const r = verify(k, repo, envWith(k, [k.bin], { CG_TEST_PCT: 'expanded' }));
    expect(r.output).toContain('RESULT: PASS');
    expect(r.status).toBe(0);
    expect(r.received).toEqual(['status', repo, '--json']);
  });

  it.runIf(process.platform !== 'win32')('runs the codegraph on PATH directly, as before', () => {
    const k = kit();
    const shim = path.join(k.bin, 'codegraph');
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${k.fake}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
    const repo = path.join(k.root, 'some repo');
    const r = verify(k, repo, envWith(k, [k.bin]));
    expect(r.output).toContain('RESULT: PASS');
    expect(r.status).toBe(0);
    expect(r.received).toEqual(['status', repo, '--json']);
  });
});
