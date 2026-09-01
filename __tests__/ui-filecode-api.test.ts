/**
 * `GET /api/filecode` — everything the whole-file view draws (CG-52).
 *
 * Against a real indexed fixture over a real loopback server, like the rest of
 * the viewer's API suite. The fixture is shaped around the four claims this
 * endpoint makes that a hand-written payload could not prove:
 *
 * - a call group is one (CALLER, CALLEE) pair, not one per callee — the same
 *   helper reached from two functions has to come back as two rows, because a
 *   row is anchored to a line and there is no line that is both,
 * - `intraFileCalls` counts exactly the arcs the viewer can draw from `calls`,
 *   so the header and the picture under it cannot disagree,
 * - top-level code has an owner (the file node), which is the only way a
 *   statement outside every definition gets a port at all,
 * - a reference that resolves to nothing still comes back, so a line calling a
 *   runtime builtin shows a hollow port instead of an empty gutter.
 *
 * The pure geometry is tested without a server in `ui-filecode-model.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { MAX_FILE_CALL_GROUPS, MAX_FILE_OUTSIDE_REFS } from '../src/ui-server/api/filecode';

let server: UiServerHandle;
let api: GraphApi;
let tempDir: string;
let projectRoot: string;

function request(requestPath: string): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: requestPath,
        method: 'GET',
        headers: { Host: `127.0.0.1:${server.port}` },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            type: res.headers['content-type'],
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function getCode(file: string, expected = 200): Promise<any> {
  const res = await request(`/api/filecode/${file}`);
  expect(res.type).toBe('application/json; charset=utf-8');
  expect(res.status).toBe(expected);
  return JSON.parse(res.body);
}

function write(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

/** Rows as `caller -> callee`, which is how the rail reads. */
function pairs(payload: any): string[] {
  const names = new Map<string, string>(
    payload.outline.items.map((e: any) => [e.id, e.name] as [string, string])
  );
  return payload.calls.items.map(
    (c: any) => `${names.get(c.ownerId) ?? 'file'} -> ${c.relation.node.name}`
  );
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-filecode-'));
  projectRoot = path.join(tempDir, 'project');

  // `format` is called by TWO functions in this file and by one in another, and
  // `render` calls it twice from two different lines — every grouping case in
  // one file.
  write(
    projectRoot,
    'src/report.ts',
    `import { widen } from './widen';

export function format(value: string): string {
  return value.trim();
}

export function render(a: string, b: string): string {
  const left = format(a);
  const right = format(b);
  return left + right;
}

export function summarise(rows: string[]): string {
  const head = format(rows[0] ?? '');
  console.log(head);
  return widen(head);
}

render('a', 'b');
`
  );
  write(
    projectRoot,
    'src/widen.ts',
    `export function widen(text: string): string {
  return text + '  ';
}
`
  );
  // Nothing in it reaches anything: the empty-rail, no-arc case.
  write(projectRoot, 'src/quiet.ts', `export const NAME = 'quiet';\n`);

  const cg = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts'], exclude: [] },
  });
  await cg.indexAll();
  cg.resolveReferences();
  cg.close();

  const viewerDir = path.join(tempDir, 'viewer');
  fs.mkdirSync(viewerDir, { recursive: true });
  fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><div id="app"></div>');

  api = createGraphApi({ projectRoot });
  server = await startUiServer({ projectRoot, viewerDir, port: 0, api: api.handler });
}, 120_000);

