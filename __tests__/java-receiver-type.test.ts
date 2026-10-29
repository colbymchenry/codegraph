/**
 * A Java call through a field or a local resolves on the receiver's declared
 * type, and a receiver of a library type gets no edge.
 *
 * The field lookup only read the tightest enclosing class and only a plain
 * name, so `this.mRepo.save()`, `Outer.this.mRepo.save()`, a field read from
 * inside an anonymous class and a field chain `mOwner.repo.save()` were all
 * left to name-only guessing. And when the declared type WAS known but was a
 * library class (`Parcel`, `Handler`, `List`), the call fell through to the
 * same guessing, which bound it to whichever project class declares a method
 * of that name (`parcel.readInt()` → a project `VersionedParcel.readInt`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('Java receivers resolve on the declared type', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-recv-'));
    const src = path.join(dir, 'src', 'p');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'Repo.java'), `package p;
public class Repo {
    public void save() {}
    public void close() {}
}
`);
    fs.writeFileSync(path.join(src, 'Owner.java'), `package p;
public class Owner {
    public Repo repo = new Repo();
    public android.content.Context ctx;
}
`);
    fs.writeFileSync(path.join(src, 'Hook.java'), `package p;
public abstract class Hook {
    public abstract void fire();
}
`);
    fs.writeFileSync(path.join(src, 'Box.java'), `package p;
public class Box<T> {
    public void seal() {}
}
`);
    // Same-named methods on unrelated project classes: what a name-only
    // guess lands on. The decoy sits in the callers' own file below too.
    fs.writeFileSync(path.join(src, 'VersionedParcel.java'), `package p;
public class VersionedParcel {
    public int readInt() { return 0; }
    public void writeInt(int v) {}
}
`);
    // Project types nested in other packages that share a simple name with
    // a JDK type the callers use.
    fs.mkdirSync(path.join(dir, 'src', 'q'));
    fs.writeFileSync(path.join(dir, 'src', 'q', 'Bytes.java'), `package q;
public class Bytes {
    public static class Iterator { public boolean hasNext() { return false; } }
}
`);
    fs.writeFileSync(path.join(dir, 'src', 'q', 'Table.java'), `package q;
public class Table {
    public static class Entry { public Object getKey() { return null; } }
}
`);
    // A Scala type of the same simple name as a Java one, reached from a
    // Java file through a wildcard import.
    fs.writeFileSync(path.join(src, 'Form.java'), `package p;
public class Form<T> {
    public T get() { return null; }
}
`);
    fs.mkdirSync(path.join(dir, 'src', 'a'));
    fs.writeFileSync(path.join(dir, 'src', 'a', 'Form.scala'), `package api
class Form(value: Int) {
  def get(): Int = value
}
`);
    // A Scala trait in a file not named after it, imported explicitly.
    fs.mkdirSync(path.join(dir, 'src', 'api', 'mvc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'api', 'mvc', 'BodyParsers.scala'), `package api.mvc
trait PlayBodyParsers {
  def raw(): Int
}
`);
    // Same simple names in another package, indexed first: what an unpinned
    // lookup would land on.
    fs.mkdirSync(path.join(dir, 'src', 'b'));
    fs.writeFileSync(path.join(dir, 'src', 'b', 'Cookie.java'), `package b;
public class Cookie { public String value() { return null; } }
`);
    fs.writeFileSync(path.join(dir, 'src', 'b', 'PlayBodyParsers.java'), `package b;
public class PlayBodyParsers { public int raw() { return 0; } }
`);
    fs.writeFileSync(path.join(src, 'Http.java'), `package p;
public class Http {
    public static class Cookie { public String value() { return null; } }
}
`);
    fs.mkdirSync(path.join(dir, 'src', 'r'));
    fs.writeFileSync(path.join(dir, 'src', 'r', 'Controller.java'), `package r;
import api.mvc.PlayBodyParsers;
import p.*;
import p.Http.Cookie;
public class Controller {
    void submit(Form<String> form) { form.get(); }
    void parse(PlayBodyParsers parsers) { parsers.raw(); }
    void written(api.mvc.PlayBodyParsers other) { other.raw(); }
    void writtenLocal() {
        api.mvc.PlayBodyParsers local = null;
        local.raw();
    }
    void cookie(Cookie crumb) { crumb.value(); }
}
`);
    fs.writeFileSync(path.join(src, 'Screen.java'), `package p;

import android.os.Handler;
import android.os.Parcel;
import android.util.Log;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import q.Bytes;

class Decoy {
    void save() {}
    void post(Runnable r) {}
    void add(Object o) {}
    void put(Object k, Object v) {}
    void d(String t, String m) {}
    void getResources() {}
    void seal() {}
}
// Decoys whose names share words with the receivers, so a receiver-name
// guess prefers them over the declared type.
class StoreCache { void save() {} void close() {} }
class SharedCache { void close() {} }
class OwnerRepoCache { void save() {} }
class BoxCache { void seal() {} }

public class Screen {
    private Repo mStore;
    private Handler mHandler;
    private Owner mOwner;
    private static final Repo sShared = new Repo();

    void viaField() { mStore.save(); }
    void viaThis() { this.mStore.save(); }
    void viaConstant() { sShared.close(); }
    void viaChain() { mOwner.repo.save(); }
    void viaThisChain() { this.mOwner.repo.save(); }
    void viaLocalChain(Owner owner) { owner.repo.save(); }
    void libraryField() { mHandler.post(null); }
    void libraryChain() { mOwner.ctx.getResources(); }
    void libraryParam(Parcel parcel) { parcel.readInt(); parcel.writeInt(1); }
    void libraryGenericLocal() {
        List<String> items = null;
        items.add("x");
        Map<String, List<Repo>> byName = null;
        byName.put("k", null);
    }
    void libraryForEach(List<Parcel> parcels) {
        for (Parcel p : parcels) { p.readInt(); }
    }
    void projectGenericLocal() {
        Box<Repo> crate = make();
        crate.seal();
    }
    void iterate(List<Repo> list) {
        Iterator<Repo> it = list.iterator();
        it.hasNext();
    }
    void entries(Map<String, String> map) {
        for (Map.Entry<String, String> e : map.entrySet()) { e.getKey(); }
    }
    void nested(Bytes.Iterator bytes) { bytes.hasNext(); }
    static Box<Repo> make() { return null; }
    void staticLibrary() { Log.d("t", "m"); }

    Runnable anonymous() {
        return new Runnable() {
            public void run() { mStore.save(); }
        };
    }

    class Inner {
        private Box<Repo> mStore;
        void viaOuter() { Screen.this.mStore.close(); }
    }
}

class Holder<T extends Hook> {
    T hook;
    void go() { hook.fire(); }
}
`);
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Qualified names of what `owner.method` calls (`owner` may name an anonymous class's supertype). */
  function callees(owner: string, method: string): string[] {
    const node = cg.searchNodes(method).map((r) => r.node)
      .find((n) => n.qualifiedName.endsWith(`${owner}::${method}`) || (n.qualifiedName.includes(`${owner}$anon`) && n.qualifiedName.endsWith(`::${method}`)));
    expect(node, `${owner}::${method}`).toBeDefined();
    return cg.getCallees(node!.id)
      .filter((c) => c.edge.kind === 'calls')
      .map((c) => c.node.qualifiedName)
      .sort();
  }

  it('a field, `this.field` and a static final field resolve on the declared type', () => {
    expect(callees('Screen', 'viaField')).toEqual(['p::Repo::save']);
    expect(callees('Screen', 'viaThis')).toEqual(['p::Repo::save']);
    expect(callees('Screen', 'viaConstant')).toEqual(['p::Repo::close']);
  });

  it('an anonymous class reads its outer class field, and `Outer.this.field` names the class', () => {
    expect(callees('Runnable', 'run')).toEqual(['p::Repo::save']);
    expect(callees('Inner', 'viaOuter')).toEqual(['p::Repo::close']);
  });

  it('a chain of fields resolves through each declared type', () => {
    expect(callees('Screen', 'viaChain')).toEqual(['p::Repo::save']);
    expect(callees('Screen', 'viaThisChain')).toEqual(['p::Repo::save']);
    expect(callees('Screen', 'viaLocalChain')).toEqual(['p::Repo::save']);
  });

  it('a field, a chain hop, a parameter or a local of a library type gets no edge', () => {
    expect(callees('Screen', 'libraryField')).toEqual([]);
    expect(callees('Screen', 'libraryChain')).toEqual([]);
    expect(callees('Screen', 'libraryParam')).toEqual([]);
    expect(callees('Screen', 'libraryGenericLocal')).toEqual([]);
    expect(callees('Screen', 'libraryForEach')).toEqual([]);
    // A static call on an imported library class (`Log.d` beside a project `Decoy.d`).
    expect(callees('Screen', 'staticLibrary')).toEqual([]);
  });

  it('a JDK type is not read as a same-named type nested in another package', () => {
    // An explicit `import java.util.Iterator`, and a qualified `Map.Entry`.
    expect(callees('Screen', 'iterate')).toEqual([]);
    expect(callees('Screen', 'entries')).toEqual([]);
  });

  it('a nested project type written with its outer class resolves on it', () => {
    expect(callees('Screen', 'nested')).toEqual(['q::Bytes::Iterator::hasNext']);
  });

  it('a generic local of a project type resolves on that type', () => {
    expect(callees('Screen', 'projectGenericLocal')).toEqual(['p::Box::seal', 'p::Screen::make']);
  });

  it('a Java receiver type prefers the Java declaration over a same-named Scala one', () => {
    expect(callees('Controller', 'submit')).toEqual(['p::Form::get']);
  });

  it('an explicitly imported Scala type is a project type wherever its file is named', () => {
    expect(callees('Controller', 'parse')).toEqual(['PlayBodyParsers::raw']);
    expect(callees('Controller', 'written')).toEqual(['PlayBodyParsers::raw']);
    expect(callees('Controller', 'writtenLocal')).toEqual(['PlayBodyParsers::raw']);
  });

  it('an imported nested type is the one the import names', () => {
    expect(callees('Controller', 'cookie')).toEqual(['p::Http::Cookie::value']);
  });

  it('a type-parameter receiver is not treated as a library type', () => {
    expect(callees('Holder', 'go')).toEqual(['p::Hook::fire']);
  });
});

