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

  it('a static call on an imported library class gets no edge', () => {
    expect(callees('Screen', 'staticLibrary')).toEqual([]);
  });

  it('a type-parameter receiver is not treated as a library type', () => {
    expect(callees('Holder', 'go')).toEqual(['p::Hook::fire']);
  });
});
