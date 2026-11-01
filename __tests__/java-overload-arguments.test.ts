/**
 * Which of a Java class's overloads a call means depends on its arguments'
 * static types, and the ranking only had their count and which was declared
 * nearest: jsoup's `super.before(node)`, with `node` a `Node`, reached the first
 * `before`, the `String` one, and rocksdb's `it.seek(k2)`, with `k2` a
 * `ByteBuffer`, reached `seek(byte[])`. The arguments are read where their text
 * says: a literal, a cast, a `new`, `this`, a local, a parameter, a field, a call
 * on one of those.
 *
 * A lambda's parameter has the type the method it is passed to declares: `tb`
 * in `check(new HtmlTreeBuilder(), tb -> tb.process())` is a `HtmlTreeBuilder`
 * when `check` takes a `Consumer<HtmlTreeBuilder>`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

const FILES: Record<string, string> = {
  // jsoup's Node, Element and Elements, and rocksdb's iterator.
  'src/n/Node.java': `package n;

public class Node {
    public Node before(String html) { return this; }
    public Node before(Node node) { return this; }
    public void remove(int index) {}
    public boolean remove(Object o) { return true; }
    public void pick(long id) {}
    public void pick(boolean flag) {}
    public void pick(char c) {}
    public void pick(double d) {}
    public void pick(String s) {}
    public void pick(Node node) {}
    public void pick(Node[] nodes) {}
    public void pick(int[] ids) {}
    public void log(String message) {}
    public void log(String format, Object... args) {}
    public void attach(Holder holder) {}
    public void attach(Other other) {}
    public <T> void generic(T value, String name) {}
    public <T> void generic(T value, int index) {}
}
`,
  'src/n/Holder.java': 'package n;\n\npublic interface Holder {\n}\n',
  'src/n/Other.java': 'package n;\n\npublic class Other {\n}\n',
  'src/n/Base.java': 'package n;\n\npublic class Base implements Holder {\n}\n',
  'src/n/Leaf.java': 'package n;\n\npublic class Leaf extends Base {\n}\n',
  'src/n/Element.java': `package n;

public class Element extends Node {
    private final String label = "x";
    private static final Node[] SHARED = new Node[0];

    @Override public Element before(String html) { return (Element) super.before(html); }
    @Override public Element before(Node node) { return (Element) super.before(node); }

    void removeAt(int index) { super.remove(index); }
    void removeOne(Object o) { super.remove(o); }

    void literals(Node[] nodes, int[] ids) {
        pick(1L);
        pick(true);
        pick('c');
        pick(1.5);
        pick("s");
        pick("a" + label);
        pick(new Node());
        pick(new Node[2]);
        pick(new int[] { 1 });
        pick((Node) nodes[0]);
        pick(nodes);
        pick(ids);
        pick(this);
        pick(label);
        pick(SHARED);
    }

    void chained() {
        pick(new Node().toString());
    }

    void widen(int small) {
        pick(small);
    }

    void locals() {
        final String text = "x";
        pick(text);
        for (Node each : new Node[0]) {
            pick(each);
        }
    }

    void fixedArityFirst() {
        log("only");
        log("with %s", label);
    }

    void subtypes(Leaf leaf, Other other) {
        attach(leaf);
        attach(other);
    }

    <T> void generics(T value) {
        generic(value, "n");
        generic(value, 1);
    }
}
`,
  // jsoup's test helper taking a Consumer, and a namesake's methods to stay out of.
  'src/t/Builder.java': 'package t;\n\npublic class Builder {\n    public void process() {}\n    public void other() {}\n}\n',
  'src/t/Elsewhere.java': 'package t;\n\npublic class Elsewhere {\n    public void process() {}\n    public void other() {}\n}\n',
  'src/t/BuilderTest.java': `package t;

import java.util.function.BiConsumer;
import java.util.function.Consumer;

public class BuilderTest {
    void one() {
        check(new Builder(), tb -> {
            tb.process();
        });
    }

    void two() {
        both((left, right) -> {
            left.process();
            right.other();
        });
    }

    void library() {
        names(text -> text.process());
    }

    void onReceiver(java.util.List<Object> list) {
        list.forEach(item -> item.other());
    }

    private static void check(Builder tb, Consumer<Builder> exercise) { exercise.accept(tb); }
    private static void both(BiConsumer<Builder, Elsewhere> exercise) {}
    private static void names(Consumer<String> exercise) {}
}
`,
  // spring-ai's converter: its overload for the exact type is private.
  'src/v/Operand.java': 'package v;\n\npublic interface Operand {\n}\n',
  'src/v/Expression.java': 'package v;\n\npublic class Expression implements Operand {\n}\n',
  'src/v/Converter.java': `package v;

public class Converter {
    public String convert(Operand operand) {
        return convert((Expression) operand);
    }

    private String convert(Expression expression) {
        return "";
    }

    private void hidden(Expression expression) {}

    public void hiddenOverload(Operand operand) {}
}
`,
  'src/v/Caller.java': `package v;

public class Caller {
    private static final Converter CONVERTER = new Converter();

    String fromAnotherFile(Expression e) {
        return CONVERTER.convert(e);
    }
}
`,
  // elasticsearch's Errors: public overloads the call has to pick from by what its argument returns.
  'src/g/Message.java': 'package g;\n\npublic class Message {\n}\n',
  'src/g/Errors.java': `package g;

import java.util.Collection;

public class Errors {
    private Message merge(Message message) { return message; }
    public Errors merge(Collection<Message> messages) { return this; }
    public Errors merge(Errors more) { return this; }
    public Errors merge(Thrown thrown) { return this; }
}
`,
  'src/g/Thrown.java': `package g;

import java.util.Collection;

public class Thrown extends RuntimeException {
    public static Errors shared() { return null; }
    public static Errors shared(String name) { return null; }
    public Errors getErrors() { return null; }
    public Collection<Message> getMessages() { return null; }
    public Thrown self() { return this; }
    public Message one() { return null; }
    public Errors mixed(String name) { return null; }
    public Collection<Message> mixed(int size) { return null; }
    public Errors counted() { return null; }
    public String counted(String name) { return name; }
}
`,
  'src/g/Handler.java': `package g;

public class Handler {
    private final Thrown held = new Thrown();

    void caught(Errors errors) {
        try {
            run();
        } catch (Thrown e) {
            errors.merge(e.getErrors());
            errors.merge(e.getMessages());
        }
    }

    void onField(Errors errors) {
        errors.merge(held.getErrors());
        errors.merge(this.held.getMessages());
    }

    void onType(Errors errors) {
        errors.merge(Thrown.shared());
    }

    void longChain(Errors errors, Thrown e) {
        errors.merge(e.self().getErrors());
    }

    void overloadsDisagree(Errors errors, Thrown e) {
        errors.merge(e.mixed(make2()));
    }

    void overloadsOfItsCount(Errors errors, Thrown e) {
        errors.merge(e.counted());
    }

    void receiverless(Errors errors) {
        errors.merge(make());
    }

    private Errors make() { return null; }
    private String make2() { return null; }
    private void run() {}
}
`,
  // Minestom's Command: an argument that can't be read says nothing of the parameters there.
  'src/c/Syntax.java': `package c;

public class Syntax {
    public void add(Syntax... args) {}
    public void add(String format) {}
    public void value(java.util.function.Function<String, Integer> supplied) {}
    public <T> void value(T plain) {}
    public void bytes(java.nio.ByteBuffer key) {}
    public void bytes(byte[] key) {}
    public void shared(Syntax first, Runnable run) {}
    public void shared(Object first, Runnable run) {}
}
`,
  'src/c/Registrar.java': `package c;

public class Registrar {
    private void work() {}

    void varargsStays(Syntax syntax) {
        syntax.add(new Syntax());
        syntax.add(unread());
    }

    void literalIsNoFunction(Syntax syntax) {
        syntax.value(6);
        syntax.value("six");
    }

    void variableArity(Syntax syntax, byte... many) {
        syntax.bytes(many);
    }

    void arrayMarkersAfterTheName(Syntax syntax, byte other[]) {
        final byte key[] = new byte[1];
        syntax.bytes(key);
        syntax.bytes(other);
    }

    void sameParameterThere(Syntax syntax) {
        syntax.shared(new Syntax(), this::work);
    }

    private Syntax unread() { return null; }
}
`,
  // rocksdb's RocksDB: native overloads taking the handles every class inherits, and a comment in a parameter.
  'src/d/Native.java': 'package d;\n\npublic class Native {\n    protected final long handle_ = 0;\n    public static final byte[] EMPTY = new byte[0];\n}\n',
  'src/d/Options.java': 'package d;\n\npublic class Options extends Native {\n}\n',
  'src/d/Handle.java': 'package d;\n\npublic class Handle extends Native {\n}\n',
  'src/d/Db.java': `package d;

import java.util.List;

public class Db extends Native {
    public byte[] get(Handle handle, byte[] key) { return get(handle_, key); }
    public byte[] get(Options options, byte[] key) { return get(this.handle_, options.handle_, key); }
    private native byte[] get(long handle, byte[] key);
    private native byte[] get(long handle, long options, byte[] key);
    public byte[] get(Handle handle, Options options, byte[] key) { return key; }

    public void flush(Options options, /* @Nullable */ final Handle handle) {}
    public void flush(Options options, final List<Handle> handles) {}

    public void put(byte[] key) {}
    public void put(java.nio.ByteBuffer key) {}
    public void put(int size) {}
}
`,
  'src/d/DbTest.java': `package d;

