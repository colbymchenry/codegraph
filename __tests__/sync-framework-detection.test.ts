/**
 * A long-lived graph keeps framework detection current across syncs (#2516,
 * #2519).
 *
 * The MCP server's watcher holds one CodeGraph for the whole session. Its
 * framework detection used to be cached from the first time it ran, so a
 * framework that arrived mid-session, like Express in a new `package.json`,
 * was missing from every file synced after it until `codegraph index`. A sync
 * now detects again when what detection read changed, without walking the
 * project on a watcher's scoped sync, and says when files indexed earlier
 * were read without the change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { detectFrameworks } from '../src/resolution/frameworks';
import { clearDeclaredDependencies, declaredDependencies } from '../src/resolution/frameworks/package-deps';
import type { ResolutionContext } from '../src/resolution/types';

// Pass-through wrappers, so a test can count framework detections and see the git commands run.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('../src/resolution/frameworks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/resolution/frameworks')>();
  return { ...actual, detectFrameworks: vi.fn(actual.detectFrameworks) };
});

const EXPRESS = JSON.stringify({ dependencies: { express: '^4.18.0' } });
const ROUTES = "const app = express();\napp.get('/hello', function hello(req, res) {});\n";

describe('framework detection in a long-lived graph (#2516)', () => {
  let root: string;
  let cg: CodeGraph | undefined;
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  const routes = (rel: string) => cg!.getNodesInFile(rel).filter((n) => n.kind === 'route').map((n) => n.name);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-frameworks-')));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['full', 'scoped'] as const)('reads a file added with a new framework using it (%s sync)', async (mode) => {
    write('src/app.ts', 'export function boot() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    // An ordinary edit first, so this graph has detected (no frameworks) and cached it.
    write('src/app.ts', 'export function boot() { return 2; }\n');
    await cg.sync(mode === 'scoped' ? { paths: ['src/app.ts'] } : {});
    expect(cg.getDetectedFrameworks()).not.toContain('express');

    write('package.json', EXPRESS);
    write('src/routes.js', ROUTES);
    await cg.sync(mode === 'scoped' ? { paths: ['src/routes.js'] } : {});
    expect(cg.getDetectedFrameworks()).toContain('express');
    expect(routes('src/routes.js')).toEqual(['GET /hello']);
  });

  it('detects again when a file is added, with no manifest change', async () => {
    write('src/app.ts', 'export function boot() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(cg.getDetectedFrameworks()).not.toContain('svelte');
    // Svelte is detected from a .svelte file alone.
    write('src/Widget.svelte', '<script>let count = 0;</script>\n<button>{count}</button>\n');
    await cg.sync({ paths: ['src/Widget.svelte'] });
    expect(cg.getDetectedFrameworks()).toContain('svelte');
  });

  it('detects again when a source file detection read is edited', async () => {
    write('src/app.ts', 'export function boot() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(cg.getDetectedFrameworks()).not.toContain('react-native-bridge');
    // The bridge is detected from a TurboModule spec in the first files' source.
    write('src/app.ts', "export const Native = TurboModuleRegistry.getEnforcing<Spec>('Native');\n");
    await cg.sync({ paths: ['src/app.ts'] });
    expect(cg.getDetectedFrameworks()).toContain('react-native-bridge');
  });

  it('notices a manifest edit at the next sync, and says what the files indexed before it lack', async () => {
    write('src/server.js', ROUTES);
    write('src/util.js', 'function util() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(routes('src/server.js')).toEqual([]);
    expect(cg.getFrameworkChangesSinceIndex()).toBeNull();

    // No source file changes with the manifest; the next edit anywhere syncs it.
    write('package.json', EXPRESS);
    write('src/util.js', 'function util() { return 2; }\n');
    await cg.sync({ paths: ['src/util.js'] });
    expect(cg.getDetectedFrameworks()).toContain('express');
    // server.js was indexed without Express and is unchanged: status recommends a re-index.
    expect(routes('src/server.js')).toEqual([]);
    expect(cg.getFrameworkChangesSinceIndex()).toEqual({ added: ['express'], removed: [] });

    // Going back to what the index was built with clears it.
    write('package.json', JSON.stringify({ dependencies: {} }));
    write('src/util.js', 'function util() { return 3; }\n');
    await cg.sync({ paths: ['src/util.js'] });
    expect(cg.getDetectedFrameworks()).not.toContain('express');
    expect(cg.getFrameworkChangesSinceIndex()).toBeNull();

    // A full re-index reads every file with the new frameworks, and the note goes.
    write('package.json', EXPRESS);
    cg.close();
    cg = await CodeGraph.recreate(root);
    await cg.indexAll();
    expect(routes('src/server.js')).toEqual(['GET /hello']);
    expect(cg.getFrameworkChangesSinceIndex()).toBeNull();
  });
});

describe('a scoped sync in a fresh process keeps off the full scan (#2516)', () => {
  let root: string;
  let cg: CodeGraph | undefined;
  const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  // The full scan's untracked listing. (The scope matcher's embedded-repo
  // discovery lists with `--directory`, once per process, by design.)
  const scans = () => vi.mocked(cp.execFileSync).mock.calls
    .filter(([cmd, args]) => cmd === 'git' && Array.isArray(args) && args.join(' ') === 'ls-files -z -o --exclude-standard');

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-noscan-')));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('detects from the index, once, and not again while nothing it read changed', async () => {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\n');
    fs.writeFileSync(path.join(root, 'package.json'), EXPRESS);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'routes.js'), ROUTES);
    git('add', '-A');
    git('commit', '-qm', 'init');
    const built = CodeGraph.initSync(root);
    await built.indexAll();
    built.close();

    // The watcher's process: open, then sync one edited file at a time.
    cg = CodeGraph.openSync(root);
    vi.mocked(cp.execFileSync).mockClear();
    vi.mocked(detectFrameworks).mockClear();
    for (const n of [2, 3]) {
      fs.writeFileSync(path.join(root, 'src', 'routes.js'), ROUTES + `// edit ${n}\n`);
      await cg.sync({ paths: ['src/routes.js'] });
    }
    expect(scans()).toEqual([]);
    expect(vi.mocked(detectFrameworks)).toHaveBeenCalledTimes(1);
    expect(cg.getNodesInFile('src/routes.js').filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['GET /hello']);
  });
});

describe('declared dependencies in a long-lived graph (#2519)', () => {
  let root: string;
  let cg: CodeGraph | undefined;
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-deps-')));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sees one app swapped for another with as many files', async () => {
    write('web/package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    write('web/a.js', 'export function a() { return 1; }\n');
    write('web/b.js', 'export function b() { return 2; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    expect(cg.getDetectedFrameworks()).toContain('react');

    fs.rmSync(path.join(root, 'web'), { recursive: true, force: true });
    write('server/package.json', EXPRESS);
    write('server/a.js', ROUTES);
    write('server/b.js', 'export function b() { return 2; }\n');
    await cg.sync();
    expect(cg.getDetectedFrameworks()).toContain('express');
    expect(cg.getDetectedFrameworks()).not.toContain('react');
    cg.reinitializeResolver();
    expect(cg.getDetectedFrameworks()).toContain('express');
    expect(cg.getDetectedFrameworks()).not.toContain('react');
  });

  it('reads the manifests again once told to forget them', () => {
    write('package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    const files = ['a.js'];
    const context = {
      getAllFiles: () => files,
      fileExists: (rel: string) => fs.existsSync(path.join(root, rel)),
      readFile: (rel: string) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : null),
    } as unknown as ResolutionContext;
    expect([...declaredDependencies(context)]).toEqual(['react']);
    write('package.json', EXPRESS);
    // Same file count: the count alone keeps the old answer.
    expect([...declaredDependencies(context)]).toEqual(['react']);
    clearDeclaredDependencies(context);
    expect([...declaredDependencies(context)]).toEqual(['express']);
  });
});
