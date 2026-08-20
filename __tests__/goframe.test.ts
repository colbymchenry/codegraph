/**
 * GoFrame route → controller-method coverage (#747), end to end.
 *
 * GoFrame binds routes reflectively, so the route declared in a request type's
 * `g.Meta` tag has no static edge to the controller method that serves it, and
 * the method name is NOT derivable from the request type (`DeptSearchReq` is
 * served by `List`). This indexes a fixture through the full pipeline and
 * checks: the `g.Meta` tags become route nodes; each route joins to its handler
 * by the request type in the method signature (the naming-mismatch case
 * included); a response (`mime`-only) `g.Meta` makes no route; a route with no
 * handler is left unlinked (silent beats wrong); and the response type never
 * produces a spurious edge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('GoFrame route synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goframe-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('joins each g.Meta route to its controller method by the request-type signature', async () => {
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n\nrequire github.com/gogf/gf/v2 v2.7.0\n');

    fs.mkdirSync(path.join(dir, 'api', 'system'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'api', 'system', 'dept.go'),
      `package system

import "github.com/gogf/gf/v2/frame/g"

type DeptSearchReq struct {
	g.Meta   \`path:"/dept/list" tags:"Dept" method:"get" summary:"list"\`
	DeptName string
}
type DeptSearchRes struct {
	g.Meta \`mime:"application/json"\`
	List   []string
}

type DeptAddReq struct {
	g.Meta \`path:"/dept/add" method:"post"\`
	Name   string
}
type DeptAddRes struct{}

// A declared route whose handler does not exist in this codebase.
type OrphanReq struct {
	g.Meta \`path:"/orphan" method:"get"\`
}
type OrphanRes struct{}
`
    );

    fs.mkdirSync(path.join(dir, 'internal', 'controller'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'internal', 'controller', 'dept.go'),
      `package controller

import (
	"context"

	"example.com/app/api/system"
)

type sysDeptController struct{}

// NB: method name (List) differs from the request type (DeptSearchReq) — the join
// must be by signature, not name.
func (c *sysDeptController) List(ctx context.Context, req *system.DeptSearchReq) (res *system.DeptSearchRes, err error) {
	return helper(ctx)
}

func (c *sysDeptController) Add(ctx context.Context, req *system.DeptAddReq) (res *system.DeptAddRes, err error) {
	return
}

// Returns the response type but takes no request type — must NOT be linked.
func helper(ctx context.Context) (res *system.DeptSearchRes, err error) {
	return
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const routes = db.prepare(`SELECT name FROM nodes WHERE kind='route' ORDER BY name`).all();
    const edges = db
      .prepare(
        `SELECT json_extract(e.metadata,'$.route') route, json_extract(e.metadata,'$.requestType') reqType,
                e.kind, t.name target_name, t.kind target_kind
         FROM edges e JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'goframe-route'
         ORDER BY route`
      )
      .all();
    cg.close?.();

    // Three routes from path-bearing g.Meta; the mime-only response g.Meta makes none.
    expect(routes.map((r: any) => r.name)).toEqual(['GET /dept/list', 'GET /orphan', 'POST /dept/add']);

    // Two route→handler edges — the orphan route stays unlinked (silent beats wrong).
    expect(edges).toHaveLength(2);
    const byRoute = Object.fromEntries(edges.map((e: any) => [e.route, e]));

    // Naming mismatch resolved by signature: GET /dept/list → List.
    expect(byRoute['GET /dept/list'].target_name).toBe('List');
    expect(byRoute['GET /dept/list'].reqType).toBe('DeptSearchReq');
    expect(byRoute['POST /dept/add'].target_name).toBe('Add');

    // It is a dynamic-dispatch `calls` hop to a real method, never to the helper.
    expect(edges.every((e: any) => e.kind === 'calls' && e.target_kind === 'method')).toBe(true);
    expect(edges.some((e: any) => e.target_name === 'helper')).toBe(false);
    expect(byRoute['GET /orphan']).toBeUndefined();
  });

  it('disambiguates identical bare request types across modules by package qualifier', async () => {
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/app\n\nrequire github.com/gogf/gf/v2 v2.7.0\n');

    // Two modules that BOTH define `type ListReq struct` — the collision a large
    // GoFrame app has dozens of. The package qualifier in the handler signature
    // (`*cash.ListReq` vs `*order.ListReq`) is the only thing that tells them apart.
    for (const mod of ['cash', 'order']) {
      fs.mkdirSync(path.join(dir, 'api', mod), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'api', mod, `${mod}.go`),
        `package ${mod}

import "github.com/gogf/gf/v2/frame/g"

type ListReq struct {
	g.Meta \`path:"/${mod}/list" method:"get"\`
}
type ListRes struct{}
`
      );
      fs.mkdirSync(path.join(dir, 'internal', 'controller', mod), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'internal', 'controller', mod, `${mod}.go`),
        `package ${mod}

import (
	"context"

	"example.com/app/api/${mod}"
)

type c${mod} struct{}

func (c *c${mod}) List(ctx context.Context, req *${mod}.ListReq) (res *${mod}.ListRes, err error) {
	return
}
`
      );
    }

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT json_extract(e.metadata,'$.route') route, t.file_path handler_file
         FROM edges e JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'goframe-route'
         ORDER BY route`
      )
      .all();
    cg.close?.();

    expect(rows).toHaveLength(2);
    // Each route binds to ITS OWN module's handler, never the other's.
    const byRoute = Object.fromEntries(rows.map((r: any) => [r.route, r.handler_file]));
    expect(byRoute['GET /cash/list']).toContain('controller/cash/');
    expect(byRoute['GET /order/list']).toContain('controller/order/');
  });
});
