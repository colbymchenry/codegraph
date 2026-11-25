import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * End-to-end test for the redux-thunk dispatch-chain synthesizer.
 *
 * `createAsyncThunk(prefix, async (a, api) => {...})` passes the async body as an argument, so
 * tree-sitter never makes it its own function node — the thunk `constant`'s body calls (incl.
 * `dispatch(nextThunk(...))`) are orphaned and `callees(thunk)` is empty. Verify the synthesizer
 * body-scans each thunk constant and links it → each dispatched thunk, so the chain
 * `outer → inner → deep` connects end-to-end; and that a non-thunk constant is skipped.
 */
describe('redux-thunk synthesizer', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redux-thunk-fixture-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links each thunk constant to the thunks it dispatches, and skips non-thunks', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { '@reduxjs/toolkit': '^2' } })
    );
    fs.writeFileSync(
      path.join(dir, 'thunks.ts'),
      `import { createAsyncThunk } from '@reduxjs/toolkit';

export const deepThunk = createAsyncThunk('app/deep', async (n: number) => {
  return n * 2;
});

export const innerThunk = createAsyncThunk('app/inner', async (n: number, { dispatch }) => {
  return dispatch(deepThunk(n));
});

export const outerThunk = createAsyncThunk('app/outer', async (n: number, { dispatch }) => {
  await dispatch(innerThunk(n));
});

// Non-thunk constant that only MENTIONS dispatch in a string — must be skipped.
export const notAThunk = 'dispatch(innerThunk())';
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, s.kind source_kind, t.name target_name,
                json_extract(e.metadata,'$.via') via,
                json_extract(e.metadata,'$.registeredAt') registeredAt
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'redux-thunk'`
      )
      .all();
    cg.close?.();

    // The dispatch chain connects: outer → inner → deep.
    const pairs = new Set(rows.map((r: any) => `${r.source_name}>${r.target_name}`));
    expect(pairs.has('outerThunk>innerThunk')).toBe(true);
    expect(pairs.has('innerThunk>deepThunk')).toBe(true);

    // Sources are thunk constants; the non-thunk string constant is never a source.
    expect(rows.every((r: any) => r.source_kind === 'constant')).toBe(true);
    expect(rows.some((r: any) => r.source_name === 'notAThunk')).toBe(false);

    // Edges are 'calls' with the wiring site surfaced for the agent.
    const outer = rows.find((r: any) => r.source_name === 'outerThunk');
    expect(outer.via).toBe('innerThunk');
    expect(outer.registeredAt).toMatch(/thunks\.ts:\d+/);
  });

  it('on a name collision, a dispatch resolves to the THUNK, not a same-named service function', async () => {
    // Regression for the octo-call case: `leaveCall` exists as BOTH a `createAsyncThunk`
    // const and an unrelated service function. `dispatch(leaveCall())` targets the thunk,
    // but the old first-match resolver could pick the function. The resolver now prefers a
    // thunk-signature const > other const > same-file > first.
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { '@reduxjs/toolkit': '^2' } })
    );
    // A plain service function that shares the name `leaveCall` with the thunk below.
    fs.writeFileSync(path.join(dir, 'service.ts'), `export function leaveCall(id: string) { return id; }\n`);
    fs.writeFileSync(
      path.join(dir, 'thunks.ts'),
      `import { createAsyncThunk } from '@reduxjs/toolkit';

export const leaveCall = createAsyncThunk('call/leave', async () => {
  return 1;
});

export const logout = createAsyncThunk('user/logout', async (_: void, { dispatch }) => {
  dispatch(leaveCall());
});
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const row = db
      .prepare(
        `SELECT t.kind target_kind, t.file_path target_file
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'redux-thunk'
           AND s.name = 'logout' AND t.name = 'leaveCall'`
      )
      .get();
    cg.close?.();

    expect(row).toBeTruthy();
    // Resolved to the createAsyncThunk constant in thunks.ts, NOT service.ts's function.
    expect(row.target_kind).toBe('constant');
    expect(row.target_file).toMatch(/thunks\.ts$/);
  });
});
