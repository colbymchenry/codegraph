import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Django end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates a route->view edge from urls.py to view class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-'));
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '# marker\n');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.mkdirSync(path.join(tmpDir, 'users'));
    fs.writeFileSync(path.join(tmpDir, 'users/__init__.py'), '');
    fs.writeFileSync(
      path.join(tmpDir, 'users/views.py'),
      'class UserListView:\n    def get(self, request): pass\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'users/urls.py'),
      'from django.urls import path\n' +
        'from users.views import UserListView\n' +
        'urlpatterns = [path("users/", UserListView.as_view(), name="user-list")]\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Route node exists
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((n) => n.name === 'users/');
    expect(route).toBeDefined();

    // View class exists
    const classNodes = cg.getNodesByKind('class');
    const view = classNodes.find((n) => n.name === 'UserListView');
    expect(view).toBeDefined();

    // Edge route -> view exists
    const edges = cg.getOutgoingEdges(route!.id);
    const toView = edges.find((e) => e.target === view!.id);
    expect(toView).toBeDefined();
    expect(toView!.kind).toBe('references');

    cg.close();
  });
});

describe('Flask end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves stacked routes across @login_required to a view named after a builtin (index)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flask-'));
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==3.0\n');
    fs.writeFileSync(
      path.join(tmpDir, 'app.py'),
      'from flask import Blueprint, render_template\n' +
        'from flask_login import login_required\n' +
        'bp = Blueprint("main", __name__)\n' +
        '\n' +
        '@bp.route("/", methods=["GET", "POST"])\n' +
        '@bp.route("/index", methods=["GET", "POST"])\n' +
        '@login_required\n' +
        'def index():\n' +
        '    return render_template("index.html")\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Both stacked @bp.route decorators are extracted (the second was previously
    // dropped because @login_required broke the "def must follow" assumption).
    const routes = cg.getNodesByKind('route');
    expect(routes.map((r) => r.name).sort()).toEqual(['GET /', 'GET /index']);

    // The view function exists even though its name is a Python builtin method.
    const fn = cg.getNodesByKind('function').find((n) => n.name === 'index');
    expect(fn).toBeDefined();

    // Both routes resolve to it — exercises the bare-name builtin guard, which
    // previously filtered the `index` reference as a builtin method.
    for (const route of routes) {
      const edges = cg.getOutgoingEdges(route.id);
      const toView = edges.find((e) => e.target === fn!.id && e.kind === 'references');
      expect(toView, `route ${route.name} should resolve to index()`).toBeDefined();
    }

    cg.close();
  });
});

describe('Flutter end-to-end — setState→build synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('synthesizes a handler→build edge when a State method calls setState', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flutter-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.dart'),
      'import "package:flutter/material.dart";\n' +
        'class CounterPage extends StatefulWidget {\n' +
        '  @override\n' +
        '  State<CounterPage> createState() => _CounterPageState();\n' +
        '}\n' +
        'class _CounterPageState extends State<CounterPage> {\n' +
        '  int _count = 0;\n' +
        '  void _increment() {\n' +
        '    setState(() {\n' +
        '      _count++;\n' +
        '    });\n' +
        '  }\n' +
        '  @override\n' +
        '  Widget build(BuildContext context) {\n' +
        '    return Text("$_count");\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const increment = methods.find((n) => n.name === '_increment');
    const build = methods.find((n) => n.name === 'build');
    expect(increment).toBeDefined();
    expect(build).toBeDefined();

    // setState re-runs build (Flutter-internal, no static edge). The synthesizer
    // bridges the handler → build so the "tap → setState → rebuilt UI" flow connects.
    const edges = cg.getOutgoingEdges(increment!.id);
    const toBuild = edges.find((e) => e.target === build!.id && e.kind === 'calls');
    expect(toBuild, '_increment should reach build via setState synthesis').toBeDefined();

    cg.close();
  });
});

describe('C++ end-to-end — virtual override synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('bridges a base virtual method to the subclass override', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-'));
    fs.writeFileSync(
      path.join(tmpDir, 'iter.cpp'),
      'class Iterator {\n' +
        ' public:\n' +
        '  virtual void Next() { }\n' +
        '};\n' +
        'class DBIter : public Iterator {\n' +
        ' public:\n' +
        '  void Next() override { advance(); }\n' +
        '  void advance() { }\n' +
        '};\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Two methods named Next: the base virtual (lower line) and the override.
    const nexts = cg
      .getNodesByKind('method')
      .filter((n) => n.name === 'Next')
      .sort((a, b) => a.startLine - b.startLine);
    expect(nexts.length).toBe(2);
    const [baseNext, overrideNext] = nexts;

    // A vtable call to Iterator::Next dispatches to DBIter::Next — bridge it so
    // trace/callees from the interface method reaches the implementation.
    const edge = cg
      .getOutgoingEdges(baseNext!.id)
      .find((e) => e.target === overrideNext!.id && e.kind === 'calls');
    expect(edge, 'Iterator::Next should reach DBIter::Next via override synthesis').toBeDefined();

    cg.close();
  });
});

