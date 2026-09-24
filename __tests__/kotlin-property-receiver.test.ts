/**
 * A call through a Kotlin property resolves on the property's declared type.
 *
 * Kotlin properties are indexed without a signature, and primary-constructor
 * properties are not indexed at all, so the Java-shaped field inference found
 * no type and every `prop.method()` fell through to name-only guessing: the
 * interface method, or any same-named method elsewhere (a `close()` on an
 * unrelated class). The declared type is now read from the declaration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('Kotlin property receivers resolve on the declared type', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kt-prop-'));
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'Probe.kt'), `package p
import java.io.Closeable
internal interface Probe : Closeable {
    fun probe(host: String): Int
}
internal class HttpProbe(
    private val endpoints: (String) -> List<String>,
) : Probe {
    override fun probe(host: String): Int = 1
    override fun close() {}
}
internal class OtherProbe : Closeable {
    fun probe(host: String): Int = 2
    override fun close() {}
}
class Store { fun put(v: Int) = v }
class HardwareLock {
    class Lease {
        fun close() {}
    }
}
class SessionLock {
    class Lease {
        fun close() {}
    }
}
`);
    fs.writeFileSync(path.join(src, 'Users.kt'), `package p
class LateinitUser {
    private lateinit var probe: HttpProbe
    fun setUp() { probe = HttpProbe(endpoints = { listOf(it) }) }
    fun useIt() { probe.probe("a") }
    fun tearDown() { probe.close() }
}
class CtorUser(private val store: Store, val maybe: HttpProbe?) {
    fun save() { store.put(1) }
    fun check() { maybe?.probe("b") }
}
class InitUser {
    private val probe = HttpProbe(endpoints = { emptyList() })
    fun stop() { probe.close() }
}
class NestedUser(private val lease: HardwareLock.Lease) {
    fun release() { lease.close() }
}
`);
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.kt'], exclude: [] } });
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Qualified names of what `owner.method` calls. */
  function callees(owner: string, method: string): string[] {
    const node = cg.searchNodes(method).map((r) => r.node)
      .find((n) => n.qualifiedName.endsWith(`${owner}::${method}`));
    expect(node, `${owner}::${method}`).toBeDefined();
    return cg.getCallees(node!.id).filter((c) => c.edge.kind === 'calls').map((c) => c.node.qualifiedName);
  }

  it('a lateinit property resolves on its concrete type, not the interface', () => {
    expect(callees('LateinitUser', 'useIt')).toEqual(['p::HttpProbe::probe']);
    expect(callees('LateinitUser', 'tearDown')).toEqual(['p::HttpProbe::close']);
  });

  it('a primary-constructor property resolves on its type, nullable included', () => {
    expect(callees('CtorUser', 'save')).toEqual(['p::Store::put']);
    expect(callees('CtorUser', 'check')).toEqual(['p::HttpProbe::probe']);
  });

  it('a property initialized by a constructor call resolves on that type', () => {
    expect(callees('InitUser', 'stop')).toEqual(['p::HttpProbe::close']);
  });

  it('a nested type keeps its outer type', () => {
    expect(callees('NestedUser', 'release')).toEqual(['p::HardwareLock::Lease::close']);
  });
});
