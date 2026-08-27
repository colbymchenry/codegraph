/**
 * OpenSCAD import resolution.
 *
 * `include <p>` / `use <p>` name a PATH, not a symbol. Before this was wired,
 * OpenSCAD imports fell through to the name-matcher, which picks a candidate by
 * basename similarity. Measured on a three-library fixture that got 1627 of
 * 1633 right — and still produced two failures of opposite kinds:
 *
 *   - an INVENTED edge for `include <math.scad>` where no search root holds one
 *     and OpenSCAD itself reports "Can't open include file";
 *   - a MISSING edge for `include <../polyhedra.scad>`, whose written path is
 *     unambiguous but whose basename is not.
 *
 * Resolution now walks the language's own search order — the including file's
 * directory, then the project's library roots — and declines when nothing
 * matches, because a wrong edge is worse than none (#660).
 *
 * No test here asserts against a system path. `/etc/...` becomes a
 * non-existent `C:\etc` on Windows and would pass for the wrong reason, and a
 * target that could never become a node makes an escape assertion vacuous
 * everywhere. Escape targets are real `.scad` files in a sibling directory, so
 * an unguarded resolver would genuinely reach them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { clearOpenscadLibraryRootCache } from '../src/resolution/import-resolver';

const posixOnly = it.runIf(process.platform !== 'win32');

describe('openscad import resolution', () => {
  let root: string; // holds the project AND an out-of-project sibling
  let dir: string; // the indexed project

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openscad-res-'));
    dir = path.join(root, 'proj');
    fs.mkdirSync(dir, { recursive: true });
    clearOpenscadLibraryRootCache();
    delete process.env.OPENSCADPATH;
  });

  afterEach(() => {
    delete process.env.OPENSCADPATH;
    clearOpenscadLibraryRootCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, body: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  /** Every resolved `imports` edge from an OpenSCAD file, as `from -> to`. */
  async function importEdges(): Promise<string[]> {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.file_path sf, t.file_path tf
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'imports' AND s.language = 'openscad' AND t.kind = 'file'`
      )
      .all() as Array<{ sf: string; tf: string }>;
    cg.destroy();
    return rows.map((r) => `${r.sf} -> ${r.tf}`).sort();
  }

  // Two libraries whose basenames collide, which is the normal state of the
  // OpenSCAD ecosystem: almost every library ships a math.scad.
  function twoLibraries(): void {
    write('lib/AAA/math.scad', 'function aaa_math() = 1;\n');
    write('lib/AAA/std.scad', 'include <math.scad>\nfunction aaa_std() = 2;\n');
    write('lib/BBB/math.scad', 'function bbb_math() = 3;\n');
    write('lib/BBB/util.scad', 'include <math.scad>\nfunction bbb_util() = 4;\n');
  }

  it('prefers a sibling over a same-named file in another library', async () => {
    twoLibraries();
    write('src/part.scad', 'include <AAA/std.scad>\nmodule part() { cube(1); }\n');

    const edges = await importEdges();

    // The language resolves the including file's directory first, so AAA/std
    // must reach ITS OWN math.scad. An edge to BBB's would be one the renderer
    // contradicts.
    expect(edges).toContain('lib/AAA/std.scad -> lib/AAA/math.scad');
    expect(edges).toContain('lib/BBB/util.scad -> lib/BBB/math.scad');
    expect(edges).not.toContain('lib/AAA/std.scad -> lib/BBB/math.scad');
    expect(edges).not.toContain('lib/BBB/util.scad -> lib/AAA/math.scad');
  });

  it('sends a library-qualified path to the library it names', async () => {
    twoLibraries();
    write('src/part.scad', 'include <BBB/math.scad>\nmodule part() { cube(1); }\n');

    expect(await importEdges()).toContain('src/part.scad -> lib/BBB/math.scad');
  });

  it('resolves a parent-relative path even when the basename collides', async () => {
    // The defect this change fixes: the written path names exactly one file,
    // but two files share its basename, so name-matching declined.
    write('lib/AAA/shape.scad', 'function outer_shape() = 1;\n');
    write('lib/AAA/tests/shape.scad', 'include <../shape.scad>\nfunction test_shape() = 2;\n');
    write('lib/BBB/shape.scad', 'function other_shape() = 3;\n');

    const edges = await importEdges();

    expect(edges).toContain('lib/AAA/tests/shape.scad -> lib/AAA/shape.scad');
    expect(edges).not.toContain('lib/AAA/tests/shape.scad -> lib/BBB/shape.scad');
  });

  it('produces no edge for an ambiguous bare name no search root satisfies', async () => {
    // The other defect, and the reason this change exists. `math.scad` sits in
    // neither src/ nor lib/, so OpenSCAD reports "Can't open include file" and
    // the correct number of edges is zero — not "whichever math.scad scored
    // highest".
    twoLibraries();
    write('src/part.scad', 'include <math.scad>\nmodule part() { cube(1); }\n');

    const edges = await importEdges();

    expect(edges.filter((e) => e.startsWith('src/part.scad ->'))).toEqual([]);
  });

  it('never resolves an import to a same-named symbol', async () => {
    // `gears.scad` exists nowhere, but a module named `gears` does. An import
    // names a file; resolving it to the module would be a category error.
    write('src/shapes.scad', 'module gears() { cube(1); }\n');
    write('src/part.scad', 'use <gears.scad>\nmodule part() { gears(); }\n');

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const bad = db
      .prepare(
        `SELECT count(*) c FROM edges e JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'imports' AND t.kind != 'file'`
      )
      .get() as { c: number };
    cg.destroy();

    expect(bad.c).toBe(0);
  });

  it('does not resolve a path that climbs out of the project root', async () => {
    // The escape target is a real, readable .scad file one level above the
    // project, so an unguarded resolver would reach it — the assertion is not
    // vacuous.
    fs.mkdirSync(path.join(root, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(root, 'outside', 'secret.scad'), 'function secret() = 1;\n');
    write('src/part.scad', 'include <../../outside/secret.scad>\nmodule part() { cube(1); }\n');

    const edges = await importEdges();

    expect(edges.filter((e) => e.startsWith('src/part.scad ->'))).toEqual([]);
    expect(edges.some((e) => e.includes('secret.scad'))).toBe(false);
  });

  posixOnly('follows an in-root symlink whose target is outside the project', async () => {
    // The inverse of the test above, and the one that guards against
    // "tightening" resolution to the strict path-validation tier. The directory
    // walk already follows such a symlink to enumerate the files under it; a
    // resolver that refused would leave discovery and resolution disagreeing,
    // which is the defect #935 fixed for the indexing read sites.
    const external = path.join(root, 'external-lib');
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'vendored.scad'), 'function vendored() = 1;\n');
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.symlinkSync(external, path.join(dir, 'lib', 'EXT'), 'dir');
    write('src/part.scad', 'include <EXT/vendored.scad>\nmodule part() { cube(1); }\n');

    expect(await importEdges()).toContain('src/part.scad -> lib/EXT/vendored.scad');
  });

  it('ignores an OPENSCADPATH root that lies outside the project', async () => {
    // The variable is set by the user running the indexer, not by an indexed
    // file, so it may inform discovery — but never widen it past the project
    // root. Pointed at a sibling of the fixture rather than a system path, so
    // the assertion holds on every platform.
    fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true });
    fs.writeFileSync(path.join(root, 'elsewhere', 'remote.scad'), 'function remote() = 1;\n');
    write('src/part.scad', 'include <remote.scad>\nmodule part() { cube(1); }\n');
    process.env.OPENSCADPATH = path.join(root, 'elsewhere');
    clearOpenscadLibraryRootCache();

    const edges = await importEdges();

    expect(edges.filter((e) => e.startsWith('src/part.scad ->'))).toEqual([]);
  });

  it('does not treat an undeclared directory as a library root', async () => {
    // Discovery under-reaches on purpose. dotSCAD's shape: its examples import
    // as though `src/` were on OPENSCADPATH, and real OpenSCAD declines them
    // unless it is. A probe that accepted any directory holding .scad files
    // would assert edges the actual build does not have.
    write('lib/CCC/src/helper.scad', 'function helper() = 1;\n');
    write('lib/CCC/examples/demo.scad', 'use <helper.scad>\nmodule demo() { cube(1); }\n');

    const edges = await importEdges();

    expect(edges.filter((e) => e.startsWith('lib/CCC/examples/demo.scad ->'))).toEqual([]);
  });

  it('resolves once the project declares that root', async () => {
    // The same tree as above, with the root declared. Resolution follows the
    // configuration rather than guessing at it — which is why the previous test
    // is a correctness assertion and not a limitation.
    write('lib/CCC/src/helper.scad', 'function helper() = 1;\n');
    write('lib/CCC/examples/demo.scad', 'use <helper.scad>\nmodule demo() { cube(1); }\n');
    process.env.OPENSCADPATH = path.join(dir, 'lib', 'CCC', 'src');
    clearOpenscadLibraryRootCache();

    expect(await importEdges()).toContain(
      'lib/CCC/examples/demo.scad -> lib/CCC/src/helper.scad'
    );
  });
});
