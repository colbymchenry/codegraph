/**
 * The viewer's live channel and its drift parity (CG-53).
 *
 * Two things are proved here that a unit test could not:
 *
 * - `GET /api/events` is a real SSE stream over the real loopback server, and
 *   it says something the moment a source file changes and again when the index
 *   moves underneath it. Both watchers are edge-triggered, so a test that
 *   passed by polling would be testing the wrong thing entirely.
 * - `/api/source?ondrift=current` serves a drifted file's CURRENT bytes rather
 *   than nothing, flagged `showing: 'current'` — the parity with
 *   `codegraph_node`'s behaviour on a file that changed after its last sync.
 *
 * Every test that rewrites a fixture file restores it, because the fixture is
 * indexed once for the whole suite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { HEARTBEAT_MS, MAX_EVENT_FILES } from '../src/ui-server/api/events';

let server: UiServerHandle;
let api: GraphApi;
let tempDir: string;
let projectRoot: string;

const ORIGINAL = `export function greet(name: string): string {
  return 'hello ' + name;
}

export function shout(name: string): string {
  return greet(name).toUpperCase();
}
`;

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

interface SseEvent {
  event: string;
  data: any;
}

/**
 * One open SSE connection, with the frames it has received so far.
 *
 * The parser is the whole SSE grammar this server uses: `retry:`, `event:`,
 * `data:` and a blank line. Comment frames (`: ping`) are counted separately —
 * they are the heartbeat, and a client must never see them as events.
 */
class Stream {
  readonly events: SseEvent[] = [];
  comments = 0;
  status = 0;
  contentType: string | undefined;
  private buffer = '';
  private req: http.ClientRequest | null = null;
  private res: http.IncomingMessage | null = null;

  open(requestPath = '/api/events'): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: requestPath,
          method: 'GET',
          headers: { Host: `127.0.0.1:${server.port}`, Accept: 'text/event-stream' },
          setHost: false,
        },
        (res) => {
          this.res = res;
          this.status = res.statusCode ?? 0;
          this.contentType = res.headers['content-type'];
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => this.ingest(chunk));
          resolve();
        }
      );
      this.req = req;
      req.on('error', reject);
      req.end();
    });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let split = this.buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      this.parse(frame);
      split = this.buffer.indexOf('\n\n');
    }
    // A heartbeat is its own frame and ends the same way, but node may deliver
    // it alone; the loop above already handled it.
  }

  private parse(frame: string): void {
    let name = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) {
        this.comments += 1;
        continue;
      }
      if (line.startsWith('event: ')) name = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data === '') return;
    try {
      this.events.push({ event: name, data: JSON.parse(data) });
    } catch {
      this.events.push({ event: name, data });
    }
  }

  /** Wait for an event of `type`, or give up. Never polls the server. */
  async waitFor(type: string, timeoutMs = 12_000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find((e) => e.event === type);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `No "${type}" event within ${timeoutMs}ms. Saw: ${this.events.map((e) => e.event).join(', ') || '(nothing)'}`
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    this.res?.destroy();
    this.req?.destroy();
  }
}