afterAll(async () => {
  api?.close();
  await server?.close();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('GET /api/filecode', () => {
  it('describes the file and its length, which is the view\'s layout', async () => {
    const payload = await getCode('src/report.ts');
    expect(payload.file.path).toBe('src/report.ts');
    expect(payload.file.language).toBe('typescript');
    expect(payload.file.id).toBe('file:src/report.ts');
    expect(payload.drift).toBe(false);
    // The count comes from disk, not from the index: it is the height of the
    // scrolling document, and the source itself is paged in separately.
    const onDisk = fs.readFileSync(path.join(projectRoot, 'src/report.ts'), 'utf-8');
    expect(payload.file.totalLines).toBe(onDisk.replace(/\n$/, '').split('\n').length);
  });

  it('returns the same outline rows the File view draws', async () => {
    const code = await getCode('src/report.ts');
    const file = JSON.parse((await request('/api/file/src/report.ts')).body);
    expect(code.outline.total).toBe(file.outline.total);
    expect(code.outline.items.map((e: any) => e.name)).toEqual(
      file.outline.items.map((e: any) => e.name)
    );
    // A rail that disagreed with the source beside it would be worse than none.
    for (const entry of code.outline.items) {
      expect(entry.line).toBeGreaterThan(0);
      expect(entry.endLine).toBeGreaterThanOrEqual(entry.line);
    }
  });

  it('groups by the PAIR, so one callee reached from two functions is two rows', async () => {
    const payload = await getCode('src/report.ts');
    const rows = pairs(payload);
    expect(rows).toContain('render -> format');
    expect(rows).toContain('summarise -> format');

    // …and the two lines `render` calls it from stay ONE row, with both lines.
    const renderRow = payload.calls.items.find(
      (c: any) =>
        c.relation.node.name === 'format' &&
        payload.outline.items.find((e: any) => e.id === c.ownerId)?.name === 'render'
    );
    expect(renderRow.relation.lines.length).toBe(2);
    expect(renderRow.relation.lines[0]).toBeLessThan(renderRow.relation.lines[1]);
  });

  it('rows are in call-site order — the only ordering the screen has', async () => {
    const payload = await getCode('src/report.ts');
    const firstLines = payload.calls.items.map((c: any) => c.relation.lines[0] ?? Infinity);
    const sorted = [...firstLines].sort((a: number, b: number) => a - b);
    expect(firstLines).toEqual(sorted);
  });

  it('gives top-level code an owner, so a statement outside every definition has a port', async () => {
    const payload = await getCode('src/report.ts');
    const topLevel = payload.calls.items.filter((c: any) => c.ownerId === payload.file.id);
    // `render('a', 'b')` at the bottom of the file belongs to no symbol.
    expect(topLevel.map((c: any) => c.relation.node.name)).toContain('render');
  });

  it('counts exactly the arcs the payload can draw', async () => {
    const payload = await getCode('src/report.ts');
    // Recompute the arc list the way the viewer does, from `calls` alone.
    let arcs = 0;
    for (const call of payload.calls.items) {
      if (call.relation.node.file !== payload.file.path) continue;
      for (const line of call.relation.lines) {
        if (line !== call.relation.node.line) arcs++;
      }
    }
    expect(payload.intraFileCalls).toBe(arcs);
    // render x2, summarise x1, top-level render x1 — every call that stays home.
    expect(payload.intraFileCalls).toBeGreaterThanOrEqual(4);
  });

  it('does not count a cross-file call as an arc', async () => {
    const payload = await getCode('src/report.ts');
    const widen = payload.calls.items.find((c: any) => c.relation.node.name === 'widen');
    expect(widen).toBeDefined();
    expect(widen.relation.node.file).toBe('src/widen.ts');
  });

  it('returns references that resolved to nothing, with a line and a plain name', async () => {
    const payload = await getCode('src/report.ts');
    const names = payload.outside.items.map((r: any) => r.name);
    // `console.log` reaches a runtime builtin; the gutter must still show it.
    expect(names).toContain('log');
    for (const ref of payload.outside.items) {
      expect(ref.line).toBeGreaterThan(0);
      expect(ref.name).toMatch(/^[A-Za-z_$][\w$]*$/);
    }
    expect(payload.outside.total).toBe(payload.outside.items.length);
    expect(payload.outside.shown).toBeLessThanOrEqual(MAX_FILE_OUTSIDE_REFS);
  });

  it('answers for a file that reaches nothing without inventing rows', async () => {
    const payload = await getCode('src/quiet.ts');
    expect(payload.calls.total).toBe(0);
    expect(payload.calls.items).toEqual([]);
    expect(payload.intraFileCalls).toBe(0);
    expect(payload.file.totalLines).toBe(1);
  });

  it('every capped list still reports its real total', async () => {
    const payload = await getCode('src/report.ts');
    for (const list of [payload.outline, payload.calls, payload.outside]) {
      expect(list.shown).toBe(list.items.length);
      expect(list.total).toBeGreaterThanOrEqual(list.shown);
      expect(list.truncated).toBe(list.shown < list.total);
    }
    expect(payload.calls.shown).toBeLessThanOrEqual(MAX_FILE_CALL_GROUPS);
  });

  it('refuses a path outside the project before it looks in the index', async () => {
    // The chokepoint answers "outside the project", not "not indexed" — the
    // order is what makes that true by construction. See `resolveRequestedFile`.
    const res = await request('/api/filecode//etc/passwd');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('refused');
  });

  it('answers 404 for a file that is fine but not indexed', async () => {
    const payload = await getCode('src/nope.ts', 404);
    expect(payload.code).toBe('not-found');
    expect(payload.error).toMatch(/not in this CodeGraph index/);
  });

  it('says what the endpoint wants when given no path', async () => {
    const res = await request('/api/filecode');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/\/api\/filecode\/<path>/);
  });

  it('is listed on the API index', async () => {
    const body = JSON.parse((await request('/api')).body);
    expect(body.endpoints.find((e: any) => e.path === '/api/filecode/<path>')).toBeDefined();
    // The shorter route must still resolve to the File view's own endpoint.
    expect(body.endpoints.find((e: any) => e.path === '/api/file/<path>')).toBeDefined();
  });
});

describe('drift', () => {
  it('flags a file that changed on disk and withholds its length', async () => {
    const file = path.join(projectRoot, 'src/widen.ts');
    const original = fs.readFileSync(file, 'utf-8');
    try {
      fs.writeFileSync(file, `// a new first line\n${original}`);
      const payload = await getCode('src/widen.ts');
      expect(payload.drift).toBe(true);
      expect(payload.reason).toMatch(/changed on disk/);
      // The rows are still true about the graph; only the line numbers are not,
      // which is exactly why the view draws the banner instead of the source.
      expect(payload.outline.total).toBeGreaterThan(0);
    } finally {
      fs.writeFileSync(file, original);
    }
  });
});
