/**
 * A supertype written through its enclosing type, `Outer.Inner`, names the
 * nested type: Java's `class Named extends Outer.Inner`, `implements
 * Api.Listener` and `new Api.Listener() { … }`, Kotlin's `class K :
 * Outer.Inner()`, C#'s `class N : Outer.IListener`. Before, Java and C# left
 * the path unresolved, Kotlin took its FIRST segment (`Outer`), and a Java
 * anonymous class kept only the last one. A Kotlin object expression,
 * `object : Listener { … }`, is an anonymous class as Java's is: its members
 * are its own, and a call through the interface reaches its override.
 *
 * Cases from @mixxer's #1927 and the T5 triage fixtures.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-dotted-super-'));
  const files: Record<string, string> = {
    'java/p/Api.java': `package p;
public interface Api {
    interface Listener { void on(); }
}
`,
    'java/p/Outer.java': `package p;
public class Outer {
    public static class Inner { public void run() {} }
}
`,
    'java/p/Users.java': `package p;
class Named extends Outer.Inner {
    @Override public void run() {}
}
class Impl implements Api.Listener {
    public void on() {}
}
class Host {
    Api.Listener field = new Api.Listener() {
        public void on() {}
    };
}
`,
    'java/a/Box.java': `package a;
public class Box { public static class Part { public void use() {} } }
`,
    'java/b/Box.java': `package b;
public class Box { public static class Part { public void use() {} } }
`,
    'java/c/Thing.java': `package c;
import a.Box;
class Thing extends Box.Part {
    public void use() {}
}
`,
    'java/d/Stray.java': `package d;
class Stray extends Box.Part {
    public void use() {}
}
`,
    'java/b2/Message.java': `package b2;
public class Message {
    public static class Builder<T extends Builder<T>> {
        public T content(String c) { return null; }
    }
}
`,
    'java/b2/Use.java': `package b2;
class Other {
    static class Builder {
        Builder content(String c) { return this; }
    }
}
class Legacy {
    static LegacyBuilder builder() { return new LegacyBuilder(); }
    static final class LegacyBuilder extends Message.Builder<LegacyBuilder> {}
}
class Use {
    void run() { Legacy.builder().content("x"); }
}
`,
    'kotlin/k/Outer.kt': `package k

open class KOuter {
    open class KInner { open fun run() {} }
    interface KListener { fun on() }
}
`,
    'kotlin/k/Users.kt': `package k

class KNamed : KOuter.KInner() {
    override fun run() {}
}

class KImpl : KOuter.KListener {
    override fun on() {}
}
`,
    'kotlin/k/Flow.kt': `package k

interface Listener { fun onEvent() }

abstract class Base(val n: Int) { abstract fun run() }

class Bus(private val listener: Listener) {
    fun fire() { listener.onEvent() }
}

class Host {
    fun wire(): Bus = Bus(object : Listener {
        override fun onEvent() { handled() }
    })

    fun build(): Base = object : Base(compute()) {
        override fun run() { other() }
    }

    private val held = object : KOuter.KListener {
        override fun on() { handled() }
    }

    fun handled() {}
    fun other() {}
    fun compute(): Int = 1
}
`,
    'kotlin/k/Client.kt': `package k

class Server {
    fun url(path: String): String = path
}
class Remote {
    fun url(path: String): String = path
}
interface Callback {
    fun onResponse()
}
class Caller(private val backup: Server) {
    private val remote: Server = Server()
    fun send(callback: Callback) {}
    fun run() {
        send(object : Callback {
            override fun onResponse() {
                remote.url("/a")
                backup.url("/b")
            }
        })
    }
}
`,
    'kotlin/k/JarApi.kt': `package k

interface Jar {
    fun load()
}
`,
    'kotlin/k/Jar.kt': `package k

enum class Override {
    Jar,
}
class JarUser {
    fun make(): Any = object : Jar {
        override fun load() {}
    }
}
`,
    'kotlin/k/Wrap.kt': `package k

abstract class Body {
    abstract fun measure(): Long
}

fun wrap(original: Body?): Body =
    object : Body() {
        override fun measure(): Long = original!!.measure()
    }

class Tasks {
    interface Task {
        fun ready(): Boolean
    }
    private val queue = ArrayList<Task>()
    fun add() {
        queue.add(object : Task {
            override fun ready() = true
        })
    }
    fun next(): Int = queue.indexOfFirst { it.ready() }
}

interface ScrollListener {
    fun onScroll(d: Int)
}
class Scroller {
    fun onScroll(d: Int) {}
    val listener = object : ScrollListener {
        override fun onScroll(d: Int) = this@Scroller.onScroll(d)
    }
}

class Pipe {
    fun close() {}
    val stream = object : java.io.FilterInputStream(null) {
        override fun close() {
            super.close()
        }
    }
}
`,
    'kotlin/k/Ext.kt': `package k

fun String.produce(): Runnable = object : Runnable {
    override fun run() {}
    fun request(n: Long) {}
}
fun consume(items: List<Any>) {
    items.forEach { it.request(1) }
}
`,
    'kotlin/k/Padding.kt': `package k

interface Padding { val block: Int }

private val padding = object : Padding {
    override val block = 1
}
`,
    'kotlin/k/Runner.kt': `package k

fun runIt(block: () -> Unit) { block() }
`,
    'java/v/Visit.java': `package v;
interface Visitor { void a(); void b(); }
class Walker {
    static final Visitor VISITOR = new Visitor() {
        public void a() { b(); }
        public void b() {}
    };
}
`,
    'csharp/Outer.cs': `namespace Shop
{
    public class Outer
    {
        public class Inner { public virtual void Run() {} }
        public interface IListener { void On(); }
    }
}
`,
    'csharp/Users.cs': `namespace Shop
{
    public class Named : Outer.Inner
    {
        public override void Run() {}
    }
    public class Impl : Outer.IListener
    {
        public void On() {}
    }
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `kind qualified-name` of the supertypes the class named `name` in `file` links to. */
function supertypes(file: string, name: string): string[] {
  const types = cg.getNodesInFile(file).filter((n) => n.kind === 'class' || n.kind === 'interface');
  const from = types.find((n) => n.name === name) ?? types.find((n) => n.name.startsWith(name))!;
  return cg
    .getOutgoingEdgesFrom([from.id])
    .filter((e) => e.kind === 'extends' || e.kind === 'implements')
    .map((e) => `${e.kind} ${cg.getNode(e.target)!.qualifiedName}`)
    .sort();
}

