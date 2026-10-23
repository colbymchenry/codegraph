/**
 * An overload is overridden by the overload with its parameters (#2663). The
 * override edges (`synthesizedBy: interface-impl`) linked every overload of an
 * interface or base-class method to every same-named method of the class, so
 * `ExampleService.putTairValue(String)` reached
 * `ExampleServiceImpl.putTairValue(List<String>, double)` and the other way
 * round. Java, Kotlin, C# and Scala make an override repeat the parameter list
 * of what it overrides, so an overload now pairs with the methods of its
 * parameter count, and of those with the ones whose parameter types are its
 * own; where a type can't be compared (a type parameter, a type written in
 * another language), the count alone decides. A name declared once on each
 * side links as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const FILES: Record<string, string> = {
  // The issue's example.
  'src/main/java/com/example/ExampleService.java': `package com.example;

import java.util.List;

interface ExampleService {
    Object putTairValue(String tairKey);

    Object putTairValue(List<String> tairKey, double count);
}
`,
  'src/main/java/com/example/ExampleServiceImpl.java': `package com.example;

import java.util.List;

class ExampleServiceImpl implements ExampleService {
    @Override
    public Object putTairValue(String tairKey) {
        return null;
    }

    @Override
    public Object putTairValue(List<String> tairKey, double count) {
        return null;
    }
}
`,
  'src/main/java/com/example/Shapes.java': `package com.example;

import java.util.List;

// One parameter each, told apart by type; \`final\` and annotations aside.
interface Slots {
    void put(String key);
    void put(int index);
}

class ArraySlots implements Slots {
    public void put(@Deprecated final String key) {}
    public void put(int index) {}
}

// A subclass overriding one overload of its base.
class Base {
    void draw(int x) {}
    void draw(String label) {}
}

class Sub extends Base {
    @Override
    void draw(int x) {}
}

// An implementation with an overload of its own.
interface Logger {
    void log(String msg);
}

class FileLogger implements Logger {
    public void log(String msg) {}
    public void log(String msg, int level) {}
}

// Written another way but the same types: qualified, varargs as an array,
// a C-style array, a raw type.
interface Codec {
    void write(java.util.List<String> lines);
    void write(String... parts);
    void write(int[] data, int length);
    void write(List<Integer> codes, String sep);
}

class CodecImpl implements Codec {
    public void write(List<String> lines) {}
    public void write(String[] parts) {}
    public void write(int data[], int length) {}
    public void write(List codes, String sep) {}
}

// Generic methods: a type parameter can be any type.
interface Mapper {
    <T> T map(Class<T> type);
    Object map(String name);
}

class ReflectMapper implements Mapper {
    public <U> U map(Class<U> type) { return null; }
    public Object map(String name) { return null; }
}

// One method on each side: linked as before, whatever its parameters.
interface Single {
    void only(int x);
}

class SingleImpl implements Single {
    public void only(long x) {}
}

// A Java interface a Kotlin class implements: the count decides.
interface Sink {
    void accept(int x);
    void accept(String s, int n);
}

// A method's own type parameter stands in for no concrete type of its base:
// the generic appendTo overrides only the generic one.
class Appender {
    <A extends Appendable> A appendTo(A appendable, java.util.Iterator<?> parts) { return appendable; }
    StringBuilder appendTo(StringBuilder builder, java.util.Iterator<?> parts) { return builder; }
}

class SkippingAppender extends Appender {
    @Override
    <A extends Appendable> A appendTo(A appendable, java.util.Iterator<?> parts) { return appendable; }
}
`,
  'src/main/kotlin/com/example/Repos.kt': `package com.example

interface Repository<T> {
    fun save(entity: T)
    fun save(entities: List<T>, flush: Boolean)
}

class UserRepository : Repository<String> {
    override fun save(entity: String) {}
    fun save(entities: Map<String, Int>) {}
    override fun save(entities: List<String>, flush: Boolean) {}
}

interface Cache {
    fun put(key: String): Any?
    fun put(keys: List<String>, count: Double = 1.0): Any?
    fun put(key: String, value: Int): Any?
}

class MemoryCache : Cache {
    override fun put(key: String): Any? = null
    override fun put(keys: List<String>, count: Double): Any? = null
    override fun put(key: kotlin.String, value: Int): Any? = null
}

open class Shape {
    open fun draw(x: Int) {}
    open fun draw(label: String) {}
}

class Circle : Shape() {
    override fun draw(x: Int) {}
}

class KotlinSink : Sink {
    override fun accept(x: Int) {}
    override fun accept(s: String, n: Int) {}
}
`,
  'src/Store.cs': `using System;
using System.Collections.Generic;

namespace Example
{
    public interface IStore
    {
        object Put(string key);
        object Put(List<string> keys, double count);
        object Put(int index);
    }

    public class Store : IStore
    {
        public object Put(string key) { return null; }
        public object Put(List<string> keys, double count) { return null; }
        public object Put(int index) { return null; }
    }

    public class ExplicitStore : IStore
    {
        object IStore.Put(string key) => null;
        object IStore.Put(List<string> keys, double count) => null;
        object IStore.Put(int index) => null;
    }

    // BCL names for the keywords, a namespace, a default value, an
    // attribute and a comment that mention the method.
    public class SpelledStore : IStore
    {
        [Obsolete("Put(int) is the one to use")]
        public object Put(String key) => null;
        public object Put(System.Collections.Generic.List<String> keys, Double count = 1.0) => null;
        // Put(string) and Put(List<string>, double) above.
        public object Put(
            Int32 index) => null;
    }

    public interface IRepo<T>
    {
        void Save(T entity);
        void Save(IList<T> entities, bool flush);
    }

    public class UserRepo : IRepo<string>
    {
        public void Save(string entity) { }
        public void Save(IList<string> entities, bool flush) { }
    }

    public abstract class Widget
    {
        public virtual void Draw(int x) { }
        public virtual void Draw(string label) { }
        public virtual void Move(ref int x) { }
        public virtual void Move(int x) { }
    }

    public class Button : Widget
    {
        public override void Draw(int x) { }
        public override void Move(ref int x) { }
    }
}
`,
  'src/Repo.scala': `package example

trait Repo {
  def find(id: Long): Any
  def find(ids: List[Long], limit: Int = 10): Any
}

class SqlRepo extends Repo {
  def find(id: Long): Any = null
  def find(ids: List[Long], limit: Int): Any = null
}
`,
};

let root = '';
let graph: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-override-overloads-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  graph = await CodeGraph.init(root, { index: true });
}, 120_000);

afterAll(() => {
  graph?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `Owner::name:line -> Owner::name:line` for every override edge out of `owner`'s methods. */