describe('Dagger 2 — @Provides / @Binds binding synthesis', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  // Helper: find the synthesized binding edge between two named nodes.
  const findBindingEdge = (cg: CodeGraph, ifaceName: string, implName: string) => {
    const iface = cg.getNodesByKind('interface').find((n) => n.name === ifaceName)
      ?? cg.getNodesByKind('class').find((n) => n.name === ifaceName);
    const impl = cg.getNodesByKind('class').find((n) => n.name === implName);
    if (!iface || !impl) return undefined;
    return cg
      .getOutgoingEdges(iface.id)
      .find((e) => e.target === impl.id
        && e.kind === 'references'
        && (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'dagger-provides');
  };

  it('links interface to impl through @Provides Interface(Impl impl)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'DataManager.java'),
      'package com.example.di;\npublic interface DataManager { void load(); }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppDataManager.java'),
      'package com.example.di;\npublic class AppDataManager implements DataManager {\n' +
        '  public void load() {}\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ApplicationModule.java'),
      'package com.example.di;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module\npublic class ApplicationModule {\n' +
        '  @Provides DataManager provideDataManager(AppDataManager impl) { return impl; }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(findBindingEdge(cg, 'DataManager', 'AppDataManager')).toBeDefined();
    cg.close();
  });

  it('links interface to impl through @Binds abstract method', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.java'),
      'package com.example;\npublic interface Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'FooImpl.java'),
      'package com.example;\npublic class FooImpl implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'FooModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Binds;\n' +
        '@Module\npublic abstract class FooModule {\n' +
        '  @Binds abstract Foo bindFoo(FooImpl impl);\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(findBindingEdge(cg, 'Foo', 'FooImpl')).toBeDefined();
    cg.close();
  });

  it('works for Kotlin @Module object with @Provides', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Repo.kt'),
      'package com.example\n\ninterface Repo { fun load() }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'RepoImpl.kt'),
      'package com.example\n\nclass RepoImpl : Repo { override fun load() {} }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'RepoModule.kt'),
      'package com.example\n\nimport dagger.Module\nimport dagger.Provides\n\n' +
        '@Module\nclass RepoModule {\n' +
        '  @Provides fun provideRepo(impl: RepoImpl): Repo = impl\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(findBindingEdge(cg, 'Repo', 'RepoImpl')).toBeDefined();
    cg.close();
  });

  it('disambiguates two impls of the same interface across modules', async () => {
    // Both ImplA and ImplB implement Foo. The generic interface-impl pass would
    // pair Foo with both; the Dagger pass should emit edges only to the impl
    // each module actually binds (binding-precise).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.java'),
      'package com.example;\npublic interface Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ImplA.java'),
      'package com.example;\npublic class ImplA implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ImplB.java'),
      'package com.example;\npublic class ImplB implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ModuleA.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class ModuleA { @Provides Foo a(ImplA impl) { return impl; } }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ModuleB.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class ModuleB { @Provides Foo b(ImplB impl) { return impl; } }\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Both binding edges should exist with binding-precise provenance.
    // (Resolving which one wins in any particular call site is downstream;
    // here we just check the graph carries both binding facts.)
    expect(findBindingEdge(cg, 'Foo', 'ImplA')).toBeDefined();
    expect(findBindingEdge(cg, 'Foo', 'ImplB')).toBeDefined();
    cg.close();
  });

  it('does not emit a binding for a factory @Provides whose body builds the return value', async () => {
    // Real-world failure mode (seen in Plaid): `@Provides Interface m(Impl impl)`
    // signature, but body calls a factory instead of returning impl. The
    // signature *looks* like a binding; the body proves it's a factory.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'ViewModel.java'),
      'package com.example;\npublic class ViewModel {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ViewModelFactory.java'),
      'package com.example;\npublic class ViewModelFactory {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class AppModule {\n' +
        '  @Provides ViewModel provideViewModel(ViewModelFactory factory) {\n' +
        '    return factory.create();\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(findBindingEdge(cg, 'ViewModel', 'ViewModelFactory')).toBeUndefined();
    cg.close();
  });

  it('does not emit a binding for a factory method (no impl parameter)', async () => {
    // `@Provides Foo provideFoo() { return new Foo(); }` — no impl param.
    // Identity-style shapes (return type == param type) are not bindings.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.java'),
      'package com.example;\npublic class Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ConfigModule.java'),
      'package com.example;\nimport dagger.Module;\nimport dagger.Provides;\n' +
        '@Module public class ConfigModule {\n' +
        '  @Provides Foo provideFoo() { return new Foo(); }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const foo = cg.getNodesByKind('class').find((n) => n.name === 'Foo');
    expect(foo).toBeDefined();
    const daggerOut = cg
      .getOutgoingEdges(foo!.id)
      .filter((e) => (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'dagger-provides');
    expect(daggerOut.length).toBe(0);
    cg.close();
  });

  it('does not emit bindings from a non-@Module class', async () => {
    // The same method shape outside a @Module class — must be ignored.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dagger-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.java'),
      'package com.example;\npublic interface Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'FooImpl.java'),
      'package com.example;\npublic class FooImpl implements Foo {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'NotAModule.java'),
      'package com.example;\npublic class NotAModule {\n' +
        '  Foo provide(FooImpl impl) { return impl; }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(findBindingEdge(cg, 'Foo', 'FooImpl')).toBeUndefined();
    cg.close();
  });
});
