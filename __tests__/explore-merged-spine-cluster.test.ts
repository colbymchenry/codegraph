/**
 * An oversize SPINE METHOD is windowed; a cluster that is long only because it
 * merged is not.
 *
 * `buildSection` cuts a god-method on the flow path (n8n's 962-line
 * `processRunExecutionData`) to its signature head plus a window on its
 * next-hop call site. It used to decide that on the CLUSTER's span, and a
 * cluster merges every symbol within `gapThreshold` lines of the next — so a
 * dense file, and every PINNED file (whose whole symbol list enters the
 * gather), became one cluster spanning hundreds of lines around a short spine
 * method, and the window threw away everything else in it. Measured on
 * microsoft/vscode: `rpcProtocol.ts`, pinned by the query "MessageType enum
 * rpcProtocol.ts _receiveOneMessage MessageIO serializeRequest …", merged into
 * one cluster over lines 20–968 around a 77-line `_receiveOneMessage`. The
 * response carried a 5-line file head and ±28 lines of one call site — 2,910
 * chars of a 16,800 reservation, reported unclipped, and not one of the five
 * `MessageIO.serialize*` bodies or the `MessageType` enum the query named. The
 * agent Read the file back five times.
 *
 * The fixtures below are that shape, generated so the sizes that decide it are
 * visible here. Each was checked against the pre-fix build:
 *
 *   protocol (pinned, small tier)   pre-fix: lines 1–37 only, 0 of 5 serializers
 *   workflow (a real god-method)    pre-fix: `executeNode` absent, its call site
 *                                   absent, the file reported unclipped
 *   protocol past the pin cap       render-by-member without the hold-back: the
 *                                   five serializers, one cluster down, absent
 *   protocol, medium tier           without the last-resort trim: the file
 *                                   skipped whole (0 chars)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { ExploreDiagnosticReport } from '../src/mcp/explore-diagnostics';

// ── Fixture generators ───────────────────────────────────────────────────────

/**
 * vscode's `rpcProtocol.ts`, reduced: a `receiveOne` → `dispatchRequest` →
 * `MessageCodec.serializeReply` flow at the top, the `MessageKind` enum, then a
 * named `MessageCodec` whose five serializers are followed by `fields` small
 * members (importance 3 — connected to the named class through `contains`) and
 * optionally `helpers` unrelated methods inside `Protocol` itself.
 */
function protocolSource(fields: number, helpers = 0): string {
  const L: string[] = [
    'export class Protocol {',
    '  private handlers = new Map<string, (x: Uint8Array) => unknown>();',
    '  private outbox: Uint8Array[] = [];',
    '',
    '  receiveOne(raw: Uint8Array): void {',
    '    const kind = raw[0] as MessageKind;',
    '    switch (kind) {',
    '      case MessageKind.Request:',
    '        this.dispatchRequest(raw);',
    '        break;',
    '      case MessageKind.Cancel:',
    '        this.outbox.push(MessageCodec.serializeCancel(raw[1] ?? 0));',
    '        break;',
    '      default:',
    '        this.outbox.push(MessageCodec.serializeAck(raw[1] ?? 0));',
    '    }',
    '  }',
    '',
    '  dispatchRequest(raw: Uint8Array): void {',
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
    '    const elapsed = Date.now() - started;',
    '    if (elapsed > 1000) {',
    '      this.outbox.push(MessageCodec.serializeAck(id));',
    '    }',
    '    if (result === undefined) {',
    '      result = null;',
    '    }',
    '    if (this.outbox.length > 64) {',
    '      this.outbox.splice(0, this.outbox.length - 64);',
    '    }',
    '    this.outbox.push(MessageCodec.serializeReply(id, result));',
    '  }',
  ];
  for (let i = 0; i < helpers; i++) {
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
  for (let i = 0; i < fields; i++) {
    L.push('', `  static encodeField${i}(id: number): Uint8Array {`, `    return Uint8Array.of(${i % 250}, id & 0xff, ${(i * 7) % 250});`, '  }');
  }
  L.push('}');
  return L.join('\n') + '\n';
}

/**
 * A real god-method on the flow: `prepareRun` → `runExecution` (240 lines, its
 * call to `executeNode` in the middle) → `executeNode`, adjacent, so all three
 * merge into one cluster.
 */
function workflowSource(): string {
  const L = ['export class WorkflowRunner {', '  private log: string[] = [];', '', '  prepareRun(input: number[]): number {'];
  for (let i = 0; i < 9; i++) L.push(`    this.log.push('prepare-${i}:' + input.length);`);
  L.push('    return this.runExecution(input, input.length);', '  }', '');
  L.push('  runExecution(input: number[], seed: number): number {', '    let acc = seed;');
  for (let i = 0; i < 117; i++) L.push(`    acc = acc * 3 + ${i};`);
  L.push('    acc = this.executeNode(acc);');
  for (let i = 0; i < 118; i++) L.push(`    acc = acc - ${i};`);
  L.push('    return acc;', '  }', '', '  executeNode(value: number): number {');
  for (let i = 0; i < 7; i++) L.push(`    value = value ^ ${i + 11};`);
  L.push("    this.log.push('node:' + value);", '    return value;', '  }', '');
  for (let i = 0; i < 12; i++) L.push(`  auditTrail${i}(): string {`, `    return this.log.slice(${i}).join(',');`, '  }', '');
  L.push('}');
  return L.join('\n') + '\n';
}

/** Enough one-line files to put a project in the >=500-file (24K) tier. */
function tierPadding(count: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) out[`src/pad/pad${i}.ts`] = `export const pad${i} = ${i};\n`;
  return out;
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface Project { dir: string; cg: CodeGraph }

async function buildProject(files: Record<string, string>): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-merged-spine-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg };
}