/** Qualified names of what `qualifiedName` calls (or, with `kind`, links to by that kind). */
function callees(qualifiedName: string, kind = 'calls'): string[] {
  const from = cg.searchNodes(qualifiedName.split('::').pop()!).map((r) => r.node).find((n) => n.qualifiedName === qualifiedName)!;
  return cg
    .getOutgoingEdgesFrom([from.id])
    .filter((e) => e.kind === kind)
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('Java: a dotted supertype', () => {
  it('names the nested type it spells', () => {
    expect(supertypes('java/p/Users.java', 'Named')).toEqual(['extends p::Outer::Inner']);
    expect(supertypes('java/p/Users.java', 'Impl')).toEqual(['implements p::Api::Listener']);
  });

  it('is kept whole on an anonymous class', () => {
    expect(supertypes('java/p/Users.java', '<Listener$anon@')).toEqual(['implements p::Api::Listener']);
  });

  it('passes on the methods of the nested type it names, not of a namesake', () => {
    expect(supertypes('java/b2/Use.java', 'LegacyBuilder')).toEqual(['extends b2::Message::Builder']);
    expect(callees('b2::Use::run')).toContain('b2::Message::Builder::content');
    expect(callees('b2::Use::run')).not.toContain('b2::Other::Builder::content');
  });

  it('starts at the type the file imports, or at none it cannot name', () => {
    expect(supertypes('java/c/Thing.java', 'Thing')).toEqual(['extends a::Box::Part']);
    expect(supertypes('java/d/Stray.java', 'Stray')).toEqual([]);
  });
});

describe('Kotlin: a dotted supertype', () => {
  it('names the nested type, not its first segment', () => {
    expect(supertypes('kotlin/k/Users.kt', 'KNamed')).toEqual(['extends k::KOuter::KInner']);
    expect(supertypes('kotlin/k/Users.kt', 'KImpl')).toEqual(['implements k::KOuter::KListener']);
  });
});

describe('Kotlin: an object expression', () => {
  it('is an anonymous class whose overrides are its own members', () => {
    const anon = cg.getNodesInFile('kotlin/k/Flow.kt').filter((n) => n.kind === 'class' && n.name.includes('$anon@'));
    expect(anon.map((n) => n.qualifiedName).sort()).toEqual([
      'k::Host::build::<Base$anon@16>',
      'k::Host::held::<KListener$anon@20>',
      'k::Host::wire::<Listener$anon@12>',
    ]);
    expect(supertypes('kotlin/k/Flow.kt', '<Listener$anon@')).toEqual(['implements k::Listener']);
    expect(supertypes('kotlin/k/Flow.kt', '<Base$anon@')).toEqual(['extends k::Base']);
    expect(supertypes('kotlin/k/Flow.kt', '<KListener$anon@')).toEqual(['implements k::KOuter::KListener']);
  });

  it('is instantiated by the code around it, as its supertype is written', () => {
    expect(callees('k::Host::held', 'instantiates')).toEqual(['k::KOuter::KListener']);
    expect(callees('k::Host::wire', 'instantiates')).toEqual(['k::Bus', 'k::Listener']);
    // Never an enum entry of the name, which no object extends.
    expect(callees('k::JarUser::make', 'instantiates')).toEqual(['k::Jar']);
  });

  it('keeps its header in the code around it, and its body in its members', () => {
    expect(callees('k::Host::build')).toContain('k::Host::compute');
    expect(callees('k::Host::build::<Base$anon@16>::run')).toEqual(['k::Host::other']);
    expect(callees('k::Host::wire::<Listener$anon@12>::onEvent')).toEqual(['k::Host::handled']);
  });

  it('is reached through the interface it implements', () => {
    expect(callees('k::Listener::onEvent')).toEqual(['k::Host::wire::<Listener$anon@12>::onEvent']);
    expect(callees('k::Base::run')).toEqual(['k::Host::build::<Base$anon@16>::run']);
  });

  it('sees the properties of the class it is written in', () => {
    expect(callees('k::Caller::run::<Callback$anon@16>::onResponse')).toEqual(['k::Server::url', 'k::Server::url']);
  });

  it('leaves the names it overrides to the code that calls them', () => {
    // A call its override makes on another object is not the override itself.
    expect(callees('k::wrap::<Body$anon@8>::measure')).toEqual(['k::Body::measure']);
    expect(callees('k::Scroller::listener::<ScrollListener$anon@30>::onScroll')).toEqual(['k::Scroller::onScroll']);
    // `super.close()` is the library parent's, not the class around the object.
    expect(callees('k::Pipe::stream::<FilterInputStream$anon@37>::close')).toEqual([]);
    // Its override outside the object's reach leaves the interface's method the one of that name.
    expect(callees('k::Tasks::next')).toEqual(['k::Tasks::Task::ready']);
  });
});

describe('An anonymous class\'s members', () => {
  it('are named only inside the declaration holding the class', () => {
    expect(callees('k::runIt').filter((qn) => qn.includes('$anon@'))).toEqual([]);
    // An extension function holds one too, though it is named by its receiver (`String::produce`).
    expect(callees('k::consume').filter((qn) => qn.includes('$anon@'))).toEqual([]);
    expect(callees('v::Walker::VISITOR::<Visitor$anon@4>::a')).toEqual(['v::Walker::VISITOR::<Visitor$anon@4>::b']);
  });
});

describe('C#: a dotted base type', () => {
  it('names the nested type it spells', () => {
    expect(supertypes('csharp/Users.cs', 'Named')).toEqual(['extends Shop::Outer::Inner']);
    expect(supertypes('csharp/Users.cs', 'Impl')).toEqual(['implements Shop::Outer::IListener']);
  });
});
