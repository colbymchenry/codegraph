/**
 * `codegraph deps` and `codegraph info` — the compact, token-efficient CLI
 * outputs (GitHub issue #500). Exercised end-to-end against the built binary
 * on a small multi-file fixture that mirrors the issue's worked example.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function run(cwd: string, args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args, '-p', cwd], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status ?? 1 };
  }
}

function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'src', 'utils'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'controllers'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'types'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'services'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'src', 'types', 'User.ts'),
    'export interface User { id: number; name: string; }\nexport type Role = \'admin\' | \'user\';\n'
  );
  fs.writeFileSync(
    path.join(root, 'src', 'services', 'logger.ts'),
    'export function log(message: string): void { console.log(message); }\n'
  );
  fs.writeFileSync(
    path.join(root, 'src', 'utils', 'auth.ts'),
    [
      "import bcrypt from 'bcrypt';",
      "import isEmpty from 'lodash/isEmpty';",
      "import { User, Role } from '../types/User';",
      "import { log } from '../services/logger';",
      '',
      'export class AuthUtil {',
      '  constructor(private user: User) {}',
      "  public hashPassword(pw: string): string { log('hash'); return bcrypt.hashSync(pw, 10); }",
      '  public verifyPassword(pw: string): boolean { return !isEmpty(pw); }',
      '}',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(root, 'src', 'controllers', 'auth.ts'),
    [
      "import { AuthUtil } from '../utils/auth';",
      'export class AuthController {',
      '  constructor(private util: AuthUtil) {}',
      '  login(pw: string): string { return this.util.hashPassword(pw); }',
      '}',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(root, 'tests', 'auth.test.ts'),
    [
      "import { AuthController } from '../src/controllers/auth';",
      "const c = new AuthController(new (require('../src/utils/auth').AuthUtil)({} as any));",
      "c.login('x');",
      '',
    ].join('\n')
  );
}

describe('codegraph deps', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deps-'));
    writeFixture(tempDir);
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints the compressed markdown summary', () => {
    const { stdout, code } = run(tempDir, ['deps', 'src/utils/auth.ts']);
    expect(code).toBe(0);
    expect(stdout).toContain('## deps of: src/utils/auth.ts');
    expect(stdout).toContain('### calls out (imports)');
    // npm bucket lists package specifiers only (no import-binding noise).
    expect(stdout).toContain('`bcrypt`, `lodash/isEmpty` (npm)');
    expect(stdout).not.toContain('(npm) -');
    // Local modules carry the symbols they pull in.
    expect(stdout).toMatch(/`\.\.\/types\/User` \(local\) - `Role, User`/);
    expect(stdout).toMatch(/`\.\.\/services\/logger` \(local\) - `log`/);
    // Reverse deps with file:line.
    expect(stdout).toContain('### called by (reverse deps)');
    expect(stdout).toContain('`src/controllers/auth.ts:1`');
    expect(stdout).toContain('`tests/auth.test.ts:2`');
    // defines.
    expect(stdout).toContain('### defines');
    expect(stdout).toContain('`class AuthUtil`');
    expect(stdout).toContain('`method hashPassword()`');
  });

  it('emits structured JSON with --json', () => {
    const { stdout, code } = run(tempDir, ['deps', 'src/utils/auth.ts', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.path).toBe('src/utils/auth.ts');
    expect(parsed.callsOut.npm).toEqual(expect.arrayContaining(['bcrypt', 'lodash/isEmpty']));
    expect(parsed.callsOut.npm).not.toContain('isEmpty');
    const local = parsed.callsOut.local as Array<{ module: string; symbols: unknown[] }>;
    const user = local.find((l) => l.module === '../types/User');
    expect(user).toBeTruthy();
    expect(user!.symbols.map((s: any) => s.name).sort()).toEqual(['Role', 'User']);
    expect(parsed.calledBy).toEqual(
      expect.arrayContaining([
        { file: 'src/controllers/auth.ts', line: 1 },
        { file: 'tests/auth.test.ts', line: 2 },
      ])
    );
    expect(parsed.defines).toEqual(
      expect.arrayContaining([{ kind: 'class', name: 'AuthUtil' }])
    );
  });

  it('reports a file that is not in the index', () => {
    const { stdout, code } = run(tempDir, ['deps', 'src/nope.ts']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/not in the index/i);
  });
});

describe('codegraph info', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-info-'));
    writeFixture(tempDir);
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints the compressed markdown profile', () => {
    const { stdout, code } = run(tempDir, ['info', 'AuthController']);
    expect(code).toBe(0);
    expect(stdout).toContain('## AuthController');
    expect(stdout).toMatch(/\*\*kind\*\*: class \| \*\*file\*\*: `src\/controllers\/auth.ts:\d+`/);
    expect(stdout).toMatch(/\*\*exported\*\*: yes \| \*\*vis\*\*: -/);
    expect(stdout).toContain('**depends on**:');
    expect(stdout).toMatch(/`class AuthUtil` \(references\)/);
    expect(stdout).toContain('**used by**:');
    expect(stdout).toMatch(/`constant c` \(instantiates\)/);
  });

  it('emits structured JSON with --json', () => {
    const { stdout, code } = run(tempDir, ['info', 'AuthController', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.symbol).toBe('AuthController');
    expect(parsed.kind).toBe('class');
    expect(parsed.file).toMatch(/^src\/controllers\/auth.ts:\d+$/);
    expect(parsed.exported).toBe(true);
    expect(parsed.dependsOn.map((d: any) => d.name)).toContain('AuthUtil');
    expect(parsed.usedBy.map((d: any) => d.name)).toContain('c');
    expect(parsed.code).toBeNull();
  });

  it('includes the source body with --with-code', () => {
    const { stdout, code } = run(tempDir, ['info', 'AuthUtil', '--with-code']);
    expect(code).toBe(0);
    expect(stdout).toContain('export class AuthUtil {');
    expect(stdout).toMatch(/\d{1,4}\s+export class AuthUtil/);
  });

  it('reports a symbol that is not found', () => {
    const { stdout, code } = run(tempDir, ['info', 'NoSuchSymbol']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/not found/i);
  });
});
