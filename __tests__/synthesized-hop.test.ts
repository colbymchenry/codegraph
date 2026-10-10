/**
 * One wording for a synthesized (dynamic-dispatch) hop, on both surfaces that
 * print one: codegraph_explore's Flow and the codegraph_node trail
 * (`dynamic: …`), and ContextBuilder's "## Call paths" (`→[…]`, what
 * `buildContext` and `codegraph context` print). The call paths used to keep
 * their own list, and every synthesizer missing from it — interface dispatch,
 * a C++ override, a redux thunk — read as an "event".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { describeSynthesizedHop } from '../src/graph/synthesized-hop';
import type { Edge } from '../src/types';

describe('an interface-impl hop on both surfaces', () => {
  const query = 'runExport exportReport renderPdf';
  let dir: string;
  let cg: CodeGraph;
  // Assertions read RAW codegraph_explore output; managed offload would replace it.
  let prevOffloadDisable: string | undefined;

  beforeAll(async () => {
    prevOffloadDisable = process.env.CODEGRAPH_OFFLOAD_DISABLE;
    process.env.CODEGRAPH_OFFLOAD_DISABLE = '1';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synth-hop-'));
    // One file each: ContextBuilder keeps only a few nodes per file, and with
    // everything in one file the interface method is the node it drops.
    const files: Record<string, string> = {
      'src/exporter.ts': `export interface Exporter {
  exportReport(data: string): string;
}
`,
      'src/pdf-exporter.ts': `import type { Exporter } from './exporter';
import { renderPdf } from './render';

export class PdfExporter implements Exporter {
  exportReport(data: string): string {
    return renderPdf(data);
  }
}
`,
      'src/render.ts': `export function renderPdf(data: string): string {
  return '%PDF ' + data;
}
`,
      'src/run.ts': `import type { Exporter } from './exporter';

export function runExport(exporter: Exporter): string {
  return exporter.exportReport('q3');
}
`,
    };
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (prevOffloadDisable === undefined) delete process.env.CODEGRAPH_OFFLOAD_DISABLE;
    else process.env.CODEGRAPH_OFFLOAD_DISABLE = prevOffloadDisable;
  });

  it('ContextBuilder call paths label it interface dispatch, not "event"', async () => {
    // Precondition: the hop is a real synthesized edge, not a static call.
    const [iface] = cg.getNodesByName('exportReport').filter((n) => n.qualifiedName === 'Exporter::exportReport');
    expect(cg.getOutgoingEdges(iface!.id).map((e) => e.metadata?.synthesizedBy)).toContain('interface-impl');

    const md = String(await cg.buildContext(query, { format: 'markdown' }));
    expect(md).toContain('## Call paths');
    const callPaths = md.slice(md.indexOf('## Call paths'));
    expect(callPaths).toContain(
      '- runExport → exportReport →[interface → impl @src/pdf-exporter.ts:5] exportReport → renderPdf'
    );
    expect(callPaths).not.toContain('→[event');
  });

  it('codegraph_explore tags the same hop with the same words', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
    expect(res.content?.[0]?.text).toContain('↓ dynamic: interface → impl @src/pdf-exporter.ts:5');
  });
});

describe('describeSynthesizedHop', () => {
  const at = 'src/wire.ts:7';
  const edge = (metadata: Record<string, unknown>): Edge =>
    ({ source: 'a', target: 'b', kind: 'calls', provenance: 'heuristic', metadata: { registeredAt: at, ...metadata } });

  it.each([
    // Synthesizers the call paths used to call an "event".
    [{ synthesizedBy: 'interface-impl', via: 'handle' }, 'interface → impl', ''],
    [{ synthesizedBy: 'interface-impl', via: 'Report', promotedInto: 'scrapeLoop' }, 'interface → method promoted into scrapeLoop', ''],
    [{ synthesizedBy: 'closure-collection', field: 'validators' }, 'runs `validators` handlers', ''],
    [{ synthesizedBy: 'cpp-override', via: 'Run' }, 'cpp override', ''],
    [{ synthesizedBy: 'redux-thunk', via: 'fetchUser' }, 'redux thunk', ''],
    [{ synthesizedBy: 'gin-middleware-chain', via: 'Auth' }, 'gin middleware chain', ''],
    [{ synthesizedBy: 'event-bus', channel: 'event', event: 'user.created' }, 'bus event `user.created`', ''],
    // The detail only the call paths print.
    [{ synthesizedBy: 'queue-job', event: 'send-email', queue: 'emails' }, 'queue job `send-email`', ' on `emails`'],
    [{ synthesizedBy: 'event-bus', channel: 'socket', event: 'chat', tier: 'client→server' }, 'socket message `chat`', ' → server'],
    [{ synthesizedBy: 'http-client', method: 'POST', href: '/api/users' }, 'HTTP POST /api/users', " — the client's call onto its own route"],
  ])('%o reads "%s"', (metadata, summary, detail) => {
    expect(describeSynthesizedHop(edge(metadata))).toEqual({ summary, detail, registeredAt: at });
  });

  it('is null for a static edge and for a heuristic edge no synthesizer made', () => {
    expect(describeSynthesizedHop({ source: 'a', target: 'b', kind: 'calls', provenance: 'tree-sitter' })).toBeNull();
    expect(describeSynthesizedHop({ ...edge({ synthesizedBy: 'callback', via: 'on' }), provenance: undefined })).toBeNull();
    expect(describeSynthesizedHop(edge({ confidence: 0.5 }))).toBeNull();
    expect(describeSynthesizedHop(null)).toBeNull();
  });
});
