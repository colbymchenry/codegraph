/**
 * `GET /api/flow` — the call path behind the Flow strip (CG-50).
 *
 * Against a real indexed fixture over a real loopback server, like the rest of
 * the viewer's API suite. The fixture is shaped to produce the four things this
 * endpoint has to get right and that a synthetic payload cannot prove:
 *
 * - a real five-hop chain of calls, so the hops, their edges, and the line each
 *   card is opened at all come out of the graph rather than out of a fixture
 *   object,
 * - two definitions of the same name, one of them in a test file, so the
 *   directed search's overload handling and the `ambiguous` report can be
 *   checked (this is the shape that broke `main` on the engine's own index —
 *   the right definition sorted seventh),
 * - a symbol nothing reaches, so "no path" is exercised as the ordinary answer
 *   it is rather than as an error,
 * - a Go interface with one implementation, so a SYNTHESIZED hop — the thing
 *   the strip draws dashed and labels with its wiring site — is a real edge
 *   from the resolver rather than a hand-written metadata blob.
 *
 * The pure geometry is tested without a server in `ui-flow-model.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { createGraphApi, startUiServer, type GraphApi, type UiServerHandle } from '../src/ui-server';
import { flowEdgeLabel, parseFlowQuery } from '../src/ui-server/api/flow';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { ToolHandler } from '../src/mcp/tools';
import { continuationsFrom } from '../src/graph/dynamic-boundary-report';
import type { Edge } from '../src/types';

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

async function getFlow(query: string, expected = 200): Promise<any> {
  const res = await request(`/api/flow${query}`);
  expect(res.type).toBe('application/json; charset=utf-8');
  expect(res.status).toBe(expected);
  return JSON.parse(res.body);
}

function write(root: string, rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

/** `name` at each hop, so an assertion reads like the strip does. */
function names(flow: any): string[] {
  return flow.hops.map((h: any) => h.node.name);
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-flow-'));
  projectRoot = path.join(tempDir, 'project');

  // A five-hop chain: bootstrap -> handleRequest -> loadRow -> readRow -> toRow.
  write(
    projectRoot,
    'src/main.ts',
    `import { handleRequest } from './server/handler';

export function bootstrap(): string {
  const banner = 'ready';
  return handleRequest(banner);
}
`
  );
  write(
    projectRoot,
    'src/server/handler.ts',
    `import { loadRow } from '../db/rows';

export function handleRequest(id: string): string {
  const trimmed = id.trim();
  return loadRow(trimmed);
}

/** Nothing on the chain calls this — it is the "no path" endpoint. */
export function orphanHandler(): string {
  return 'nobody calls me';
}
`
  );
  write(
    projectRoot,
    'src/db/rows.ts',
    `export function loadRow(id: string): string {
  return readRow(id);
}

function readRow(id: string): string {
  return toRow(id);
}

function toRow(id: string): string {
  return id.toUpperCase();
}
`
  );
  // Two `describe` definitions, one of them in a test file: the ambiguity the
  // directed search has to walk past rather than truncate away.
  write(
    projectRoot,
    'src/db/describe.ts',
    `import { loadRow } from './rows';

export function describeRow(id: string): string {
  return loadRow(id);
}
`
  );
  write(
    projectRoot,
    '__tests__/rows.test.ts',
    `export function describeRow(id: string): string {
  return id;
}
`
  );

  // A registry whose call target is a string key (CG-51): one site whose key is
  // a literal — so a candidate shortlist is possible — and one whose key is a
  // runtime value, where claiming a candidate would be a guess.
  write(
    projectRoot,
    'src/router/table.ts',
    `type Handler = (payload: string) => string;

const routerTable: Record<string, Handler> = {};

export function register(key: string, fn: Handler): void {
  routerTable[key] = fn;
}

export function routeSave(payload: string): string {
  return routerTable['save'](payload);
}

export function routeAny(name: string, payload: string): string {
  return routerTable[name](payload);
}

export function beginWork(name: string, payload: string): string {
  return routeAny(name, payload);
}
`
  );
  write(
    projectRoot,
    'src/router/handlers.ts',
    `import { register } from './table';

export function onSave(payload: string): string {
  return payload;
}

register('save', onSave);
`
  );

  // A Go interface with one implementation: the resolver synthesizes an
  // interface-impl `calls` edge across it, which is what the strip draws dashed.
  write(
    projectRoot,
    'go/clock.go',
    `package clock

type Clock interface {
	Now() string
}

type SystemClock struct{}

func (SystemClock) Now() string {
	return stamp()
}

func stamp() string {
	return "now"
}

func Tick(c Clock) string {
	return c.Now()
}
`
  );

  const cg = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts', '__tests__/**/*.ts', 'go/**/*.go'], exclude: [] },
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

describe('parseFlowQuery', () => {
  it('reads the three shapes and refuses the empty one', () => {
    expect(parseFlowQuery(new URLSearchParams('from=a&to=b'))).toEqual({
      kind: 'directed',
      from: 'a',
      to: 'b',
    });
    expect(parseFlowQuery(new URLSearchParams('symbols=a,b,c'))).toEqual({
      kind: 'symbols',
      text: 'a,b,c',
    });
    expect(parseFlowQuery(new URLSearchParams('hop=sx&hop=dy&hop=uz'))).toEqual({
      kind: 'trail',
      hops: [
        { id: 'x', dir: 'start' },
        { id: 'y', dir: 'down' },
        { id: 'z', dir: 'up' },
      ],
    });
    expect(() => parseFlowQuery(new URLSearchParams(''))).toThrow(/No flow was asked for/);
  });

  it('refuses a pair that names the same symbol twice', () => {
    expect(() => parseFlowQuery(new URLSearchParams('from=run&to=run'))).toThrow(/same symbol/);
  });

  it('takes a trail over a from/to pair, and refuses a one-hop trail', () => {
    // A hop parameter is only ever sent by "Read as flow", which is a complete
    // question on its own; a stray `from` alongside it must not be searched.
    const parsed = parseFlowQuery(new URLSearchParams('from=a&to=b&hop=sx&hop=dy'));
    expect(parsed.kind).toBe('trail');
    expect(() => parseFlowQuery(new URLSearchParams('hop=sx'))).toThrow(/at least two hops/);
  });
});

describe('flowEdgeLabel', () => {
  const edge = (metadata: Record<string, unknown>, provenance = 'heuristic'): Edge =>
    ({ kind: 'calls', source: 'a', target: 'b', provenance, metadata }) as unknown as Edge;

  it('names the mechanism and the wiring site for a synthesized hop', () => {
    expect(
      flowEdgeLabel(edge({ synthesizedBy: 'callback', registeredAt: 'src/a.ts:12' }), false)
    ).toBe('via callback · registered at src/a.ts:12');
  });

  it('never lets a synthesized hop read as a plain call', () => {
    expect(flowEdgeLabel(edge({ synthesizedBy: 'react-render' }), false)).toBe('via react render');
  });

  it('says "called by" when the reader walked the edge backwards', () => {
    expect(flowEdgeLabel(edge({}, 'resolved'), true)).toBe('called by');
    expect(flowEdgeLabel(edge({}, 'resolved'), false)).toBe('calls');
  });
});

describe('GET /api/flow — a directed question', () => {
  it('returns the whole chain, one hop per card', async () => {
    const payload = await getFlow('?from=bootstrap&to=toRow');
    expect(payload.query).toMatchObject({ kind: 'directed', from: 'bootstrap', to: 'toRow' });
    expect(payload.reason).toBeNull();
    expect(payload.flows).toHaveLength(1);
    expect(names(payload.flows[0])).toEqual([
      'bootstrap',
      'handleRequest',
      'loadRow',
      'readRow',
      'toRow',
    ]);
    expect(payload.flows[0].label).toBe('bootstrap → toRow');
  });

  it('opens each card at the line that calls the next one', async () => {
    const { flows } = await getFlow('?from=bootstrap&to=toRow');
    const hops = flows[0].hops;
    for (let i = 0; i < hops.length - 1; i++) {
      const ref = hops[i].callRef;
      expect(ref, `hop ${i} has a call site`).not.toBeNull();
      expect(ref.name).toBe(hops[i + 1].node.name);
      expect(ref.targetId).toBe(hops[i + 1].node.id);
      expect(ref.backwards).toBe(false);
      // The window is centred on it, and the source really contains it.
      expect(ref.line).toBeGreaterThanOrEqual(hops[i].source.from);
      expect(ref.line).toBeLessThanOrEqual(hops[i].source.to);
      const offset = ref.line - hops[i].source.from;
      expect(hops[i].source.lines[offset]).toContain(hops[i + 1].node.name);
    }
    // The last card has nothing to call, so it opens at its own definition.
    const last = hops[hops.length - 1];
    expect(last.callRef).toBeNull();
    expect(last.source.from).toBeLessThanOrEqual(last.node.line);
    expect(last.source.to).toBeGreaterThanOrEqual(last.node.line);
  });

  it('carries the edge on every hop but the first, with its line', async () => {
    const { flows } = await getFlow('?from=bootstrap&to=toRow');
    const hops = flows[0].hops;
    expect(hops[0].edge).toBeNull();
    for (let i = 1; i < hops.length; i++) {
      expect(hops[i].edge.kind).toBe('calls');
      expect(hops[i].edge.label).toBe('calls');
      expect(hops[i].edge.upward).toBe(false);
      expect(hops[i].edge.synthesized).toBe(false);
      // The edge's line is the previous card's call site — the two agree, and
      // the strip prints both, so a disagreement would be visible.
      expect(hops[i].edge.line).toBe(hops[i - 1].callRef.line);
    }
  });

  it('highlights each card with real source, never a drifted slice', async () => {
    const { flows } = await getFlow('?from=bootstrap&to=toRow');
    for (const hop of flows[0].hops) {
      expect(hop.source.drift).toBe(false);
      expect(hop.source.lines.length).toBeGreaterThan(0);
      expect(hop.source.lines.length).toBe(hop.source.to - hop.source.from + 1);
      // Highlight rides with the slice and is line-for-line with it (CG-43).
      expect(hop.source.highlight.lines).toHaveLength(hop.source.lines.length);
    }
  });

  it('answers "not connected" as an ordinary answer, with a reason', async () => {
    const payload = await getFlow('?from=bootstrap&to=orphanHandler');
    expect(payload.flows).toEqual([]);
    expect(payload.reason).toMatch(/No chain of calls reaches orphanHandler/);
    expect(payload.reason).toMatch(/dynamic dispatch/);
    expect(payload.unresolved).toEqual([]);
  });

  it('says which names matched nothing rather than blaming the path', async () => {
    const payload = await getFlow('?from=bootstrap&to=thisNameIsNotHere');
    expect(payload.unresolved).toEqual(['thisNameIsNotHere']);
    expect(payload.reason).toMatch(/thisNameIsNotHere names nothing/);
  });

  it('walks past an overload in a test file and reports the ambiguity', async () => {
    const payload = await getFlow('?from=describeRow&to=toRow');
    expect(names(payload.flows[0])).toEqual(['describeRow', 'loadRow', 'readRow', 'toRow']);
    const ambiguity = payload.ambiguous.find((a: any) => a.token === 'describeRow');
    expect(ambiguity).toBeDefined();
    expect(ambiguity.chosen.file).toBe('src/db/describe.ts');
    expect(ambiguity.others.map((o: any) => o.file)).toContain('__tests__/rows.test.ts');
  });
});

describe('GET /api/flow — where the graph stops', () => {
  it('caps a keyed dispatch with its form, its key and a candidate target', async () => {
    const payload = await getFlow('?from=routeSave&to=onSave');
    // No static edge crosses `routerTable['save']`, so this is not a path — it
    // is the one card where the looking stopped, plus the cap.
    expect(payload.reason).toMatch(/No chain of calls reaches onSave/);
    const flow = payload.flows[0];
    expect(flow.partial).toBe(true);
    expect(names(flow)).toEqual(['routeSave']);

    const boundary = flow.boundary;
    expect(boundary.node.name).toBe('routeSave');
    const site = boundary.sites[0];
    expect(site.form).toBe('computed-call');
    expect(site.label).toBe('computed member call');
    expect(site.key).toBe('save');
    expect(site.line).toBeGreaterThan(boundary.node.line);
    expect(site.candidates.map((c: any) => c.display)).toContain('onSave');
    // The reader named it, so the cap says so rather than presenting it as new.
    expect(site.candidates.find((c: any) => c.display === 'onSave').named).toBe(true);
    expect(boundary.missed.map((m: any) => m.name)).toContain('onSave');
  });

  it('opens the card at the dispatch line, with real source around it', async () => {
    const payload = await getFlow('?from=routeSave&to=onSave');
    const flow = payload.flows[0];
    const site = flow.boundary.sites[0];
    const source = flow.hops[0].source;
    expect(source.drift).toBe(false);
    expect(source.from).toBeLessThanOrEqual(site.line);
    expect(source.to).toBeGreaterThanOrEqual(site.line);
    expect(source.lines.join('\n')).toContain("routerTable['save']");
  });

  it('claims no candidates when the key is a runtime value', async () => {
    const payload = await getFlow('?from=routeAny&to=onSave');
    const site = payload.flows[0].boundary.sites[0];
    expect(site.form).toBe('computed-call');
    expect(site.key).toBeNull();
    expect(site.candidates).toEqual([]);
    expect(site.candidateNote).toBeNull();
  });

  it('caps a chain that connects but never reaches everything it was asked about', async () => {
    const payload = await getFlow('?symbols=beginWork,routeAny,onSave');
    const flow = payload.flows[0];
    expect(flow.partial).toBe(false);
    expect(names(flow)).toEqual(['beginWork', 'routeAny']);
    // The cap hangs off the dead end, not off the symbol that was named last.
    expect(flow.boundary.node.name).toBe('routeAny');
    expect(flow.boundary.sites[0].form).toBe('computed-call');
    expect(flow.boundary.missed.map((m: any) => m.name)).toEqual(['onSave']);
    // The last card opens at the dispatch line the cap beside it describes.
    const last = flow.hops[flow.hops.length - 1].source;
    const stop = flow.boundary.sites[0].line;
    expect(last.from).toBeLessThanOrEqual(stop);
    expect(last.to).toBeGreaterThanOrEqual(stop);
  });

  it('never caps a flow that reaches what it was asked for', async () => {
    const payload = await getFlow('?from=bootstrap&to=toRow');
    expect(payload.flows[0].boundary).toBeNull();
    expect(payload.flows[0].partial).toBe(false);
  });

  it('stays silent when nothing connects and no dispatch site explains it', async () => {
    // `bootstrap` and `orphanHandler` are both ordinary code. Inventing a
    // stopping point here would be a claim, not a finding.
    const payload = await getFlow('?from=bootstrap&to=orphanHandler');
    expect(payload.flows).toEqual([]);
  });

  it('counts the calls the path did not need and lists them', async () => {
    const payload = await getFlow('?symbols=beginWork,routeAny,onSave');
    const { further, uncertain } = payload.flows[0].boundary;
    // The count and the list are the same fact — the rule every payload keeps.
    expect(further.shown).toBe(further.items.length);
    expect(further.total).toBeGreaterThanOrEqual(further.shown);
    expect(uncertain.shown).toBe(uncertain.items.length);
  });
});

describe('the end cap and codegraph_explore agree', () => {
  it('names the same site, the same key and the same candidate', async () => {
    const payload = await getFlow('?from=routeSave&to=onSave');
    const site = payload.flows[0].boundary.sites[0];

    const cg = CodeGraph.openSync(projectRoot);
    try {
      const res = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'routeSave onSave',
      });
      const text = res.content[0].text as string;
      // Both renderings come from `findDynamicBoundaries`; if they ever drift
      // apart, a reader with the strip and the MCP answer side by side has no
      // way to tell which one is lying.
      expect(text).toContain('**Dynamic boundaries');
      expect(text).toContain(site.label);
      expect(text).toContain(`src/router/table.ts:${site.line}`);
      expect(text).toContain(`candidates for key \`${site.key}\``);
      for (const candidate of site.candidates) expect(text).toContain(candidate.display);
    } finally {
      cg.close();
    }
  });

  it('splits a symbol\'s outgoing calls into the sure and the unfollowed', () => {
    const cg = CodeGraph.openSync(projectRoot);
    try {
      const node = cg.getNodesByName('handleRequest')[0]!;
      const all = continuationsFrom(cg, node);
      expect(all.resolved.map((c) => c.node.name)).toContain('loadRow');
      expect(all.uncertain.every((c) => (c.confidence ?? 1) < 0.6)).toBe(true);
      // Excluding what is already on the path is what keeps the cap from
      // listing the hop the reader just walked as an unexplored exit.
      const target = all.resolved[0]!.node.id;
      const rest = continuationsFrom(cg, node, new Set([target]));
      expect(rest.resolved.map((c) => c.node.id)).not.toContain(target);
    } finally {
      cg.close();
    }
  });
});

