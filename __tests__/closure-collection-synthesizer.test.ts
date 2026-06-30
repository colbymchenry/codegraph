import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * End-to-end synthesizer test for closure-collection dynamic dispatch.
 *
 * A method appends a closure to a collection property; another method iterates
 * that property *invoking each element* (`coll.forEach { $0() }`) — a dynamic
 * dispatch tree-sitter can't resolve, so a flow into the dispatcher dead-ends
 * before the registered closures. This is Alamofire's request-validation shape:
 * `DataRequest.validate` does `validators.write { $0.append(validator) }`, the
 * base `Request.didCompleteTask` runs `validators.forEach { $0() }`.
 *
 * Verify the synthesizer (1) links the dispatcher → each same-named registrar
 * across files/classes, (2) handles both the Swift `prop.write { $0.append }`
 * and the direct `prop.append(...)` registrar forms, (3) surfaces the wiring
 * site, and (4) does NOT fire on a `.forEach` that doesn't invoke its element
 * (the closure-invoke is the precision gate — a plain collection is skipped).
 */
describe('closure-collection synthesizer', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-coll-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links dispatcher → registrars across files, both append forms, and skips non-invoked collections', async () => {
    // Base class: the dispatchers (iterate-and-invoke) + a non-closure control.
    fs.writeFileSync(
      path.join(dir, 'Request.swift'),
      `class Request {
    var validators: [() -> Void] = []
    var handlers: [() -> Void] = []
    var names: [String] = []

    func didCompleteTask() {
        let validators = validators
        validators.forEach { $0() }
    }

    func runHandlers() {
        handlers.forEach { $0() }
    }

    func printNames() {
        names.forEach { print($0) }
    }
}
`
    );

    // Subclass: the registrars (append a closure) in a DIFFERENT file/class.
    fs.writeFileSync(
      path.join(dir, 'DataRequest.swift'),
      `class DataRequest: Request {
    func validate(_ validation: @escaping () -> Void) -> Self {
        let validator: () -> Void = { validation() }
        validators.write { $0.append(validator) }
        return self
    }

    func onEvent(_ handler: @escaping () -> Void) {
        handlers.append(handler)
    }

    func addName(_ n: String) {
        names.append(n)
    }
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, s.kind source_kind, t.name target_name,
                json_extract(e.metadata,'$.field') field,
                json_extract(e.metadata,'$.registeredAt') registeredAt
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'closure-collection'`
      )
      .all();
    cg.close?.();

    expect(rows.length).toBeGreaterThan(0);

    // Every edge originates from a dispatcher method and is a real `calls` hop.
    expect(rows.every((r: any) => r.source_kind === 'method')).toBe(true);

    // The validators flow: didCompleteTask → validate, captured via the Swift
    // Protected `prop.write { $0.append }` form, wiring site surfaced.
    const validatorsEdge = rows.find(
      (r: any) => r.field === 'validators' && r.target_name === 'validate'
    );
    expect(validatorsEdge).toBeTruthy();
    expect(validatorsEdge.source_name).toBe('didCompleteTask');
    expect(validatorsEdge.registeredAt).toMatch(/DataRequest\.swift:\d+/);

    // The handlers flow: runHandlers → onEvent, via the direct `prop.append`
    // form — proves both registrar shapes are covered.
    const handlersEdge = rows.find(
      (r: any) => r.field === 'handlers' && r.target_name === 'onEvent'
    );
    expect(handlersEdge).toBeTruthy();
    expect(handlersEdge.source_name).toBe('runHandlers');

    // Precision gate: `names.forEach { print($0) }` does NOT invoke its element,
    // so `names` is not a closure collection — no edge, and addName is never a target.
    expect(rows.some((r: any) => r.field === 'names')).toBe(false);
    expect(rows.some((r: any) => r.target_name === 'addName')).toBe(false);
  });

  it('skips minified-style closure-collection files while still indexing their methods', async () => {
    fs.writeFileSync(
      path.join(dir, 'Request.swift'),
      `class Request {
    var validators: [() -> Void] = []

    func didCompleteTask() {
        validators.forEach { $0() }
    }
}
`
    );

    fs.writeFileSync(
      path.join(dir, 'DataRequest.swift'),
      `class DataRequest: Request {
    func validate(_ validation: @escaping () -> Void) -> Self {
        let validator: () -> Void = { validation() }
        validators.append(validator)
        return self
    }
}
`
    );

    fs.writeFileSync(
      path.join(dir, 'Minified.swift'),
      `class MinifiedRequest { var handlers: [() -> Void] = []; func runHandlers() { handlers.forEach { $0() } } } class MinifiedDataRequest: MinifiedRequest { func addHandler(_ handler: @escaping () -> Void) -> Self { handlers.append(handler); return self } } // ${'x'.repeat(280)}`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, s.file_path source_file,
                t.name target_name, t.file_path target_file,
                json_extract(e.metadata,'$.registeredAt') registeredAt
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'closure-collection'
         ORDER BY s.file_path, t.file_path`
      )
      .all();
    const minifiedMethods = db
      .prepare(
        `SELECT name
         FROM nodes
         WHERE file_path = 'Minified.swift' AND kind = 'method'
         ORDER BY name`
      )
      .all()
      .map((r: any) => r.name);
    cg.close?.();

    expect(minifiedMethods).toEqual(['addHandler', 'runHandlers']);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_name: 'didCompleteTask',
      source_file: 'Request.swift',
      target_name: 'validate',
      target_file: 'DataRequest.swift',
    });
    expect(rows[0].registeredAt).toMatch(/DataRequest\.swift:\d+/);
    expect(rows.some((r: any) => r.target_name === 'addHandler')).toBe(false);
    expect(rows.some((r: any) => String(r.registeredAt).includes('Minified.swift'))).toBe(false);
  });
});
