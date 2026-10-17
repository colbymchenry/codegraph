/**
 * Extensionless shell scripts (#1203, #1217): `bin/deploy`, a dokku plugin's
 * `commands`. No extension says Bash, so the shebang must — read from disk by
 * every path that decides what to index (scan, grammar preload, git change
 * detection, sync, the watcher), never assumed from the path alone.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CodeGraph } from '../src';
import { getGitChangedFiles, preloadLanguagesForFiles, scanDirectory } from '../src/extraction';
import { detectLanguage, initGrammars, isSourceFile, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['bash']);
});

let dir: string | undefined;
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.destroy();
  cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function project(files: Record<string, string>): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bash-extless-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('shebang detection', () => {
  it.each(['#!/bin/bash', '#! /bin/sh', '#!/usr/bin/env bash', '#!/usr/bin/env -S bash -eu', '#!/usr/bin/env -- sh', '#!/bin/sh\r'])
    ('reads `%s` as Bash', (header) => {
      expect(detectLanguage('bin/tool', `${header}\n`)).toBe('bash');
    });

  it.each(['#!/usr/bin/python3 /tmp/bash', '#!/usr/bin/env python3 bash', '#!/usr/bin/env -S python3 sh', ' #!/bin/bash', 'plain text bash'])
    ('does not read `%s` as Bash', (header) => {
      expect(detectLanguage('bin/tool', `${header}\n`)).toBe('unknown');
    });

  it('decides an extensionless path by its shebang on disk only when given the project root', () => {
    const root = project({ 'bin/deploy': '#!/usr/bin/env bash\n', 'bin/notes': 'plain text\n', 'bin/tool': '#!/usr/bin/env python3\n' });
    fs.mkdirSync(path.join(root, 'bin', 'subdir'));
    expect(isSourceFile('bin/deploy', undefined, root)).toBe(true);
    expect(isSourceFile('bin/deploy')).toBe(false);
    expect(isSourceFile('bin/notes', undefined, root)).toBe(false);
    expect(isSourceFile('bin/tool', undefined, root)).toBe(false);
    expect(isSourceFile('bin/subdir', undefined, root)).toBe(false);
    expect(isSourceFile('bin/absent', undefined, root)).toBe(false);
    expect(detectLanguage('bin/deploy', undefined, undefined, root)).toBe('bash');
    expect(detectLanguage('bin/notes', undefined, undefined, root)).toBe('unknown');
  });
});

describe('scanning and grammar preload', () => {
  it('scans extensionless shell scripts and leaves out text and other interpreters', () => {
    const root = project({
      'bin/run': '#!/bin/sh\nf() { :; }\n',
      'bin/notes': 'plain text\n',
      'bin/python': '#!/usr/bin/python3 /tmp/bash\n',
      'LICENSE': 'MIT\n',
    });
    expect(scanDirectory(root)).toEqual(['bin/run']);
  });

  it('preloads the Bash grammar for an extensionless path only after reading its interpreter', () => {
    const root = project({ 'run': '#!/bin/sh\nf() { :; }\n', 'notes': 'plain text\n', 'python': '#!/usr/bin/python3 /tmp/bash\n' });
    expect(preloadLanguagesForFiles(['run'], undefined, root)).toContain('bash');
    expect(preloadLanguagesForFiles(['notes', 'python', 'absent'], undefined, root)).not.toContain('bash');
    expect(preloadLanguagesForFiles(['run'])).not.toContain('bash');
  });
});

describe('sync in a git repository', () => {
  async function indexedRepo(): Promise<string> {
    const root = project({ 'bin/deploy': '#!/usr/bin/env bash\ndeploy() {\n  echo ok\n}\n', 'README': 'docs\n' });
    git(root, 'init');
    git(root, 'config', 'user.email', 'test@test.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'core.autocrlf', 'false');
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'initial');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(cg.getFile('bin/deploy')?.language).toBe('bash');
    expect(cg.getFile('README')).toBeNull();
    return root;
  }

  const functionsIn = (file: string) => cg!.getNodesInFile(file).filter((n) => n.kind === 'function').map((n) => n.name);

  it('keeps a modified script indexed and picks up its new functions', async () => {
    const root = await indexedRepo();
    fs.writeFileSync(path.join(root, 'bin/deploy'), '#!/usr/bin/env bash\ndeploy() {\n  rollback\n}\nrollback() { :; }\n');
    expect(getGitChangedFiles(root)?.modified).toContain('bin/deploy');
    // What `codegraph status` reports as pending: a modified script, not a removed one.
    expect(cg!.getChangedFiles()).toEqual({ added: [], modified: ['bin/deploy'], removed: [] });
    await cg!.sync();
    expect(cg!.getFile('bin/deploy')?.language).toBe('bash');
    expect(functionsIn('bin/deploy').sort()).toEqual(['deploy', 'rollback']);
  });

  it('indexes a newly added script and drops a deleted one', async () => {
    const root = await indexedRepo();
    fs.writeFileSync(path.join(root, 'bin/release'), '#!/bin/sh\nrelease() { :; }\n');
    await cg!.sync();
    expect(functionsIn('bin/release')).toEqual(['release']);

    fs.rmSync(path.join(root, 'bin/deploy'));
    expect(getGitChangedFiles(root)?.deleted).toContain('bin/deploy');
    await cg!.sync();
    expect(cg!.getFile('bin/deploy')).toBeNull();
  });

  it('drops a script whose shebang turns into another interpreter', async () => {
    const root = await indexedRepo();
    fs.writeFileSync(path.join(root, 'bin/deploy'), '#!/usr/bin/env python3\nprint("ok")\n');
    await cg!.sync();
    expect(cg!.getFile('bin/deploy')).toBeNull();
  });
});
