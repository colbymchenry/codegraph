/**
 * Regression: codegraph_explore must SURFACE a synthesized edge whose endpoints are
 * `constant` nodes (RTK thunk→thunk), on a SMALL repo.
 *
 * `buildFlowFromNamedSymbols` historically filtered its "named" set to CALLABLE kinds
 * (method/function/component/constructor), excluding `constant`. RTK thunks are
 * `export const X = createAsyncThunk(...)`, so a thunk→thunk hop is constant→constant —
 * it never entered the flow scan and surfaced nowhere on the Flow path. The kind-agnostic
 * "### Relationships" section would have caught it, but that is disabled below 500 files.
 * Net: on a small RTK app the synthesized edge existed in the graph yet was invisible to
 * the agent. The fix feeds a `dynNamed` set (named non-callable endpoints that participate
 * in a heuristic edge) to the tier-independent "**Dynamic-dispatch links**" scan. This test
 * pins it on a deliberately tiny (<150-file) fixture so the Relationships gate is OFF and
 * the dynamic-dispatch-links path is the ONLY thing that can surface the hop.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

// Assertions read RAW codegraph_explore output; managed offload would replace it. Disable
// it for this file so the suite is hermetic regardless of dev-machine config, then restore.
let _prevOffloadDisable: string | undefined;
beforeAll(() => { _prevOffloadDisable = process.env.CODEGRAPH_OFFLOAD_DISABLE; process.env.CODEGRAPH_OFFLOAD_DISABLE = '1'; });
afterAll(() => {
  if (_prevOffloadDisable === undefined) delete process.env.CODEGRAPH_OFFLOAD_DISABLE;
  else process.env.CODEGRAPH_OFFLOAD_DISABLE = _prevOffloadDisable;
});

describe('codegraph_explore — synthesized constant→constant edges surface on small repos', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  afterEach(() => {
    if (cg) cg.destroy();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces an RTK thunk→thunk hop (both `constant`) in the Dynamic-dispatch links section', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-thunk-surface-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { '@reduxjs/toolkit': '^2' } })
    );
    fs.writeFileSync(
      path.join(dir, 'thunks.ts'),
      `import { createAsyncThunk } from '@reduxjs/toolkit';

export const deepThunk = createAsyncThunk('app/deep', async (n: number) => n * 2);

export const innerThunk = createAsyncThunk('app/inner', async (n: number, { dispatch }) => {
  return dispatch(deepThunk(n));
});

export const outerThunk = createAsyncThunk('app/outer', async (n: number, { dispatch }) => {
  await dispatch(innerThunk(n));
});
`
    );

    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // Precondition: the endpoints really are `constant` nodes — the exact kind the old
    // CALLABLE-only flow scan dropped (if extraction ever classed them as functions the
    // test would pass vacuously, so assert the case we actually fixed).
    const db = (cg as any).db.db;
    const outerKind = db.prepare(`SELECT kind FROM nodes WHERE name = 'outerThunk' LIMIT 1`).get()?.kind;
    expect(outerKind).toBe('constant');

    handler = new ToolHandler(cg);
    const res = await handler.execute('codegraph_explore', { query: 'outerThunk innerThunk' });
    const text = res.content[0].text as string;

    // The synthesized hop now surfaces (was invisible: both endpoints `constant` AND the
    // small-repo Relationships section is off).
    expect(text).toContain('**Dynamic-dispatch links among your symbols');
    expect(text).toMatch(/outerThunk\s+→\s+innerThunk/);
    // It reads as a dynamic-dispatch bridge with its wiring site, not a bare `calls`.
    expect(text).toMatch(/dynamic: redux thunk @/);
    expect(text).not.toMatch(/outerThunk\s+→\s+innerThunk\s+\[calls\]/);
  });
});
