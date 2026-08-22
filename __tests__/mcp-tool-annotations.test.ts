/**
 * Read-only MCP ToolAnnotations on every codegraph tool (issue #1018).
 *
 * Every codegraph tool is query-only — it reads the pre-built index and never
 * mutates the workspace. Clients gate on this: Cursor's Ask mode refuses any MCP
 * tool that doesn't advertise `readOnlyHint: true`, so without annotations the
 * codegraph tools were blocked there even though they only read.
 *
 * These tests pin that the read-only contract is present on the master tool
 * array AND survives every transform that builds a `tools/list` response — the
 * static proxy surface (`getStaticTools`), the live surface (`getTools`, which
 * rewrites codegraph_explore's description via spread), and the no-default-
 * project surface (`withRequiredProjectPath`, which clones the schema). A drop in
 * any of those would silently re-block the tools in Ask mode.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler, getStaticTools, tools, type ToolDefinition } from '../src/mcp/tools';
import { CodeGraph } from '../src';

const ENV = 'CODEGRAPH_MCP_TOOLS';
const ALL_TOOLS = tools.map((t) => t.name).join(',');

/** Assert a single tool advertises the full read-only contract from #1018. */
function expectReadOnly(tool: ToolDefinition): void {
  expect(tool.annotations, `${tool.name} is missing annotations`).toBeDefined();
  // The hint Cursor Ask mode (and other clients) gate on.
  expect(tool.annotations!.readOnlyHint).toBe(true);
  // The exact triplet the issue asks for, plus the honest closed-world hint.
  expect(tool.annotations!.destructiveHint).toBe(false);
  expect(tool.annotations!.idempotentHint).toBe(true);
  expect(tool.annotations!.openWorldHint).toBe(false);
}

describe('Read-only annotations on the codegraph MCP tools (#1018)', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('every tool in the master array is annotated read-only', () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expectReadOnly(tool);
  });

  it('the static proxy surface carries annotations on every exposed tool', () => {
    // getStaticTools() answers tools/list before any project opens (proxy path).
    process.env[ENV] = ALL_TOOLS;
    const got = getStaticTools();
    expect(got.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const tool of got) expectReadOnly(tool);
  });

  it('the no-default-project surface keeps annotations through the schema clone', () => {
    // withRequiredProjectPath (null cg) clones each tool's inputSchema — the
    // top-level annotations field must ride along on the spread.
    process.env[ENV] = ALL_TOOLS;
    const got = new ToolHandler(null).getTools();
    expect(got.length).toBe(tools.length);
    for (const tool of got) {
      expectReadOnly(tool);
      // Sanity: this IS the clone path (projectPath got marked required).
      expect(tool.inputSchema.required ?? []).toContain('projectPath');
    }
  });
});

describe('Live tool surface keeps annotations with a project open (#1018)', () => {
  let tempDir: string;
  let cg: CodeGraph;
  const original = process.env[ENV];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-annot-'));
    fs.writeFileSync(
      path.join(tempDir, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 0; }\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('getTools() keeps annotations, incl. codegraph_explore whose description is rebuilt', () => {
    process.env[ENV] = ALL_TOOLS;
    const got = new ToolHandler(cg).getTools();
    expect(got.length).toBeGreaterThan(0);
    for (const tool of got) expectReadOnly(tool);

    // explore's description is regenerated with a per-repo budget suffix via
    // object spread; the annotation must survive that rewrite.
    const explore = got.find((t) => t.name === 'codegraph_explore');
    expect(explore).toBeDefined();
    expect(explore!.description).toMatch(/Budget: make at most/);
    expectReadOnly(explore!);
  });
});
