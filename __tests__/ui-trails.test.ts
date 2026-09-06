/**
 * Saved trails (CG-60) — the viewer's only write.
 *
 * Two things are worth a real end-to-end fixture rather than a unit test, and
 * they are the two the feature exists for:
 *
 * 1. **A trail survives a re-index.** The suite indexes a project, saves a
 *    trail, then EDITS the files so every node id changes (a symbol shifts down
 *    a file, another moves to a different file, a third is deleted), re-indexes,
 *    and asserts the trail still opens and says what became of each hop. That
 *    cannot be faked: node ids contain a start line, so the ids really do all
 *    change.
 * 2. **The write boundary.** `POST` without the marker header, from a foreign
 *    `Origin`, or against a `--read-only` server has to be refused — by a real
 *    loopback server, because the refusals live in the request handler and not
 *    in the endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import {
  encodeResolvedRun,
  isTrailId,
  listStoredTrails,
  parseTrail,
  slugify,
  TRAILS_RELATIVE_DIR,
  type StoredTrail,
  type WireTrailHop,
} from '../src/ui-server/api';
import { writeStoredTrail } from '../src/ui-server/api/trail-store';
import { resetTrailAuthor, trailAuthor } from '../src/ui-server/api/trails';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

let tempDir: string;
let projectRoot: string;
let viewerDir: string;
let api: GraphApi;
let server: UiServerHandle;
let readOnlyApi: GraphApi;
let readOnlyServer: UiServerHandle;

interface CallOptions {
  method?: string;
  body?: unknown;
  /** Send the write marker header. On by default for a write. */
  marker?: boolean;
  contentType?: string | null;
  origin?: string;
}

/**
 * One request against a live server.
 *
 * `http.request` rather than `fetch` so `Host` is ours to set — undici treats
 * it as a forbidden header, and the `Host` allowlist is half of what is being
 * tested here.
 */
function callOn(port: number, requestPath: string, opts: CallOptions = {}): Promise<Res> {
  const method = opts.method ?? 'GET';
  const isWrite = method === 'POST' || method === 'DELETE';
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body), 'utf-8');
  const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
  if (isWrite && (opts.marker ?? true)) headers['X-CodeGraph-UI'] = '1';
  if (opts.origin) headers['Origin'] = opts.origin;
  if (payload) {
    const type = opts.contentType === undefined ? 'application/json' : opts.contentType;
    if (type !== null) headers['Content-Type'] = type;
    headers['Content-Length'] = String(payload.length);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method, headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* a text/plain refusal is a legitimate answer on the static side */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function call(requestPath: string, opts: CallOptions = {}): Promise<Res> {
  return callOn(server.port, requestPath, opts);
}

/** The id of a fixture symbol, looked up through the API itself. */
async function idOf(name: string): Promise<string> {
  const res = await call(`/api/search?q=${encodeURIComponent(name)}`);
  const hit = res.body.results.items.find((r: any) => r.name === name);
  expect(hit, `no symbol named ${name}`).toBeTruthy();
  return hit.id as string;
}

function trailsDir(): string {
  return path.join(projectRoot, TRAILS_RELATIVE_DIR);
}

function storedTrail(id: string): StoredTrail {
  return {
    version: 1,
    id,
    name: 'Must stay inside',
    note: '',
    author: 'test',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    hops: [
      {
        dir: 'start',
        name: 'start',
        qualifiedName: 'start',
        kind: 'function',
        file: 'src/start.ts',
        line: 1,
        id: 'function:start',
      },
    ],
  };
}

/** Re-index in place, the way a `codegraph sync` would after an edit. */
async function reindex(): Promise<void> {
  const cg = CodeGraph.openSync(projectRoot);
  await cg.sync();
  cg.resolveReferences();
  cg.close();
}

const SRC = () => path.join(projectRoot, 'src');

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-trails-'));
  projectRoot = path.join(tempDir, 'project');
  fs.mkdirSync(SRC(), { recursive: true });

  fs.writeFileSync(
    path.join(SRC(), 'handler.ts'),
    `import { load } from './service';

export function handleRequest(key: string): string {
  return load(key);
}
`
  );
  fs.writeFileSync(
    path.join(SRC(), 'service.ts'),
    `import { read } from './cache';

export function load(key: string): string {
  return read(key);
}

export function retired(): string {
  return 'nothing calls me after the edit';
}
`
  );
  fs.writeFileSync(
    path.join(SRC(), 'cache.ts'),
    `export function read(key: string): string {
  return key;
}
`
  );

  const cg = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts'], exclude: [] },
  });
  await cg.indexAll();
  cg.resolveReferences();
  cg.close();

  viewerDir = path.join(tempDir, 'viewer');
  fs.mkdirSync(viewerDir, { recursive: true });
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><div id="app"></div>');

  api = createGraphApi({ projectRoot });
  server = await startUiServer({ projectRoot, viewerDir, port: 0, api: api.handler });

  readOnlyApi = createGraphApi({
    projectRoot,
    readOnly: true,
    readOnlyReason: 'This viewer was started with --read-only, so trails cannot be saved.',
  });
  readOnlyServer = await startUiServer({
    projectRoot,
    viewerDir,
    port: 0,
    api: readOnlyApi.handler,
  });
}, 120_000);

