/**
 * Java's `Type.FIELD.m()` calls a method on a value a type holds in a static
 * field: an interface's constant, a class's `static final`, an enum constant.
 * The value is typed by the field's own declaration, with its own file's
 * imports: the method an anonymous class the field is initialized with
 * declares, else the class a `new X(…)` builds, else the declared type's.
 * Before, nothing read the field: an interface's constants weren't indexed
 * at all, and the call was guessed by the method's name alone, often onto a
 * same-named class in another package, or onto a project method for a field
 * of a library class (`Intent.ACTION_VIEW.equals(…)`).
 *
 * Cases from @mixxer's #1949 and the T5 triage fixtures.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-static-field-'));
  const files: Record<string, string> = {
    'r/Consts.java': `package r;
public interface Consts {
    int MAX = 10;
    Helper HELPER = new Helper();
    String NAME = "x";
}
`,
    'r/Helper.java': `package r;
public class Helper { public void go() {} }
`,
    'r/Holder.java': `package r;
public class Holder {
    public static final Helper SHARED = new Helper();
}
`,
    'r/User.java': `package r;
public class User {
    void viaInterface() { Consts.HELPER.go(); }
    void viaClass() { Holder.SHARED.go(); }
}
`,
    'com/lib/ProjectInterpolator.java': `package com.lib;
public class ProjectInterpolator { public float getInterpolation(float t) { return t; } }
`,
    'p/ProjectInterpolator.java': `package p;
public class ProjectInterpolator { public float getInterpolation(float t) { return t; } }
`,
    'r/ProjectInterpolators.java': `package r;
import p.ProjectInterpolator;
class ProjectInterpolators { static final ProjectInterpolator LOCAL = new ProjectInterpolator(); }
`,
    'r/Consumer.java': `package r;
public class Consumer {
    float projectCall() { return ProjectInterpolators.LOCAL.getInterpolation(1); }
}
`,
    's/Shapes.java': `package s;

import android.os.Parcel;
import android.os.Parcelable;
import android.content.Intent;
import android.view.animation.Interpolators;

class Parent {
    public static final Runner SHARED = new Runner();
}

class Child extends Parent {}

class Runner { public void run() {} public String getName() { return "r"; } }

class FastRunner extends Runner { @Override public void run() {} }

interface Defaults {
    Runner DEFAULT = new FastRunner();
}

class Impl implements Defaults {}

class Outer {
    static class Inner {
        static final Runner NESTED = new Runner();
    }
}

enum Color {
    RED,
    GREEN {
        @Override String hex() { return "0f0"; }
    };
    String hex() { return "f00"; }
}

class Foo implements Parcelable {
    public static final Parcelable.Creator<Foo> CREATOR = new Parcelable.Creator<Foo>() {
        public Foo createFromParcel(Parcel in) { return new Foo(); }
        public Foo[] newArray(int size) { return new Foo[size]; }
    };
}

class Calls {
    void inherited() { Child.SHARED.run(); }
    void interfaceConstant() { Impl.DEFAULT.run(); }
    void nested() { Outer.Inner.NESTED.run(); }
    void enumConstant() { Color.RED.hex(); }
    void enumBody() { Color.GREEN.hex(); }
    void anonymous(Parcel p) { Foo.CREATOR.createFromParcel(p); }
    boolean library(String a) { return Intent.ACTION_VIEW.equals(a); }
    float libraryField(float t) { return Interpolators.FAST_OUT_SLOW_IN.getInterpolation(t); }
    String javaLang() { return Integer.TYPE.getName(); }
    void kotlinObject() { KObj.INSTANCE.go(); }
}
`,
    's/KObj.kt': `package s

object KObj {
    fun go() {}
}

class Other {
    fun equals(x: String): Boolean = true
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

/** Qualified names of what the method `name` in `file` calls. */
function callees(file: string, name: string): string[] {
  const from = cg.getNodesInFile(file).find((n) => n.kind === 'method' && n.name === name)!;
  return cg
    .getOutgoingEdgesFrom([from.id])
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('Java: an interface constant', () => {
  it('is indexed, as a static final field is', () => {
    const constants = cg.getNodesInFile('r/Consts.java').filter((n) => n.kind === 'constant').map((n) => n.qualifiedName);
    expect(constants.sort()).toEqual(['r::Consts::HELPER', 'r::Consts::MAX', 'r::Consts::NAME']);
  });
});

describe('Java: Type.FIELD.m()', () => {
  it('reaches the method of the field\'s type', () => {
    expect(callees('r/User.java', 'viaInterface')).toEqual(['r::Helper::go']);
    expect(callees('r/User.java', 'viaClass')).toEqual(['r::Helper::go']);
  });

  it('reads the field\'s type with the field\'s own file\'s imports', () => {
    expect(callees('r/Consumer.java', 'projectCall')).toEqual(['p::ProjectInterpolator::getInterpolation']);
  });

  it('finds a field the type inherits, from a class or an interface', () => {
    expect(callees('s/Shapes.java', 'inherited')).toEqual(['s::Runner::run']);
    expect(callees('s/Shapes.java', 'interfaceConstant')).toEqual(['s::FastRunner::run']);
  });

  it('walks a nested type', () => {
    expect(callees('s/Shapes.java', 'nested')).toEqual(['s::Runner::run']);
  });

  it('reaches an enum constant\'s own override, else the enum\'s method', () => {
    expect(callees('s/Shapes.java', 'enumConstant')).toEqual(['s::Color::hex']);
    expect(callees('s/Shapes.java', 'enumBody')).toEqual(['s::Color::GREEN::hex']);
  });

  it('reaches the method of an anonymous class the field holds', () => {
    expect(callees('s/Shapes.java', 'anonymous')).toEqual(['s::Foo::CREATOR::<Creator$anon@39>::createFromParcel']);
  });

  it('links nothing for a library type\'s field', () => {
    expect(callees('s/Shapes.java', 'library')).toEqual([]);
    expect(callees('s/Shapes.java', 'libraryField')).toEqual([]);
    expect(callees('s/Shapes.java', 'javaLang')).toEqual([]);
  });

  it('reaches a Kotlin object\'s member through INSTANCE', () => {
    expect(callees('s/Shapes.java', 'kotlinObject')).toEqual(['s::KObj::go']);
  });
});
