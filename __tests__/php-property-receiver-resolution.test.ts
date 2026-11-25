/**
 * PHP property-receiver resolution (#1108 family).
 *
 * `$this->prop->method()` reaches the resolver as `this->prop.method` (the
 * extractor records the receiver's raw text with the leading `$` stripped, and
 * — unlike a `foo()->bar()` chain — there are no `()` on the receiver). The
 * property's declaration lives OUTSIDE the calling method: a promoted
 * constructor parameter (`private readonly Greeter $greeter`), a classic typed
 * property assigned in `__construct`, or a property typed by an interface. The
 * resolver recovers the property's declared type from PROPERTY-shaped
 * declarations only — a modifier-prefixed typed declaration, the
 * `$this->prop = new X()` pseudoconstructor, or (for a classic untyped
 * property) the typed variable assigned to it inside its own function. Plain
 * `$prop` locals and parameters live in a different namespace than
 * `$this->prop` and can never shadow it, so they must never type it — the
 * interference tests below pin that. The inferred type is validated through
 * `resolveMethodOnType`, so a property whose type can't be recovered stays
 * UNLINKED rather than guessed — a wrong inference produces no edge instead
 * of a wrong one.
 *
 * Method lookup runs EXCLUSIVELY through declared-type inference: the
 * name-similarity fallbacks never see this shape, which is what makes the
 * same-name-collision and no-type cases below negative. Inherited methods
 * resolve only once `extends`/`implements` edges exist, so these refs defer to
 * the conformance pass; the full `indexAll()` path here exercises that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { Node } from '../src/types';
import { ResolutionContext } from '../src/resolution';
import { matchMethodCall } from '../src/resolution/name-matcher';
import type { UnresolvedRef } from '../src/resolution/types';

describe('PHP property-receiver resolution', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-prop-recv-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  const load = async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const calls: { src: string; tgt: string; tgtQn: string }[] = db
      .prepare(
        `SELECT s.name src, t.name tgt, t.qualified_name tgtQn
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls' AND t.kind = 'method'`,
      )
      .all();
    cg.close?.();
    return calls;
  };
  const hasCall = (calls: any[], src: string, tgtQn: string) =>
    calls.some((e) => e.src === src && e.tgtQn === tgtQn);
  // Any resolved method call `src` makes to a method of the given bare name —
  // used by the negative cases to assert nothing was guessed.
  const callsMethodNamed = (calls: any[], src: string, tgt: string) =>
    calls.some((e) => e.src === src && e.tgt === tgt);

  const greeter = `<?php\nclass Greeter { public function greet() { return 1; } }\n`;

  it('resolves a promoted constructor property (`private readonly Greeter $greeter`)', async () => {
    write('Greeter.php', greeter);
    write('App.php', `<?php
class App {
  public function __construct(private readonly Greeter $greeter) {}
  public function run() { return $this->greeter->greet(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'Greeter::greet')).toBe(true);
  });

  it('resolves a classic typed property assigned in the constructor', async () => {
    write('Greeter.php', greeter);
    write('App.php', `<?php
class App {
  private Greeter $greeter;
  public function __construct(Greeter $greeter) { $this->greeter = $greeter; }
  public function run() { return $this->greeter->greet(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'Greeter::greet')).toBe(true);
  });

  it('resolves a property typed by an interface to the interface method', async () => {
    write('GreeterInterface.php', `<?php\ninterface GreeterInterface { public function hello(); }\n`);
    write('App.php', `<?php
class App {
  public function __construct(private GreeterInterface $g) {}
  public function run() { return $this->g->hello(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'GreeterInterface::hello')).toBe(true);
  });

  it('resolves an inherited method through the conformance pass (property typed by the subclass)', async () => {
    // `baseMethod` is declared only on Base; the property is typed `Sub`.
    // The `Sub extends Base` edge is what lets the deferred conformance walk
    // find the method on the supertype — the whole point of deferring this ref.
    write('Base.php', `<?php\nclass Base { public function baseMethod() { return 1; } }\n`);
    write('Sub.php', `<?php\nclass Sub extends Base { public function other() { return 2; } }\n`);
    write('App.php', `<?php
class App {
  public function __construct(private Sub $s) {}
  public function run() { return $this->s->baseMethod(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'Base::baseMethod')).toBe(true);
  });

  it('disambiguates by declared type when two classes share a method name (negative)', async () => {
    // Both classes declare `greet`; the property is typed `Greeter`. A
    // name-similarity fallback would happily link either — this shape must
    // route to the RIGHT class and ONLY it.
    write('Greeter.php', greeter);
    write('OtherGreeter.php', `<?php\nclass OtherGreeter { public function greet() { return 2; } }\n`);
    write('App.php', `<?php
class App {
  public function __construct(private Greeter $greeter) {}
  public function run() { return $this->greeter->greet(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'Greeter::greet')).toBe(true);
    expect(hasCall(calls, 'run', 'OtherGreeter::greet')).toBe(false);
    // Exactly one method edge from `run` — no double-linking.
    expect(calls.filter((e) => e.src === 'run')).toHaveLength(1);
  });

  it('creates no edge for an untyped property with only a docblock type (negative)', async () => {
    // `@var Greeter` is a comment, not a declared type. Guessing from a
    // docblock is out of scope — the property stays unlinked.
    write('Greeter.php', greeter);
    write('App.php', `<?php
class App {
  /** @var Greeter */
  private $greeter;
  public function run() { return $this->greeter->greet(); }
}
`);
    const calls = await load();
    expect(callsMethodNamed(calls, 'run', 'greet')).toBe(false);
  });

  it('creates no edge for a deep property chain `$this->a->b->method()` (negative)', async () => {
    // The single-property pattern deliberately does not match a two-hop chain;
    // the intermediate type is unknown, so nothing is guessed.
    write('Greeter.php', greeter);
    write('App.php', `<?php
