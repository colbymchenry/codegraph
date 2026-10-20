/**
 * A folder named `build` below `src/` is a source folder in a JS/TS app:
 * luci-go's milo/ui keeps its whole LUCI "build" feature in `src/build/`, and
 * its router lazily loads pages from `@/build/...`. The default ignore list
 * skipped every folder named `build` as build output, so none of that feature
 * was indexed and those routes linked nothing.
 *
 * Such a folder is now walked and its hand-written source (TypeScript, JSX,
 * Vue, Svelte, Astro, and Go, C# and Rust, as in Go's `src/go/build`, a .NET
 * solution's `src/Build/` project or dioxus's `src/build/`) indexed, while
 * what a build step writes there — JavaScript, declarations, CSS, HTML, maps,
 * a frozen app's Python, CMake's C — stays out, as does every `build/` folder
 * outside `src/`. Both enumeration paths, the git-status sync and the watcher
 * share the rule (#1728).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { buildDefaultIgnore, buildScopeIgnore, getGitChangedFiles, scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { FileWatcher, __emitWatchEventForTests } from '../src/sync/watcher';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
};

let dirs: string[] = [];
let graphs: CodeGraph[] = [];
let watchers: FileWatcher[] = [];
afterEach(() => {
  for (const watcher of watchers) watcher.stop();
  for (const graph of graphs) graph.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  watchers = [];
  graphs = [];
  dirs = [];
});

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-src-build-'));
  dirs.push(dir);
  return dir;
};

const write = (dir: string, files: Record<string, string>): void => {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
};

const gitRepo = (dir: string): void => {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@test.com');
  git(dir, 'config', 'user.name', 'Test');
};

describe('the scope of a build folder below src', () => {
  const SOURCES = [
    'src/build/constants.ts',
    'src/build/legacy/build_page/build_page.tsx',
    'src/build/nested/build/deep.ts',
    // Any case, like the other defaults (its own parent: Windows and macOS
    // file systems would merge it into `src/build/`).
    'web/src/Build/upper_case.ts',
    'packages/app/src/core/build/runner.mts',
    'packages/app/src/core/build/loader.cts',
    'src/views/tool/build/index.vue',
    'src/routes/build/+page.svelte',
    'src/pages/build/BuildPage.jsx',
    'src/content/build/Card.astro',
    // Go, C# and Rust toolchains write their output elsewhere.
    'src/go/build/build.go',
    'tools/src/Build/BuildManager.cs',
    'crates/cli/src/build/mod.rs',
    // A JVM package named `build` keeps every file, as before (#1642).
    'src/main/java/com/acme/build/Script.js',
  ];
  const IGNORED = [
    // What a build step writes, below src/ too.
    'src/build/bundle.js',
    'src/build/chunk.mjs',
    'src/build/legacy.cjs',
    'src/build/types/index.d.ts',
    'src/build/types/module.d.mts',
    'src/build/routes.yml',
    'src/client/build/static/js/main.4f3a2b1c.js',
    'src/main/resources/static/build/bundle.js',
    'src/main/resources/build/Generated.java',
    // Builds copy or generate these into a build folder: a frozen app's `.py`,
    // CMake's C and C++, WordPress's PHP.
    'src/build/lib/app/main.py',
    'src/build/CMakeFiles/feature_tests.c',
    'src/build/CMakeFiles/feature_tests.cxx',
    'src/build/routes.php',
    // The other defaults still apply inside such a folder.
    'src/build/node_modules/pkg/index.ts',
    'src/build/dist/index.ts',
    'src/build/vendor/lib.ts',
    // A build folder outside src/ stays excluded, whatever it holds.
    'build/index.ts',
    'build/static/js/main.4f3a2b1c.js',
    'packages/app/build/index.ts',
    'tools/build/release.ts',
  ];

  it.each(['filesystem', 'untracked', 'tracked'])(
    'indexes its hand-written source and nothing a build writes (%s)',
    async (mode) => {
      const root = tempDir();
      write(root, Object.fromEntries([...SOURCES, ...IGNORED].map((rel) => [rel, 'export const x = 1;\n'])));
      write(root, { 'src/client/package.json': '{"name":"client"}' });
      if (mode !== 'filesystem') {
        git(root, 'init', '-q');
        if (mode === 'tracked') git(root, 'add', '-f', '.');
      }

      const defaults = buildDefaultIgnore(root);
      const scope = buildScopeIgnore(root);
      const files = scanDirectory(root);
      expect(await scanDirectoryAsync(root)).toEqual(files);
      for (const rel of SOURCES) {
        expect(defaults.ignores(rel), rel).toBe(false);
        expect(scope.ignores(rel), rel).toBe(false);
        // The watcher and the filesystem walk must reach every folder on the way.
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i++) {
          expect(scope.ignores(parts.slice(0, i).join('/') + '/'), rel).toBe(false);
        }
        expect(files).toContain(rel);
      }
      for (const rel of IGNORED) {
        expect(defaults.ignores(rel), rel).toBe(true);
        expect(scope.ignores(rel), rel).toBe(true);
        expect(files).not.toContain(rel);
      }
    },
  );

  it("follows the project's own rules first", () => {
    const files = {
      'src/build/page.tsx': 'export const page = 1;\n',
      'src/build/bundle.js': 'export const bundle = 1;\n',
      'src/build/legacy/helper.js': 'export const helper = 1;\n',
      'src/build/node_modules/pkg/index.js': 'export const dep = 1;\n',
    };
    const scope = (ignoreFile: string, rules: string): ReturnType<typeof buildScopeIgnore> => {
      const root = tempDir();
      write(root, files);
      gitRepo(root);
      write(root, { [ignoreFile]: rules });
      return buildScopeIgnore(root);
    };

    // An explicit exclusion wins over the folder's source.
    expect(scope('.gitignore', 'build/\n').ignores('src/build/page.tsx')).toBe(true);
    expect(scope('codegraph.json', JSON.stringify({ exclude: ['src/build/'] })).ignores('src/build/page.tsx')).toBe(true);

    // Re-including the folder — the documented opt-in — keeps every type in it, as before.
    const optedIn = scope('.gitignore', '!src/build/\n');
    expect(optedIn.ignores('src/build/bundle.js')).toBe(false);
    expect(optedIn.ignores('src/build/legacy/helper.js')).toBe(false);
    expect(optedIn.ignores('src/build/node_modules/pkg/index.js')).toBe(true);

    // So does re-including a folder inside it, or the file itself.
    const legacy = scope('.gitignore', '!src/build/legacy/\n');
    expect(legacy.ignores('src/build/legacy/helper.js')).toBe(false);
    expect(legacy.ignores('src/build/bundle.js')).toBe(true);
    expect(scope('.gitignore', '!src/build/bundle.js\n').ignores('src/build/bundle.js')).toBe(false);

    // Without project rules, the folder's JavaScript stays out.
    const root = tempDir();
    write(root, files);
    expect(scanDirectory(root).sort()).toEqual(['src/build/page.tsx']);
  });
});

describe('a module kept in a build folder below src', () => {
  it('is indexed for Go, C# and Rust', async () => {
    const root = tempDir();
    write(root, {
      'src/go/build/build.go': 'package build\n\nfunc Import(path string) error {\n\treturn nil\n}\n',
      'tools/src/Build/BuildManager.cs': 'namespace Tools.Build\n{\n    public class BuildManager\n    {\n        public void Run() { }\n    }\n}\n',
      'crates/cli/Cargo.toml': '[package]\nname = "cli"\nversion = "0.1.0"\n',
      'crates/cli/src/main.rs': 'mod build;\n\nfn main() {\n    build::BuildRequest::new().run();\n}\n',
      'crates/cli/src/build/mod.rs': 'pub struct BuildRequest;\n\nimpl BuildRequest {\n    pub fn new() -> Self {\n        BuildRequest\n    }\n\n    pub fn run(&self) {}\n}\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    graphs.push(cg);
    const names = (file: string) => cg.getNodesInFile(file).map((n) => n.name);
    expect(names('src/go/build/build.go')).toContain('Import');
    expect(names('tools/src/Build/BuildManager.cs')).toEqual(expect.arrayContaining(['BuildManager', 'Run']));
    expect(names('crates/cli/src/build/mod.rs')).toEqual(expect.arrayContaining(['BuildRequest', 'new', 'run']));
  }, 60_000);
});

describe('a JS/TS feature kept in src/build', () => {
  const FILES: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ui', private: true, dependencies: { react: '^18', 'react-router': '^7' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    'src/core/routes/routes.ts': `import { createBrowserRouter } from 'react-router';

export const router = createBrowserRouter([
  { path: '/p/:project/builders/:bucket/:builder', lazy: () => import('@/build/pages/builder_page') },
  { path: '/b/:buildId', lazy: () => import('@/build/legacy/build_page') },
]);
`,
    'src/build/pages/builder_page/index.ts': `export * from './builder_page';
`,
    'src/build/pages/builder_page/builder_page.tsx': `export function BuilderPage() {
  return null;
}

export function Component() {
  return <BuilderPage />;
}
`,
    'src/build/legacy/build_page/index.ts': `export * from './build_page';
`,
    'src/build/legacy/build_page/build_page.tsx': `export const BuildPage = () => null;

export function Component() {
  return <BuildPage />;
}
`,
  };

  /** Each route's `references` edges, as `name@file`. */
  const routeLinks = (graph: CodeGraph): Record<string, string[]> => Object.fromEntries(
    graph.getNodesByKind('route').map((route) => [route.name, graph.getOutgoingEdges(route.id)
      .filter((e) => e.kind === 'references')
      .map((e) => graph.getNode(e.target)!)
      .map((n) => `${n.name}@${n.filePath}`)
      .sort()])
  );

  it('is indexed, so its lazy routes link, and sync keeps it', async () => {
    const root = tempDir();
    write(root, FILES);
    gitRepo(root);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    const cg = await CodeGraph.init(root, { index: true });
    graphs.push(cg);

    expect(routeLinks(cg)).toEqual({
      '/p/:project/builders/:bucket/:builder': ['Component@src/build/pages/builder_page/builder_page.tsx'],
      '/b/:buildId': ['Component@src/build/legacy/build_page/build_page.tsx'],
    });
    expect(cg.getNodesInFile('src/build/pages/builder_page/builder_page.tsx').map((n) => n.name)).toContain('BuilderPage');

    // An edit, a new page and new build output below src/build: the git-status
    // sync reads them by the same rule as the full index.
    write(root, {
      'src/build/pages/builder_page/builder_page.tsx': FILES['src/build/pages/builder_page/builder_page.tsx']!.replace(/BuilderPage/g, 'BuilderView'),
      'src/build/pages/search_page/search_page.tsx': 'export function Component() {\n  return null;\n}\n',
      'src/build/pages/bundle.js': 'export function bundled() {}\n',
      'src/build/pages/types.d.ts': 'export declare function bundled(): void;\n',
    });
    const changes = getGitChangedFiles(root)!;
    expect([...changes.added, ...changes.modified].sort()).toEqual([
      'src/build/pages/builder_page/builder_page.tsx',
      'src/build/pages/search_page/search_page.tsx',
    ]);
    const synced = await cg.sync();
    expect(synced.filesAdded).toBe(1);
    expect(synced.filesModified).toBe(1);
    expect(cg.getNodesInFile('src/build/pages/builder_page/builder_page.tsx').map((n) => n.name)).toContain('BuilderView');
    expect(cg.getNodesInFile('src/build/pages/bundle.js')).toEqual([]);
  }, 60_000);

  it('is watched: its source edits sync, build output there does not', async () => {
    const root = tempDir();
    write(root, FILES);
    const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
    const watcher = new FileWatcher(root, syncFn, { inertForTests: true, debounceMs: 100 });
    watchers.push(watcher);
    watcher.start();
    await watcher.waitUntilReady();

    write(root, {
      'src/build/pages/bundle.js': 'export function bundled() {}\n',
      'build/main.ts': 'export const out = 1;\n',
      'src/build/pages/search_page/search_page.tsx': 'export function Component() {\n  return null;\n}\n',
    });
    __emitWatchEventForTests(root, 'src/build/pages/bundle.js');
    __emitWatchEventForTests(root, 'build/main.ts');
    __emitWatchEventForTests(root, 'src/build/pages/search_page/search_page.tsx');
    expect(watcher.getPendingFiles().map((p) => p.path)).toEqual(['src/build/pages/search_page/search_page.tsx']);
    await vi.waitFor(() => expect(syncFn).toHaveBeenCalledTimes(1));
    expect(syncFn.mock.calls[0]![0]).toEqual(['src/build/pages/search_page/search_page.tsx']);

    // A folder removed inside it arrives as one event on the folder's path:
    // that schedules the full reconcile which drops its files (#1285).
    fs.rmSync(path.join(root, 'src/build/legacy'), { recursive: true, force: true });
    __emitWatchEventForTests(root, 'src/build/legacy');
    await vi.waitFor(() => expect(syncFn).toHaveBeenCalledTimes(2));
    expect(syncFn.mock.calls[1]![0]).toBeUndefined();
  });
});
