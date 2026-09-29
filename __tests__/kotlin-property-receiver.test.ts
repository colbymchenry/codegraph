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
    fs.writeFileSync(path.join(src, 'Machines.kt'), `package p
class Tank { fun flush() {} }
class Motor {
    val reservoir = Tank()
    val runner = Thread { }
}
class Plant(val unit: Motor)
class Crate<T> { fun seal() {} }
object Registry { val primary = Motor() }
enum class Gear { LOW, HIGH; fun shift() {} }
fun Thread.label(): String = name
`);
    // The decoy `flush` sits in the caller's own file, where a name-only
    // guess would look first.
    fs.writeFileSync(path.join(src, 'Chains.kt'), `package p
class Other { fun flush() {}; fun seal() {}; fun shift() {} }
class Owner(private val engine: Motor, private val site: Plant) {
    private val box = Crate<Int>()
    fun generic() { box.seal() }
    fun viaObject() { Registry.primary.reservoir.flush() }
    fun viaEnum() { Gear.LOW.shift() }
    fun go() { engine.reservoir.flush() }
    fun viaThis() { this.engine.reservoir.flush() }
    fun deep() { site.unit.reservoir.flush() }
    fun library() { engine.runner.start() }
    fun extension() { engine.runner.label() }
}
`);
    // A property a class inherits: from a base in another file (a body
    // property and a primary-constructor one, two levels up), or in the same
    // file. Variable names differ from type names so no capitalized-name
    // guess can land on the right type.
    fs.writeFileSync(path.join(src, 'Bases.kt'), `package p
class Ledger { fun post() {} }
class Feed { fun refresh() {} }
abstract class BaseScreen(protected val source: Feed) : java.io.Serializable {
    protected lateinit var model: Ledger
}
open class MidScreen(origin: Feed) : BaseScreen(origin)
`);
    fs.writeFileSync(path.join(src, 'Screens.kt'), `package p
class Cache { fun post() {}; fun refresh() {}; fun twist() {}; fun open() {} }
class Knob { fun twist() {} }
class Sink { fun drainAll() {} }
open class Panel { val widget = Knob() }
class SidePanel : Panel() {
    fun turn() { widget.twist() }
}
class HomeScreen(start: Feed) : MidScreen(start), Runnable {
    override fun run() {}
    fun show() { model.post() }
    fun pull() { source.refresh() }
    fun viaThis() { this.model.post() }
}
class LibScreen : android.app.Activity() {
    fun go() { helper.drainAll() }
}
abstract class Hook { abstract fun fire(code: Int) }
class Gate { fun open() {} }
class Rig { val gate = Gate() }
class Wiring {
    fun wire(): Hook {
        val motor = Rig()
        return object : Hook() {
            override fun fire(code: Int) { motor.gate.open() }
        }
    }
    fun siblings(): Hook {
        val latch = Gate()
        return object : Hook() {
            fun prep() { val latch = Cache() }
            override fun fire(code: Int) { latch.open() }
        }
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
    // The anonymous object's `onOpen`, not the abstract `Listener::onOpen`
    // (which may carry a synthesized override edge to it).
    const listen = cg.searchNodes('listen').map((r) => r.node)
      .find((n) => n.qualifiedName.endsWith('AliasUser::listen'));
    expect(listen).toBeDefined();
    const onOpens = cg.searchNodes('onOpen').map((r) => r.node).filter((n) => n.filePath.endsWith('Users.kt'));
    const onOpen = onOpens.find((n) => n.qualifiedName.includes('$anon')) ??
      onOpens.find((n) => n.startLine > listen!.startLine && n.startLine <= (listen!.endLine ?? listen!.startLine));
    expect(onOpen).toBeDefined();
    const calls = cg.getCallees(onOpen!.id)
      .filter((c) => c.edge.kind === 'calls' && !c.edge.metadata?.synthesizedBy && !c.edge.metadata?.registeredAt);
    expect(calls).toEqual([]);
  });

  it('a receiver chain is typed through each property declared type', () => {
    expect(callees('Owner', 'go')).toEqual(['p::Tank::flush']);
    expect(callees('Owner', 'viaThis')).toEqual(['p::Tank::flush']);
    expect(callees('Owner', 'deep')).toEqual(['p::Tank::flush']);
  });

  it('a chain may start at an object or an enum entry; a generic constructor types its property', () => {
    expect(callees('Owner', 'viaObject')).toEqual(['p::Tank::flush']);
    expect(callees('Owner', 'viaEnum')).toEqual(['p::Gear::shift']);
    expect(callees('Owner', 'generic')).toEqual(['p::Crate::seal']);
  });

  it('a receiver chain through a library type gets no edge', () => {
    // `Thread.start` must not bind to the project's `Worker.start`.
    expect(callees('Owner', 'library')).toEqual([]);
    // The project's own extension of that library type is still reached.
    expect(callees('Owner', 'extension')).toEqual(['Thread::label']);
  });

  it('a property inherited from a superclass is typed, in the same file or another', () => {
    expect(callees('SidePanel', 'turn')).toEqual(['p::Knob::twist']);
    // Two levels up, past a library interface in the supertype list.
    expect(callees('HomeScreen', 'show')).toEqual(['p::Ledger::post']);
    expect(callees('HomeScreen', 'viaThis')).toEqual(['p::Ledger::post']);
    // A primary-constructor property of the base.
    expect(callees('HomeScreen', 'pull')).toEqual(['p::Feed::refresh']);
  });

  it('a receiver not found up to a library base class keeps the name-only resolution', () => {
    // The property may come from the library base, so it is neither typed
    // nor treated as a library type.
    expect(callees('LibScreen', 'go')).toEqual(['p::Sink::drainAll']);
  });

  it('a local of the outer function is typed inside an anonymous object', () => {
    /** Callees of the `fire` override declared inside `Wiring::<fn>`. */
    const fire = (fn: string): string[] => {
      const outer = cg.searchNodes(fn).map((r) => r.node).find((n) => n.qualifiedName.endsWith(`Wiring::${fn}`));
      expect(outer, fn).toBeDefined();
      const node = cg.searchNodes('fire').map((r) => r.node).find(
        (n) => n.filePath.endsWith('Screens.kt') && n.startLine > outer!.startLine && n.startLine <= (outer!.endLine ?? outer!.startLine),
      );
      expect(node, `${fn} fire`).toBeDefined();
      return cg.getCallees(node!.id)
        .filter((c) => c.edge.kind === 'calls' && !c.edge.metadata?.synthesizedBy)
        .map((c) => c.node.qualifiedName);
    };
    expect(fire('wire')).toEqual(['p::Gate::open']);
    // A sibling member's same-named local is not visible from `fire`.
    expect(fire('siblings')).toEqual(['p::Gate::open']);
  });

  it('a nested type keeps its outer type', () => {
    expect(callees('NestedUser', 'release')).toEqual(['p::HardwareLock::Lease::close']);
  });
});