afterAll(async () => {
  api?.close();
  readOnlyApi?.close();
  await server?.close();
  await readOnlyServer?.close();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------- pure bits -- */

describe('trail ids', () => {
  it('slugs a name into something that is a filename and not a path', () => {
    expect(slugify('How a request reaches the handler')).toBe(
      'how-a-request-reaches-the-handler'
    );
    expect(slugify('  Spaces   and --- dashes  ')).toBe('spaces-and-dashes');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    // A name with no ASCII word characters still has to produce a valid id.
    expect(slugify('日本語')).toBe('trail');
    expect(isTrailId(slugify('../../etc/passwd'))).toBe(true);
  });

  it('refuses anything that is not a slug', () => {
    for (const bad of ['..', 'a/b', 'A', 'has.dot', '-leading', '', 'a b']) {
      expect(isTrailId(bad), bad).toBe(false);
    }
  });
});

describe('trail write containment', () => {
  it.runIf(process.platform !== 'win32')(
    'refuses a missing trail directory below a symlink that leaves the project',
    () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-trail-symlink-'));
      const project = path.join(base, 'project');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(path.join(project, '.codegraph'), { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(project, '.codegraph', 'ui'), 'dir');

      try {
        expect(() => writeStoredTrail(project, storedTrail('must-stay-inside'))).toThrow(
          /outside the project/
        );
        expect(fs.existsSync(path.join(outside, 'trails'))).toBe(false);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'allows a project root reached through a symlink when the real path stays inside it',
    () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-trail-root-link-'));
      const project = path.join(base, 'project');
      const alias = path.join(base, 'project-link');
      fs.mkdirSync(path.join(project, '.codegraph'), { recursive: true });
      fs.symlinkSync(project, alias, 'dir');

      try {
        expect(() => writeStoredTrail(alias, storedTrail('safe-root-link'))).not.toThrow();
        expect(
          fs.existsSync(path.join(project, TRAILS_RELATIVE_DIR, 'safe-root-link.json'))
        ).toBe(true);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
  );
});

describe('trail read containment', () => {
  it.runIf(process.platform !== 'win32')(
    'skips a trail file symlinked outside the project instead of reading it',
    () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-trail-read-link-'));
      const project = path.join(base, 'project');
      const outside = path.join(base, 'outside');
      const dir = path.join(project, TRAILS_RELATIVE_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(
        path.join(outside, 'secret.json'),
        JSON.stringify({ ...storedTrail('outside'), note: 'must not be read' })
      );
      fs.symlinkSync(path.join(outside, 'secret.json'), path.join(dir, 'linked.json'));

      try {
        expect(listStoredTrails(project)).toEqual({ trails: [], skipped: 1 });
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'skips a FIFO in the trails directory without blocking on it',
    () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-trail-read-fifo-'));
      const project = path.join(base, 'project');
      const dir = path.join(project, TRAILS_RELATIVE_DIR);
      fs.mkdirSync(dir, { recursive: true });
      // A FIFO with no writer: a blocking open would hang here until one showed up.
      execFileSync('mkfifo', [path.join(dir, 'blocked.json')]);

      try {
        expect(listStoredTrails(project)).toEqual({ trails: [], skipped: 1 });
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
    5_000
  );
});

describe('trail author cache', () => {
  it('keeps git user names separate for projects served by one process', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-trail-authors-'));
    const first = path.join(base, 'first');
    const second = path.join(base, 'second');

    try {
      for (const [dir, author] of [
        [first, 'Alice Project'],
        [second, 'Bob Project'],
      ] as const) {
        fs.mkdirSync(dir, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['config', 'user.name', author], { cwd: dir });
      }
      resetTrailAuthor();
      expect(trailAuthor(first)).toBe('Alice Project');
      expect(trailAuthor(second)).toBe('Bob Project');
    } finally {
      resetTrailAuthor();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('parseTrail', () => {
  it('rejects a file that is not a trail rather than half-reading it', () => {
    expect(parseTrail('x', 'not json')).toBeNull();
    expect(parseTrail('x', '[]')).toBeNull();
    expect(parseTrail('x', '{"name":"a"}')).toBeNull();
    expect(parseTrail('x', '{"name":"a","hops":[]}')).toBeNull();
    expect(parseTrail('x', '{"name":"","hops":[{"qualifiedName":"a"}]}')).toBeNull();
  });

  it('rejects a declared format version this build does not understand', () => {
    expect(
      parseTrail('future', JSON.stringify({ ...storedTrail('future'), version: 2 }))
    ).toBeNull();
  });

  it('takes its id from the FILE, not from the field inside it', () => {
    const trail = parseTrail('on-disk', '{"name":"a","id":"remembered","hops":[{"name":"f"}]}');
    expect(trail?.id).toBe('on-disk');
  });
});

describe('encodeResolvedRun', () => {
  const hop = (id: string | null, dir: 'start' | 'down' | 'up' = 'down'): WireTrailHop => ({
    dir,
    name: id ?? 'gone',
    qualifiedName: id ?? 'gone',
    kind: 'function',
    savedFile: 'src/a.ts',
    savedLine: 1,
    status: id ? 'ok' : 'missing',
    id,
    file: id ? 'src/a.ts' : null,
    line: id ? 1 : null,
    note: null,
  });

  it('never stitches across a hole — it takes the longest consecutive run', () => {
    const run = encodeResolvedRun([hop('a', 'start'), hop(null), hop('c'), hop('d')]);
    expect(run.encoded).toBe('sc,dd');
    expect(run.openFrom).toBe(3);
    expect(run.openCount).toBe(2);
    expect(run.openId).toBe('d');
  });

  it('writes the run’s first hop as a start, whatever it was saved as', () => {
    const run = encodeResolvedRun([hop(null), hop('b', 'up')]);
    expect(run.encoded).toBe('sb');
  });

  it('answers nothing when nothing resolves', () => {
    expect(encodeResolvedRun([hop(null), hop(null)])).toEqual({
      encoded: null,
      openFrom: 0,
      openCount: 0,
      openId: null,
    });
  });
});

/* ----------------------------------------------------------- the endpoint -- */

describe('GET /api/trails', () => {
  it('is an empty list, not an error, before anything is saved', async () => {
    const res = await call('/api/trails');
    expect(res.status).toBe(200);
    expect(res.body.trails).toEqual([]);
    expect(res.body.readOnly).toBe(false);
    expect(res.body.directory).toBe(TRAILS_RELATIVE_DIR);
  });

  it('is listed by GET /api', async () => {
    const res = await call('/api');
    expect(res.body.endpoints.some((e: any) => e.path === '/api/trails')).toBe(true);
    // The old blanket claim is gone: the server writes exactly one thing.
    expect(res.body.readOnly).toBe(false);
    expect(res.body.writes).toContain('POST /api/trails');
  });
});

describe('POST /api/trails', () => {
  it('saves the walk and answers with the whole list', async () => {
    const hops = [
      { dir: 'start', id: await idOf('handleRequest') },
      { dir: 'down', id: await idOf('load') },
      { dir: 'down', id: await idOf('read') },
    ];
    const res = await call('/api/trails', {
      method: 'POST',
      body: { name: 'How a request is served', note: 'the whole path', hops },
    });

    expect(res.status).toBe(200);
    expect(res.body.saved).toBe('how-a-request-is-served');
    expect(res.body.replaced).toBe(false);
    expect(res.body.trails).toHaveLength(1);

    const trail = res.body.trails[0];
    expect(trail.name).toBe('How a request is served');
    expect(trail.note).toBe('the whole path');
    expect(trail.intact).toBe(true);
    expect(trail.resolved).toBe(3);
    expect(trail.openCount).toBe(3);
    expect(trail.hops.map((h: any) => h.name)).toEqual(['handleRequest', 'load', 'read']);
    // The identity that survives an edit, recorded beside the id hint.
    expect(trail.hops[1].qualifiedName).toBe('load');
    expect(trail.hops[1].savedFile).toBe('src/service.ts');
  });

  it('writes one readable JSON file into .codegraph/ui/trails', () => {
    const file = path.join(trailsDir(), 'how-a-request-is-served.json');
    expect(fs.existsSync(file)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.hops).toHaveLength(3);
    expect(raw.hops[0].qualifiedName).toBe('handleRequest');
    expect(typeof raw.createdAt).toBe('string');
    // Nothing but trails lands there — no temp file survives the rename.
    expect(fs.readdirSync(trailsDir())).toEqual(['how-a-request-is-served.json']);
  });

  it('replaces a trail saved under the same name, keeping its createdAt', async () => {
    const before = (await call('/api/trails')).body.trails[0];
    const res = await call('/api/trails', {
      method: 'POST',
      body: {
        name: 'How a request is served',
        hops: [{ dir: 'start', id: await idOf('handleRequest') }],
      },
    });
    expect(res.body.replaced).toBe(true);
    expect(res.body.trails).toHaveLength(1);
    expect(res.body.trails[0].createdAt).toBe(before.createdAt);
    expect(res.body.trails[0].hops).toHaveLength(1);
    expect(res.body.trails[0].note).toBe('');
  });

  it('gives a different name its own file rather than colliding', async () => {
    const res = await call('/api/trails', {
      method: 'POST',
      body: { name: 'How a request is served!', hops: [{ dir: 'start', id: await idOf('load') }] },
    });
    expect(res.body.saved).toBe('how-a-request-is-served-2');
    expect(res.body.trails).toHaveLength(2);
  });

  it('refuses a hop the index does not hold', async () => {
    const res = await call('/api/trails', {
      method: 'POST',
      body: { name: 'invented', hops: [{ dir: 'start', id: 'function:not-a-real-id' }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Hop 1 is not in the index');
  });

  it('refuses a nameless or hopless trail', async () => {
    const noName = await call('/api/trails', { method: 'POST', body: { name: '  ', hops: [] } });
    expect(noName.status).toBe(400);
    const noHops = await call('/api/trails', { method: 'POST', body: { name: 'x', hops: [] } });
    expect(noHops.status).toBe(400);
    expect(noHops.body.error).toContain('at least one hop');
  });
});

describe('DELETE /api/trails/<id>', () => {
  it('removes the file and answers with the list that is left', async () => {
    const res = await call('/api/trails/how-a-request-is-served-2', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('how-a-request-is-served-2');
    expect(res.body.trails).toHaveLength(1);
    expect(fs.existsSync(path.join(trailsDir(), 'how-a-request-is-served-2.json'))).toBe(false);
  });

  it('is a 404 for a trail that is not there', async () => {
    const res = await call('/api/trails/never-existed', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('refuses an id shaped like a path before it is joined to anything', async () => {
    const res = await call('/api/trails/..%2f..%2fetc%2fpasswd', { method: 'DELETE' });
    // The `..` segments are caught on the RAW url, before WHATWG parsing folds
    // them away — a traversal attempt is a 404, never the app shell.
    expect([400, 404]).toContain(res.status);
    expect(res.headers['content-type']).toContain('application/json');
  });
});

/* ------------------------------------------------------- the write boundary */

describe('the write boundary', () => {
  it('refuses a POST without the marker header', async () => {
    const res = await call('/api/trails', {
      method: 'POST',
      marker: false,
      body: { name: 'forged', hops: [] },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('refused');
    expect(String(res.body.error)).toContain('x-codegraph-ui');
  });

  it('refuses a POST whose body claims to be a form', async () => {
    const res = await call('/api/trails', {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: { name: 'forged', hops: [] },
    });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('application/json');
  });

  it('refuses a POST from a foreign origin even with the marker', async () => {
    const res = await call('/api/trails', {
      method: 'POST',
      origin: 'https://evil.example',
      body: { name: 'forged', hops: [] },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a write anywhere but /api/, and still serves the asset on GET', async () => {
    const post = await call('/index.html', { method: 'POST', body: { a: 1 } });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    const get = await call('/index.html');
    expect(get.status).toBe(200);
  });

  it('still refuses a method it has never answered', async () => {
    const res = await call('/api/trails', { method: 'PUT' });
    expect(res.status).toBe(405);
  });

  it('refuses every write under --read-only, but still lists what is there', async () => {
    const list = await callOn(readOnlyServer.port, '/api/trails');
    expect(list.status).toBe(200);
    expect(list.body.readOnly).toBe(true);
    expect(list.body.readOnlyReason).toContain('--read-only');
    expect(list.body.trails.length).toBeGreaterThan(0);

    const save = await callOn(readOnlyServer.port, '/api/trails', {
      method: 'POST',
      body: { name: 'nope', hops: [{ dir: 'start', id: 'x' }] },
    });
    expect(save.status).toBe(403);
    expect(save.body.code).toBe('refused');

    const remove = await callOn(readOnlyServer.port, '/api/trails/how-a-request-is-served', {
      method: 'DELETE',
    });
    expect(remove.status).toBe(403);
  });
});

/* ------------------------------------------------- surviving a re-index --- */

describe('a saved trail survives a re-index', () => {
  it('re-resolves hops by qualified name once every node id has changed', async () => {
    // Save the three-hop walk again, plus a fourth hop that is about to be
    // deleted outright, so one trail exercises every outcome at once.
    const saved = await call('/api/trails', {
      method: 'POST',
      body: {
        name: 'The whole walk',
        hops: [
          { dir: 'start', id: await idOf('handleRequest') },
          { dir: 'down', id: await idOf('load') },
          { dir: 'down', id: await idOf('read') },
          { dir: 'down', id: await idOf('retired') },
        ],
      },
    });
    const before = saved.body.trails.find((t: any) => t.id === 'the-whole-walk');
    expect(before.intact).toBe(true);
    const idsBefore = before.hops.map((h: any) => h.id);

    // Now move the world underneath it:
    //  - `handleRequest` shifts down its file (a node id contains its start
    //    line, so its id changes while it is the same symbol);
    //  - `read` moves to a different file entirely;
    //  - `retired` is deleted.
    fs.writeFileSync(
      path.join(SRC(), 'handler.ts'),
      `import { load } from './service';

// A comment inserted above the symbol. This alone renames it.
// Another line.
// And another.

export function handleRequest(key: string): string {
  return load(key);
}
`
    );
    fs.writeFileSync(
      path.join(SRC(), 'service.ts'),
      `import { read } from './store';

export function load(key: string): string {
  return read(key);
}
`
    );
    fs.writeFileSync(path.join(SRC(), 'cache.ts'), `export const unused = 1;\n`);
    fs.writeFileSync(
      path.join(SRC(), 'store.ts'),
      `export function read(key: string): string {
  return key;
}
`
    );
    await reindex();

    const after = (await call('/api/trails')).body.trails.find(
      (t: any) => t.id === 'the-whole-walk'
    );

    // Every id really did change — otherwise this test proves nothing.
    const idsAfter = after.hops.map((h: any) => h.id);
    expect(idsAfter[0]).not.toBe(idsBefore[0]);
    expect(idsAfter[0]).toBeTruthy();

    const [handle, load, read, retired] = after.hops;
    expect(handle.status).toBe('ok');
    expect(handle.file).toBe('src/handler.ts');
    expect(handle.line).toBeGreaterThan(handle.savedLine);

    expect(load.status).toBe('ok');

    // Moved to another file: still resolved, and the row says where from.
    expect(read.status).toBe('moved');
    expect(read.savedFile).toBe('src/cache.ts');
    expect(read.file).toBe('src/store.ts');
    expect(read.note).toContain('src/cache.ts');
    expect(read.note).toContain('src/store.ts');

    // Deleted: named honestly, with no invented target.
    expect(retired.status).toBe('missing');
    expect(retired.id).toBeNull();
    expect(retired.note).toContain('moved or renamed');

    // And it still opens — the first three hops, not the fourth.
    expect(after.intact).toBe(false);
    expect(after.resolved).toBe(3);
    expect(after.openFrom).toBe(1);
    expect(after.openCount).toBe(3);
    expect(after.openId).toBe(idsAfter[2]);
    expect(after.encoded?.split(',')).toHaveLength(3);
    expect(after.encoded?.startsWith('s')).toBe(true);
  }, 120_000);
});
