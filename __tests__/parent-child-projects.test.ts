/**
 * Parent / child multi-project support (#1822).
 *
 * 'codegraph init' in a folder that holds other projects discovers them: the ones
 * with their own .codegraph/ become "children" in codegraph.json, so the parent
 * leaves their files out of its own index while a search issued from the parent
 * still reaches their graphs. A child with no index of its own stays part of the
 * parent index and is named in the init output instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { findChildProjectRoots, listChildProjects, indexedChildProjectRoots } from '../src/directory';
import { addChildProjects, loadChildProjects, clearProjectConfigCache } from '../src/project-config';
import { ToolHandler } from '../src/mcp/tools';

let root = '';

/** Make 'dir' an initialized project with an index of its own. */
function mkIndexed(dir: string): CodeGraph {
  fs.mkdirSync(dir, { recursive: true });
  return CodeGraph.initSync(dir);
}

/** A directory that looks like a project root by manifest name. */
function mkProject(dir: string, manifest: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const body = manifest === 'package.json' ? '{"name":"fixture"}' : 'fixture';
  fs.writeFileSync(path.join(dir, manifest), body);
}


/**
 * A handler whose child projects are already-open instances: the production
 * path opens them through the loader, which a unit test cannot stand up.
 */
class ChildAwareHandler extends ToolHandler {
  constructor(
    cg: CodeGraph,
    private readonly childRoot: string,
    private readonly childCg: CodeGraph,
  ) {
    super(cg);
  }

  protected openChildProject(root: string): CodeGraph {
    return path.resolve(root) === path.resolve(this.childRoot) ? this.childCg : super.openChildProject(root);
  }
}

describe('parent / child projects (#1822)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1822-'));
    clearProjectConfigCache();
  });

  afterEach(() => {
    clearProjectConfigCache();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('discovers project roots under the parent, but never the parent itself', () => {
    mkProject(path.join(root, 'web'), 'package.json');
    mkProject(path.join(root, 'api'), 'Cargo.toml');
    fs.mkdirSync(path.join(root, 'src'));

    const found = findChildProjectRoots(root).map((dir) => path.relative(root, dir).split(path.sep).join('/'));
    expect(found).toEqual(['api', 'web']);
  });

  it('stops at the first project on a branch', () => {
    mkProject(path.join(root, 'api'), 'Cargo.toml');
    mkProject(path.join(root, 'api', 'crate'), 'Cargo.toml');

    const found = findChildProjectRoots(root).map((dir) => path.relative(root, dir).split(path.sep).join('/'));
    expect(found).toEqual(['api']);
  });

  it('reports declared children apart from discovered ones, and which are indexed', () => {
    mkProject(path.join(root, 'declared'), 'package.json');
    mkProject(path.join(root, 'discovered'), 'pyproject.toml');
    addChildProjects(root, ['declared']);
    clearProjectConfigCache();

    const children = listChildProjects(root);
    expect(children.map((c) => c.rel)).toEqual(['declared', 'discovered']);
    expect(children.find((c) => c.rel === 'declared')!.declared).toBe(true);
    expect(children.find((c) => c.rel === 'discovered')!.declared).toBe(false);
    expect(children.every((c) => c.indexed === false)).toBe(true);
    expect(indexedChildProjectRoots(root)).toEqual([]);
  });

  it('round-trips children through codegraph.json idempotently', () => {
    addChildProjects(root, ['web', 'api']);
    const second = addChildProjects(root, ['web', './api/', 'api']);
    expect(second.added).toBe(0);
    clearProjectConfigCache();
    expect(loadChildProjects(root)).toEqual(['web', 'api']);

    const raw = JSON.parse(fs.readFileSync(path.join(root, 'codegraph.json'), 'utf-8'));
    expect(raw.children).toEqual(['web', 'api']);
  });

  it('drops child paths that escape the project', () => {
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ children: ['../outside', '/abs', 'ok'] }));
    clearProjectConfigCache();
    expect(loadChildProjects(root)).toEqual(['ok']);
  });

  it('keeps a declared child out of the parent index, yet still answers from the parent', async () => {
    const parent = path.join(root, 'parent');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(parent, 'parentOnly.ts'), 'export function parentOnlyHelper() { return 1; }\n');

    const childDir = path.join(parent, 'child-app');
    mkProject(childDir, 'package.json');
    fs.writeFileSync(path.join(childDir, 'childOnly.ts'), 'export function childOnlyHelper() { return 2; }\n');
    const childCg = mkIndexed(childDir);
    try { await childCg.indexAll(); } finally { childCg.destroy(); }

    // Declare the child the way 'codegraph init' in the parent would.
    addChildProjects(parent, ['child-app']);
    clearProjectConfigCache();

    const parentCg = mkIndexed(parent);
    try {
      await parentCg.indexAll();

      // The child owns those files; the parent must not index a second, staler copy.
      const indexedFiles = parentCg.getFiles().map((file) => file.path);
      expect(indexedFiles).toContain('parentOnly.ts');
      expect(indexedFiles).not.toContain('child-app/childOnly.ts');

      // ...but a search from the parent still reaches the child's graph.
      const childCgOpen = CodeGraph.openSync(childDir);
      try {
        const handler = new ChildAwareHandler(parentCg, childDir, childCgOpen);
        const result = await handler.execute('codegraph_search', { query: 'childOnlyHelper' });
        const text = result.content[0]!.text as string;
        expect(result.isError).toBeFalsy();
        expect(text).toContain('Also found in child projects');
        expect(text).toContain('child-app/childOnly.ts');
      } finally {
        childCgOpen.destroy();
      }
    } finally {
      parentCg.destroy();
    }
  });
});