describe('GET /api/flow — a synthesized hop', () => {
  it('draws the interface bridge as a dashed hop that names its mechanism', async () => {
    const payload = await getFlow('?from=Tick&to=stamp');
    expect(payload.flows.length).toBeGreaterThan(0);
    const hops = payload.flows[0].hops;
    expect(names(payload.flows[0])[0]).toBe('Tick');
    expect(names(payload.flows[0]).at(-1)).toBe('stamp');
    const synthesized = hops.filter((h: any) => h.edge?.synthesized);
    expect(synthesized.length).toBeGreaterThan(0);
    for (const hop of synthesized) {
      expect(hop.edge.provenance).toBe('heuristic');
      expect(hop.edge.label).toMatch(/^via /);
      expect(hop.edge.label).not.toBe('calls');
    }
  });
});

describe('GET /api/flow — explore parity', () => {
  it('answers a ?symbols= question with the chain the explore search finds', async () => {
    const payload = await getFlow('?symbols=bootstrap,loadRow,toRow');
    expect(payload.query.kind).toBe('symbols');
    expect(payload.flows.length).toBeGreaterThan(0);

    // The endpoint must not have its own path finder. Run the engine's directly
    // and require the same hops, in the same order.
    const cg = CodeGraph.openSync(projectRoot);
    try {
      const flow = resolveNamedSymbolFlow(cg, 'bootstrap,loadRow,toRow');
      expect(flow.chains[0]?.steps.map((s) => s.node.id)).toEqual(
        payload.flows[0].hops.map((h: any) => h.node.id)
      );
    } finally {
      cg.close();
    }
  });
});

