/**
 * A named pipe with a config file's name (package.json, go.mod, tsconfig.json, ...) must not stop
 * indexing. Opening a FIFO for reading waits for a writer, and a synchronous wait cannot be
 * interrupted by Vitest's timeout, so indexing runs in a child the parent can kill.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isNonRegularFile, readRegularFile } from '../src/file-limits';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

const CONFIG_NAMES = [
  'package.json',
  'pnpm-workspace.yaml',
  'oh-package.json5',
  'go.mod',
  'Cargo.toml',
  'tsconfig.json',
  'jsconfig.json',
  'compile_commands.json',
  '.gitignore',
];

/** Read at the root only: the project's own config, and the ignore file in CodeGraph's directory. */
const ROOT_ONLY_NAMES = ['codegraph.json', '.codegraph/.gitignore'];

/** .NET project files, read for the C# and VB files beside them. */
const PROJECT_FILE_NAMES = ['X.csproj', 'Directory.Build.props', 'P.vbproj'];

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-config-fifo-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], timeout = 60_000): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' },
  });
}

describe('config files that are named pipes', () => {
  // mkfifo is POSIX-only.
  it.runIf(process.platform !== 'win32')(
    'indexes and syncs a project whose config files, at the root and in a subdirectory, are FIFOs',
    () => {
      const dir = tempDir();
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export function alpha() { return 1; }\n');
      fs.writeFileSync(path.join(dir, 'sub', 'b.ts'), "import { alpha } from '../a';\nexport const beta = alpha();\n");
      fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n\nfunc main() {}\n');
      fs.writeFileSync(path.join(dir, 'lib.rs'), 'pub fn gamma() {}\n');
      fs.writeFileSync(path.join(dir, 'c.c'), 'int delta(void) { return 0; }\n');
      fs.writeFileSync(
        path.join(dir, 'sub', 'A.cs'),
        'using static Util.Helpers;\nnamespace Util { public static class Helpers { public static int Twice(int x) { return x * 2; } } }\nnamespace App { public class Svc { public int Run() { return Twice(3); } } }\n',
      );
      fs.writeFileSync(path.join(dir, 'sub', 'G.vb'), 'Namespace Lib\n  Public Class Greeter\n    Public Function Hello() As String\n      Return "x"\n    End Function\n  End Class\nEnd Namespace\n');
      fs.writeFileSync(path.join(dir, 'sub', 'M.vb'), 'Imports Lib\nNamespace App\n  Public Module Main\n    Sub Run()\n      Dim g As New Greeter()\n      g.Hello()\n    End Sub\n  End Module\nEnd Namespace\n');
      fs.mkdirSync(path.join(dir, '.codegraph'));
      // No writer ever opens these: a blocking open would wait here for good.
      const fifos = [
        ...CONFIG_NAMES.flatMap((name) => [name, `sub/${name}`]),
        ...ROOT_ONLY_NAMES,
        ...PROJECT_FILE_NAMES.map((name) => `sub/${name}`),
      ];
      for (const name of fifos) execFileSync('mkfifo', [path.join(dir, name)]);

      for (const args of [['init', '-i', dir], ['sync', dir]]) {
        if (args[0] === 'sync') fs.appendFileSync(path.join(dir, 'a.ts'), 'export const later = 2;\n');
        const result = run(args);
        expect(result.error, `${args[0]}: ${String(result.stderr)}`).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, String(result.stderr)).toBe(0);
      }
      // The pipes were skipped, not the project: every language's file is in the index.
      for (const [symbol, file] of [['alpha', 'a.ts'], ['beta', 'sub/b.ts'], ['gamma', 'lib.rs'], ['delta', 'c.c'], ['Svc', 'sub/A.cs'], ['Greeter', 'sub/G.vb']]) {
        const query = run(['query', symbol, '-p', dir, '-j']);
        expect(query.status, String(query.stderr)).toBe(0);
        expect(String(query.stdout), symbol).toContain(file);
      }
      for (const name of fifos) expect(fs.lstatSync(path.join(dir, name)).isFIFO(), name).toBe(true);
    },
    150_000,
  );
});