function overrides(owner: string): string[] {
  const label = (id: string): string => {
    const n = graph.getNode(id)!;
    return `${n.qualifiedName.split('::').slice(-2).join('::')}:${n.startLine}`;
  };
  return graph
    .getNodesByKind('method')
    .filter((m) => m.qualifiedName.split('::').slice(-2)[0] === owner)
    .flatMap((m) => graph.getOutgoingEdges(m.id)
      .filter((e) => e.kind === 'calls' && e.metadata?.synthesizedBy === 'interface-impl')
      .map((e) => `${label(e.source)} -> ${label(e.target)}`))
    .sort();
}

describe('an overload is overridden by the overload with its parameters (#2663)', () => {
  it("Java: the issue's interface and implementation", () => {
    expect(overrides('ExampleService')).toEqual([
      'ExampleService::putTairValue:6 -> ExampleServiceImpl::putTairValue:6',
      'ExampleService::putTairValue:8 -> ExampleServiceImpl::putTairValue:11',
    ]);
  });

  it('Java: by parameter types at the same count, past `final` and annotations', () => {
    expect(overrides('Slots')).toEqual([
      'Slots::put:7 -> ArraySlots::put:12',
      'Slots::put:8 -> ArraySlots::put:13',
    ]);
  });

  it('Java: a subclass overrides only the overload it repeats', () => {
    expect(overrides('Base')).toEqual(['Base::draw:18 -> Sub::draw:23']);
  });

  it("Java: an implementation's own overload is no override", () => {
    expect(overrides('Logger')).toEqual(['Logger::log:29 -> FileLogger::log:33']);
  });

  it('Java: the same types written another way', () => {
    expect(overrides('Codec')).toEqual([
      'Codec::write:40 -> CodecImpl::write:47',
      'Codec::write:41 -> CodecImpl::write:48',
      'Codec::write:42 -> CodecImpl::write:49',
      'Codec::write:43 -> CodecImpl::write:50',
    ]);
  });

  it('Java: a type parameter matches any type in its place', () => {
    expect(overrides('Mapper')).toEqual([
      'Mapper::map:55 -> ReflectMapper::map:60',
      'Mapper::map:56 -> ReflectMapper::map:61',
    ]);
  });

  it("Java: an override's own type parameter stands in for no concrete type", () => {
    expect(overrides('Appender')).toEqual(['Appender::appendTo:82 -> SkippingAppender::appendTo:87']);
  });

  it('a name declared once on each side links as before', () => {
    expect(overrides('Single')).toEqual(['Single::only:66 -> SingleImpl::only:70']);
  });

  it('Kotlin: by count where a type parameter stands in, by type elsewhere', () => {
    expect(overrides('Repository')).toEqual([
      'Repository::save:4 -> UserRepository::save:10',
      'Repository::save:4 -> UserRepository::save:9',
      'Repository::save:5 -> UserRepository::save:11',
    ]);
    expect(overrides('Cache')).toEqual([
      'Cache::put:15 -> MemoryCache::put:21',
      'Cache::put:16 -> MemoryCache::put:22',
      'Cache::put:17 -> MemoryCache::put:23',
    ]);
    expect(overrides('Shape')).toEqual(['Shape::draw:27 -> Circle::draw:32']);
  });

  it('Kotlin implementing a Java interface: by parameter count', () => {
    expect(overrides('Sink')).toEqual([
      'Sink::accept:75 -> KotlinSink::accept:36',
      'Sink::accept:76 -> KotlinSink::accept:37',
    ]);
  });

  it('C#: by parameter types, read from the declarations', () => {
    expect(overrides('IStore')).toEqual([
      'IStore::Put:10 -> ExplicitStore::Put:24',
      'IStore::Put:10 -> SpelledStore::Put:35',
      'IStore::Put:10 -> Store::Put:17',
      'IStore::Put:8 -> ExplicitStore::Put:22',
      'IStore::Put:8 -> SpelledStore::Put:31',
      'IStore::Put:8 -> Store::Put:15',
      'IStore::Put:9 -> ExplicitStore::Put:23',
      'IStore::Put:9 -> SpelledStore::Put:33',
      'IStore::Put:9 -> Store::Put:16',
    ]);
    expect(overrides('IRepo')).toEqual([
      'IRepo::Save:41 -> UserRepo::Save:47',
      'IRepo::Save:42 -> UserRepo::Save:48',
    ]);
    // `Move(ref int)` and `Move(int)` are two overloads.
    expect(overrides('Widget')).toEqual([
      'Widget::Draw:53 -> Button::Draw:61',
      'Widget::Move:55 -> Button::Move:62',
    ]);
  });

  it('Scala: by parameter types, past a default value', () => {
    expect(overrides('Repo')).toEqual([
      'Repo::find:4 -> SqlRepo::find:9',
      'Repo::find:5 -> SqlRepo::find:10',
    ]);
  });
});
