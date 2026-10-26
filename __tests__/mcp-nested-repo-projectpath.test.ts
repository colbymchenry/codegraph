/**
 * A `projectPath` inside an independent nested git repository that the
 * ancestor index excludes (#2110).
 *
 * `findNearestCodeGraphRoot` walks up to the nearest `.codegraph/` without
 * looking at git boundaries. For a submodule or embedded clone the ancestor
 * indexes, that is what we want — one index serves the whole workspace. For a
 * nested repository the ancestor does NOT index (typically gitignored), the
 * call silently answered from the ancestor's code instead. It must now get the
 * same success-shaped "isn't indexed" guidance a project with no index at all
 * gets, while every layout the ancestor index does cover keeps resolving to it.
 *
 * Real `git`, real temp repositories, real indexes — no mocking.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

/**
 * The issue's layout: `parent/` is a repository that gitignores `nested/`,
 * and `nested/` is an independent repository of its own. Only the parent is
 * indexed. `parent/src/` is an ordinary subdirectory of the parent.
 */
function makeParentWithIgnoredNestedRepo(root: string, ignoreNested = true): { parent: string; nested: string } {
  const parent = path.join(root, 'parent');
  const nested = path.join(parent, 'nested');
  initRepo(parent);
  if (ignoreNested) fs.writeFileSync(path.join(parent, '.gitignore'), 'nested/\nwt/\n');
  fs.writeFileSync(path.join(parent, 'parent-only.ts'), "export function parentOnly() { return 'parent'; }\n");
  fs.mkdirSync(path.join(parent, 'src'));
  fs.writeFileSync(path.join(parent, 'src', 'sub.ts'), "export function parentSub() { return 'sub'; }\n");
  git(parent, 'add', '.');
  git(parent, 'commit', '-q', '-m', 'repro-parent');

  initRepo(nested);
  fs.writeFileSync(path.join(nested, 'nested-only.ts'), "export function nestedOnly() { return 'nested'; }\n");
  fs.mkdirSync(path.join(nested, 'lib'));
  fs.writeFileSync(path.join(nested, 'lib', 'deep.ts'), "export function nestedDeep() { return 'deep'; }\n");
  git(nested, 'add', '.');
  git(nested, 'commit', '-q', '-m', 'repro-nested');
  return { parent, nested };
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  const first = res.content[0];
  return first && first.type === 'text' ? first.text ?? '' : '';
}

