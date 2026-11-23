/**
 * The code a Kotlin class or object writes in its header is the class's own:
 * a constructor parameter's default value, the arguments of the superclass
 * constructor it calls, and the expression after `by` that it delegates an
 * interface to —
 *
 *     class BaseActivity : AppCompatActivity(), SecureActivityDelegate by SecureActivityDelegateImpl() {
 *
 * A bodiless class always walked its header as its body; a class with a body
 * walked only the body, so those calls linked nowhere. Under tree-sitter-kotlin
 * 0.3.8 a `by X()` delegate swallowed the body into a trailing lambda, which
 * made such a class look bodiless and linked `X()` by accident; the grammar
 * since #3410 reads the body, and the links were gone. Both engines walk the
 * header of a bodied class now; kernel-kotlin-parity.test.ts pins that they
 * agree.
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

class HeaderCode(
    val a: WidgetK = WidgetK(1),
    b: Int = 2,
    val cb: () -> Unit = { helper() },
    val d: Repo = Repo.create(),
) : OpenBase(compute(3), ::topLevel), Drawable by makeDrawable(seed()) {
    fun own() {
        helper()
    }
}

object HeaderObject : OpenBase(objArg()), Drawable by Defaults.INSTANCE {
    fun own() {
        helper()
    }
}

class AnonDelegate : Runnable by object : Runnable {
    override fun run() {
        helper()
    }
} {
    fun own() {
    }
}

enum class EnumHeader(val v: Int = enumDefault()) {
    A, B;
    fun own() {
    }
}

class Outer {
    companion object : Factory by factoryOf(companionArg()) {
        fun c() {
        }
    }
}

class Bodiless(val b: Int = initB()) : OpenBase(readCfg2())

fun topLevel() {}
`;

/** `kind name line:column` for each reference made from the node named `name`. */
function refsFrom(result: ExtractionResult, name: string): string[] {
  const node = result.nodes.find((n) => n.name === name);
  expect(node, `no node named ${name}`).toBeDefined();
  return result.unresolvedReferences
    .filter((r) => r.fromNodeId === node!.id)
    .map((r) => `${r.referenceKind} ${r.referenceName} ${r.line}:${r.column}`)
    .sort();
}

function checkHeaders(result: ExtractionResult): void {
  // Defaults (a call, a lambda's call, a qualified call), the superclass
  // constructor's arguments (a call, a function reference), the delegate (a
  // call and the call in its arguments). `own`'s call stays its own.
  expect(refsFrom(result, 'HeaderCode')).toEqual([
    'calls Repo.create 7:18',
    'calls WidgetK 4:21',
    'calls compute 8:13',
    'calls helper 6:27',
    'calls makeDrawable 8:50',
    'calls seed 8:63',
    'extends OpenBase 8:4',
    'function_ref topLevel 8:27',
  ]);
  expect(refsFrom(result, 'own').filter((r) => r.startsWith('calls helper'))).toContain('calls helper 10:8');

  // An object: its superclass constructor's arguments. A property read as the
  // delegate links nothing, as it doesn't in a bodiless header.
  expect(refsFrom(result, 'HeaderObject')).toEqual(['calls objArg 14:31', 'extends OpenBase 14:22']);

  // An object expression as the delegate is an anonymous class like any other.
  expect(refsFrom(result, 'AnonDelegate')).toEqual(['instantiates Runnable 20:42']);
  const anon = result.nodes.find((n) => n.name === '<Runnable$anon@20>');
  expect(anon?.kind).toBe('class');
  const run = result.nodes.find((n) => n.name === 'run');
  expect(run?.kind).toBe('method');
  expect(refsFrom(result, 'run')).toEqual(['calls helper 22:8']);

  // An enum class's constructor defaults.
  expect(refsFrom(result, 'EnumHeader')).toEqual(['calls enumDefault 29:35']);

  // Unchanged: a companion object's header was always walked (for the class
  // around it), and so was a bodiless class's.
  expect(refsFrom(result, 'Outer')).toEqual(['calls companionArg 36:44', 'calls factoryOf 36:34']);
  expect(refsFrom(result, 'Bodiless')).toEqual(['calls initB 42:28', 'calls readCfg2 42:48', 'extends OpenBase 42:39']);
}

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Kotlin class headers: extraction', () => {
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

  it('the wasm extractor walks a bodied class header as the class', () => {
    process.env.CODEGRAPH_KERNEL = '0';
    checkHeaders(extractFromSource('src/demo/Header.kt', SOURCE, 'kotlin'));
  });

  it.skipIf(!kernelBuilt)('the native kernel walks a bodied class header as the class', () => {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const result = tryKernelExtract('src/demo/Header.kt', SOURCE, 'kotlin');
    expect(result, 'kernel extraction deferred or failed').not.toBeNull();
    checkHeaders(result!);
  });
});

describe('Kotlin class headers: the calls link', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-header-'));
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

open class Screen(val title: String)

fun screenTitle(): String = "home"

open class BaseActivity : Screen(screenTitle()), SecureActivityDelegate by SecureActivityDelegateImpl() {
    fun start() {
        registerSecureActivity()
    }
}
`,
      'src/main/kotlin/app/data/Repo.kt': `package app.data

interface Clock {
    fun now(): Long
}

class SystemClock : Clock {
    override fun now(): Long = 0
}

class Repo(private val clock: Clock = SystemClock()) {
    fun stamp() = clock.now()
}

open class Loader(val seed: Int)

fun loadDefaults(): Int = 1

object Registry : Loader(loadDefaults()) {
    fun get() {
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

  /** Qualified names of what the class or object named `name` in `file` links to. */
  function targetsOf(file: string, name: string): string[] {
    const node = cg.getNodesInFile(file).find((n) => n.name === name);
    expect(node, `no node named ${name} in ${file}`).toBeDefined();
    return cg
      .getOutgoingEdges(node!.id)
      .filter((e) => e.kind !== 'contains')
      .map((e) => `${e.kind} ${cg.getNode(e.target)!.qualifiedName}`)
      .sort();
  }

  // A call that names a class resolves to it as an instantiation.
  it('a `by` delegate and a superclass constructor argument', () => {
    const targets = targetsOf('src/main/kotlin/app/ui/BaseActivity.kt', 'BaseActivity');
    expect(targets).toContain('instantiates app.security::SecureActivityDelegateImpl');
    expect(targets).toContain('calls app.ui::screenTitle');
  });

  it('a constructor parameter default', () => {
    expect(targetsOf('src/main/kotlin/app/data/Repo.kt', 'Repo')).toContain('instantiates app.data::SystemClock');
  });

  it("an object's superclass constructor argument", () => {
    expect(targetsOf('src/main/kotlin/app/data/Repo.kt', 'Registry')).toContain('calls app.data::loadDefaults');
  });
});
