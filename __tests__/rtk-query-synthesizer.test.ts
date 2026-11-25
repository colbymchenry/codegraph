/**
 * RTK Query generated-hook → endpoint synthesizer.
 *
 * RTK Query's `createApi({ endpoints })` defines endpoints as object-literal
 * properties (`getX: build.query(...)`) and generates one `useGetXQuery` /
 * `useUpdateYMutation` hook per endpoint, exported via a `const {…} = api`
 * destructuring. Neither the endpoint nor the generated hook is otherwise a node,
 * so a `component → useGetXQuery → getX → queryFn` flow has nothing to connect to.
 *
 * This validates the two halves: extraction mints a function node for each
 * endpoint (named by its key, both the `build => ({...})` arrow form and the
 * `endpoints(build){ return {...} }` method-shorthand form) and for each generated
 * hook binding; then the synthesizer bridges hook→endpoint by the naming
 * convention (incl. the `useLazyGetXQuery` variant → the same endpoint). Precision
 * is gated to genuinely-generated hooks: a hand-written `use*Query` arrow is never
 * bridged, and no edge ever crosses files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('rtk-query synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-query-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('extracts endpoints + generated hooks and bridges hook→endpoint (arrow + method + lazy + factory forms)', async () => {
    // Arrow form (shapeshift-style): `endpoints: build => ({...})`, `queryFn: () => {}`.
    fs.writeFileSync(
      path.join(dir, 'fiatRampApi.ts'),
      `import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { fetchRamps } from './ramps';

export const fiatRampApi = createApi({
  reducerPath: 'fiatRampApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  endpoints: build => ({
    getFiatRamps: build.query({
      queryFn: async () => {
        const data = await fetchRamps();
        return { data };
      },
    }),
    placeOrder: build.mutation({
      query: body => ({ url: 'order', method: 'POST', body }),
    }),
  }),
});

export const { useGetFiatRampsQuery, usePlaceOrderMutation, useLazyGetFiatRampsQuery } = fiatRampApi;
`
    );
    // Method-shorthand form (basetool-style): `endpoints(builder){ return {...} }`,
    // `query(){}` method handler, plus a factory-handler endpoint (no fn literal).
    fs.writeFileSync(
      path.join(dir, 'dashApi.ts'),
      `import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { makeCheckFn } from './factory';

export const dashApi = createApi({
  reducerPath: 'dash',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  endpoints(builder) {
    return {
      getDashboards: builder.query({
        query() {
          return '/dashboards';
        },
      }),
      checkConnection: builder.mutation({
        queryFn: makeCheckFn('/check'),
      }),
    };
  },
});

export const { useGetDashboardsQuery, useCheckConnectionMutation } = dashApi;
`
    );
    // Components consuming the generated hooks.
    fs.writeFileSync(
      path.join(dir, 'Views.tsx'),
      `import { useGetFiatRampsQuery, useLazyGetFiatRampsQuery } from './fiatRampApi';
import { useGetDashboardsQuery } from './dashApi';

export function FiatForm() {
  const { data } = useGetFiatRampsQuery();
  return data;
}
export function DashList() {
  const { data } = useGetDashboardsQuery();
  return data;
}
export function LazyForm() {
  const [load] = useLazyGetFiatRampsQuery();
  return load;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // Endpoints are extracted as function nodes named by their key.
    const endpoints = db
      .prepare(`SELECT name, kind FROM nodes WHERE name IN ('getFiatRamps','placeOrder','getDashboards','checkConnection')`)
      .all();
    expect(endpoints.length).toBe(4);
    expect(endpoints.every((n: any) => n.kind === 'function')).toBe(true);

    // Generated hooks are extracted as function nodes carrying the sentinel.
    const hooks = db
      .prepare(`SELECT name FROM nodes WHERE signature = '= RTK Query generated hook' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(hooks).toEqual([
      'useCheckConnectionMutation',
      'useGetDashboardsQuery',
      'useGetFiatRampsQuery',
      'useLazyGetFiatRampsQuery',
      'usePlaceOrderMutation',
    ]);

    // hook → endpoint synth edges, including the Lazy variant mapping to the same endpoint.
    const synth = db
      .prepare(
        `SELECT s.name source, t.name target, s.file_path sf, t.file_path tf
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'rtk-query'`
      )
      .all();
    const pairs = synth.map((r: any) => `${r.source}->${r.target}`).sort();
    expect(pairs).toEqual([
      'useCheckConnectionMutation->checkConnection',
      'useGetDashboardsQuery->getDashboards',
      'useGetFiatRampsQuery->getFiatRamps',
      'useLazyGetFiatRampsQuery->getFiatRamps',
      'usePlaceOrderMutation->placeOrder',
    ]);
    // Every synth edge stays within one file (RTK colocates api + hooks).
    expect(synth.every((r: any) => r.sf === r.tf)).toBe(true);

    // The component reaches the hook (normal import/call resolution), so the full
    // `component → hook → endpoint` chain is connected.
    const compToHook = db
      .prepare(
        `SELECT s.name source, t.name target FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.name = 'FiatForm' AND t.name = 'useGetFiatRampsQuery' AND e.kind = 'calls'`
      )
      .all();
    expect(compToHook.length).toBeGreaterThan(0);

    cg.close?.();
  });

  it('does not bridge a hand-written use*Query hook (no createApi, no sentinel) — 0 synth edges', async () => {
    // A real custom hook of the same name shape, plus a same-file `getThing`
    // function it could spuriously map to. Without the generated-hook sentinel +
    // createApi destructuring, the synthesizer must produce nothing.
    fs.writeFileSync(
      path.join(dir, 'useGetThingQuery.ts'),
      `export function getThing() { return 42; }
export const useGetThingQuery = () => {
  return getThing();
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'Thing.tsx'),
      `import { useGetThingQuery } from './useGetThingQuery';
export function Thing() {
  return useGetThingQuery();
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const synth = db
      .prepare(`SELECT count(*) c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'rtk-query'`)
      .get();
    expect(synth.c).toBe(0);
    // The hand-written hook keeps its real body (not a sentinel binding).
    const sentinel = db
      .prepare(`SELECT count(*) c FROM nodes WHERE signature = '= RTK Query generated hook'`)
      .get();
    expect(sentinel.c).toBe(0);

    cg.close?.();
  });
});