class App {
  public function __construct(private Wrapper $a) {}
  public function run() { return $this->a->b->greet(); }
}
`);
    const calls = await load();
    expect(callsMethodNamed(calls, 'run', 'greet')).toBe(false);
  });

  it('a local variable shadowing a property routes to the local\'s type, not the property (#1108 regression)', async () => {
    // `$greeter->greet()` has receiver `greeter` (no `this->`), so it takes the
    // existing #1108 local-variable path, not the new property path. The local
    // `new OtherGreeter()` must win by nearest-declaration-backward even though
    // a property `$greeter` typed `Greeter` exists — the property change must
    // not hijack a plain-variable receiver.
    write('Greeter.php', greeter);
    write('OtherGreeter.php', `<?php\nclass OtherGreeter { public function greet() { return 2; } }\n`);
    write('App.php', `<?php
class App {
  public function __construct(private Greeter $greeter) {}
  public function run() { $greeter = new OtherGreeter(); return $greeter->greet(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'OtherGreeter::greet')).toBe(true);
    expect(hasCall(calls, 'run', 'Greeter::greet')).toBe(false);
  });

  it('a same-named local in ANOTHER method never types the property (interference)', async () => {
    // In PHP `$greeter` (a local) and `$this->greeter` (the property) are
    // different namespaces — unlike CFML's scopes, no shadowing is possible.
    // The nearest declaration walking backward from run()'s call is helper()'s
    // `$greeter = new OtherGreeter()`; the property's promoted type `Greeter`
    // must still win.
    write('Greeter.php', greeter);
    write('OtherGreeter.php', `<?php\nclass OtherGreeter { public function greet() { return 2; } }\n`);
    write('App.php', `<?php
class App {
  public function __construct(private Greeter $greeter) {}
  public function helper() { $greeter = new OtherGreeter(); return $greeter->greet(); }
  public function run() { return $this->greeter->greet(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'Greeter::greet')).toBe(true);
    expect(hasCall(calls, 'run', 'OtherGreeter::greet')).toBe(false);
    // helper()'s own local-receiver call still routes to the local's type.
    expect(hasCall(calls, 'helper', 'OtherGreeter::greet')).toBe(true);
  });

  it('a same-named local in the SAME method never types the property (interference)', async () => {
    write('Greeter.php', greeter);
    write('OtherGreeter.php', `<?php\nclass OtherGreeter { public function greet() { return 2; } }\n`);
    write('App.php', `<?php
class App {
  public function __construct(private Greeter $greeter) {}
  public function run() {
    $greeter = new OtherGreeter();
    $greeter->greet();
    return $this->greeter->greet();
  }
}
`);
    const calls = await load();
    // Both calls resolve, each to its own receiver's type.
    expect(hasCall(calls, 'run', 'OtherGreeter::greet')).toBe(true);
    expect(hasCall(calls, 'run', 'Greeter::greet')).toBe(true);
  });

  it('a same-named parameter of an unrelated method never types the property (interference)', async () => {
    write('Greeter.php', greeter);
    write('OtherGreeter.php', `<?php\nclass OtherGreeter { public function greet() { return 2; } }\n`);
    write('App.php', `<?php
class App {
  public function __construct(private Greeter $greeter) {}
  public function accept(OtherGreeter $greeter) { return $greeter->greet(); }
  public function run() { return $this->greeter->greet(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'Greeter::greet')).toBe(true);
    expect(hasCall(calls, 'run', 'OtherGreeter::greet')).toBe(false);
    expect(hasCall(calls, 'accept', 'OtherGreeter::greet')).toBe(true);
  });

  it('resolves a classic UNTYPED property through its constructor assignment (multi-line signature)', async () => {
    // Pre-7.4 style: the property declaration carries no type; the type lives
    // on the constructor parameter, here across a multi-line signature. The
    // resolver follows `$this->greeter = $greeter` to the parameter's type.
    write('Greeter.php', greeter);
    write('App.php', `<?php
class App {
  private $greeter;
  public function __construct(
    Greeter $greeter,
    $other
  ) {
    $this->greeter = $greeter;
  }
  public function run() { return $this->greeter->greet(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'Greeter::greet')).toBe(true);
  });

  it('resolves a setter-injected untyped property through the setter parameter', async () => {
    write('Greeter.php', greeter);
    write('App.php', `<?php
class App {
  private $greeter;
  public function setGreeter(Greeter $greeter) { $this->greeter = $greeter; }
  public function run() { return $this->greeter->greet(); }
}
`);
    const calls = await load();
    expect(hasCall(calls, 'run', 'Greeter::greet')).toBe(true);
  });

  it('the assignment-following fallback stays inside the assigning function (interference)', async () => {
    // The untyped property is assigned from an UNTYPED constructor parameter,
    // and a same-named typed variable exists in the method directly above the
    // constructor. The backward scan from the assignment must stop at the
    // constructor's own `function` line — no type is recoverable, no edge.
    write('Greeter.php', greeter);
    write('OtherGreeter.php', `<?php\nclass OtherGreeter { public function greet() { return 2; } }\n`);
    write('App.php', `<?php
class App {
  private $greeter;
  public function helper() { $greeter = new OtherGreeter(); return $greeter->greet(); }
  public function __construct($greeter) {
    $this->greeter = $greeter;
  }
  public function run() { return $this->greeter->greet(); }
}
`);
    const calls = await load();
    expect(callsMethodNamed(calls, 'run', 'greet')).toBe(false);
  });

  // Unit-level check of the confidence the integration DB does not expose:
  // the property-receiver shape resolves through resolveMethodOnType at 0.9.
  it('matchMethodCall resolves `this->prop.method` at confidence 0.9', () => {
    const node = (id: string, name: string, qn: string, kind: Node['kind'], file: string): Node => ({
      id, kind, name, qualifiedName: qn, filePath: file, language: 'php',
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0,
    });
    const byName: Record<string, Node[]> = {
      Greeter: [node('c:greeter', 'Greeter', 'Greeter', 'class', 'Greeter.php')],
      greet: [node('m:greet', 'greet', 'Greeter::greet', 'method', 'Greeter.php')],
    };
    const lines = [
      '<?php',
      'class App {',
      '  public function __construct(private readonly Greeter $greeter) {}',
      '  public function run() { return $this->greeter->greet(); }',
      '}',
    ];
    const ctx: ResolutionContext = {
      getNodesInFile: () => [],
      getNodesByName: (name) => byName[name] ?? [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getFileLines: () => lines,
      getProjectRoot: () => '',
      getAllFiles: () => [],
      getImportMappings: () => [],
    };
    const ref: UnresolvedRef = {
      fromNodeId: 'caller', referenceName: 'this->greeter.greet', referenceKind: 'calls',
      line: 4, column: 0, filePath: 'App.php', language: 'php',
    };
    const res = matchMethodCall(ref, ctx);
    expect(res?.targetNodeId).toBe('m:greet');
    expect(res?.confidence).toBe(0.9);
    expect(res?.resolvedBy).toBe('instance-method');
  });
});
