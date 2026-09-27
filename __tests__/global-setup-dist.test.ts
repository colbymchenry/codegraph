import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureTestDist } from './global-setup-dist';

let root: string;
let builds: string[];
function write(file: string, content = file): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}
const engineOutputs = ['dist/bin/codegraph.js', 'dist/db/schema.sql',
  'dist/extraction/wasm/typescript.wasm', 'dist/resolution/resolve-worker.js'];
const viewerOutputs = ['dist/viewer/index.html', 'dist/viewer/assets/app.js', 'dist/viewer/assets/app.css'];
function build(part: 'engine' | 'viewer'): void {
  builds.push(part);
  for (const file of part === 'engine' ? engineOutputs : viewerOutputs) write(file);
}
function setup(): void { ensureTestDist(root, build); }

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-build-'));
  builds = [];
  for (const file of ['src/bin/codegraph.ts', 'src/db/schema.sql',
    'src/extraction/wasm/typescript.wasm', 'tsconfig.json', 'package.json',
    'package-lock.json', 'scripts/check-ui-build.mjs', 'ui/src/App.svelte',
    'ui/vite.config.ts', 'ui/svelte.config.js', 'ui/tsconfig.json', 'ui/package.json', 'ui/index.html']) write(file);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('test dist prerequisites', () => {
  it('builds a cold checkout in dependency order and leaves a warm checkout untouched', () => {
    setup();
    expect(builds).toEqual(['engine', 'viewer']);
    builds = [];
    setup();
    expect(builds).toEqual([]);
  });

  it.each([...engineOutputs, ...viewerOutputs])('repairs missing output %s even with current sentinels', file => {
    setup();
    builds = [];
    fs.unlinkSync(path.join(root, file));
    setup();
    expect(builds).toEqual([file.startsWith('dist/viewer/') ? 'viewer' : 'engine']);
    expect(fs.existsSync(path.join(root, file))).toBe(true);
  });

  it.each([
    ['src/bin/codegraph.ts', ['engine']],
    ['src/db/schema.sql', ['engine']],
    ['src/extraction/wasm/typescript.wasm', ['engine']],
    ['tsconfig.json', ['engine', 'viewer']],
    ['package.json', ['engine', 'viewer']],
    ['package-lock.json', ['engine', 'viewer']],
    ['scripts/check-ui-build.mjs', ['engine', 'viewer']],
    ['ui/src/App.svelte', ['viewer']],
    ['ui/vite.config.ts', ['viewer']],
    ['ui/svelte.config.js', ['viewer']],
    ['ui/tsconfig.json', ['viewer']],
    ['ui/package.json', ['viewer']],
    ['ui/index.html', ['viewer']],
  ])('invalidates changed input %s even with a preserved mtime', (file, expected) => {
    setup();
    builds = [];
    const stat = fs.statSync(path.join(root, file));
    write(file, 'changed');
    fs.utimesSync(path.join(root, file), stat.atime, stat.mtime);
    setup();
    expect(builds).toEqual(expected);
  });

  it('invalidates added and removed source files', () => {
    setup();
    builds = [];
    write('src/new-worker.ts');
    setup();
    fs.unlinkSync(path.join(root, 'src/new-worker.ts'));
    setup();
    expect(builds).toEqual(['engine', 'engine']);
  });

  it('fails directly when the checkout has no installed compiler', () => {
    expect(() => ensureTestDist(root)).toThrow(/engine build failed: Cannot find module/);
    expect(fs.existsSync(path.join(root, 'dist/.test-build-engine.json'))).toBe(false);
  });

  it('reports build errors directly and retries instead of recording partial success', () => {
    expect(() => ensureTestDist(root, () => {
      write('dist/bin/codegraph.js');
      throw new Error('compiler diagnostic');
    })).toThrow('[test setup] engine build failed: compiler diagnostic');
    expect(fs.existsSync(path.join(root, 'dist/.test-build-engine.json'))).toBe(false);
    setup();
    expect(builds).toEqual(['engine', 'viewer']);
  });
});
