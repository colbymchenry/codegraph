/**
 * Kotlin annotation capture + @Composable component classification.
 *
 * Framework annotations (@Composable, @HiltViewModel, @Inject, …) are declared
 * in external libraries outside the index, so their `decorates` references never
 * resolve. These tests assert the two extraction-level guarantees that make
 * annotation facts queryable anyway:
 *   1. annotation simple names are persisted on the node's `decorators` list
 *   2. @Composable functions/methods are classified as `component`
 *
 * Both are opt-in per language via `LanguageExtractor.extendedAnnotations`
 * (Kotlin only today) and are implemented TWICE — in the wasm walker
 * (src/extraction/tree-sitter.ts) and in the native Rust walker
 * (codegraph-kernel/src/kotlin.rs).
 *
 * Every guarantee is therefore asserted on BOTH arms. This matters more than it
 * looks: Kotlin is in the kernel's DEFAULT_ROUTED set, so a bare
 * `extractFromSource` call exercises the KERNEL and says nothing about the wasm
 * fallback — and `kernel-kotlin-parity.test.ts` only proves the two arms agree
 * with each other, not that either is correct. See `arms()`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import { CodeGraph } from '../src';
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

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
let savedEnv: Record<string, string | undefined>;

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['kotlin', 'typescript', 'python', 'java']);
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

/** Extract through the wasm walker, with kernel routing forced off. */
function viaWasm(file: string, code: string): ExtractionResult {
  process.env.CODEGRAPH_KERNEL = '0';
  resetKernelForTests();
  try {
    return extractFromSource(file, code, 'kotlin');
  } finally {
    delete process.env.CODEGRAPH_KERNEL;
    resetKernelForTests();
  }
}

/** Extract through the native kernel. Null when no binary is staged. */
function viaKernel(file: string, code: string): ExtractionResult | null {
  if (!kernelBuilt) return null;
  process.env.CODEGRAPH_KERNEL_LANGS = 'all';
  delete process.env.CODEGRAPH_KERNEL;
  resetKernelForTests();
  return tryKernelExtract(file, code, 'kotlin');
}

/**
 * Every available arm, labeled. The kernel entry is absent when the .node isn't
 * staged (a from-source checkout without `scripts/build-kernel.sh`), so the
 * suite still runs — but on CI and any machine that built the kernel, both arms
 * are checked.
 */
function arms(file: string, code: string): Array<[string, ExtractionResult]> {
  const out: Array<[string, ExtractionResult]> = [['wasm', viaWasm(file, code)]];
  const k = viaKernel(file, code);
  if (k) out.push(['kernel', k]);
  return out;
}

