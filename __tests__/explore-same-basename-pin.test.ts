/**
 * A bare basename two directories share pins only the file defining what the
 * query names.
 *
 * vscode has two `editorOptions.ts`: the editor's option registry (which holds
 * `clampedInt`, `cursorStyleToString`, `cursorStyleFromString`) and a small
 * workbench helper holding none of them. `editorOptions.ts clampedInt
 * cursorStyleToString cursorStyleFromString` pinned BOTH, and the two pins split
 * the pinned reservation — 8,626 chars each, against 15,181 for the named file
 * when the same query left the path out. So writing the file's name made the
 * answer worse: the named file got half the room, and the unrelated one spent
 * the rest.
 *
 * Path extraction now asks which of a span's matches define a symbol the query
 * names, and pins those; the rest are set aside and named in the summary line.
 * When no match defines one, or every match does, the symbols pick nothing out
 * and every match pins as before.
 *
 * The fixture is that shape, generated so the sizes that decide it are visible
 * here: the registry is ~60 option classes with the three named functions in
 * the middle, the helper is a handful of unrelated functions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { ExploreDiagnosticReport } from '../src/mcp/explore-diagnostics';

const REGISTRY = 'src/editor/common/config/editorOptions.ts';
const HELPER = 'src/workbench/common/editor/editorOptions.ts';
const NAMED = ['clampedInt', 'cursorStyleToString', 'cursorStyleFromString'];

function registrySource(): string {
  const L: string[] = [
    'export interface IConfigurationPropertySchema {',
    '  type?: string;',
    '  default?: unknown;',
    '  minimum?: number;',
    '  maximum?: number;',
    '}',
    '',
    'export abstract class BaseEditorOption<K extends number, V> {',
    '  constructor(public readonly id: K, public readonly name: string, public readonly defaultValue: V) {}',
    '  public abstract validate(input: unknown): V;',
    '}',
  ];
  const optionClass = (i: number) => {
    L.push(
      '',
      `export class EditorOption${i} extends BaseEditorOption<number, string> {`,
      `  private readonly allowed${i} = ['alpha${i}', 'beta${i}', 'gamma${i}'];`,
      '',
      `  constructor() {`,
      `    super(${i}, 'option${i}', 'alpha${i}');`,
      '  }',
      '',
      '  public validate(input: unknown): string {',
      "    if (typeof input !== 'string') {",
      '      return this.defaultValue;',
      '    }',
      `    return this.allowed${i}.includes(input) ? input : this.defaultValue;`,
      '  }',
      '}',
    );
  };
  for (let i = 0; i < 30; i++) optionClass(i);
  L.push(
    '',
    'export function clampedInt<T>(value: unknown, defaultValue: T, minimum: number, maximum: number): number | T {',
    "  if (typeof value === 'undefined') {",
    '    return defaultValue;',
    '  }',
    '  let r = parseInt(String(value), 10);',
    '  if (isNaN(r)) {',
    '    return defaultValue;',
    '  }',
    '  r = Math.max(minimum, r);',
    '  r = Math.min(maximum, r);',
    '  return r | 0;',
    '}',
    '',
    'export class EditorIntOption<K extends number> extends BaseEditorOption<K, number> {',
    '  public static clampedInt<T>(value: unknown, defaultValue: T, minimum: number, maximum: number): number | T {',
    '    return clampedInt(value, defaultValue, minimum, maximum);',
    '  }',
    '',
    '  constructor(id: K, name: string, defaultValue: number, public readonly minimum: number, public readonly maximum: number, schema?: IConfigurationPropertySchema) {',
    "    if (typeof schema !== 'undefined') {",
    "      schema.type = 'integer';",
    '      schema.default = defaultValue;',
    '      schema.minimum = minimum;',
    '      schema.maximum = maximum;',
    '    }',
    '    super(id, name, defaultValue);',
    '  }',
    '',
    '  public validate(input: unknown): number {',
    '    return EditorIntOption.clampedInt(input, this.defaultValue, this.minimum, this.maximum);',
    '  }',
    '}',
    '',
    'export const enum TextEditorCursorStyle {',
    '  Line = 1,',
    '  Block = 2,',
    '  Underline = 3,',
    '  LineThin = 4,',
    '  BlockOutline = 5,',
    '  UnderlineThin = 6,',
    '}',
    '',
    'export function cursorStyleToString(cursorStyle: TextEditorCursorStyle): string {',
    '  switch (cursorStyle) {',
    "    case TextEditorCursorStyle.Line: return 'line';",
    "    case TextEditorCursorStyle.Block: return 'block';",
    "    case TextEditorCursorStyle.Underline: return 'underline';",
    "    case TextEditorCursorStyle.LineThin: return 'line-thin';",
    "    case TextEditorCursorStyle.BlockOutline: return 'block-outline';",
    "    case TextEditorCursorStyle.UnderlineThin: return 'underline-thin';",
    '  }',
    '}',
    '',
    'export function cursorStyleFromString(cursorStyle: string): TextEditorCursorStyle {',
    '  switch (cursorStyle) {',
    "    case 'line': return TextEditorCursorStyle.Line;",
    "    case 'block': return TextEditorCursorStyle.Block;",
    "    case 'underline': return TextEditorCursorStyle.Underline;",
    "    case 'line-thin': return TextEditorCursorStyle.LineThin;",
    "    case 'block-outline': return TextEditorCursorStyle.BlockOutline;",
    "    case 'underline-thin': return TextEditorCursorStyle.UnderlineThin;",
    '  }',
    '  return TextEditorCursorStyle.Line;',
    '}',
  );
  for (let i = 30; i < 60; i++) optionClass(i);
  return L.join('\n') + '\n';
}

function helperSource(): string {
  const L: string[] = [
    'export interface ITextEditorViewState { scrollTop: number; cursor: number }',
    '',
    'export function applyTextEditorOptions(options: { selection?: number; viewState?: ITextEditorViewState }, editor: { reveal(line: number): void; restore(s: ITextEditorViewState): void }): boolean {',
    '  if (options.viewState) {',
    '    editor.restore(massageEditorViewState(options.viewState));',
    '    return true;',
    '  }',
    '  if (typeof options.selection === "number") {',
    '    editor.reveal(options.selection);',
    '    return true;',
    '  }',
    '  return false;',
    '}',
    '',
    'function massageEditorViewState(state: ITextEditorViewState): ITextEditorViewState {',
    '  return { scrollTop: Math.max(0, state.scrollTop), cursor: Math.max(0, state.cursor) };',
    '}',
  ];
  for (let i = 0; i < 12; i++) {
    L.push(
      '',
      `export function restoreEditorGroup${i}(state: ITextEditorViewState): number {`,
      `  const offset = state.scrollTop * ${i + 2} + state.cursor;`,
      `  return offset > ${100 * (i + 1)} ? offset - ${i} : offset + ${i};`,
      '}',
    );
  }
  return L.join('\n') + '\n';
}

let dir: string;
let cg: CodeGraph;

/** One explore call plus the CG-4 diagnostic for it. */
async function explore(query: string): Promise<{ text: string; report: ExploreDiagnosticReport }> {
  const sidecar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-same-basename-diag-')), 'r.jsonl');
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

const fileRecord = (report: ExploreDiagnosticReport, file: string) =>
  report.files.find((f) => f.path === file);

/** The response renders a source section for `file`. */
const hasSection = (response: string, file: string): boolean =>
  response.includes('**`' + file + '`');

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

/** How many of the registry's named definitions the response sent whole. */
function completeNamedBodies(response: string): number {
  const sent = renderedLines(response, REGISTRY);
  return cg.getNodesInFile(REGISTRY)
    .filter((n) => NAMED.includes(n.name) && n.kind !== 'import')
    .filter((n) => {
      for (let l = n.startLine; l <= n.endLine; l++) if (!sent.has(l)) return false;
      return true;
    }).length;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-same-basename-'));
  for (const [file, source] of [[REGISTRY, registrySource()], [HELPER, helperSource()]] as const) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}, 180_000);

