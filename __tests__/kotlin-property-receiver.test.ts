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
class AAValidator { fun validate(v: String): List<String> = emptyList() }
object HardwareGate {
    fun tryBegin(): HardwareLock.Lease? = null
}
class Checker {
    fun validate(v: String): List<String> = emptyList()
    companion object {
        fun load(): Checker = Checker()
    }
}
internal fun interface Reply {
    fun send(message: String): Boolean
}

/** Events of one session, for the application layer. */
internal interface SessionEvents {
    fun onLost(reason: String)
}
class Pattern { fun find(text: String): Int = 0 }
class Conn { fun close() {} }
class Buffer(val size: Int) { fun drain(): Int = 0 }
class Pump { fun drain(): Int = 1 }
enum class Mode { ON, OFF; fun next(): Mode = this }
class Wheel { fun next(): Int = 0 }
class Worker { fun start() {}; fun join(ms: Long) {} }
class Vm {
    fun refresh() {}
    fun tick() {
        activeController?.refresh()
    }
    companion object {
        @Volatile private var activeController: Vm? = null
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
class CallResultUser {
    private val schema = Checker.load()
    fun check() { schema.validate("x") }
    fun locked() {
        val lease = HardwareGate.tryBegin()
        lease?.close()
    }
}
class Supervisor(private val events: SessionEvents) {
    fun lost() { events.onLost("gone") }
}
class ValUser {
    private val pending = Buffer(
        size = 4,
    )
    @Volatile private var current = Mode.ON
    fun work() {
        listOf(1).forEach {
            pending.drain()
        }
    }
    fun toggle() { current.next() }
}
class Socket2 { fun cancel() {} }
class Session { fun cancel() {} }
abstract class Listener { abstract fun onOpen(socket: java.net.Socket) }
class AliasUser {
    @Volatile private var current: Session? = null
    fun stop() {
        val old = current ?: return
        old.cancel()
    }
    fun listen(): Listener = object : Listener() {
        override fun onOpen(socket: java.net.Socket) {
            socket.close()
        }
    }
}
class ThreadUser {
    fun run() {
        val serverThread = Thread {
            println("x")
        }
        serverThread.start()
        val later = lazy { 1 }
        val items = mutableListOf(1)
        items.clear()
    }
}
class LibraryUser {
    private val regex = Regex("[0-9]+")
    fun first(text: String) = regex.find(text)
    fun scheduled() {
        val scheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
        scheduler.shutdown()
    }
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

  it('a local or property bound to a call is typed by the callee return type', () => {
    expect(callees('CallResultUser', 'check')).toEqual(['p::Checker::validate']);
    expect(callees('CallResultUser', 'locked').sort()).toEqual(['p::HardwareGate::tryBegin', 'p::HardwareLock::Lease::close']);
  });

  it('a fun interface does not swallow the declaration after it', () => {
    const events = cg.searchNodes('SessionEvents').map((r) => r.node)
      .find((n) => n.qualifiedName === 'p::SessionEvents');
    expect(events?.kind).toBe('interface');
    expect(callees('Supervisor', 'lost')).toEqual(['p::SessionEvents::onLost']);
  });

  it('a receiver of a library type gets no edge instead of a same-named project method', () => {
    // `Regex.find` must not bind to the project's `Pattern.find`.
    expect(callees('LibraryUser', 'first')).toEqual([]);
    expect(callees('LibraryUser', 'scheduled')).toEqual([]);
  });

  it('a val property (indexed as a constant) and an enum-entry var are typed, inside a lambda too', () => {
    expect(callees('ValUser', 'work')).toContain('p::Buffer::drain');
    expect(callees('ValUser', 'work')).not.toContain('p::Pump::drain');
    expect(callees('ValUser', 'toggle')).toEqual(['p::Mode::next']);
  });

  it('a companion-object property is typed', () => {
    expect(callees('Vm', 'tick')).toEqual(['p::Vm::refresh']);
  });

  it('a trailing-lambda constructor or a library call types a local as a library type', () => {
    // `Thread { … }.start()` must not bind to the project's `Worker.start`.
    expect(callees('ThreadUser', 'run')).toEqual([]);
  });

  it('an alias takes the aliased value type; a library-typed parameter gets no edge', () => {
    expect(callees('AliasUser', 'stop')).toEqual(['p::Session::cancel']);
    const onOpen = cg.searchNodes('onOpen').map((r) => r.node).find((n) => n.filePath.endsWith('Users.kt'));
    expect(onOpen).toBeDefined();
    expect(cg.getCallees(onOpen!.id).filter((c) => c.edge.kind === 'calls')).toEqual([]);
  });

  it('a nested type keeps its outer type', () => {
    expect(callees('NestedUser', 'release')).toEqual(['p::HardwareLock::Lease::close']);
  });
});