describe('Kotlin annotation capture', () => {
  it('captures a simple annotation on a top-level function', () => {
    const code = `
@Composable
fun ProfileCard(name: String) {
    Text(name)
}
`;
    for (const [arm, result] of arms('ProfileCard.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'ProfileCard');
      expect(node, arm).toBeDefined();
      expect(node?.decorators, arm).toContain('Composable');
    }
  });

  it('captures stacked annotations', () => {
    const code = `
@Preview
@Composable
fun CardPreview() {
    ProfileCard("x")
}
`;
    for (const [arm, result] of arms('CardPreview.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'CardPreview');
      expect(node?.decorators, arm).toContain('Preview');
      expect(node?.decorators, arm).toContain('Composable');
    }
  });

  it('captures annotations with arguments (constructor_invocation form)', () => {
    // The upstream bug this fixes: an arg-bearing annotation parses as
    // `constructor_invocation`, which neither arm unwrapped, so `@Preview(...)`
    // emitted nothing at all — no decorates ref, no name on the node.
    const code = `
@Preview(showBackground = true, name = "dark")
@Composable
fun ArgPreview() {}
`;
    for (const [arm, result] of arms('ArgPreview.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'ArgPreview');
      expect(node?.decorators, arm).toContain('Preview');
      expect(node?.decorators, arm).toContain('Composable');
      const decorates = (result.unresolvedReferences ?? [])
        .filter((r) => r.referenceKind === 'decorates')
        .map((r) => r.referenceName);
      expect(decorates, arm).toContain('Preview');
    }
  });

  it('does not harvest nested annotation arguments as annotation names', () => {
    // `ReplaceWith(...)` is an argument to @Deprecated, not an annotation on the
    // declaration. Collecting every target under one annotation node (needed for
    // Kotlin's bracket form) must not reach into the argument list.
    const code = `
@Deprecated("gone", ReplaceWith("newThing"))
fun oldThing() {}
`;
    for (const [arm, result] of arms('Deprecated.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'oldThing');
      expect(node?.decorators, arm).toContain('Deprecated');
      expect(node?.decorators ?? [], arm).not.toContain('ReplaceWith');
    }
  });

  it('captures class annotations (Hilt / Room)', () => {
    const code = `
@HiltViewModel
class MyViewModel : ViewModel() {}

@Entity(tableName = "users")
data class UserEntity(val id: String)
`;
    for (const [arm, result] of arms('MyViewModel.kt', code)) {
      const vm = result.nodes.find((n) => n.name === 'MyViewModel');
      expect(vm?.kind, arm).toBe('class');
      expect(vm?.decorators, arm).toContain('HiltViewModel');

      const entity = result.nodes.find((n) => n.name === 'UserEntity');
      expect(entity?.decorators, arm).toContain('Entity');
    }
  });

  it('captures annotations on an interface (Room @Dao) and an enum', () => {
    // Room puts @Dao on an INTERFACE and Kotlin serialization puts
    // @Serializable on enums; both take a different extraction path than
    // classes and emitted nothing before. The path is gated on the language
    // opt-in because it previously emitted no decorates refs at all, so calling
    // it unconditionally would move every other decorator-using language.
    const code = `
@Dao
interface NewsDao {
    @Query("SELECT * FROM news")
    fun getAll(): List<String>
}

@Serializable
enum class SyncKind { FULL, DELTA }
`;
    for (const [arm, result] of arms('NewsDao.kt', code)) {
      const dao = result.nodes.find((n) => n.name === 'NewsDao');
      expect(dao?.kind, arm).toBe('interface');
      expect(dao?.decorators, arm).toContain('Dao');

      const getAll = result.nodes.find((n) => n.name === 'getAll');
      expect(getAll?.decorators, arm).toContain('Query');

      const kind = result.nodes.find((n) => n.name === 'SyncKind');
      expect(kind?.kind, arm).toBe('enum');
      expect(kind?.decorators, arm).toContain('Serializable');
    }
  });

  it('leaves a non-opted language\'s interfaces untouched', () => {
    // The interface/enum path is new, so it must stay inert for Java — whose
    // Rust walker was not changed and whose parity gate would fail otherwise.
    const java = extractFromSource(
      'Foo.java',
      `
@FunctionalInterface
public interface Foo { void a(); }
`
    );
    const foo = java.nodes.find((n) => n.name === 'Foo');
    expect(foo?.kind).toBe('interface');
    expect(foo?.decorators ?? []).not.toContain('FunctionalInterface');
  });

  it('resolves qualified annotations to the simple name', () => {
    const code = `
@androidx.compose.runtime.Composable
fun Qualified() {}
`;
    for (const [arm, result] of arms('Qualified.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'Qualified');
      expect(node?.decorators, arm).toContain('Composable');
      expect(node?.decorators, arm).not.toContain('androidx');
    }
  });

  it('captures every entry of bracketed multi-annotations', () => {
    const code = `
@[Suppress("unused") JvmStatic]
fun bracketAnnotated() {}
`;
    for (const [arm, result] of arms('Bracket.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'bracketAnnotated');
      expect(node?.decorators, arm).toContain('Suppress');
      expect(node?.decorators, arm).toContain('JvmStatic');
    }
  });

  it('captures use-site-targeted annotations, skipping the target prefix', () => {
    const code = `
@receiver:Fancy
fun String.shout(): String = this.uppercase()
`;
    for (const [arm, result] of arms('Ext.kt', code)) {
      const ext = result.nodes.find((n) => n.name === 'shout');
      expect(ext?.decorators, arm).toContain('Fancy');
      expect(ext?.decorators, arm).not.toContain('receiver');
    }
  });

  it('does NOT attribute parameter annotations to the function', () => {
    const code = `
fun plain(@Suppress("x") arg: String) {}
`;
    for (const [arm, result] of arms('Plain.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'plain');
      expect(node?.decorators ?? [], arm).not.toContain('Suppress');
    }
  });

  it('keeps expect/actual markers alongside annotation names', () => {
    // `decorators` already carried the KMP platform modifiers (the expect/actual
    // synthesizer reads them); annotation names append after, without
    // displacing them.
    const code = `
@JvmStatic
expect fun platformName(): String
`;
    for (const [arm, result] of arms('Platform.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'platformName');
      expect(node?.decorators, arm).toContain('expect');
      expect(node?.decorators, arm).toContain('JvmStatic');
    }
  });
});

describe('Kotlin @Composable component classification', () => {
  it('classifies a @Composable top-level function as component', () => {
    const code = `
@Composable
fun ProfileCard(name: String) {
    Text(name)
}
`;
    for (const [arm, result] of arms('ProfileCard.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'ProfileCard');
      expect(node?.kind, arm).toBe('component');
    }
  });

  it('classifies a @Composable method inside a class as component', () => {
    const code = `
class CardRenderer {
    @Composable
    fun Render(name: String) {
        Text(name)
    }
}
`;
    for (const [arm, result] of arms('CardRenderer.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'Render');
      expect(node?.kind, arm).toBe('component');
    }
  });

  it('classifies a @Preview composable as component with Preview decorator', () => {
    const code = `
@Preview
@Composable
fun CardPreview() {}
`;
    for (const [arm, result] of arms('CardPreview.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'CardPreview');
      expect(node?.kind, arm).toBe('component');
      expect(node?.decorators, arm).toContain('Preview');
    }
  });

  it('does not reclassify @Composable in a type position', () => {
    // `@Composable () -> Unit` annotates a function TYPE, not a declaration.
    // `content` is a parameter and `holder` stays a plain function.
    const code = `
fun holder(content: @Composable () -> Unit) {
    content()
}
`;
    for (const [arm, result] of arms('Holder.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'holder');
      expect(node?.kind, arm).toBe('function');
      expect(node?.decorators ?? [], arm).not.toContain('Composable');
    }
  });

  it('does not reclassify an annotated class', () => {
    // The kind map applies to functions and methods only; a @Composable-adjacent
    // annotation on a class must not turn it into a component.
    const code = `
@HiltViewModel
class Screen : ViewModel() {}
`;
    for (const [arm, result] of arms('Screen.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'Screen');
      expect(node?.kind, arm).toBe('class');
    }
  });

  it('keeps plain functions as function (no regression)', () => {
    const code = `
fun calculateTotal(items: List<Item>): Double {
    return items.sumOf { it.price }
}
`;
    for (const [arm, result] of arms('utils.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'calculateTotal');
      expect(node?.kind, arm).toBe('function');
      expect(node?.decorators ?? [], arm).toHaveLength(0);
    }
  });

  it('keeps non-Composable annotated functions as function', () => {
    const code = `
@JvmStatic
fun helper() {}
`;
    for (const [arm, result] of arms('Helper.kt', code)) {
      const node = result.nodes.find((n) => n.name === 'helper');
      expect(node?.kind, arm).toBe('function');
      expect(node?.decorators, arm).toContain('JvmStatic');
    }
  });

  it('decorator-name persistence is opt-in per language, not universal', () => {
    // The engine has ONE shared collector, but persisting names onto nodes is
    // gated on `LanguageExtractor.extendedAnnotations` and only Kotlin opts in.
    // Two reasons, both load-bearing:
    //   1. every language routed to the native kernel must emit the SAME names
    //      from its Rust walker or the kernel<->wasm parity gate fails, and
    //      each of the 13 walkers carries its own decorator logic;
    //   2. collecting past the first target is Kotlin-specific — Swift carries
    //      argument expressions in the attribute node
    //      (`@Siblings(through: Pivot.self, from: \\.$left)`), so collecting on
    //      would harvest `self` and `$left` as annotation names.
    // Flipping a language on means porting its Rust walker first, then updating
    // this test. Until then non-opted languages stay byte-identical.
    const ts = extractFromSource(
      'service.ts',
      `
@Injectable()
export class AuthService {
  login(): void {}
}
`
    );
    const tsClass = ts.nodes.find((n) => n.name === 'AuthService');
    expect(tsClass).toBeDefined();
    expect(tsClass?.decorators ?? []).not.toContain('Injectable');

    const java = extractFromSource(
      'UserController.java',
      `
@RestController
public class UserController {
  @Deprecated
  public void old() {}
}
`
    );
    const javaClass = java.nodes.find((n) => n.name === 'UserController');
    expect(javaClass).toBeDefined();
    expect(javaClass?.decorators ?? []).not.toContain('RestController');

    // The `decorates` REFERENCE is still emitted for every language — only the
    // persisted name is gated. That behavior is unchanged by this work.
    const tsDecorates = (ts.unresolvedReferences ?? [])
      .filter((r) => r.referenceKind === 'decorates')
      .map((r) => r.referenceName);
    expect(tsDecorates).toContain('Injectable');
  });
});

/**
 * The reclassification's blast radius. A node created as `component` instead of
 * `function` drops out of every engine gate that keys on function/method, so
 * each of these pins one gate that had to be widened alongside it. Without them
 * the feature regresses the graph silently — nothing fails, the edges just go
 * missing.
 */
describe('@Composable reclassification does not break kind-gated behavior', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(async () => {
    if (cg) {
      await cg.close();
      cg = undefined;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('spans a @Composable body so its callees are captured', () => {
    // createNode's endLine extension gates on function|method, and 'component'
    // was added there for consistency. Guard, not a pin: Kotlin's grammar nests
    // the body inside the declaration, so the extension is a documented no-op
    // for this language and the span is right either way. The assertion that
    // matters is the callee one — the callee trail and the callback
    // synthesizer's body scan both read a node's span.
    const code = `
@Composable
fun Screen() {
    Header()
    Footer()
}
`;
    for (const [arm, result] of arms('Screen.kt', code)) {
      const screen = result.nodes.find((n) => n.name === 'Screen');
      expect(screen?.kind, arm).toBe('component');
      expect((screen!.endLine ?? screen!.startLine) - screen!.startLine, arm).toBeGreaterThan(1);
      const callNames = (result.unresolvedReferences ?? [])
        .filter((r) => r.referenceKind === 'calls')
        .map((r) => r.referenceName);
      expect(callNames, arm).toContain('Header');
      expect(callNames, arm).toContain('Footer');
    }
  });

  it('keeps a function-ref edge to a @Composable used as a value', () => {
    // flushFnRefCandidates / defined_fn_names gate candidate names on
    // function|method before emitting a function_ref. `::Header` is a plain
    // function reference even though Header is now a component.
    const code = `
@Composable
fun Header() {}

fun install() {
    register(::Header)
}
`;
    for (const [arm, result] of arms('Ui.kt', code)) {
      const fnRefs = (result.unresolvedReferences ?? []).filter(
        (r) => r.referenceKind === 'function_ref' && r.referenceName === 'Header'
      );
      expect(fnRefs.length, arm).toBeGreaterThan(0);
    }
  });

  it('resolves a call from one composable into another', async () => {
    // End-to-end through resolution: the `calls` kind-preference and the
    // callable-candidate filters must accept `component` on both ends.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-kt-calls-'));
    fs.writeFileSync(
      path.join(tempDir, 'Screen.kt'),
      `package p

@Composable
fun Header() {}

@Composable
fun Screen() {
    Header()
}
`
    );
    cg = await CodeGraph.init(tempDir, { index: true });

    const header = cg
      .searchNodes('Header', { limit: 20 })
      .map((r) => r.node)
      .find((n) => n.kind === 'component');
    expect(header).toBeDefined();
    const callers = cg.getCallers(header!.id).map((c) => c.node.name);
    expect(callers).toContain('Screen');
  });

  it('keeps receiver inference scoped to each composable', async () => {
    // enclosingScopeStartLine bounds receiver inference to the enclosing
    // function/method; `component` had to be added or the backward scan widens
    // to the whole file. Guard, not a pin: Kotlin's scan already finds the
    // nearest preceding declaration, so this holds before the fix too — it
    // exists so a future change to the bound can't silently cross composables.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-kt-scope-'));
    fs.writeFileSync(
      path.join(tempDir, 'Screen.kt'),
      `package p

class Alpha { fun run() {} }
class Beta { fun run() {} }

@Composable
fun First() {
    val svc = Alpha()
    svc.run()
}

@Composable
fun Second() {
    val svc = Beta()
    svc.run()
}
`
    );
    cg = await CodeGraph.init(tempDir, { index: true });

    const byOwner = (owner: string) =>
      cg!
        .searchNodes('run', { limit: 50 })
        .map((r) => r.node)
        .find((n) => n.kind === 'method' && n.qualifiedName?.includes(owner));

    const alphaRun = byOwner('Alpha');
    const betaRun = byOwner('Beta');
    expect(alphaRun).toBeDefined();
    expect(betaRun).toBeDefined();

    expect(cg.getCallers(alphaRun!.id).map((c) => c.node.name)).toEqual(['First']);
    expect(cg.getCallers(betaRun!.id).map((c) => c.node.name)).toEqual(['Second']);
  });
});

/**
 * The annotation names have to be reachable by an agent, not just present in the
 * database — `decorates` edges to a library annotation never resolve, so
 * `codegraph_node`'s Annotations line is the only place the fact surfaces.
 */
describe('annotations are visible through the MCP node tool', () => {
  let tempDir: string;
  let cg: CodeGraph | undefined;

  afterEach(async () => {
    if (cg) {
      await cg.close();
      cg = undefined;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists a symbol\'s annotations in codegraph_node output', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-kt-mcp-'));
    fs.writeFileSync(
      path.join(tempDir, 'Vm.kt'),
      `package p

@HiltViewModel
class ProfileViewModel : ViewModel() {}

@Composable
fun ProfileCard() {}
`
    );
    cg = await CodeGraph.init(tempDir, { index: true });

    const { ToolHandler } = await import('../src/mcp/tools');
    const handler = new ToolHandler(cg);

    const vm = await handler.execute('codegraph_node', { symbol: 'ProfileViewModel' });
    const vmText = JSON.stringify(vm);
    expect(vmText).toContain('@HiltViewModel');

    const card = await handler.execute('codegraph_node', { symbol: 'ProfileCard' });
    expect(JSON.stringify(card)).toContain('@Composable');
  });
});