describe('Java receivers keep the type their declaration names', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-field-written-'));
    const write = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    write('src/a/Pause.java', `package a;
public class Pause {
    public static class Suite {
        public void runDelay(String id) {}
    }
}
`);
    write('src/a/http/Request.java', `package a.http;
public class Request {
    public String getBody() { return ""; }
}
`);
    // kestra's AbstractRunnerTest: `protected PauseTest.Suite pauseTest;` under
    // `import io.kestra.plugin.core.flow.*;`, and RequestTest's field written
    // with the project package beside an import of a library `HttpRequest`.
    write('src/b/Runner.java', `package b;

import a.*;
import io.lib.Request;

public class Runner {
    protected Pause.Suite pause;
    private a.http.Request request;

    public void delay() {
        pause.runDelay("x");
    }

    public void body() {
        request.getBody();
    }

    // spring-ai's \`org.springframework.ai.chat.messages.Message message\` beside
    // an import of the Anthropic SDK's \`Message\`: a local or loop variable
    // written with its package.
    public void localBody(java.util.List<a.http.Request> all) {
        a.http.Request first = all.get(0);
        first.getBody();
    }

    public void eachBody(java.util.List<a.http.Request> all) {
        for (a.http.Request each : all) {
            each.getBody();
        }
    }
}
`);
    // SystemUI's QSTileImpl<TState extends State>: a field typed by the class's
    // type parameter, beside another class's same-named method.
    write('src/a/State.java', `package a;
public class State {
    public void copyTo(State other) {}
}
`);
    write('src/a/Other.java', `package a;
public class Other {
    public void copyTo(Other other) {}
}
`);
    write('src/b/Tile.java', `package b;

import a.State;

public abstract class Tile<TState extends State> {
    private TState mTmpState;

    public void refresh() {
        mTmpState.copyTo(null);
    }
}
`);
    // SystemUI's HeadsUpManagerPhone: `AlertEntry`, nested in a class two
    // levels up its hierarchy, named without an import.
    write('src/a/Alerts.java', `package a;
public abstract class Alerts {
    public static class Entry {
        public void update() {}
    }
}
`);
    write('src/a/HeadsUp.java', `package a;
public abstract class HeadsUp extends Alerts {}
`);
    write('src/c/Store.java', `package c;
public class Store {
    public void update() {}
}
`);
    write('src/b/Phone.java', `package b;

import a.HeadsUp;

public class Phone extends HeadsUp {
    public void refresh(java.util.List<Entry> entries) {
        for (Entry entry : entries) {
            entry.update();
        }
    }
}
`);
    // kestra: a `java.net.URI` (short enough to read as a type parameter) and
    // a project enum, whose `name()` is Java's, beside project methods the
    // receivers' names match.
    write('src/a/FlowWithPath.java', `package a;
public class FlowWithPath {
    public String getPath() { return ""; }
}
`);
    write('src/a/Type.java', `package a;
public class Type {
    public String name() { return ""; }
}
`);
    write('src/a/ServiceType.java', `package a;
public enum ServiceType { WORKER, EXECUTOR }
`);
    write('src/b/Storage.java', `package b;

import java.net.URI;
import a.ServiceType;

public class Storage {
    private URI base;
    private ServiceType kind;

    public void local(URI path, ServiceType type) {
        path.getPath();
        type.name();
    }

    public void field() {
        base.getPath();
        kind.name();
    }
}
`);
    // playframework's javaguide: `import play.mvc.Http.*;` names Http's
    // nested `RequestBody`.
    write('src/a/Web.java', `package a;
public class Web {
    public static class Body {
        public String asText() { return ""; }
    }
}
`);
    write('src/b/Parsers.java', `package b;

import a.Web.*;

public class Parsers {
    public void read(Body body) {
        body.asText();
    }
}
`);
    // spring-modulith's ApplicationModule: `Comparable<ApplicationModule>` in
    // the class head names the class, not a type parameter, and a nested
    // class's field of that type types the call on a local named like it.
    write('src/a/AppModule.java', `package a;
public class AppModule implements Comparable<AppModule> {
    public java.util.List<String> getNames() { return null; }
    public int compareTo(AppModule other) { return 0; }

    public static class Link {
        private final AppModule target;

        Link(AppModule target) { this.target = target; }

        static Link of(AppModule source) {
            var target = source.find();
            var names = target.getNames();
            return null;
        }
    }

    public AppModule find() { return this; }
}
`);
    write('src/c/Other.java', `package c;
public class Other {
    public java.util.List<String> getNames() { return null; }
}
`);
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function callees(owner: string, method: string): string[] {
    const node = cg.searchNodes(method).map((r) => r.node).find((n) => n.qualifiedName.endsWith(`${owner}::${method}`));
    expect(node, `${owner}::${method}`).toBeDefined();
    return cg.getCallees(node!.id).filter((c) => c.edge.kind === 'calls').map((c) => c.node.qualifiedName).sort();
  }

  it('a field typed with its outer class, through an on-demand import, resolves on the nested type', () => {
    expect(callees('Runner', 'delay')).toEqual(['a::Pause::Suite::runDelay']);
  });

  it('a field written with its package resolves on that type, whatever the file imports by the name', () => {
    expect(callees('Runner', 'body')).toEqual(['a.http::Request::getBody']);
  });

  it('a local or loop variable written with its package resolves on that type too', () => {
    expect(callees('Runner', 'localBody')).toEqual(['a.http::Request::getBody']);
    expect(callees('Runner', 'eachBody')).toEqual(['a.http::Request::getBody']);
  });

  it('a field typed by the class type parameter resolves on its bound', () => {
    expect(callees('Tile', 'refresh')).toEqual(['a::State::copyTo']);
  });

  it('a nested type a superclass declares is named without an import', () => {
    expect(callees('Phone', 'refresh')).toEqual(['a::Alerts::Entry::update']);
  });

  it('a library type with a short name, or a project enum lacking the method, gets no guess', () => {
    expect(callees('Storage', 'local')).toEqual([]);
    expect(callees('Storage', 'field')).toEqual([]);
  });

  it('an on-demand import of a class names its nested types', () => {
    expect(callees('Parsers', 'read')).toEqual(['a::Web::Body::asText']);
  });

  it('a class the head names as a type argument is no type parameter', () => {
    expect(callees('Link', 'of')).toEqual(['a::AppModule::find', 'a::AppModule::getNames']);
  });
});
