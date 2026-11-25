/**
 * A symbol the query names survives a pinned file's node cap.
 *
 * A file named by path is PINNED: its symbols enter the gather unconditionally,
 * the first `PINNED_FILE_NODE_CAP` (300) of them by start line. Under the cap a
 * dense file merges into one cluster, and the cluster shrinks by member in
 * importance order, so what the query named is kept first. Past the cap the file
 * splits in two: the head (one named method merged with ~300 pinned neighbours)
 * and, one cluster down, the named symbols the cap cut off. Those were gathered
 * and ranked importance 10 — the named-def injection was never the problem —
 * but the head cluster ranked first on density and shrank against its OWN
 * members only, so pin filler spent the file's budget and the named cluster was
 * left under MIN_CHARS and dropped. `protocol.ts receiveOne serializeAck`
 * rendered `serializeAck` at 0 of 3 lines; `receiveOne serializeAck`, without
 * the path, rendered it whole.
 *
 * Fixed by the cross-cluster hold-back of #2062 (a cluster's incidental members
 * wait until lower-ranked clusters' named members are paid), which reaches this
 * shape without knowing about pinning. #2062's own fixture is an unpinned file,
 * so this one guards the pinned entry path: the pin is what floods the head
 * cluster with filler, and a hold-back re-scoped away from it would reopen the
 * bug here and nowhere else.
 *
 * The fixture is that shape, generated so the sizes that decide it are visible
 * here: `receiveOne` → `dispatchRequest` / `MessageCodec.serializeAck` at the
 * top, 300 unrelated `trackMetric*` methods, then the `MessageKind` enum and a
 * `MessageCodec` whose five serializers are followed by 150 `encodeField*`
 * members.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { ExploreDiagnosticReport } from '../src/mcp/explore-diagnostics';

const FILE = 'src/rpc/protocol.ts';
/** `PINNED_FILE_NODE_CAP` in `handleExplore`. */
const PIN_CAP = 300;

function protocolSource(): string {
  const L: string[] = [
    'export class Protocol {',
    '  private handlers = new Map<string, (x: Uint8Array) => unknown>();',
    '  private outbox: Uint8Array[] = [];',
    '',
    '  receiveOne(raw: Uint8Array): void {',
    '    const kind = raw[0] as MessageKind;',
    '    if (kind === MessageKind.Request) {',
    '      this.dispatchRequest(raw);',
    '      this.outbox.push(MessageCodec.serializeAck(raw[1] ?? 0));',
    '    } else if (kind === MessageKind.Cancel) {',
    '      this.outbox.push(MessageCodec.serializeCancel(raw[1] ?? 0));',
    '    }',
    '  }',
    '',
    '  private dispatchRequest(raw: Uint8Array): void {',
    '    const id = raw[1] ?? 0;',
    "    const method = String(raw[2] ?? '');",
    '    const handler = this.handlers.get(method);',
    '    if (!handler) {',
    '      this.outbox.push(MessageCodec.serializeReplyErr(id, new Error(`no handler: ${method}`)));',
    '      return;',
    '    }',
    '    const started = Date.now();',
    '    let result: unknown;',
    '    try {',
    '      result = handler(raw.subarray(3));',
    '    } catch (err) {',
    '      this.outbox.push(MessageCodec.serializeReplyErr(id, err as Error));',
    '      return;',
    '    }',
    '    if (Date.now() - started > 1000) {',
    '      this.outbox.push(MessageCodec.serializeAck(id));',
    '    }',
    '    if (this.outbox.length > 64) {',
    '      this.outbox.splice(0, this.outbox.length - 64);',
    '    }',
    '    this.outbox.push(MessageCodec.serializeReply(id, result ?? null));',
    '  }',
  ];
  for (let i = 0; i < 300; i++) {
    L.push('', `  trackMetric${i}(value: number): number {`, `    return value * ${i + 1} + this.outbox.length;`, '  }');
  }
  L.push(
    '}',
    '',
    'export const enum MessageKind {',
    '  Request = 1,',
    '  Reply = 2,',
    '  ReplyErr = 3,',
    '  Cancel = 4,',
    '  Ack = 5,',
    '}',
    '',
    'export class MessageCodec {',
    '  static serializeRequest(id: number, method: string): Uint8Array {',
    '    const body = new TextEncoder().encode(method);',
    '    const out = new Uint8Array(body.length + 2);',
    '    out[0] = MessageKind.Request;',
    '    out[1] = id & 0xff;',
    '    out.set(body, 2);',
    '    return out;',
    '  }',
    '',
    '  static serializeAck(id: number): Uint8Array {',
    '    return Uint8Array.of(MessageKind.Ack, id & 0xff);',
    '  }',
    '',
    '  static serializeCancel(id: number): Uint8Array {',
    '    return Uint8Array.of(MessageKind.Cancel, id & 0xff);',
    '  }',
    '',
    '  static serializeReply(id: number, value: unknown): Uint8Array {',
    '    const body = new TextEncoder().encode(JSON.stringify(value ?? null));',
    '    const out = new Uint8Array(body.length + 2);',
    '    out[0] = MessageKind.Reply;',
    '    out[1] = id & 0xff;',
    '    out.set(body, 2);',
    '    return out;',
    '  }',
    '',
    '  static serializeReplyErr(id: number, err: Error): Uint8Array {',
    '    const body = new TextEncoder().encode(err.message);',
    '    const out = new Uint8Array(body.length + 2);',
    '    out[0] = MessageKind.ReplyErr;',
    '    out[1] = id & 0xff;',
    '    out.set(body, 2);',
    '    return out;',
    '  }',
  );
  for (let i = 0; i < 150; i++) {
    L.push('', `  static encodeField${i}(id: number): Uint8Array {`, `    return Uint8Array.of(${i % 250}, id & 0xff, ${(i * 7) % 250});`, '  }');
  }
  L.push('}');
  return L.join('\n') + '\n';
}