function fixture(rel: string): string {
  return path.join(projectRoot, rel);
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-events-'));
  projectRoot = path.join(tempDir, 'project');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(fixture('src/greet.ts'), ORIGINAL);
  fs.writeFileSync(
    fixture('src/other.ts'),
    `import { greet } from './greet';\n\nexport const hi = greet('there');\n`
  );

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

describe('GET /api/events', () => {
  it('is listed by the API index', async () => {
    const index = JSON.parse((await request('/api')).body);
    const paths = index.endpoints.map((e: any) => e.path);
    expect(paths).toContain('/api/events');
  });

  it('answers as an event stream and opens with the index revision', async () => {
    const stream = new Stream();
    await stream.open();
    try {
      const hello = await stream.waitFor('hello');
      expect(stream.status).toBe(200);
      expect(stream.contentType).toBe('text/event-stream; charset=utf-8');
      expect(hello.data.type).toBe('hello');
      // The revision the client is synchronised against — the same numbers
      // /api/stats reports.
      expect(hello.data.index.files).toBe(2);
      expect(typeof hello.data.index.lastIndexedAt).toBe('number');
      expect(hello.data.heartbeatMs).toBe(HEARTBEAT_MS);
      // Whether each observer came up is stated, never implied.
      expect(typeof hello.data.watching.source).toBe('boolean');
      expect(typeof hello.data.watching.index).toBe('boolean');
      expect(hello.data.degraded).toBeNull();
    } finally {
      stream.close();
    }
  });

  it('never sends a heartbeat as an event', async () => {
    const stream = new Stream();
    await stream.open();
    try {
      await stream.waitFor('hello');
      // The heartbeat is a comment frame; if it ever became an event, every
      // client would refetch every 25 seconds forever.
      expect(stream.events.every((e) => e.event !== 'ping' && e.event !== 'message')).toBe(true);
    } finally {
      stream.close();
    }
  });

  it('answers HEAD with the stream headers and no body', async () => {
    const res = await new Promise<{ status: number; type?: string; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/api/events',
          method: 'HEAD',
          headers: { Host: `127.0.0.1:${server.port}` },
          setHost: false,
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () =>
            resolve({
              status: r.statusCode ?? 0,
              type: r.headers['content-type'],
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/event-stream; charset=utf-8');
    expect(res.body).toBe('');
  });

  it('announces a source file that changed on disk, before any sync', async () => {
    const stream = new Stream();
    await stream.open();
    try {
      await stream.waitFor('hello');
      // Give the watcher a moment to install its watch before the write; an
      // event that predates the watch is not a bug, just an untestable one.
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(fixture('src/greet.ts'), `${ORIGINAL}\nexport const EXTRA = 1;\n`);

      const changed = await stream.waitFor('changed');
      expect(changed.data.type).toBe('changed');
      expect(changed.data.scan === true || changed.data.files.includes('src/greet.ts')).toBe(true);
      // A count always equals a list, or says it was cut.
      expect(changed.data.total).toBeGreaterThanOrEqual(changed.data.files.length);
      expect(changed.data.files.length).toBeLessThanOrEqual(MAX_EVENT_FILES);

      // ...and the index has NOT moved: this server watches, it never syncs.
      const source = JSON.parse((await request('/api/source?file=src/greet.ts')).body);
      expect(source.drift).toBe(true);
    } finally {
      fs.writeFileSync(fixture('src/greet.ts'), ORIGINAL);
      stream.close();
    }
  });

  it('announces the index moving, and names what the sync picked up', async () => {
    const stream = new Stream();
    await stream.open();
    try {
      await stream.waitFor('hello');
      await new Promise((r) => setTimeout(r, 300));

      // Another process re-indexes — exactly what a daemon's watcher or a
      // `codegraph sync` does while the viewer is open.
      fs.writeFileSync(fixture('src/greet.ts'), `${ORIGINAL}\nexport const SYNCED = 2;\n`);
      const writer = CodeGraph.openSync(projectRoot);
      await writer.sync();
      writer.close();

      const moved = await stream.waitFor('index');
      expect(moved.data.type).toBe('index');
      expect(moved.data.index.files).toBe(2);
      expect(moved.data.files).toContain('src/greet.ts');
      expect(moved.data.total).toBeGreaterThanOrEqual(moved.data.files.length);

      // And the graph really did move: the new symbol is there.
      const search = JSON.parse((await request('/api/search?q=SYNCED')).body);
      expect(search.results.items.some((r: any) => r.name === 'SYNCED')).toBe(true);
    } finally {
      fs.writeFileSync(fixture('src/greet.ts'), ORIGINAL);
      const writer = CodeGraph.openSync(projectRoot);
      await writer.sync();
      writer.close();
      stream.close();
    }
  }, 60_000);

  it('stops serving a symbol a sync in another process deleted', async () => {
    // A node's id contains its start line, so pushing two lines in above
    // `shout` gives it a different id. The old one must go — the query layer
    // keeps an LRU of nodes by id that only its OWN writes invalidate, so
    // without `GraphSession` dropping it this endpoint would keep answering
    // 200 with a row that is no longer in the database, while `/api/search`
    // beside it correctly says the symbol moved.
    const before = JSON.parse((await request('/api/search?q=shout')).body);
    const oldId = before.results.items[0].id as string;
    expect((await request(`/api/node/${encodeURIComponent(oldId)}`)).status).toBe(200);

    fs.writeFileSync(fixture('src/greet.ts'), `// one
// two
${ORIGINAL}`);
    const writer = CodeGraph.openSync(projectRoot);
    await writer.sync();
    writer.close();

    try {
      expect((await request(`/api/node/${encodeURIComponent(oldId)}`)).status).toBe(404);
      const after = JSON.parse((await request('/api/search?q=shout')).body);
      const newId = after.results.items[0].id as string;
      expect(newId).not.toBe(oldId);
      const moved = JSON.parse((await request(`/api/node/${encodeURIComponent(newId)}`)).body);
      expect(moved.node.line).toBe(7);
      // ...and its rails came back with it, rather than an empty shell — the
      // exact symptom of a cached row whose edges were re-keyed around it.
      expect(moved.counts.callees).toBeGreaterThan(0);
    } finally {
      fs.writeFileSync(fixture('src/greet.ts'), ORIGINAL);
      const restore = CodeGraph.openSync(projectRoot);
      await restore.sync();
      restore.close();
    }
  }, 60_000);

  it('closes every stream when the API is closed', async () => {
    const own = createGraphApi({ projectRoot });
    const handle = await startUiServer({
      projectRoot,
      viewerDir: path.join(tempDir, 'viewer'),
      port: 0,
      api: own.handler,
    });
    const ended = new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/api/events',
          method: 'GET',
          headers: { Host: `127.0.0.1:${handle.port}` },
          setHost: false,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        }
      );
      req.on('error', reject);
      req.end();
    });
    // Let the subscription land before pulling the rug.
    await new Promise((r) => setTimeout(r, 200));
    own.close();
    await ended;
    await handle.close();
  });
});