describe('GET /api/flow — a trail read as a flow', () => {
  it('draws the hops it was given, finding the edge that already joins them', async () => {
    const forward = await getFlow('?from=bootstrap&to=toRow');
    const ids: string[] = forward.flows[0].hops.map((h: any) => h.node.id);
    const query = ids
      .map((id, i) => `hop=${encodeURIComponent(`${i === 0 ? 's' : 'd'}${id}`)}`)
      .join('&');

    const payload = await getFlow(`?${query}`);
    expect(payload.query.kind).toBe('trail');
    expect(payload.flows[0].hops.map((h: any) => h.node.id)).toEqual(ids);
    expect(payload.flows[0].hops[1].edge.kind).toBe('calls');
    expect(payload.flows[0].hops[1].edge.upward).toBe(false);
  });

  it('reads a trail walked BACKWARDS as caller hops, opened at the calling line', async () => {
    const forward = await getFlow('?from=bootstrap&to=toRow');
    const ids: string[] = forward.flows[0].hops.map((h: any) => h.node.id).reverse();
    const query = ids
      .map((id, i) => `hop=${encodeURIComponent(`${i === 0 ? 's' : 'u'}${id}`)}`)
      .join('&');

    const payload = await getFlow(`?${query}`);
    const hops = payload.flows[0].hops;
    expect(hops.map((h: any) => h.node.id)).toEqual(ids);
    // Every hop after the first is the caller of the one before it, so its own
    // body holds the call — and the card opens there, pointing BACK.
    for (let i = 1; i < hops.length; i++) {
      expect(hops[i].edge.upward).toBe(true);
      expect(hops[i].edge.label).toBe('called by');
      expect(hops[i].callRef.backwards).toBe(true);
      expect(hops[i].callRef.name).toBe(hops[i - 1].node.name);
      expect(hops[i].callRef.line).toBe(hops[i].edge.line);
    }
    // The first card is the callee: nothing in it calls anything on this trail.
    expect(hops[0].callRef).toBeNull();
  });

  it('says so when the ids on a trail are no longer in the index', async () => {
    const payload = await getFlow('?hop=smethod%3Agone&hop=dmethod%3Aalso-gone');
    expect(payload.flows).toEqual([]);
    expect(payload.unresolved).toEqual(['method:gone', 'method:also-gone']);
    expect(payload.reason).toMatch(/still in the index/);
  });
});

describe('GET /api/flow — refusals', () => {
  it('answers JSON, not text, when the question is malformed', async () => {
    const payload = await getFlow('', 400);
    expect(payload.code).toBe('bad-request');
    expect(payload.error).toMatch(/No flow was asked for/);
    expect(payload.hint).toMatch(/\?from=/);
  });

  it('caps the number of trail hops it will read', async () => {
    const query = Array.from({ length: 40 }, (_, i) => `hop=s${i}xx`).join('&');
    const payload = await getFlow(`?${query}`, 400);
    expect(payload.code).toBe('bad-request');
    expect(payload.error).toMatch(/longer than this endpoint reads/);
  });

  it('is listed on the API index', async () => {
    const res = await request('/api');
    const body = JSON.parse(res.body);
    const entry = body.endpoints.find((e: any) => e.path === '/api/flow');
    expect(entry).toBeDefined();
    expect(entry.params).toContain('from');
    expect(entry.params).toContain('hop');
  });
});
