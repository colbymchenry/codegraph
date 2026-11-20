/**
 * codegraph applies .gitignore rules itself in two places: on the filesystem
 * walk (a project without git), for every .gitignore it meets, and in a git
 * project on top of `git ls-files`, for its built-in defaults merged with the
 * root .gitignore. Both go through the `ignore` package, which before 7.0.14
 * read several pattern forms differently from git:
 * - a backslash escape: `\d` was a regex digit, not a literal `d`;
 * - a POSIX class such as `[[:digit:]]`, and a `]` or `!` first in a bracket;
 * - a run of three asterisks, which git reads as a globstar;
 * - a lone `!` line, which matched every path, so it re-included everything
 *   the .gitignore and codegraph's own defaults (node_modules) leave out.
 * Each fixture file is kept or dropped the way git decides, except
 * node_modules, which codegraph's defaults always leave out.
 */
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

function project(mode: 'walk' | 'git', gitignore: string, files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cg-gitignore-parity-${mode}-`));
  roots.push(root);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'export const value = 1;\n');
  }
  fs.writeFileSync(path.join(root, '.gitignore'), gitignore);
  if (mode === 'git') execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  return root;
}

function scanned(root: string): string[] {
  return scanDirectory(root).map((f) => f.replace(/\\/g, '/')).sort();
}

describe.each(['walk', 'git'] as const)('.gitignore patterns follow git (%s)', (mode) => {
  it('reads escapes, POSIX classes, brackets, *** and trailing spaces as git does', () => {
    const root = project(
      mode,
      [
        '\\d.ts', // a literal "d"
        '[[:digit:]]x.ts', // a POSIX class
        '[!a]neg.ts', // a negated bracket
        '[]]bracket.ts', // "]" first in a bracket is a member
        'stars/***/z.ts', // three asterisks are a globstar
        'trail.ts   ', // trailing spaces are trimmed
      ].join('\n') + '\n',
      [
        '1.ts', 'd.ts', '1x.ts', 'ax.ts', 'aneg.ts', 'bneg.ts', ']bracket.ts',
        'stars/z.ts', 'stars/b/z.ts', 'stars/b/c/z.ts', 'trail.ts', 'other.ts',
      ],
    );
    expect(scanned(root)).toEqual(['1.ts', 'aneg.ts', 'ax.ts', 'other.ts']);
  });

  it('treats a lone "!" line as no pattern, so ignored files and node_modules stay out', () => {
    const root = project(mode, 'skipped.ts\n!\n', ['kept.ts', 'skipped.ts', 'node_modules/pkg/index.ts']);
    expect(scanned(root)).toEqual(['kept.ts']);
  });
});
