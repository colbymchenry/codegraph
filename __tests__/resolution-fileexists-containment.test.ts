/**
 * `fileExists` must not probe outside the project root (#1631).
 *
 * `resolveRelativeImport` hands this callback paths built with
 * `path.relative(projectRoot, basePath)`, which can carry `../` segments, and
 * `path.join` does not clamp — so a crafted relative import in an indexed file
 * made the resolver stat arbitrary absolute paths. Nothing outside is read (the
 * content sinks are guarded separately, #527) and no edge is produced, but the
 * probe itself is an existence oracle driven by repository content.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReferenceResolver } from '../src/resolution';
import type { QueryBuilder } from '../src/db/queries';

describe('fileExists containment (#1631)', () => {
  let sandbox: string;
  let projectRoot: string;

  /** The resolver only needs a project root here — `fileExists` never queries. */
  const contextFor = (root: string) =>
    new ReferenceResolver(root, {} as unknown as QueryBuilder).getResolutionContext();

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
    projectRoot = path.join(sandbox, 'proj');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'a.js'), 'export const a = 1;');
    // A real file two levels above the root, as the reproduction in #1631 has.
    fs.mkdirSync(path.join(sandbox, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'outside', 'secret.js'), 'export const secret = 42;');
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('still reports files inside the root', () => {
    expect(contextFor(projectRoot).fileExists('src/a.js')).toBe(true);
    expect(contextFor(projectRoot).fileExists('src/missing.js')).toBe(false);
  });

  it('refuses to probe a path that escapes the root, even though it exists', () => {
    const escaping = path.join('..', 'outside', 'secret.js');
    // Baseline: the target really is there — so `false` can only come from the guard.
    expect(fs.existsSync(path.join(projectRoot, escaping))).toBe(true);

    expect(contextFor(projectRoot).fileExists(escaping)).toBe(false);
  });

  it('keeps following an in-root symlink whose target is outside the root (#935)', () => {
    const link = path.join(projectRoot, 'vendor');
    try {
      fs.symlinkSync(path.join(sandbox, 'outside'), link, 'dir');
    } catch {
      return; // symlink creation not permitted (e.g. Windows without privilege)
    }
    // Lexically inside the root, physically outside — the indexing tier allows this.
    expect(contextFor(projectRoot).fileExists(path.join('vendor', 'secret.js'))).toBe(true);
  });
});