let dir: string;
let cg: CodeGraph;

/** One explore call plus the CG-4 diagnostic for it. */
async function explore(query: string): Promise<{ text: string; report: ExploreDiagnosticReport }> {
  const sidecar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pin-cap-diag-')), 'r.jsonl');
  const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
  process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
  let text = '';
  try {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
    text = res.content?.[0]?.text ?? '';
  } finally {
    if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
    else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
  }
  const lines = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
  fs.rmSync(path.dirname(sidecar), { recursive: true, force: true });
  return { text, report: JSON.parse(lines[lines.length - 1]!) as ExploreDiagnosticReport };
}

/** Every `<n>\t<text>` line number the response sent for `file`. */
function renderedLines(response: string, file: string): Set<number> {
  const out = new Set<number>();
  let current: string | null = null;
  let inFence = false;
  for (const line of response.split('\n')) {
    const header = !inFence ? line.match(/^\*\*`([^`]+)`\*\*/) : null;
    if (header) { current = header[1]!; continue; }
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    const m = inFence && current === file ? line.match(/^(\d+)\t/) : null;
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/** The pinned file's indexable symbols in the order the pin gathers them. */
function pinOrder() {
  return cg.getNodesInFile(FILE)
    .filter((n) => n.kind !== 'file' && n.kind !== 'import' && n.kind !== 'export')
    .sort((a, b) => a.startLine - b.startLine);
}

/** Names whose whole definition did NOT reach the response. */
function incompleteBodies(response: string, names: string[]): string[] {
  const sent = renderedLines(response, FILE);
  return names.filter((name) => {
    const node = cg.getNodesInFile(FILE).find((n) => n.name === name && n.kind !== 'import');
    expect(node, `${name} is not indexed in ${FILE}`).toBeDefined();
    for (let l = node!.startLine; l <= node!.endLine; l++) if (!sent.has(l)) return true;
    return false;
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pin-cap-'));
  fs.mkdirSync(path.join(dir, path.dirname(FILE)), { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), protocolSource());
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}, 180_000);

afterAll(() => {
  cg?.destroy();
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fixture shape — if this rots, the tests below mean nothing', () => {
  it('holds more symbols than a pinned file contributes to the gather', () => {
    expect(pinOrder().length).toBeGreaterThan(PIN_CAP);
  });

  it('puts the named serializers past the cap and receiveOne inside it', () => {
    const order = pinOrder().map((n) => n.name);
    expect(order.indexOf('receiveOne')).toBeLessThan(PIN_CAP);
    for (const name of ['serializeAck', 'serializeCancel', 'serializeReply']) {
      expect(order.indexOf(name), name).toBeGreaterThanOrEqual(PIN_CAP);
    }
  });

  it('renders the named symbols whole when the file is NOT pinned', async () => {
    // The parity the pinned query is held to below.
    const { text } = await explore('receiveOne serializeAck');
    expect(incompleteBodies(text, ['receiveOne', 'serializeAck'])).toEqual([]);
  });
});

describe('a pinned file past the node cap', () => {
  it('returns a named symbol past the cap, and the named one before it', async () => {
    // Pre-fix: 0 of serializeAck's 3 lines — the head cluster's filler took the budget.
    const { text, report } = await explore('protocol.ts receiveOne serializeAck');
    expect(report.files.find((f) => f.path === FILE)?.pinned).toBe(true);
    expect(incompleteBodies(text, ['receiveOne', 'serializeAck'])).toEqual([]);
  });

  it('returns a lone named symbol past the cap', async () => {
    // No flow at all (one token), so no named-def injection either: the symbol
    // is gathered as a search entry, and the render alone decided its fate.
    const { text } = await explore('protocol.ts serializeAck');
    expect(incompleteBodies(text, ['serializeAck'])).toEqual([]);
  });

  it('keeps the file inside the room it had — the fix redistributes, never raises', async () => {
    // Before the fix the head cluster alone fit inside the reservation (8,700 of
    // 9,100), so paying the named symbols must come out of that room, not on
    // top of it. Letting the file's clusters share the head cluster's CEILING
    // instead was measured at ~3K more filler per pinned response.
    const { report } = await explore('protocol.ts receiveOne serializeAck');
    const rec = report.files.find((f) => f.path === FILE)!;
    expect(rec.render).toBe('clusters');
    expect(rec.emittedChars).toBeLessThanOrEqual(rec.allowance);
  });
});