describe('projectPath inside a nested git repository the ancestor index excludes (#2110)', () => {
  let root: string;
  let parent: string;
  let nested: string;
  let cg: CodeGraph;
  let handler: ToolHandler | null;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nested-repo-'));
    ({ parent, nested } = makeParentWithIgnoredNestedRepo(root));
    cg = CodeGraph.initSync(parent);
    await cg.indexAll();
    handler = null;
  });

  afterEach(async () => {
    __setLoadCodeGraphForTests(null);
    if (handler) await handler.closeAll();
    try { cg.destroy(); } catch { /* best effort */ }
    try { git(parent, 'worktree', 'remove', '--force', path.join(parent, 'wt')); } catch { /* none added */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('the fixture matches the issue: the parent index holds none of the nested repository', () => {
    expect(cg.getFile('parent-only.ts')).not.toBeNull();
    expect(cg.getFile('nested/nested-only.ts')).toBeNull();
  });

  it('answers with success-shaped "isn\'t indexed" guidance instead of the parent\'s code', async () => {
    handler = new ToolHandler(cg); // the server runs in the parent, as in the issue
    const res = await handler.execute('codegraph_explore', {
      query: 'parentOnly nestedOnly',
      projectPath: nested,
      maxFiles: 10,
    });
    const body = text(res);
    expect(res.isError).toBeUndefined();
    expect(body).toMatch(/isn't indexed/);
    expect(body).toMatch(/codegraph init/);
    expect(body).toMatch(/built-in tools/);
    expect(body).not.toContain('parent-only.ts');
    expect(body).not.toContain('parentOnly()');
  });

  it('covers a subdirectory of the nested repository, existing or not', async () => {
    handler = new ToolHandler(cg);
    for (const projectPath of [path.join(nested, 'lib'), path.join(nested, 'lib', 'not-created-yet')]) {
      const res = await handler.execute('codegraph_search', { query: 'parentOnly', projectPath });
      expect(res.isError).toBeUndefined();
      expect(text(res)).toMatch(/isn't indexed/);
    }
  });

  it('refuses the same way when the parent is not the session\'s default project', async () => {
    __setLoadCodeGraphForTests(CodeGraph);
    handler = new ToolHandler(null);
    const res = await handler.execute('codegraph_search', { query: 'parentOnly', projectPath: nested });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toMatch(/isn't indexed/);

    // …while the parent itself is still served by projectPath.
    const ok = await handler.execute('codegraph_search', { query: 'parentOnly', projectPath: parent });
    expect(ok.isError).toBeUndefined();
    expect(text(ok)).toContain('parent-only.ts');
  });

  it('keeps resolving an ordinary subdirectory of the parent to the parent index', async () => {
    handler = new ToolHandler(cg);
    const res = await handler.execute('codegraph_search', {
      query: 'parentSub',
      projectPath: path.join(parent, 'src'),
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).not.toMatch(/isn't indexed/);
    expect(text(res)).toContain('src/sub.ts');
  });

  it('keeps serving a linked worktree of the parent from the parent index, with the #155 notice', async () => {
    // A worktree nested inside (and ignored by) the main checkout is the SAME
    // repository — the borrowed-worktree case, which is warned about, not refused.
    const wt = path.join(parent, 'wt');
    git(parent, 'worktree', 'add', '-q', '-b', 'feature', wt);
    handler = new ToolHandler(cg);
    const res = await handler.execute('codegraph_search', { query: 'parentOnly', projectPath: wt });
    expect(res.isError).toBeUndefined();
    expect(text(res)).not.toMatch(/isn't indexed/);
    expect(text(res)).toContain('different git worktree');
    expect(text(res)).toContain('parent-only.ts');
  });

  it('notices the nested repository joining the index without a restart', async () => {
    handler = new ToolHandler(cg);
    const before = await handler.execute('codegraph_search', { query: 'nestedOnly', projectPath: nested });
    expect(text(before)).toMatch(/isn't indexed/);

    // The user stops ignoring it and the parent re-syncs (an embedded clone the
    // parent does not ignore is indexed with it).
    fs.writeFileSync(path.join(parent, '.gitignore'), 'wt/\n');
    await cg.sync();
    expect(cg.getFile('nested/nested-only.ts')).not.toBeNull();

    const after = await handler.execute('codegraph_search', { query: 'nestedOnly', projectPath: nested });
    expect(after.isError).toBeUndefined();
    expect(text(after)).not.toMatch(/isn't indexed/);
    expect(text(after)).toContain('nested/nested-only.ts');
  });

  it('serves a nested repository that has its own index from that index', async () => {
    const nestedCg = CodeGraph.initSync(nested);
    await nestedCg.indexAll();
    nestedCg.close();
    __setLoadCodeGraphForTests(CodeGraph);
    handler = new ToolHandler(cg);
    const res = await handler.execute('codegraph_search', { query: 'nestedOnly', projectPath: nested });
    expect(res.isError).toBeUndefined();
    expect(text(res)).not.toMatch(/isn't indexed/);
    expect(text(res)).toContain('nested-only.ts');
  });

  it('fails open to the ancestor index when git cannot be run', async () => {
    handler = new ToolHandler(cg);
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const res = await handler.execute('codegraph_search', { query: 'parentOnly', projectPath: nested });
      expect(res.isError).toBeUndefined();
      expect(text(res)).not.toMatch(/isn't indexed/);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('projectPath inside a nested git repository the ancestor index DOES cover (#2110)', () => {
  let root: string;
  let parent: string;
  let nested: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nested-covered-'));
    // Same two repositories, but the parent does not ignore the nested one — an
    // embedded clone the parent's index takes in.
    ({ parent, nested } = makeParentWithIgnoredNestedRepo(root, false));
    cg = CodeGraph.initSync(parent);
    await cg.indexAll();
  });

  afterEach(() => {
    try { cg.destroy(); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('keeps resolving to the parent index, which answers for the nested repository', async () => {
    expect(cg.getFile('nested/nested-only.ts')).not.toBeNull();
    const res = await new ToolHandler(cg).execute('codegraph_search', {
      query: 'nestedOnly',
      projectPath: nested,
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).not.toMatch(/isn't indexed/);
    expect(text(res)).toContain('nested/nested-only.ts');
  });

  it('keeps resolving a submodule the parent indexes to the parent index', async () => {
    const source = path.join(root, 'sub-source');
    initRepo(source);
    fs.writeFileSync(path.join(source, 'lib.ts'), 'export function fromSubmodule() { return 1; }\n');
    git(source, 'add', '.');
    git(source, 'commit', '-q', '-m', 'sub');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'service-a');
    git(parent, 'commit', '-q', '-m', 'add submodule');
    await cg.sync();
    expect(cg.getFile('service-a/lib.ts')).not.toBeNull();

    const res = await new ToolHandler(cg).execute('codegraph_search', {
      query: 'fromSubmodule',
      projectPath: path.join(parent, 'service-a'),
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).not.toMatch(/isn't indexed/);
    expect(text(res)).toContain('service-a/lib.ts');
  });
});

/** Send a JSON-RPC request and resolve with the response matching its id. */
function request(
  child: ChildProcessWithoutNullStreams,
  msg: { id: number; method: string; params?: unknown },
  timeoutMs = 20000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`timeout waiting for response id=${msg.id}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === msg.id) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // non-JSON noise on stdout — ignore
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  });
}

describe('stdio MCP: projectPath inside an excluded nested git repository (#2110)', { timeout: 60_000 }, () => {
  let root: string;
  let parent: string;
  let nested: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nested-stdio-'));
    ({ parent, nested } = makeParentWithIgnoredNestedRepo(root));
    const cg = CodeGraph.initSync(parent);
    await cg.indexAll();
    cg.close();
  });

  afterEach(async () => {
    if (child) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      child = null;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('returns the not-indexed guidance for the nested repository and still serves the parent', async () => {
    child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp'], {
      cwd: parent,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // In-process server (no detached daemon to leak); see mcp-unindexed.test.ts.
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    }) as ChildProcessWithoutNullStreams;

    await request(child, {
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
        rootUri: `file://${parent}`,
      },
    });

    const res = await request(child, {
      id: 3,
      method: 'tools/call',
      params: {
        name: 'codegraph_explore',
        arguments: { query: 'parentOnly nestedOnly', projectPath: nested, maxFiles: 10 },
      },
    });
    const result = res.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/isn't indexed/);
    expect(result.content[0]!.text).not.toContain('parent-only.ts');

    const ok = await request(child, {
      id: 4,
      method: 'tools/call',
      params: { name: 'codegraph_explore', arguments: { query: 'parentOnly', projectPath: parent } },
    });
    const okResult = ok.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(okResult.isError).toBeUndefined();
    expect(okResult.content[0]!.text).toContain('parent-only.ts');
  });
});
