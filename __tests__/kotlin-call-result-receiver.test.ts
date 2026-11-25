/**
 * A Kotlin call on what an unqualified call returns is a call on the type
 * that function declares (#2805). `repository().pending(1)`, with a private
 * `fun repository(): RealRepo` in the calling class, went to whichever
 * `pending` the name matched first — a test double's `FakeRepo.pending` in
 * another package — and `val repo = repository(); repo.pending(1)` went to
 * the interface `Repo.pending`, guessed from the local's name. Both now link
 * `RealRepo.pending`, through the helper the class declares, inherits or the
 * package declares at the top level; a type that has no such method links
 * nothing rather than a namesake elsewhere.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const FILES: Record<string, string> = {
  // The issue's four files, verbatim.
  'src/main/kotlin/demo/domain/Repo.kt': `package demo.domain

interface Repo {
    fun pending(id: Long): Int
}
`,
  'src/main/kotlin/demo/data/RealRepo.kt': `package demo.data

import demo.domain.Repo

class RealRepo : Repo {
    override fun pending(id: Long): Int = 1
}
`,
  'src/test/kotlin/demo/testutil/FakeRepo.kt': `package demo.testutil

import demo.domain.Repo

class FakeRepo : Repo {
    override fun pending(id: Long): Int = 2
}
`,
  'src/test/kotlin/demo/data/RealRepoTest.kt': `package demo.data

class RealRepoTest {
    private fun repository(): RealRepo = RealRepo()

    fun viaConstructor() {
        val repo = RealRepo()
        repo.pending(1)
    }

    fun viaHelperLocal() {
        val repo = repository()
        repo.pending(1)
    }

    fun viaHelperChain() {
        repository().pending(1)
    }
}
`,
  // More helpers and call shapes.
  'src/test/kotlin/demo/data/MoreHelperTest.kt': `package demo.data

import demo.domain.Repo

abstract class BaseRepoTest {
    protected fun baseRepository(): RealRepo = RealRepo()
}

class MoreHelperTest : BaseRepoTest() {
    private fun repository(): RealRepo = RealRepo()
    private fun asInterface(): Repo = RealRepo()
    private fun nullable(): RealRepo? = null

    private fun runTest(block: () -> Unit) = block()

    fun viaBaseHelper() {
        baseRepository().pending(1)
    }

    fun viaInterfaceHelper() {
        asInterface().pending(1)
    }

    fun viaThis() {
        this.repository().pending(1)
    }

    fun viaSafeCall() {
        nullable()?.pending(1)
    }

    fun viaTopLevel() {
        freshRepo().pending(1)
    }

    fun viaLambdaLocal() {
        runTest {
            var repo = repository()
            repo.pending(1)
        }
    }

    fun viaMissing() {
        repository().missing()
    }
}
`,
  'src/test/kotlin/demo/data/Fixtures.kt': `package demo.data

fun freshRepo(): RealRepo = RealRepo()

fun RealRepo.describe(): String = "real"

class Codec {
    class Reader {
        fun readInt(): Int = 0
    }
}

// A nested type sharing its name with the one the helper names (in Request.kt); an extension on a nested type.
class MockRequest {
    class Builder {
        fun post(): Builder = this
    }
}

class Mall {
    class Builder {
        fun open(): Mall = Mall()
    }
}

// Shop.newBuilder() declares a plain Builder, which is Shop.Builder.
fun Shop.reopen(): Shop = newBuilder().open()

class Dns {
    class Call
}

fun Dns.Call.toEvents(): Int = 1

class Client {
    private fun request(): Request.Builder = Request.Builder()
    private fun newCall(): Dns.Call = Dns.Call()

    fun send() {
        request().post()
    }

    fun events() {
        newCall().toEvents()
    }
}

class InheritedHelperTest {
    private fun audited(): AuditedRepo = AuditedRepo()
    private fun repository(): RealRepo = RealRepo()
    private fun newReader(): Codec.Reader = Codec.Reader()
    private fun text(): StringBuilder = StringBuilder()

    // A nested type the helper names through its outer class.
    fun viaNested() {
        newReader().readInt()
    }

    // A type from outside the project: linked by the method's name, as before.
    fun viaOutside() {
        text().reverse()
    }

    // A method the helper's type inherits; an extension function on it.
    fun viaInherited() {
        audited().audit()
    }

    fun viaExtension() {
        repository().describe()
    }

    fun viaVisibleExtension() {
        repository().label()
    }
}
`,
  'src/main/kotlin/demo/data/Shop.kt': `package demo.data

class Shop {
    class Builder {
        fun open(): Shop = Shop()
    }

    fun newBuilder(): Builder = Builder()
}
`,
  'src/main/kotlin/demo/data/Request.kt': `package demo.data

class Request {
    class Builder {
        fun post(): Builder = this
    }
}
`,
  // The helper's type and its base, in a file indexed after the caller's.
  'src/test/kotlin/demo/data/zz/Audit.kt': `package demo.data

open class BaseAudit {
    fun audit() {}
}

class AuditedRepo : BaseAudit()
`,
  // Two extensions of one name: the caller's package declares one, another package the other.
  'src/test/kotlin/demo/aa/OtherLabels.kt': `package demo.aa

import demo.data.RealRepo

fun RealRepo.label(): String = "other"
`,
  'src/test/kotlin/demo/data/zz/Labels.kt': `package demo.data

fun RealRepo.label(): String = "own"
`,
  // A namesake of both methods in an unrelated package.
  'src/test/kotlin/demo/other/Decoy.kt': `package demo.other

class Decoy {
    fun missing() {}
    fun pending(id: Long): Int = 3
    fun audit() {}
    fun describe(): String = "decoy"
    fun readInt(): Int = 3
    fun reverse() {}
}
`,
};

let root = '';
let graph: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-call-result-'));
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

/** The qualified names `owner::fn` calls, sorted. */
function callees(owner: string, fn: string): string[] {
  const caller = graph.getNodesByKind('method').find((m) =>
    m.qualifiedName.endsWith(`::${owner}::${fn}`) || m.qualifiedName === `${owner}::${fn}`);
  expect(caller, `${owner}::${fn}`).toBeDefined();
  return graph
    .getOutgoingEdges(caller!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => graph.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('a Kotlin call on what an unqualified call returns (#2805)', () => {
  it("the issue's local and chained forms reach the helper's declared type", () => {
    expect(callees('RealRepoTest', 'viaConstructor')).toEqual(['demo.data::RealRepo::pending']);
    expect(callees('RealRepoTest', 'viaHelperLocal')).toEqual([
      'demo.data::RealRepo::pending',
      'demo.data::RealRepoTest::repository',
    ]);
    expect(callees('RealRepoTest', 'viaHelperChain')).toEqual([
      'demo.data::RealRepo::pending',
      'demo.data::RealRepoTest::repository',
    ]);
  });

  it('a helper the class inherits, one through `this.`, a safe call and a top-level function', () => {
    expect(callees('MoreHelperTest', 'viaBaseHelper')).toEqual([
      'demo.data::BaseRepoTest::baseRepository',
      'demo.data::RealRepo::pending',
    ]);
    expect(callees('MoreHelperTest', 'viaThis')).toEqual([
      'demo.data::MoreHelperTest::repository',
      'demo.data::RealRepo::pending',
    ]);
    expect(callees('MoreHelperTest', 'viaSafeCall')).toEqual([
      'demo.data::MoreHelperTest::nullable',
      'demo.data::RealRepo::pending',
    ]);
    expect(callees('MoreHelperTest', 'viaTopLevel')).toEqual([
      'demo.data::RealRepo::pending',
      'demo.data::freshRepo',
    ]);
  });

  it('a helper declared to return the interface reaches the interface method', () => {
    expect(callees('MoreHelperTest', 'viaInterfaceHelper')).toEqual([
      'demo.data::MoreHelperTest::asInterface',
      'demo.domain::Repo::pending',
    ]);
  });

  it('a local set from a helper inside a lambda', () => {
    expect(callees('MoreHelperTest', 'viaLambdaLocal')).toEqual([
      'demo.data::MoreHelperTest::repository',
      'demo.data::MoreHelperTest::runTest',
      'demo.data::RealRepo::pending',
    ]);
  });

  it("a method the helper's type inherits, and an extension function on it", () => {
    expect(callees('InheritedHelperTest', 'viaInherited')).toEqual([
      'demo.data::BaseAudit::audit',
      'demo.data::InheritedHelperTest::audited',
    ]);
    expect(callees('InheritedHelperTest', 'viaExtension')).toEqual([
      'RealRepo::describe',
      'demo.data::InheritedHelperTest::repository',
    ]);
  });

  it('a nested type named through its outer class; a type from outside the project as before', () => {
    expect(callees('InheritedHelperTest', 'viaNested')).toEqual([
      'demo.data::Codec::Reader::readInt',
      'demo.data::InheritedHelperTest::newReader',
    ]);
    // `StringBuilder.reverse()` is the JDK's: the project's namesake is the
    // guess it was on main, left to the strategies this change doesn't touch.
    expect(callees('InheritedHelperTest', 'viaOutside')).toEqual([
      'demo.data::InheritedHelperTest::text',
      'demo.other::Decoy::reverse',
    ]);
  });

  it('a nested type of a shared name is the one the helper names', () => {
    expect(callees('Client', 'send')).toEqual([
      'demo.data::Client::request',
      'demo.data::Request::Builder::post',
    ]);
    expect(callees('Shop', 'reopen')).toEqual([
      'demo.data::Shop::Builder::open',
      'demo.data::Shop::newBuilder',
    ]);
    // An extension on a nested type is kept under the outer type's name: found by name, as before.
    expect(callees('Client', 'events')).toEqual([
      'Dns::toEvents',
      'demo.data::Client::newCall',
    ]);
  });

  it("an extension the calling file can name, of two alike", () => {
    const caller = graph.getNodesByKind('method').find((m) => m.qualifiedName.endsWith('::InheritedHelperTest::viaVisibleExtension'))!;
    const targets = graph.getOutgoingEdges(caller.id).filter((e) => e.kind === 'calls').map((e) => graph.getNode(e.target)!)
      .filter((n) => n.name === 'label').map((n) => n.filePath);
    expect(targets).toEqual(['src/test/kotlin/demo/data/zz/Labels.kt']);
  });

  it('a method the declared type lacks links nothing, not a namesake elsewhere', () => {
    expect(callees('MoreHelperTest', 'viaMissing')).toEqual(['demo.data::MoreHelperTest::repository']);
  });
});
