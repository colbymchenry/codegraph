import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * End-to-end synthesizer test for the gin middleware chain.
 *
 * `(*Context).Next` runs the handler chain by slice index
 * (`c.handlers[c.index](c)`) — a computed dispatch tree-sitter can't resolve, so
 * `callees(Next)` would otherwise dead-end at the `len()` helper. Handlers are
 * registered via `.Use(...)` / `.GET("/path", h)`. Verify the synthesizer links
 * `Next` → each registered NAMED HandlerFunc, captures the wiring site, and
 * skips inline (anonymous) closures.
 */
describe('gin middleware-chain synthesizer', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gin-chain-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links Context.Next to handlers registered via Use/GET and skips inline closures', async () => {
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module ginapp\n\ngo 1.21\n');

    // gin-core shape: the dynamic-dispatch chain driver + registration surface.
    fs.writeFileSync(
      path.join(dir, 'gin.go'),
      `package gin

type HandlerFunc func(*Context)
type HandlersChain []HandlerFunc

type Context struct {
	handlers HandlersChain
	index    int8
}

func (c *Context) Next() {
	c.index++
	for c.index < int8(len(c.handlers)) {
		c.handlers[c.index](c)
		c.index++
	}
}

type Engine struct {
	Handlers HandlersChain
}

func (e *Engine) Use(middleware ...HandlerFunc) {
	e.Handlers = append(e.Handlers, middleware...)
}

func (e *Engine) GET(path string, handlers ...HandlerFunc) {}
`
    );

    // registration site: named middleware + named route handler + an inline closure.
    fs.writeFileSync(
      path.join(dir, 'app.go'),
      `package gin

func Logger(c *Context)   {}
func Recovery(c *Context) {}
func getUser(c *Context)  {}

func setup() {
	e := &Engine{}
	e.Use(Logger, Recovery)
	e.GET("/users", getUser)
	e.GET("/inline", func(c *Context) {})
}
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
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'gin-middleware-chain'`
      )
      .all();
    cg.close?.();

    // Every edge originates from the chain dispatcher Context.Next.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.source_name === 'Next' && r.source_kind === 'method')).toBe(true);

    // Exactly the three NAMED handlers are linked — the inline closure (4th
    // registration) is anonymous and must be skipped.
    const targets = new Set(rows.map((r: any) => r.target_name));
    expect(targets).toEqual(new Set(['Logger', 'Recovery', 'getUser']));

    // The wiring site (`.Use`/`.GET` call) is surfaced for the agent.
    const logger = rows.find((r: any) => r.target_name === 'Logger');
    expect(logger.via).toBe('Logger');
    expect(logger.registeredAt).toMatch(/app\.go:\d+/);
  });
});