function destroyProject(p?: Project): void {
  if (!p) return;
  p.cg.destroy();
  if (fs.existsSync(p.dir)) fs.rmSync(p.dir, { recursive: true, force: true });
}

/** One explore call plus the CG-4 diagnostic for it. */
async function explore(p: Project, query: string) {
  const sidecar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-merged-spine-diag-')), 'r.jsonl');
  const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
  process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
  let text = '';
  try {
    const res = await new ToolHandler(p.cg).execute('codegraph_explore', { query });
    text = res.content?.[0]?.text ?? '';
  } finally {
    if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
    else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
  }
  const lines = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
  fs.rmSync(path.dirname(sidecar), { recursive: true, force: true });
  const report = JSON.parse(lines[lines.length - 1]!) as ExploreDiagnosticReport;
  return { text, report };
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

/** Names whose whole definition in `file` did NOT reach the response. */
function incompleteBodies(p: Project, response: string, file: string, names: string[]): string[] {
  const sent = renderedLines(response, file);
  return names.filter((name) => {
    const node = p.cg.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'import');
    expect(node, `${name} is not indexed in ${file}`).toBeDefined();
    for (let l = node!.startLine; l <= node!.endLine; l++) if (!sent.has(l)) return true;
    return false;
  });
}

const PROTOCOL = 'src/rpc/protocol.ts';
/** The vscode query, transposed: the file by path plus the symbols it asks about. */
const PROTOCOL_QUERY =
  'protocol.ts MessageKind MessageCodec receiveOne serializeRequest serializeReply serializeReplyErr serializeCancel serializeAck';
/** Every body the answer needs: the named symbols plus the flow's own bridge. */
const PROTOCOL_ANSWER = [
  'receiveOne', 'dispatchRequest', 'MessageKind',
  'serializeRequest', 'serializeAck', 'serializeCancel', 'serializeReply', 'serializeReplyErr',
];

// ── The reported shape ──────────────────────────────────────────────────────

describe('a pinned file whose spine cluster is long only because it merged', () => {
  let p: Project;
  let text: string;
  let report: ExploreDiagnosticReport;

  beforeAll(async () => {
    p = await buildProject({ [PROTOCOL]: protocolSource(150) });
    ({ text, report } = await explore(p, PROTOCOL_QUERY));
  }, 120_000);
  afterAll(() => destroyProject(p));

  it('fixture shape: one merged cluster far past the god-method line, around a short spine method', () => {
    const lines = fs.readFileSync(path.join(p.dir, PROTOCOL), 'utf-8').split('\n').length;
    expect(lines).toBeGreaterThan(280); // past the whole-file window, so it clusters
    const spine = p.cg.getNodesInFile(PROTOCOL).find((n) => n.name === 'receiveOne')!;
    expect(spine.endLine - spine.startLine + 1).toBeLessThan(200); // not a god-method
    expect(text).toContain('Flow (call path among the symbols you queried)');
    expect(report.files.find((f) => f.path === PROTOCOL)?.render).toBe('clusters');
  });

  it('returns every body the query named, and the flow bridge between them', () => {
    // Pre-fix: a 5-line file head plus ±28 lines of `receiveOne`'s call site.
    expect(incompleteBodies(p, text, PROTOCOL, PROTOCOL_ANSWER)).toEqual([]);
  });
});

