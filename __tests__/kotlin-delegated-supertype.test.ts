/**
 * A Kotlin class implements the interface it delegates `by`:
 *
 *     class BaseActivity : AppCompatActivity(), SecureActivityDelegate by SecureActivityDelegateImpl() {
 *     class CachedRepo(private val inner: Repo) : Repo by inner {
 *
 * The specifier's only child is an `explicit_delegation` (`user_type by
 * <expr>`), which the supertype reading skipped on both engines, so the class
 * had no edge to the interface: it was missing from the interface's
 * implementations, and a call through the interface never reached the
 * methods the class overrides. Both engines read the delegation's type now,
 * as they already did for an object expression's (`object : I by x { }`);
 * kernel-kotlin-parity.test.ts pins that they agree.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

const SOURCE = `package demo

class Both : Base(), Drawable by Impl(), Sink by sink {
    fun own() {
    }
}

class DelegatedImpl(d: Drawable) : Drawable by d

class Qualified(x: api.IFoo) : api.IFoo by x {
    fun own() {
    }
}

class Generic<E>(c: Channel<E>) : Channel<E> by c

class FnType(f: (Int) -> Unit) : (Int) -> Unit by f

object Single : Drawable by Impl() {
    fun own() {
    }
}
`;

/** `kind name line:column` for each supertype reference made from the node named `name`. */
function supertypesOf(result: ExtractionResult, name: string): string[] {
  const node = result.nodes.find((n) => n.name === name);
  expect(node, `no node named ${name}`).toBeDefined();
  return result.unresolvedReferences
    .filter((r) => r.fromNodeId === node!.id && (r.referenceKind === 'extends' || r.referenceKind === 'implements'))
    .map((r) => `${r.referenceKind} ${r.referenceName} ${r.line}:${r.column}`);
}

function checkSupertypes(result: ExtractionResult): void {
  // In source order, beside a constructor call; a delegate that is a call or a name.
  expect(supertypesOf(result, 'Both')).toEqual(['extends Base 3:13', 'extends Drawable 3:21', 'extends Sink 3:41']);
  expect(supertypesOf(result, 'DelegatedImpl')).toEqual(['extends Drawable 8:35']);
  // A qualified type keeps its path; a generic one drops its arguments.
  expect(supertypesOf(result, 'Qualified')).toEqual(['extends api.IFoo 10:31']);
  expect(supertypesOf(result, 'Generic')).toEqual(['extends Channel 15:34']);
  // A function type names no class, so it gives no supertype.
  expect(supertypesOf(result, 'FnType')).toEqual([]);
  expect(supertypesOf(result, 'Single')).toEqual(['extends Drawable 19:16']);
}

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Kotlin `I by x`: extraction', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['kotlin']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  it('the wasm extractor reads the delegated interface as a supertype', () => {
    process.env.CODEGRAPH_KERNEL = '0';
    checkSupertypes(extractFromSource('src/demo/By.kt', SOURCE, 'kotlin'));
  });

  it.skipIf(!kernelBuilt)('the native kernel reads the delegated interface as a supertype', () => {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const result = tryKernelExtract('src/demo/By.kt', SOURCE, 'kotlin');
    expect(result, 'kernel extraction deferred or failed').not.toBeNull();
    checkSupertypes(result!);
  });
});