import java.util.List;

public class DbTest {
    private byte[][] keys;

    void commented(Db db, Options options, List<Handle> handles) {
        db.flush(options, handles);
    }

    private int size;

    void varHidesTheField(Db db, Object anything) {
        final var size = anything;
        db.put(size);
    }

    void throughFields(Db db, byte[] key) {
        db.put(Native.EMPTY);
        db.put(keys[0]);
        db.put(key.length);
    }
}
`,
  'src/r/Iter.java': `package r;

import java.nio.ByteBuffer;

public class Iter {
    public void seek(byte[] target) {}
    public void seek(ByteBuffer target) {}
}
`,
  'src/r/WriteTest.java': `package r;

import java.nio.ByteBuffer;

public class WriteTest {
    void byTypedReceiver(Iter it, byte[] raw) {
        final ByteBuffer k2 = ByteBuffer.allocateDirect(8);
        it.seek(k2);
        it.seek(raw);
    }
}
`,
};

describe('a Java call\'s arguments pick its overload', () => {
  let dir: string;
  let cg: CodeGraph;
  let lines: Record<string, string[]>;

  /** The parameter lists a method's call on the given line text reaches (of `only`, when there are two on the line). */
  const calledFrom = (method: string, callText: string, only?: string): string[] => {
    const from = cg.getNodesByKind('method').find((n: Node) => n.name === method);
    expect(from, method).toBeDefined();
    const file = from!.filePath;
    const line = lines[file]!.findIndex((text, i) => i >= from!.startLine - 1 && text.includes(callText)) + 1;
    expect(line, callText).toBeGreaterThan(0);
    return cg.getOutgoingEdges(from!.id).filter((e) => e.kind === 'calls' && e.line === line)
      .map((e) => cg.getNode(e.target)!).filter((n) => !only || n.name === only)
      .map((n) => n.signature ?? '').map((s) => s.slice(s.indexOf('('))).sort();
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-overloads-'));
    lines = {};
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
      lines[rel] = text.split('\n');
    }
    cg = await CodeGraph.init(dir, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads what a call passed as an argument returns', () => {
    expect(calledFrom('caught', 'errors.merge(e.getErrors())', 'merge')).toEqual(['(Errors more)']);
    expect(calledFrom('caught', 'errors.merge(e.getMessages())', 'merge')).toEqual(['(Collection<Message> messages)']);
    expect(calledFrom('onField', 'errors.merge(held.getErrors())', 'merge')).toEqual(['(Errors more)']);
    expect(calledFrom('onField', 'errors.merge(this.held.getMessages())', 'merge')).toEqual(['(Collection<Message> messages)']);
    expect(calledFrom('overloadsOfItsCount', 'errors.merge(e.counted())', 'merge')).toEqual(['(Errors more)']);
  });

  it('reads a type\'s static method only when its overloads agree', () => {
    expect(calledFrom('onType', 'errors.merge(Thrown.shared())', 'merge')).toEqual(['(Errors more)']);
  });

  it('makes no call of one it can\'t tell apart, past a private overload of another file', () => {
    for (const [method, text] of [['longChain', 'errors.merge(e.self()'], ['overloadsDisagree', 'errors.merge(e.mixed(make2()))'], ['receiverless', 'errors.merge(make())']] as const) {
      expect(calledFrom(method, text, 'merge'), text).toEqual([]);
    }
  });

  it('keeps a variable-arity overload for an argument it can\'t read', () => {
    expect(calledFrom('varargsStays', 'syntax.add(new Syntax())', 'add')).toEqual(['(Syntax... args)']);
    expect(calledFrom('varargsStays', 'syntax.add(unread())', 'add')).toEqual(['(Syntax... args)']);
  });

  it('reads a field the class inherits, and one read through a receiver', () => {
    const called = (sig: string): string[] => {
      const from = cg.getNodesByKind('method').find((n) => n.filePath === 'src/d/Db.java' && n.name === 'get' && n.signature?.includes(sig))!;
      return cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.signature!).map((s) => s.slice(s.indexOf('(')));
    };
    expect(called('Handle handle, byte[] key')).toEqual(['(long handle, byte[] key)']);
    expect(called('(Options options, byte[] key')).toEqual(['(long handle, long options, byte[] key)']);
  });

  it('leaves a comment in a parameter out of its type', () => {
    expect(calledFrom('commented', 'db.flush(options, handles)', 'flush')).toEqual(['(Options options, final List<Handle> handles)']);
  });

  it('doesn\'t take a `var` for the field it hides', () => {
    expect(calledFrom('varHidesTheField', 'db.put(size)', 'put')).toEqual(['(byte[] key)']);
  });

  it('reads a type\'s field, an array\'s element and its length', () => {
    expect(calledFrom('throughFields', 'db.put(Native.EMPTY)', 'put')).toEqual(['(byte[] key)']);
    expect(calledFrom('throughFields', 'db.put(keys[0])', 'put')).toEqual(['(byte[] key)']);
    expect(calledFrom('throughFields', 'db.put(key.length)', 'put')).toEqual(['(int size)']);
  });

  it('takes no number or string for a function', () => {
    expect(calledFrom('literalIsNoFunction', 'syntax.value(6)', 'value')).toEqual(['(T plain)']);
    expect(calledFrom('literalIsNoFunction', 'syntax.value("six")', 'value')).toEqual(['(T plain)']);
  });

  it('takes a variable-arity parameter for the array it is', () => {
    expect(calledFrom('variableArity', 'syntax.bytes(many)', 'bytes')).toEqual(['(byte[] key)']);
  });

  it('reads array markers written after the name', () => {
    expect(calledFrom('arrayMarkersAfterTheName', 'syntax.bytes(key)', 'bytes')).toEqual(['(byte[] key)']);
    expect(calledFrom('arrayMarkersAfterTheName', 'syntax.bytes(other)', 'bytes')).toEqual(['(byte[] key)']);
  });

  it('goes by the others when it can\'t read one', () => {
    expect(calledFrom('sameParameterThere', 'syntax.shared(new Syntax(), this::work)', 'shared')).toEqual(['(Syntax first, Runnable run)']);
  });

  it('reads a `super` call\'s parameter', () => {
    const overrides = cg.getNodesByKind('method').filter((n) => n.name === 'before' && n.filePath === 'src/n/Element.java');
    const called = (sig: string): string[] => {
      const from = overrides.find((n) => n.signature?.includes(sig))!;
      return cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.signature!);
    };
    expect(called('Node node')).toEqual(['Node (Node node)']);
    expect(called('String html')).toEqual(['Node (String html)']);
    expect(calledFrom('removeAt', 'super.remove(index)')).toEqual(['(int index)']);
    expect(calledFrom('removeOne', 'super.remove(o)')).toEqual(['(Object o)']);
  });

  it('reads a typed receiver\'s call the same way', () => {
    expect(calledFrom('byTypedReceiver', 'it.seek(k2)')).toEqual(['(ByteBuffer target)']);
    expect(calledFrom('byTypedReceiver', 'it.seek(raw)')).toEqual(['(byte[] target)']);
  });

  it('leaves out a private overload from another file, and keeps it in its own', () => {
    expect(calledFrom('fromAnotherFile', 'CONVERTER.convert(e)')).toEqual(['(Operand operand)']);
    const pub = cg.getNodesByKind('method').find((n) => n.name === 'convert' && n.signature?.includes('Operand'))!;
    const called = cg.getOutgoingEdges(pub.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.signature);
    expect(called).toEqual(['String (Expression expression)']);
  });

  it('types a lambda\'s parameter by the functional interface it is written for', () => {
    const called = (name: string): string[] => {
      const from = cg.getNodesByKind('method').find((n: Node) => n.name === name && n.filePath === 'src/t/BuilderTest.java')!;
      return cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.qualifiedName).sort();
    };
    expect(called('one')).toContain('t::Builder::process');
    expect(called('two')).toEqual(expect.arrayContaining(['t::Builder::process', 't::Elsewhere::other']));
    expect(called('two')).not.toContain('t::Elsewhere::process');
    expect(called('library')).not.toContain('t::Builder::process');
    expect(called('onReceiver')).toEqual([]);
  });

  it('reads literals, casts, `new`, `this`, parameters and fields', () => {
    const expected: Array<[string, string]> = [
      ['pick(1L)', '(long id)'],
      ['pick(true)', '(boolean flag)'],
      ["pick('c')", '(char c)'],
      ['pick(1.5)', '(double d)'],
      ['pick("s")', '(String s)'],
      ['pick("a" + label)', '(String s)'],
      ['pick(new Node())', '(Node node)'],
      ['pick(new Node[2])', '(Node[] nodes)'],
      ['pick(new int[] { 1 })', '(int[] ids)'],
      ['pick((Node) nodes[0])', '(Node node)'],
      ['pick(nodes)', '(Node[] nodes)'],
      ['pick(ids)', '(int[] ids)'],
      ['pick(this)', '(Node node)'],
      ['pick(label)', '(String s)'],
      ['pick(SHARED)', '(Node[] nodes)'],
    ];
    for (const [call, params] of expected) expect(calledFrom('literals', call), call).toEqual([params]);
  });

  it('widens a primitive, and reads locals with their modifiers', () => {
    expect(calledFrom('widen', 'pick(small)')).toEqual(['(long id)']);
    expect(calledFrom('locals', 'pick(text)')).toEqual(['(String s)']);
    expect(calledFrom('locals', 'pick(each)')).toEqual(['(Node node)']);
  });

  it('says nothing of what a chain returns, or of a `new` it goes on from', () => {
    expect(calledFrom('chained', 'pick(new Node().toString())')).toHaveLength(1);
  });

  it('tries a call without variable arity first', () => {
    expect(calledFrom('fixedArityFirst', 'log("only")')).toEqual(['(String message)']);
    expect(calledFrom('fixedArityFirst', 'log("with %s", label)')).toEqual(['(String format, Object... args)']);
  });

  it('follows a project type up to its supertypes', () => {
    expect(calledFrom('subtypes', 'attach(leaf)')).toEqual(['(Holder holder)']);
    expect(calledFrom('subtypes', 'attach(other)')).toEqual(['(Other other)']);
  });

  it('reads the other arguments past a type parameter', () => {
    expect(calledFrom('generics', 'generic(value, "n")')).toEqual(['(T value, String name)']);
    expect(calledFrom('generics', 'generic(value, 1)')).toEqual(['(T value, int index)']);
  });
});