describe('a real god-method on the flow is still windowed — as a member, not as its cluster', () => {
  const FILE = 'src/engine/workflow.ts';
  let p: Project;
  let text: string;
  let report: ExploreDiagnosticReport;

  beforeAll(async () => {
    p = await buildProject({ [FILE]: workflowSource() });
    ({ text, report } = await explore(p, 'prepareRun runExecution executeNode'));
  }, 120_000);
  afterAll(() => destroyProject(p));

  it('renders the named neighbours merged into its cluster in full', () => {
    // Pre-fix: the WHOLE cluster was windowed, around `prepareRun`'s call — so
    // `executeNode`, below the god-method, never appeared.
    expect(incompleteBodies(p, text, FILE, ['prepareRun', 'executeNode'])).toEqual([]);
  });

  it('windows the god-method itself to its signature and its own next-hop call site', () => {
    const god = p.cg.getNodesInFile(FILE).find((n) => n.name === 'runExecution')!;
    expect(god.endLine - god.startLine + 1).toBeGreaterThan(200);
    const sent = renderedLines(text, FILE);
    const source = fs.readFileSync(path.join(p.dir, FILE), 'utf-8').split('\n');
    const callLine = source.findIndex((l) => l.includes('this.executeNode(acc)')) + 1;
    expect(sent.has(god.startLine), 'signature').toBe(true);
    expect(sent.has(callLine), 'the call to executeNode').toBe(true);
    let bodySent = 0;
    for (let l = god.startLine; l <= god.endLine; l++) if (sent.has(l)) bodySent++;
    expect(bodySent).toBeLessThan((god.endLine - god.startLine + 1) / 2);
  });

  it('reports the windowed file as clipped', () => {
    // Pre-fix the window elided ~200 lines and the diagnostic called the
    // section complete, which is how the rpcProtocol render hid.
    expect(report.files.find((f) => f.path === FILE)?.clipped).toBe(true);
  });
});

// ── Two consequences of rendering such a cluster by member ─────────────────

describe('a merged spine cluster leaves room for the file\'s other clusters', () => {
  // Past the 300-node pin cap the gather stops, so the file splits: a spine
  // cluster of `receiveOne` plus 300 unrelated `trackMetric*` methods, and the
  // codec with the named serializers one cluster down. The spine cluster ranks
  // first; shrunk by its own members only, it filled the cap with filler.
  let p: Project;
  let text: string;

  beforeAll(async () => {
    p = await buildProject({ [PROTOCOL]: protocolSource(150, 300) });
    ({ text } = await explore(p, PROTOCOL_QUERY));
  }, 120_000);
  afterAll(() => destroyProject(p));

  it('fixture shape: more symbols than a pinned file contributes to the gather', () => {
    expect(p.cg.getNodesInFile(PROTOCOL).length).toBeGreaterThan(300);
  });

  it('still returns every named body, and the flow bridge', () => {
    expect(incompleteBodies(p, text, PROTOCOL, PROTOCOL_ANSWER)).toEqual([]);
  });
});

describe('a shrunk cluster that still overruns is trimmed to fit, never skipped', () => {
  // At the 24K tier the cap is large enough to keep hundreds of scattered small
  // members, and every gap between them is NAMED in the response (#1711) while
  // every budget upstream charges a bare gap marker. The re-render into the
  // room left still overran, and the file — every named body inside it — was
  // skipped whole.
  let p: Project;
  let text: string;
  let report: ExploreDiagnosticReport;

  beforeAll(async () => {
    p = await buildProject({ [PROTOCOL]: protocolSource(300), ...tierPadding(520) });
    ({ text, report } = await explore(p, PROTOCOL_QUERY));
  }, 120_000);
  afterAll(() => destroyProject(p));

  it('fixture shape: the 24K tier', () => {
    expect(report.budget.maxOutputChars).toBe(24000);
  });

  it('renders the file rather than skipping it', () => {
    const rec = report.files.find((f) => f.path === PROTOCOL);
    expect(rec?.skipped ?? null).toBeNull();
    expect(rec?.emittedChars ?? 0).toBeGreaterThan(0);
  });

  it('keeps every named body through the trim', () => {
    expect(incompleteBodies(p, text, PROTOCOL, PROTOCOL_ANSWER)).toEqual([]);
  });

  it('stays inside the inline cap', () => {
    expect(text.length).toBeLessThanOrEqual(25000);
  });
});
