/**
 * AOSP extension — AIDL implementation discovery.
 *
 * codegraph does not index `.aidl` files (no language extractor for them),
 * so an AIDL interface never becomes a node. But when a Kotlin class
 * declares `: IFoo.Stub()`, the extractor still records that extends clause
 * — it just can't resolve `IFoo`, so it lands in `unresolved_refs` instead
 * of an edge. That's a stronger "who implements this?" signal than name
 * matching: it fires even when the implementing class's name carries no
 * hint of the interface (case 1 below — "TestServiceStub" happens to match
 * the naming-convention search too, so case 1 doubles as a regression guard
 * that the primary unresolved_refs signal fires independently of it).
 *
 * Fail-closed is the point, not an edge case: a real AOSP interface with no
 * in-repo implementation (case 2) must report `no_implementation_found` with
 * evidence, never a false positive and never silence. Case 3 covers an
 * interface name with no matching `.aidl` declaration at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { findAidlImpl, parseAidlDeclarations } from '../src/aosp/aidl';

describe('AOSP extension: findAidlImpl', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-aidl-'));

    write(
      'src/ITestService.aidl',
      'package com.example.test;\ninterface ITestService {\n    void doWork();\n}\n'
    );
    write(
      'src/IOrphanCallback.aidl',
      'package com.example.test;\ninterface IOrphanCallback {\n    void onResult(boolean success);\n}\n'
    );
    write(
      'src/TestServiceImpl.kt',
      'package com.example.test\n\n' +
        'class TestServiceStub : ITestService.Stub() {\n' +
        '    override fun doWork() {\n' +
        '        ServiceManager.addService("TestService", this)\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds an implementation via the unresolved extends signal even though the class name matches naming-convention too', () => {
    const result = findAidlImpl(cg, dir, 'ITestService');

    expect(result.status).toBe('found');
    expect(result.declaration).not.toBeNull();
    expect(result.declaration?.filePath).toBe('src/ITestService.aidl');
    expect(result.declaration?.methods).toEqual(['doWork']);

    const stubHit = result.implementations.find((c) => c.kind === 'stub_subclass');
    expect(stubHit).toBeDefined();
    expect(stubHit?.name).toBe('TestServiceStub');
    expect(stubHit?.filePath).toBe('src/TestServiceImpl.kt');
    expect(stubHit?.matchedPattern).toContain('unresolved extends -> ITestService');

    expect(result.registrations.length).toBeGreaterThan(0);
    expect(result.registrations[0]?.matchedPattern).toContain('addService.*TestService');
  });

  it('fails closed when a declared AIDL interface has no in-repo implementation', () => {
    const result = findAidlImpl(cg, dir, 'IOrphanCallback');

    expect(result.status).toBe('no_implementation_found');
    expect(result.declaration).not.toBeNull();
    expect(result.implementations).toHaveLength(0);
    expect(result.registrations).toHaveLength(0);
    // Fail-closed means the caller can see WHAT was searched, not just "nothing".
    expect(result.evidence.some((e) => e.includes('unresolved_refs search'))).toBe(true);
    expect(result.evidence.some((e) => e.includes('naming-convention search'))).toBe(true);
    expect(result.evidence.some((e) => e.includes('service registration search'))).toBe(true);
  });

  it('reports declaration_not_found for an interface name with no matching .aidl file', () => {
    const result = findAidlImpl(cg, dir, 'IDoesNotExist');

    expect(result.status).toBe('declaration_not_found');
    expect(result.declaration).toBeNull();
    expect(result.evidence.some((e) => e.includes('no .aidl declaration'))).toBe(true);
    expect(result.evidence.every((e) => !e.includes(dir))).toBe(true);
  });

  it('surfaces a warning when the declaration walk is deliberately capped', () => {
    const result = findAidlImpl(cg, dir, 'ITestService', { maxDepth: 0 });

    expect(result.status).toBe('declaration_not_found');
    expect(result.evidence.some((e) => e.includes('WARNING:') && e.includes('상한'))).toBe(true);
  });

  it('demotes an unresolved_refs hit to convention_derived_candidate when the implementing class cannot reach this interface\'s package — a same-named interface in an unrelated package', () => {
    write(
      'src/IAmbiguous.aidl',
      'package com.example.test;\ninterface IAmbiguous {\n    void ping();\n}\n'
    );
    // "IAmbiguous.Stub()" resolves by bare name via unresolved_refs, but this
    // class actually imports a completely unrelated same-named interface and
    // has no way to reach com.example.test.IAmbiguous.
    write(
      'src/UnrelatedStub.kt',
      'package com.example.unrelated\n\n' +
        'import com.example.unrelated.rpc.IAmbiguous\n\n' +
        'class UnrelatedStub : IAmbiguous.Stub() {\n    override fun ping() {}\n}\n'
    );

    return cg.indexAll().then(() => {
      const result = findAidlImpl(cg, dir, 'IAmbiguous');

      expect(result.status).toBe('convention_derived_candidate');
      const hit = result.implementations.find((c) => c.kind === 'stub_subclass');
      expect(hit?.packageVerified).toBe('mismatch');
      expect(result.evidence.some((e) => e.includes('could not reach package'))).toBe(true);
    });
  });

  it('resolves the second of two interfaces declared in the same .aidl file, instead of returning a mismatched status/implementations pair', () => {
    write(
      'src/IMulti.aidl',
      'package com.example.test;\n' +
        'interface IFirstOne {\n    void first();\n}\n' +
        'interface ISecondOne {\n    void second();\n}\n'
    );
    write(
      'src/SecondImpl.kt',
      'package com.example.test\n\nclass SecondImpl : ISecondOne.Stub() {\n    override fun second() {}\n}\n'
    );

    return cg.indexAll().then(() => {
      const result = findAidlImpl(cg, dir, 'ISecondOne');

      expect(result.status).toBe('found');
      expect(result.declaration?.filePath).toBe('src/IMulti.aidl');
      expect(result.declaration?.methods).toEqual(['second']);
      const hit = result.implementations.find((c) => c.kind === 'stub_subclass');
      expect(hit?.name).toBe('SecondImpl');
    });
  });

  it('does not let a commented-out stale declaration bleed another interface\'s data under its name', () => {
    write(
      'src/ICommented.aidl',
      'package com.example.test;\n' +
        '// interface IWrongDecoy {\n' +
        '//     void decoy();\n' +
        '// }\n' +
        'interface ICommented {\n    void real();\n}\n'
    );

    const result = findAidlImpl(cg, dir, 'IWrongDecoy');

    expect(result.status).toBe('declaration_not_found');
    expect(result.declaration).toBeNull();
  });

  it('finds an implementation named without the leading "I" (AOSP convention: IFoo -> FooImpl), not just {Interface}Impl', () => {
    write('src/IWidget.aidl', 'package com.example.test;\ninterface IWidget {\n    void spin();\n}\n');
    write('src/WidgetImpl.kt', 'package com.example.test\n\nclass WidgetImpl\n');

    return cg.indexAll().then(() => {
      const result = findAidlImpl(cg, dir, 'IWidget');

      expect(result.status).toBe('convention_derived_candidate');
      const hit = result.implementations.find((c) => c.name === 'WidgetImpl');
      expect(hit).toBeDefined();
    });
  });

  it('picks the declaration whose package a candidate can actually verify, when the same interface name is declared in two different packages', () => {
    write('moduleA/IShared.aidl', 'package com.example.a;\ninterface IShared {\n    void ping();\n}\n');
    write('moduleB/IShared.aidl', 'package com.example.b;\ninterface IShared {\n    void ping();\n}\n');
    write(
      'src/SharedStub.kt',
      'package com.example.b\n\nclass SharedStub : IShared.Stub() {\n    override fun ping() {}\n}\n'
    );

    return cg.indexAll().then(() => {
      const result = findAidlImpl(cg, dir, 'IShared');

      expect(result.status).toBe('found');
      expect(result.declaration?.filePath).toBe('moduleB/IShared.aidl');
      const hit = result.implementations.find((c) => c.kind === 'stub_subclass');
      expect(hit?.name).toBe('SharedStub');
      expect(hit?.packageVerified).toBe('verified');
    });
  });

  it('parses a Unicode .aidl declaration correctly (AIDL/Kotlin identifiers are not ASCII-only) — but a Unicode-named implementer still cannot be matched, a CodeGraph core limitation outside this extension\'s scope', async () => {
    write('src/I가나다.aidl', 'package com.example.test;\ninterface I가나다 {\n    void 실행();\n}\n');
    write('src/한국어구현.kt', 'package com.example.test\n\nclass 한국어구현 : I가나다.Stub() {\n    override fun 실행() {}\n}\n');
    await cg.indexAll();

    const result = findAidlImpl(cg, dir, 'I가나다');

    // The declaration-file parser (this extension's own regex, reading
    // .aidl text directly) now handles Unicode correctly — verified
    // separately below. But CodeGraph's own Kotlin extractor does not
    // record an extends/implements clause at all when either side of it is
    // a non-ASCII identifier:
    // `cg.getUnresolvedReferencesByName('I가나다')` returns empty even when
    // the implementing class name is plain ASCII) — so the primary signal
    // this whole module is built on never fires for a Unicode interface,
    // regardless of what this file's own regexes do. Fixing that is a
    // CodeGraph core extractor change, not something patchable from
    // src/aosp/*.
    expect(result.declaration).not.toBeNull();
    expect(result.declaration?.methods).toEqual(['실행']);
    expect(result.status).toBe('no_implementation_found');
  });

  it('parseAidlDeclarations itself handles a Unicode interface name and its Unicode method name (isolates this extension\'s own regex parsing from the CodeGraph core limitation above)', () => {
    write('src/I가나다.aidl', 'package com.example.test;\ninterface I가나다 {\n    void 실행();\n}\n');

    const declarations = parseAidlDeclarations(dir, 'I가나다');

    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.methods).toEqual(['실행']);
    expect(declarations[0]?.packageName).toBe('com.example.test');
  });

  it('matches a lower/camelCase addService registration string against the PascalCase bare interface name', () => {
    write('src/IHybrid.aidl', 'package com.example.test;\ninterface IHybrid {\n    void ping();\n}\n');
    write(
      'src/HybridService.kt',
      'package com.example.test\n\n' +
        'class HybridService {\n' +
        '    fun setup() {\n' +
        '        ServiceManager.addService("hybrid", this)\n' +
        '    }\n' +
        '}\n'
    );

    return cg.indexAll().then(() => {
      const result = findAidlImpl(cg, dir, 'IHybrid');
      expect(result.registrations.length).toBeGreaterThan(0);
    });
  });

  it('verifies a wildcard import against the declaration\'s package, not just an exact FQCN import', () => {
    write('src/IWild.aidl', 'package com.example.test;\ninterface IWild {\n    void ping();\n}\n');
    write(
      'src/WildStub.kt',
      'package com.example.other\n\nimport com.example.test.*\n\nclass WildStub : IWild.Stub() {\n    override fun ping() {}\n}\n'
    );

    return cg.indexAll().then(() => {
      const result = findAidlImpl(cg, dir, 'IWild');

      expect(result.status).toBe('found');
      const hit = result.implementations.find((c) => c.kind === 'stub_subclass');
      expect(hit?.packageVerified).toBe('verified');
    });
  });

  it('surfaces in evidence when package verification could not run at all (no parseable package clause), instead of silently treating it as verified', () => {
    write('src/INoPackage.aidl', 'interface INoPackage {\n    void ping();\n}\n');
    write('src/NoPackageStub.kt', 'package com.example.whatever\n\nclass NoPackageStub : INoPackage.Stub() {\n    override fun ping() {}\n}\n');

    return cg.indexAll().then(() => {
      const result = findAidlImpl(cg, dir, 'INoPackage');

      expect(result.status).toBe('found');
      const hit = result.implementations.find((c) => c.kind === 'stub_subclass');
      expect(hit?.packageVerified).toBe('unverifiable');
      expect(result.evidence.some((e) => e.includes('did NOT run'))).toBe(true);
    });
  });

  // A naming-convention match (or a bare addService hit) is real signal but not proof of
  // implementation — it must never be promoted to `found` on its own.
  describe('naming-convention and registration matches stay convention_derived_candidate, not found', () => {
    it('a class named {Interface}Impl with NO extends/implements clause referencing the interface', () => {
      write(
        'src/ILonely.aidl',
        'package com.example.test;\ninterface ILonely {\n    void ping();\n}\n'
      );
      // Named per the naming convention, but implements an unrelated
      // interface — the old code's un-filtered searchNodes() hit would have
      // matched this by FTS relevance alone.
      write(
        'src/ILonelyImpl.kt',
        'package com.example.test\n\ninterface Unrelated\n\nclass ILonelyImpl : Unrelated\n'
      );

      return cg.indexAll().then(() => {
        const result = findAidlImpl(cg, dir, 'ILonely');

        expect(result.status).toBe('convention_derived_candidate');
        expect(result.implementations).toHaveLength(1);
        expect(result.implementations[0]?.kind).toBe('impl_by_name');
        expect(result.implementations[0]?.name).toBe('ILonelyImpl');
      });
    });

    it('a bare addService hit with no implementation candidate at all', () => {
      write(
        'src/IRegisteredOnly.aidl',
        'package com.example.test;\ninterface IRegisteredOnly {\n    void ping();\n}\n'
      );
      write(
        'src/SomeOtherFile.kt',
        'package com.example.test\n\n' +
          'class Unrelated {\n' +
          '    fun setup() {\n' +
          '        ServiceManager.addService("RegisteredOnly", this)\n' +
          '    }\n' +
          '}\n'
      );

      return cg.indexAll().then(() => {
        const result = findAidlImpl(cg, dir, 'IRegisteredOnly');

        expect(result.implementations).toHaveLength(0);
        expect(result.registrations.length).toBeGreaterThan(0);
        expect(result.status).toBe('convention_derived_candidate');
      });
    });

    it('does not throw on an interface name containing regex metacharacters', () => {
      expect(() => findAidlImpl(cg, dir, 'IFoo(Bar)')).not.toThrow();
      const result = findAidlImpl(cg, dir, 'IFoo(Bar)');
      expect(result.status).toBe('declaration_not_found');
    });

    it('an exact naming-convention substring should NOT match a longer unrelated class name', () => {
      write(
        'src/IPicky.aidl',
        'package com.example.test;\ninterface IPicky {\n    void ping();\n}\n'
      );
      // IPickyImplHelper contains "IPickyImpl" as a substring/FTS token but is
      // not named exactly "IPickyImpl" — must not be reported as a candidate.
      write('src/Decoy.kt', 'package com.example.test\n\nclass IPickyImplHelper\n');

      return cg.indexAll().then(() => {
        const result = findAidlImpl(cg, dir, 'IPicky');

        expect(result.implementations).toHaveLength(0);
        expect(result.status).toBe('no_implementation_found');
      });
    });
  });

  // Symmetric with aosp-hal.test.ts's equivalent case — findAidlFiles has
  // its own directory walk (app-level AIDL, not scoped to
  // hardware/interfaces/ like findHalFiles), so it needs its own symlink
  // regression coverage.
  it('refuses to follow a symlinked subdirectory when discovering .aidl files', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-aidl-outside-'));
    fs.writeFileSync(
      path.join(outsideDir, 'ISecretAidl.aidl'),
      'package secret.outside;\ninterface ISecretAidl {\n    void x();\n}\n'
    );
    fs.mkdirSync(path.join(dir, 'src', 'linked_target'), { recursive: true });
    try {
      fs.symlinkSync(outsideDir, path.join(dir, 'src', 'linked'), 'dir');
    } catch {
      // Some CI sandboxes disallow symlink creation — skip rather than fail spuriously.
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    await cg.indexAll();
    const result = findAidlImpl(cg, dir, 'ISecretAidl');

    expect(result.status).toBe('declaration_not_found');
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  describe('AIDL declaration and candidate regressions', () => {
    it('finds a real AIDL declaration living under a vendor/ directory instead of skipping it outright', async () => {
      write(
        'vendor/oem/interfaces/IVendorOnly.aidl',
        'package com.oem.vendor;\ninterface IVendorOnly {\n    void doVendorThing();\n}\n'
      );
      write(
        // A Kotlin/Java implementer under vendor/ is deliberately NOT part
        // of this fixture: CodeGraph's own core indexer (directory.ts,
        // extraction/index.ts) ignores `vendor/` by default for every
        // language, independent of this aosp extension — a Kotlin/Java
        // implementer placed there would never produce an `unresolved_refs`
        // hit no matter what this file discovers, and fixing that is a core
        // indexing-policy change outside this fork's scope, not an aosp
        // extension bug. This test only verifies the piece this extension
        // DOES own: `findAidlFiles` walks its OWN file-system scan of
        // `.aidl` files (which core never indexes for any repo) and must
        // not silently drop a real vendor-tree declaration the way the
        // previous `IGNORED_DIR_NAMES` did.
        'src/UnrelatedNonVendor.kt',
        'package com.example.other\n\nclass UnrelatedNonVendor\n'
      );

      await cg.indexAll();
      const result = findAidlImpl(cg, dir, 'IVendorOnly');

      expect(result.status).not.toBe('declaration_not_found');
      expect(result.declaration?.filePath).toBe('vendor/oem/interfaces/IVendorOnly.aidl');
    });

    it('prefers a genuinely package-verified declaration over an earlier unverifiable one, instead of stopping at the first non-mismatch', async () => {
      // First declaration on the file-system walk has no parseable package
      // clause (unverifiable for any candidate). Second has a real package,
      // and a real implementer that imports it.
      write('src/IAmbiguous_a.aidl', 'interface IAmbiguous {\n    void ping();\n}\n');
      write(
        'src/IAmbiguous_b.aidl',
        'package com.example.real;\ninterface IAmbiguous {\n    void ping();\n}\n'
      );
      write(
        'src/RealAmbiguousImpl.kt',
        'package com.example.real\n\nimport com.example.real.IAmbiguous\n\nclass RealAmbiguousImpl : IAmbiguous.Stub() {\n    override fun ping() {}\n}\n'
      );

      await cg.indexAll();
      const result = findAidlImpl(cg, dir, 'IAmbiguous');

      expect(result.status).toBe('found');
      expect(result.declaration?.filePath).toBe('src/IAmbiguous_b.aidl');
      const hit = result.implementations.find((c) => c.kind === 'stub_subclass');
      expect(hit?.packageVerified).toBe('verified');
    });

    it('does not truncate the method list at a nested enum\'s closing brace', async () => {
      write(
        'src/INested.aidl',
        'package com.example.nested;\n' +
          'interface INested {\n' +
          '    enum Mode { A, B }\n' +
          '    void afterEnum(in Mode mode);\n' +
          '}\n'
      );

      const declarations = parseAidlDeclarations(dir, 'INested');
      expect(declarations).toHaveLength(1);
      expect(declarations[0]?.methods).toContain('afterEnum');
    });
  });

  describe('a C++ `::`-qualified extends must not leak into this Kotlin/Java-only signal', () => {
    it('does not promote a C++ class that reaches the bare interface name only through a `::` namespace qualifier', async () => {
      write('src/IPlainFoo.aidl', 'interface IPlainFoo {\n    void doWork();\n}\n');
      // Before the fix, getUnresolvedByQualifiedName's shared `::`-suffix
      // match (added for hal.ts's Bn{Name} check) let this unrelated C++
      // class promote to "found" even though findAidlImpl only ever meant
      // to look at Kotlin/Java Stub extends.
      write(
        'src/Decoy.cpp',
        'namespace ns {\nclass Decoy : public ns::IPlainFoo {\npublic:\n    void doWork() {}\n};\n}\n'
      );

      await cg.indexAll();
      const result = findAidlImpl(cg, dir, 'IPlainFoo');

      expect(result.status).toBe('no_implementation_found');
      expect(result.implementations.some((c) => c.name === 'Decoy')).toBe(false);
    });
  });

  it('documents that an unverifiable package can still promote an unresolved AIDL candidate', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    const guide = fs.readFileSync(path.join(process.cwd(), 'docs/design/android-platform-analysis.md'), 'utf8');
    const contract = guide.match(/- \*\*`aidl-impl` \/ `hal-interface`\*\*:[\s\S]*?(?=\n- \*\*|$)/)?.[0] ?? '';

    expect(readme).toContain('(docs/design/android-platform-analysis.md)');
    expect(contract).toContain('unverifiable');
    expect(contract).toContain('only a confirmed `mismatch`');
    expect(contract).toContain('blocks promotion');
  });
});