afterAll(() => {
  cg?.destroy();
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fixture shape — if this rots, the gates below mean nothing', () => {
  it('the named symbols live in the registry and nowhere in the helper', () => {
    const registry = cg.getNodesInFile(REGISTRY).map((n) => n.name);
    const helper = cg.getNodesInFile(HELPER).map((n) => n.name);
    for (const name of NAMED) {
      expect(registry).toContain(name);
      expect(helper).not.toContain(name);
    }
    // Two `clampedInt`s — the function and the static method — so four bodies.
    expect(cg.getNodesInFile(REGISTRY).filter((n) => NAMED.includes(n.name))).toHaveLength(4);
  });
});

describe('a basename two directories share', () => {
  it('pins only the file defining the named symbols, and names the one it set aside', async () => {
    const { text, report } = await explore(`editorOptions.ts ${NAMED.join(' ')}`);
    expect(fileRecord(report, REGISTRY)?.pinned).toBe(true);
    expect(fileRecord(report, HELPER)?.pinned ?? false).toBe(false);
    expect(hasSection(text, HELPER)).toBe(false);
    expect(text).toContain('1 file pinned from the query.');
    expect(text).toContain(`Not pinned: \`${HELPER}\`, which defines none of the named symbols.`);
  });

  it('gives the named file the room it gets when the query leaves the path out', async () => {
    const pinned = await explore(`editorOptions.ts ${NAMED.join(' ')}`);
    const unpinned = await explore(NAMED.join(' '));
    const pinnedAllowance = fileRecord(pinned.report, REGISTRY)?.allowance ?? 0;
    const unpinnedAllowance = fileRecord(unpinned.report, REGISTRY)?.allowance ?? 0;
    expect(unpinnedAllowance).toBeGreaterThan(0);
    // Pre-fix the two pins split the reservation: half the room, or less.
    expect(pinnedAllowance).toBeGreaterThanOrEqual(unpinnedAllowance);
    expect(completeNamedBodies(pinned.text)).toBeGreaterThanOrEqual(completeNamedBodies(unpinned.text));
    expect(completeNamedBodies(pinned.text)).toBe(4);
  });

  it('pins both when the query names no symbol to choose between them', async () => {
    const { text, report } = await explore('editorOptions.ts');
    expect(fileRecord(report, REGISTRY)?.pinned).toBe(true);
    expect(fileRecord(report, HELPER)?.pinned).toBe(true);
    expect(text).toContain('2 files pinned from the query.');
    expect(text).not.toContain('Not pinned:');
  });

  it('a path with its directory pins that file alone, with no set-aside note', async () => {
    const { text, report } = await explore(`${HELPER} ${NAMED.join(' ')}`);
    expect(fileRecord(report, HELPER)?.pinned).toBe(true);
    expect(fileRecord(report, REGISTRY)?.pinned ?? false).toBe(false);
    expect(text).not.toContain('Not pinned:');
  });
});
