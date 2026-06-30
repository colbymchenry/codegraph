/**
 * Spring application-event bridge (Java).
 *
 * Spring decouples an event publisher from its listener(s) through the application
 * event bus, linked by the EVENT TYPE: `eventPublisher.publishEvent(new XEvent(...))`
 * has no static edge to the `@EventListener void on(XEvent e)` that handles it (usually
 * in a different file). This bridges each `publishEvent(new XEvent(...))` site to every
 * listener of XEvent. Covers all four listener forms — param-typed `@EventListener`,
 * annotation-typed `@EventListener(XEvent.class)`, `@TransactionalEventListener`, and the
 * older `implements ApplicationListener<XEvent>` / `onApplicationEvent` — fans out to
 * multiple listeners of the same event, and proves precision: a published event with no
 * listener, and a same-file non-annotated method, both produce no edge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('spring-event synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spring-event-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  it('bridges publishEvent(new X) to every listener form of X, ignoring unheard events and non-listeners', async () => {
    write('shop/OrderEvents.java', `package shop;
class OrderShippedEvent { }
class OrderCancelledEvent { }
class UnheardEvent { }
`);
    // Publisher — two events, one of them (UnheardEvent) has no listener.
    write('shop/OrderService.java', `package shop;
import org.springframework.context.ApplicationEventPublisher;
class OrderService {
    private ApplicationEventPublisher publisher;
    void ship() {
        publisher.publishEvent(new OrderShippedEvent());
        publisher.publishEvent(new UnheardEvent());
    }
    void cancel() {
        publisher.publishEvent(new OrderCancelledEvent());
    }
}
`);
    // Form 1: param-typed @EventListener — plus a same-file NON-listener (no annotation).
    write('shop/ShippingListener.java', `package shop;
import org.springframework.context.event.EventListener;
class ShippingListener {
    @EventListener
    public void onShipped(OrderShippedEvent event) { }

    public void helper(OrderShippedEvent event) { }
}
`);
    // Form 2: annotation-typed @EventListener(X.class) — fan-out, a 2nd OrderShipped listener.
    write('shop/AuditListener.java', `package shop;
import org.springframework.context.event.EventListener;
class AuditListener {
    @EventListener(OrderShippedEvent.class)
    public void audit(OrderShippedEvent event) { }
}
`);
    // Form 3: @TransactionalEventListener — a 3rd OrderShipped listener.
    write('shop/TxListener.java', `package shop;
import org.springframework.transaction.event.TransactionalEventListener;
class TxListener {
    @TransactionalEventListener
    public void afterShipped(OrderShippedEvent event) { }
}
`);
    // Form 4: older implements ApplicationListener<X> / onApplicationEvent.
    write('shop/LegacyListener.java', `package shop;
import org.springframework.context.ApplicationListener;
class LegacyListener implements ApplicationListener<OrderCancelledEvent> {
    @Override
    public void onApplicationEvent(OrderCancelledEvent event) { }
}
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db
      .prepare(
        `SELECT s.name source, t.name target, json_extract(e.metadata,'$.via') via
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'spring-event'`
      )
      .all();

    const targets = (src: string) =>
      edges.filter((r: any) => r.source === src).map((r: any) => r.target).sort();
    // ship() → all three OrderShippedEvent listeners (param-typed, annotation-typed, transactional).
    expect(targets('ship')).toEqual(['afterShipped', 'audit', 'onShipped']);
    // cancel() → the ApplicationListener<X> form.
    expect(targets('cancel')).toEqual(['onApplicationEvent']);
    // Every shipped edge is keyed by the event type.
    expect(edges.filter((r: any) => r.source === 'ship').every((r: any) => r.via === 'OrderShippedEvent')).toBe(true);
    // PRECISION: UnheardEvent has no listener → no edge; the non-annotated helper is never a target.
    expect(edges.some((r: any) => r.via === 'UnheardEvent')).toBe(false);
    expect(edges.some((r: any) => r.target === 'helper')).toBe(false);

    cg.close?.();
  });

  it('produces no edges in a Spring app with no event bus (clean control)', async () => {
    write('shop/PlainService.java', `package shop;
import org.springframework.stereotype.Service;
@Service
class PlainService {
    private final Repo repo;
    PlainService(Repo repo) { this.repo = repo; }
    String find(String id) { return repo.get(id); }
}
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const count = db
      .prepare(`SELECT count(*) c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'spring-event'`)
      .get();
    expect(count.c).toBe(0);
    cg.close?.();
  });
});
