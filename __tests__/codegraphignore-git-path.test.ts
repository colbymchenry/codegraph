import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanDirectory } from '../src/extraction';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('.codegraphignore on the git scan path', () => {
  it('excludes tracked files matching root rules while retaining other source files', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ignore-git-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'gen'));
    fs.writeFileSync(path.join(root, 'src/main.ts'), 'export const main = 1;\n');
    fs.writeFileSync(path.join(root, 'gen/g.ts'), 'export const generated = 1;\n');
    fs.writeFileSync(path.join(root, '.codegraphignore'), 'gen/\n');

    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'src/main.ts', 'gen/g.ts', '.codegraphignore'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: root });

    const files = scanDirectory(root);
    expect(files).toContain('src/main.ts');
    expect(files).not.toContain('gen/g.ts');
  });
});