describe('Kotlin `I by x`: the class implements the interface', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-by-'));
    const files: Record<string, string> = {
      'src/main/kotlin/app/security/SecureActivityDelegate.kt': `package app.security

interface SecureActivityDelegate {
    fun registerSecureActivity()
}

class SecureActivityDelegateImpl : SecureActivityDelegate {
    override fun registerSecureActivity() {
    }
}
`,
      'src/main/kotlin/app/ui/BaseActivity.kt': `package app.ui

import app.security.SecureActivityDelegate
import app.security.SecureActivityDelegateImpl

open class Screen

open class BaseActivity : Screen(), SecureActivityDelegate by SecureActivityDelegateImpl() {
    fun start() {
    }
}
`,
      'src/main/kotlin/app/data/Repo.kt': `package app.data

interface Repo {
    fun load(): String
}

class DbRepo : Repo {
    override fun load(): String = "db"
}

class CachedRepo(private val inner: Repo) : Repo by inner {
    private var cache: String? = null

    override fun load(): String = cache ?: inner.load()
}

fun use(repo: Repo): String = repo.load()
`,
      // A sealed class's `object List`, and a `by` of Kotlin's own List elsewhere.
      'src/main/kotlin/app/library/DisplayMode.kt': `package app.library

sealed class DisplayMode {
    object List : DisplayMode()
    object Grid : DisplayMode()
}
`,
      'src/main/kotlin/app/source/FilterList.kt': `package app.source

class FilterList(val list: List<String>) : List<String> by list {
    fun firstTwo() = list.take(2)
}
`,
      // A nested interface, reached from inside its owner and through an import.
      'src/main/kotlin/app/events/Bus.kt': `package app.events

class Bus {
    interface Listener {
        fun on()
    }

    class Inner(l: Listener) : Listener by l
}
`,
      'src/main/kotlin/app/ui/Relay.kt': `package app.ui

import app.events.Bus.Listener

class Relay(l: Listener) : Listener by l
`,
      // Two packages' `Headers`; a class that star-imports one of them.
      'src/main/kotlin/app/http/Headers.kt': `package app.http

interface Headers {
    fun get(name: String): String?
}
`,
      'src/main/kotlin/app/fetch/Headers.kt': `package app.fetch

interface Headers {
    fun get(name: String): String?
}
`,
      'src/main/kotlin/app/server/DelegateHeaders.kt': `package app.server

import app.http.*

class DelegateHeaders(private val original: Headers) : Headers by original

class PlainHeaders : Headers {
    override fun get(name: String): String? = null
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

  function nodeIn(file: string, name: string) {
    const node = cg.getNodesInFile(file).find((n) => n.name === name);
    expect(node, `no node named ${name} in ${file}`).toBeDefined();
    return node!;
  }

  /** `kind qualifiedName` of each edge out of `id`, containment left out. */
  function targetsOf(id: string): string[] {
    return cg
      .getOutgoingEdges(id)
      .filter((e) => e.kind !== 'contains')
      .map((e) => `${e.kind} ${cg.getNode(e.target)!.qualifiedName}`)
      .sort();
  }

  it('beside a superclass, with a constructor-call delegate', () => {
    const base = nodeIn('src/main/kotlin/app/ui/BaseActivity.kt', 'BaseActivity');
    expect(targetsOf(base.id)).toContain('implements app.security::SecureActivityDelegate');
    expect(targetsOf(base.id)).toContain('extends app.ui::Screen');
  });

  it('a decorator that delegates to the object it wraps', () => {
    const cached = nodeIn('src/main/kotlin/app/data/Repo.kt', 'CachedRepo');
    expect(targetsOf(cached.id)).toContain('implements app.data::Repo');
  });

  it("a `by` of Kotlin's own List is no project type's nested `object List`", () => {
    const filters = nodeIn('src/main/kotlin/app/source/FilterList.kt', 'FilterList');
    expect(targetsOf(filters.id).filter((t) => /^(extends|implements) /.test(t))).toEqual([]);
  });

  it('a nested interface, from inside its owner or through an import', () => {
    const inner = nodeIn('src/main/kotlin/app/events/Bus.kt', 'Inner');
    expect(targetsOf(inner.id)).toContain('implements app.events::Bus::Listener');
    const relay = nodeIn('src/main/kotlin/app/ui/Relay.kt', 'Relay');
    expect(targetsOf(relay.id)).toContain('implements app.events::Bus::Listener');
  });

  it('of two same-named interfaces, the one the file imports', () => {
    const file = 'src/main/kotlin/app/server/DelegateHeaders.kt';
    for (const name of ['DelegateHeaders', 'PlainHeaders']) {
      const supertypes = targetsOf(nodeIn(file, name).id).filter((t) => /^(extends|implements) /.test(t));
      expect(supertypes, name).toEqual(['implements app.http::Headers']);
    }
  });

  it("a call through the interface reaches the decorator's override", () => {
    const load = cg.getNodesInFile('src/main/kotlin/app/data/Repo.kt').find((n) => n.qualifiedName === 'app.data::Repo::load')!;
    expect(load).toBeDefined();
    const targets = targetsOf(load.id);
    expect(targets).toContain('calls app.data::DbRepo::load');
    expect(targets).toContain('calls app.data::CachedRepo::load');
  });
});
