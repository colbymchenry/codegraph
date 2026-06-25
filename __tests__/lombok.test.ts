/**
 * Lombok-generated member synthesis (Java, #912).
 *
 * Lombok generates getters/setters/builder/equals/hashCode/toString and the
 * `log` field at compile time, so they never appear in the source AST. Without
 * synthesis they're absent from the index and any `bean.getX()` / `Bean.builder()`
 * / `log.info()` call resolves to nothing — call chains break silently. We
 * synthesize the mechanical ones from the annotations + fields, mark them
 * (`lombok` decorator + a docstring naming the source annotation), and they then
 * resolve as ordinary call targets. These tests prove the synthesis, the call
 * resolution that motivated it, and the precision boundaries (static fields
 * skipped, hand-written members never overridden, a non-Lombok class is clean).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('lombok synthesis', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lombok-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  type Row = { name: string; kind: string; decorators: string | null; docstring: string | null; signature: string | null };
  const load = async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const nodes: Row[] = db.prepare(`SELECT name, kind, decorators, docstring, signature FROM nodes`).all();
    const calls: { src: string; tgt: string }[] = db
      .prepare(
        `SELECT s.name src, t.name tgt FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls'`
      )
      .all();
    cg.close?.();
    return { nodes, calls };
  };

  const isLombok = (n: Row | undefined) => !!n && (n.decorators ?? '').includes('lombok');

  it('synthesizes accessors that resolve as call targets, and the @Slf4j log field', async () => {
    write('model/User.java', `package model;
import lombok.Data;
import lombok.Builder;
import lombok.extern.slf4j.Slf4j;

@Data
@Builder
@Slf4j
public class User {
    private String name;
    private boolean active;
    private static final int MAX = 10;
}
`);
    write('svc/UserService.java', `package svc;
import model.User;

class UserService {
    String describe(User user) {
        user.setActive(true);
        return user.getName();
    }
    User make() {
        return User.builder();
    }
}
`);

    const { nodes, calls } = await load();
    const byName = (name: string) => nodes.find((n) => n.name === name && isLombok(n));

    // Accessors + Data contract + builder are synthesized and marked.
    for (const m of ['getName', 'setName', 'isActive', 'setActive', 'builder', 'equals', 'hashCode', 'toString']) {
      expect(isLombok(byName(m)), `expected synthesized ${m}`).toBe(true);
    }
    expect(byName('getName')!.docstring).toMatch(/Lombok-generated/);
    expect(byName('getName')!.signature).toBe('String getName()');
    expect(byName('isActive')!.signature).toBe('boolean isActive()'); // boolean → is-prefix
    expect(byName('builder')!.signature).toContain('static ');

    // @Slf4j → a `log` field.
    expect(isLombok(nodes.find((n) => n.name === 'log' && n.kind === 'field'))).toBe(true);

    // PRECISION: a static field gets no accessor.
    expect(nodes.some((n) => n.name === 'getMAX' || n.name === 'getMax')).toBe(false);

    // THE FIX: calls to Lombok-generated methods resolve to their synthesized target.
    const resolved = (src: string, tgt: string) => calls.some((c) => c.src === src && c.tgt === tgt);
    expect(resolved('describe', 'getName')).toBe(true);
    expect(resolved('describe', 'setActive')).toBe(true);
    expect(resolved('make', 'builder')).toBe(true);
  });

  it('never overrides a hand-written accessor', async () => {
    write('model/Account.java', `package model;
import lombok.Getter;

@Getter
public class Account {
    private int balance;
    private String owner;

    // explicit getter — Lombok skips it, so must we
    public int getBalance() { return balance < 0 ? 0 : balance; }
}
`);
    const { nodes } = await load();
    const getBalance = nodes.filter((n) => n.name === 'getBalance');
    expect(getBalance.length).toBe(1);           // exactly one, not duplicated
    expect(isLombok(getBalance[0])).toBe(false); // the hand-written one survives
    // the un-shadowed field still gets its synthesized getter
    expect(isLombok(nodes.find((n) => n.name === 'getOwner'))).toBe(true);
  });

  it('field-level @Getter/@Setter and final-field rules', async () => {
    write('model/Box.java', `package model;
import lombok.Getter;
import lombok.Setter;

public class Box {
    @Getter @Setter private String label;
    @Getter private final long id;     // final → getter only, no setter
    private int hidden;                // no annotation → nothing
}
`);
    const { nodes } = await load();
    expect(isLombok(nodes.find((n) => n.name === 'getLabel'))).toBe(true);
    expect(isLombok(nodes.find((n) => n.name === 'setLabel'))).toBe(true);
    expect(isLombok(nodes.find((n) => n.name === 'getId'))).toBe(true);
    expect(nodes.some((n) => n.name === 'setId')).toBe(false);     // final → no setter
    expect(nodes.some((n) => n.name === 'getHidden')).toBe(false); // un-annotated → nothing
  });

  it('produces no synthesized members for a plain Java class (clean control)', async () => {
    write('model/Plain.java', `package model;

public class Plain {
    private int value;
    public int getValue() { return value; }
    public void setValue(int v) { this.value = v; }
}
`);
    const { nodes } = await load();
    expect(nodes.some((n) => isLombok(n))).toBe(false);
  });
});