describe('more files that are named pipes', () => {
  // mkfifo is POSIX-only.
  it.runIf(process.platform !== 'win32')(
    'indexes a project whose root .csproj and the tsconfig.json its tsconfig extends are FIFOs',
    () => {
      const dir = tempDir();
      fs.writeFileSync(
        path.join(dir, 'A.cs'),
        'using static Util.Helpers;\nnamespace Util { public static class Helpers { public static int Twice(int x) { return x * 2; } } }\nnamespace App { public class Svc { public int Run() { return Twice(3); } } }\n',
      );
      fs.writeFileSync(path.join(dir, 'a.ts'), 'export function alpha() { return 1; }\n');
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ "extends": "./base.json", "compilerOptions": { "baseUrl": "." } }\n');
      const fifos = ['X.csproj', 'base.json'];
      for (const name of fifos) execFileSync('mkfifo', [path.join(dir, name)]);

      for (const args of [['init', '-i', dir], ['sync', dir]]) {
        if (args[0] === 'sync') fs.appendFileSync(path.join(dir, 'a.ts'), 'export const later = 2;\n');
        const result = run(args);
        expect(result.error, `${args[0]}: ${String(result.stderr)}`).toBeUndefined();
        expect(result.status, String(result.stderr)).toBe(0);
      }
      for (const [symbol, file] of [['alpha', 'a.ts'], ['Svc', 'A.cs']]) {
        const query = run(['query', symbol, '-p', dir, '-j']);
        expect(String(query.stdout), symbol).toContain(file);
      }
      for (const name of fifos) expect(fs.lstatSync(path.join(dir, name)).isFIFO(), name).toBe(true);
    },
    150_000,
  );

  // A lock file that is a FIFO holds no PID: the command reports a held lock or goes on, but never waits on it.
  for (const lock of ['codegraph.lock', 'writer.pid', 'daemon.pid', 'rebuild.pid']) {
    it.runIf(process.platform !== 'win32')(
      `index, sync and status finish when .codegraph/${lock} is a FIFO`,
      () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'a.ts'), 'export function alpha() { return 1; }\n');
        expect(run(['init', '-i', dir]).status).toBe(0);
        const lockPath = path.join(dir, '.codegraph', lock);
        fs.rmSync(lockPath, { force: true });
        execFileSync('mkfifo', [lockPath]);
        fs.writeFileSync(path.join(dir, 'b.ts'), 'export const beta = 2;\n');
        for (const args of [['index', dir], ['sync', dir], ['status', dir]]) {
          const result = run(args, 20_000);
          expect(result.error, `${args[0]}: ${String(result.stderr)}`).toBeUndefined();
          expect(result.signal, args[0]).toBeNull();
        }
      },
      120_000,
    );
  }
});

describe('readRegularFile', () => {
  it('reads a regular file as text or bytes', () => {
    const file = path.join(tempDir(), 'package.json');
    fs.writeFileSync(file, '{"name":"x"}');
    expect(readRegularFile(file, 'utf-8')).toBe('{"name":"x"}');
    expect(readRegularFile(file).equals(Buffer.from('{"name":"x"}'))).toBe(true);
  });

  // Creating a symlink on Windows needs Developer Mode.
  it.runIf(process.platform !== 'win32')('reads through a link to a regular file', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'real.json'), '{}');
    fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'package.json'));
    expect(readRegularFile(path.join(dir, 'package.json'), 'utf-8')).toBe('{}');
  });

  it('throws for a directory and for a missing file', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'package.json'));
    expect(() => readRegularFile(path.join(dir, 'package.json'), 'utf-8')).toThrow();
    expect(() => readRegularFile(path.join(dir, 'missing.json'), 'utf-8')).toThrow();
  });
});

describe('isNonRegularFile', () => {
  it('is false for a regular file and for nothing at all', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'codegraph.json'), '{}');
    expect(isNonRegularFile(path.join(dir, 'codegraph.json'))).toBe(false);
    expect(isNonRegularFile(path.join(dir, 'missing.json'))).toBe(false);
  });

  it('is true for a directory', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'codegraph.json'));
    expect(isNonRegularFile(path.join(dir, 'codegraph.json'))).toBe(true);
  });

  // mkfifo is POSIX-only. A stat does not open the pipe, so this cannot wait.
  it.runIf(process.platform !== 'win32')('is true for a FIFO', () => {
    const dir = tempDir();
    execFileSync('mkfifo', [path.join(dir, 'codegraph.json')]);
    expect(isNonRegularFile(path.join(dir, 'codegraph.json'))).toBe(true);
  });
});