describe('GET /api/source?ondrift=', () => {
  it('omits the slice by default when the file drifted', async () => {
    fs.writeFileSync(fixture('src/greet.ts'), `// a new first line\n${ORIGINAL}`);
    try {
      const body = JSON.parse((await request('/api/source?file=src/greet.ts&from=1&to=3')).body);
      expect(body.drift).toBe(true);
      expect(body.showing).toBe('none');
      expect(body.lines).toBeUndefined();
      expect(body.highlight).toBeUndefined();
      expect(body.reason).toMatch(/changed on disk/);
    } finally {
      fs.writeFileSync(fixture('src/greet.ts'), ORIGINAL);
    }
  });

  it('serves the CURRENT bytes when asked, flagged as current', async () => {
    const rewritten = `// a new first line\n${ORIGINAL}`;
    fs.writeFileSync(fixture('src/greet.ts'), rewritten);
    try {
      const body = JSON.parse(
        (await request('/api/source?file=src/greet.ts&from=1&ondrift=current')).body
      );
      expect(body.drift).toBe(true);
      expect(body.showing).toBe('current');
      // The bytes on disk right now, not the ones that were indexed.
      expect(body.lines[0]).toBe('// a new first line');
      expect(body.totalLines).toBe(rewritten.replace(/\n$/, '').split('\n').length);
      // Highlighting rides with them, or the code block paints plain text and
      // then reflows.
      expect(body.highlight).toBeTruthy();
      expect(body.highlight.lines.length).toBe(body.lines.length);
      expect(body.reason).toMatch(/current lines/);
    } finally {
      fs.writeFileSync(fixture('src/greet.ts'), ORIGINAL);
    }
  });

  it('says showing: indexed when there is no drift, with or without the flag', async () => {
    const plain = JSON.parse((await request('/api/source?file=src/greet.ts&from=1&to=2')).body);
    expect(plain.drift).toBe(false);
    expect(plain.showing).toBe('indexed');
    const asked = JSON.parse(
      (await request('/api/source?file=src/greet.ts&from=1&to=2&ondrift=current')).body
    );
    expect(asked.showing).toBe('indexed');
    expect(asked.lines).toEqual(plain.lines);
  });

  it('rejects an ondrift value it does not implement', async () => {
    const res = await request('/api/source?file=src/greet.ts&ondrift=guess');
    expect(res.status).toBe(400);
    expect(res.type).toBe('application/json; charset=utf-8');
    expect(JSON.parse(res.body).code).toBe('bad-request');
  });

  it('answers an empty slice rather than a 400 when a drifted file shrank', async () => {
    fs.writeFileSync(fixture('src/greet.ts'), 'export const only = 1;\n');
    try {
      const res = await request('/api/source?file=src/greet.ts&from=5&to=9&ondrift=current');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.showing).toBe('current');
      expect(body.lines).toEqual([]);
      expect(body.totalLines).toBe(1);
    } finally {
      fs.writeFileSync(fixture('src/greet.ts'), ORIGINAL);
    }
  });

  it('still refuses a path outside the project, ondrift or not', async () => {
    const res = await request('/api/source?file=/etc/passwd&ondrift=current');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('refused');
  });
});
