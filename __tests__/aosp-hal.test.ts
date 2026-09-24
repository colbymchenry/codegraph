/**
 * AOSP extension — HAL interface discovery.
 *
 * Same contract as find_aidl_impl, scoped to hardware/interfaces/ and
 * extended with a native (c/cpp) implementation search.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { findHalInterface, parseHalDeclarations } from '../src/aosp/hal';

describe('AOSP extension: findHalInterface', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-hal-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds a Kotlin/Java Stub implementation via the unresolved-extends signal, scoped to hardware/interfaces/', async () => {
    write(
      'hardware/interfaces/light/ILight.aidl',
      'package android.hardware.light;\ninterface ILight {\n    void setBrightness(int level);\n}\n'
    );
    write(
      'src/LightHalService.kt',
      'package com.example.hal\n\n' +
        'import android.hardware.light.ILight\n\n' +
        'class LightHalService : ILight.Stub() {\n    override fun setBrightness(level: Int) {}\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'ILight');

    expect(result.status).toBe('found');
    expect(result.declaration?.filePath).toBe('hardware/interfaces/light/ILight.aidl');
    const hit = result.implementations.find((c) => c.kind === 'stub_subclass');
    expect(hit?.name).toBe('LightHalService');
  });

  it('finds a native (c/cpp) implementation candidate by the bare interface name', async () => {
    write(
      'hardware/interfaces/foo/IFoo.aidl',
      'package android.hardware.foo;\ninterface IFoo {\n    void doWork();\n}\n'
    );
    write(
      'hardware/interfaces/foo/default/Foo.cpp',
      '#include "Foo.h"\n\nclass Foo {\npublic:\n    void doWork() {}\n};\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IFoo');

    expect(result.status).toBe('convention_derived_candidate');
    const nativeHit = result.implementations.find((c) => c.matchedPattern.includes('native impl candidate'));
    expect(nativeHit?.name).toBe('Foo');
  });

  it('finds a C++ HIDL implementation through unresolved extends when the declaration has a package', async () => {
    write(
      'hardware/interfaces/drm/1.0/IDrmPlugin.hal',
      'package android.hardware.drm@1.0;\ninterface IDrmPlugin {\n    doWork();\n};\n'
    );
    // A C++ file can never satisfy a Java-style dotted-FQCN import check
    // (`#include` is a path, not `android.hardware.drm.IDrmPlugin`), so this
    // must never be treated as a confirmed "mismatch" just because the
    // declaration's package happens to be known — that previously demoted
    // a genuinely correct C++ implementation caught by the SAME primary
    // unresolved-extends signal a real Kotlin/Java `.Stub()` extends already
    // promotes to `found`.
    write(
      'hardware/interfaces/drm/1.0/default/DrmPlugin.h',
      '#include <hardware/drm/1.0/IDrmPlugin.h>\n\nstruct DrmPlugin : public IDrmPlugin {\npublic:\n    void doWork() {}\n};\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IDrmPlugin', 'hidl');

    expect(result.status).toBe('found');
    const hit = result.implementations.find((c) => c.name === 'DrmPlugin');
    expect(hit).toBeDefined();
    expect(hit?.packageVerified).toBe('unverifiable');
  });

  it('finds a native implementation through Bn{InterfaceName} inheritance despite an unrelated class name', async () => {
    write(
      'hardware/interfaces/foo/IFoo.aidl',
      'package android.hardware.foo;\ninterface IFoo {\n    void doWork();\n}\n'
    );
    // The real class name ("DefaultFooHal") has no textual relationship to
    // "IFoo" at all — the only signal that it is IFoo's implementation is
    // that it inherits the AIDL-generated Bn{Name} Binder-native stub, the
    // C++ analog of Java's {Name}.Stub. The old naming-convention-only
    // search (bare name / "Impl" suffix) can never find this.
    write(
      'hardware/interfaces/foo/default/DefaultFooHal.h',
      '#include "BnFoo.h"\n\nclass DefaultFooHal : public BnFoo {\npublic:\n    void doWork() {}\n};\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IFoo');

    // A Bn{Name} name match alone is a weaker signal than a Kotlin/Java
    // unresolved `.Stub()` extends: there is no package/import (or any other
    // structural correlation) to check, so an unrelated C++ class that
    // happens to share the `Bn{Name}` string cannot be told apart from a
    // real AIDL-generated stub subclass here. It surfaces as evidence and
    // raises `convention_derived_candidate`, but must never alone reach
    // `found`.
    expect(result.status).toBe('convention_derived_candidate');
    const hit = result.implementations.find((c) => c.name === 'DefaultFooHal');
    expect(hit).toBeDefined();
    expect(hit?.packageVerified).toBe('unverifiable');
    expect(hit?.matchedPattern).toContain('Binder-native stub');
  });

  it('finds Bn{InterfaceName} inheritance through a C++ namespace alias', async () => {
    write(
      'hardware/interfaces/foo/IFoo.aidl',
      'package android.hardware.foo;\ninterface IFoo {\n    void doWork();\n}\n'
    );
    write(
      'hardware/interfaces/foo/default/DefaultFooHal.h',
      '#include "BnFoo.h"\n\n' +
        'namespace aidlfoo = ::aidl::android::hardware::foo;\n\n' +
        'class DefaultFooHal final : public aidlfoo::BnFoo {\npublic:\n    void doWork() {}\n};\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IFoo');

    expect(result.status).toBe('convention_derived_candidate');
    const hit = result.implementations.find((c) => c.name === 'DefaultFooHal');
    expect(hit).toBeDefined();
    expect(hit?.packageVerified).toBe('unverifiable');
    expect(hit?.matchedPattern).toContain('Binder-native stub');
  });

  describe('Bn{Name} negative/edge coverage', () => {
    it('does not match a lowercase `bnfoo` against a `BnFoo` search — SQLite LIKE is ASCII case-insensitive by default', async () => {
      write(
        'hardware/interfaces/foo/IFoo.aidl',
        'package android.hardware.foo;\ninterface IFoo {\n    void doWork();\n}\n'
      );
      write(
        'src/Decoy.cpp',
        'namespace ns {\nclass Decoy : public ns::bnfoo {\npublic:\n    void doWork() {}\n};\n}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findHalInterface(cg, dir, 'IFoo');

      expect(result.status).toBe('no_implementation_found');
      expect(result.implementations.some((c) => c.name === 'Decoy')).toBe(false);
    });

    it('does not apply the AIDL-only Bn{Name} check to a HIDL lookup — HIDL native wrappers are named BnHw{Name}, a different family', async () => {
      write('hardware/interfaces/foo/1.0/IFoo.hal', 'package android.hardware.foo@1.0;\ninterface IFoo {\n    doWork();\n};\n');
      // An unrelated C++ class that happens to inherit a bare `BnFoo` — under
      // the old code this alone would have promoted a HIDL "IFoo" lookup,
      // even though HIDL's real native wrapper naming is `BnHwFoo`, not
      // `BnFoo` (an AIDL-only convention).
      write(
        'src/Decoy.cpp',
        'class Decoy : public BnFoo {\npublic:\n    void doWork() {}\n};\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findHalInterface(cg, dir, 'IFoo', 'hidl');

      expect(result.status).toBe('no_implementation_found');
      expect(result.implementations.some((c) => c.name === 'Decoy')).toBe(false);
    });

    it('does not promote an unrelated struct that merely shares the Bn{Name} string to "found" without any other correlation', async () => {
      write(
        'hardware/interfaces/foo/IFoo.aidl',
        'package android.hardware.foo;\ninterface IFoo {\n    void doWork();\n}\n'
      );
      write(
        'src/unrelated/Decoy.cpp',
        'struct Decoy : public BnFoo {\n    void doWork() {}\n};\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findHalInterface(cg, dir, 'IFoo');

      expect(result.status).toBe('convention_derived_candidate');
      expect(result.status).not.toBe('found');
    });

    it.each([
      ['Interface', 'BnInterface'],
      ['Ifoo', 'BnIfoo'],
      ['I', 'BnI'],
    ])(
      'computes the AIDL-codegen bare name correctly for the boundary interface name "%s" (real rule requires the 2nd char to be uppercase before stripping the leading I) (MEDIUM-1)',
      async (interfaceName, bnName) => {
        write(
          `hardware/interfaces/foo/${interfaceName}.aidl`,
          `package android.hardware.foo;\ninterface ${interfaceName} {\n    void doWork();\n}\n`
        );
        write(
          'hardware/interfaces/foo/default/DefaultFooHal.h',
          `#include "${bnName}.h"\n\nclass DefaultFooHal : public ${bnName} {\npublic:\n    void doWork() {}\n};\n`
        );

        cg = CodeGraph.initSync(dir);
        await cg.indexAll();
        const result = findHalInterface(cg, dir, interfaceName);

        // A naive `replace(/^I/, '')` would compute the wrong Bn{Name} for
        // these boundary names and miss the real hit entirely
        // (no_implementation_found); the generator-accurate rule finds it.
        expect(result.status).toBe('convention_derived_candidate');
        const hit = result.implementations.find((c) => c.name === 'DefaultFooHal');
        expect(hit).toBeDefined();
      }
    );
  });

  it('demotes an unresolved_refs hit to convention_derived_candidate when the implementing class cannot reach this HAL\'s package — a same-named interface in an unrelated package', async () => {
    write(
      'hardware/interfaces/foo/IShared.aidl',
      'package android.hardware.foo;\ninterface IShared {\n    void doWork();\n}\n'
    );
    // This class's "IShared.Stub()" resolves (by bare name) to the HAL above via
    // unresolved_refs, but it actually imports a completely unrelated same-named
    // interface — it has no way to reach android.hardware.foo.IShared.
    write(
      'src/UnrelatedStub.kt',
      'package com.example.other\n\n' +
        'import com.example.other.rpc.IShared\n\n' +
        'class UnrelatedStub : IShared.Stub() {\n    override fun doWork() {}\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IShared');

    expect(result.status).toBe('convention_derived_candidate');
    const hit = result.implementations.find((c) => c.kind === 'stub_subclass');
    expect(hit?.packageVerified).toBe('mismatch');
    expect(result.evidence.some((e) => e.includes('could not reach package'))).toBe(true);
  });

  it('does NOT match an .aidl declaration outside hardware/interfaces/ (app-level AIDL is find_aidl_impl\'s job, not this tool\'s)', async () => {
    write(
      'app/src/main/aidl/com/example/IAppOnly.aidl',
      'package com.example;\ninterface IAppOnly {\n    void ping();\n}\n'
    );
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IAppOnly');

    expect(result.status).toBe('declaration_not_found');
  });

  it('reports no_implementation_found for a declared HAL with nothing implementing it', async () => {
    write(
      'hardware/interfaces/orphan/IOrphanHal.aidl',
      'package android.hardware.orphan;\ninterface IOrphanHal {\n    void ping();\n}\n'
    );
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IOrphanHal');

    expect(result.status).toBe('no_implementation_found');
    expect(result.implementations).toHaveLength(0);
  });

  it('parses a HIDL declaration that extends a parent interface', async () => {
    write(
      'hardware/interfaces/bar/1.0/IBar.hal',
      'package android.hardware.bar@1.0;\n\ninterface IBar extends IBase {\n    ping();\n};\n'
    );
    write(
      'src/BarHalService.kt',
      'package com.example.hal\n\n' +
        'import android.hardware.bar.IBar\n\n' +
        'class BarHalService : IBar.Stub() {\n    override fun ping() {}\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IBar', 'hidl');

    expect(result.declaration).not.toBeNull();
    expect(result.declaration?.filePath).toBe('hardware/interfaces/bar/1.0/IBar.hal');
    expect(result.status).toBe('found');
  });

  it('verifies against HIDL\'s actual versioned Java import ({package}.V{major}_{minor}.{Name}), not just the plain package', async () => {
    write(
      'hardware/interfaces/baz2/1.0/IBaz2.hal',
      'package android.hardware.baz2@1.0;\n\ninterface IBaz2 {\n    ping();\n};\n'
    );
    write(
      'src/Baz2HalService.kt',
      'package com.example.hal\n\n' +
        'import android.hardware.baz2.V1_0.IBaz2\n\n' +
        'class Baz2HalService : IBaz2.Stub() {\n    override fun ping() {}\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IBaz2', 'hidl');

    expect(result.status).toBe('found');
    const hit = result.implementations.find((c) => c.kind === 'stub_subclass');
    expect(hit?.packageVerified).toBe('verified');
  });

  it('refuses to follow a symlinked subdirectory when discovering .aidl/.hal files', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-hal-outside-'));
    fs.mkdirSync(path.join(outsideDir, 'secret'), { recursive: true });
    fs.writeFileSync(
      path.join(outsideDir, 'secret', 'ISecretHal.aidl'),
      'package secret.outside;\ninterface ISecretHal {\n    void x();\n}\n'
    );
    fs.mkdirSync(path.join(dir, 'hardware', 'interfaces'), { recursive: true });
    try {
      fs.symlinkSync(outsideDir, path.join(dir, 'hardware', 'interfaces', 'linked'), 'dir');
    } catch {
      // Some CI sandboxes disallow symlink creation — skip rather than fail spuriously.
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'ISecretHal');

    expect(result.status).toBe('declaration_not_found');
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('does not let a commented-out stale HAL declaration bleed another interface\'s data under its name', async () => {
    write(
      'hardware/interfaces/qux/IQux.aidl',
      'package android.hardware.qux;\n' +
        '// interface IWrongQux {\n' +
        '//     void decoy();\n' +
        '// }\n' +
        'interface IQux {\n    void real();\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IWrongQux');

    expect(result.status).toBe('declaration_not_found');
    expect(result.declaration).toBeNull();
  });

  it('picks the versioned declaration whose package a candidate can actually verify, when two HIDL versions declare the same bare interface name', async () => {
    write(
      'hardware/interfaces/ver/1.0/IVer.hal',
      'package android.hardware.ver@1.0;\n\ninterface IVer {\n    void ping();\n};\n'
    );
    write(
      'hardware/interfaces/ver/2.0/IVer.hal',
      'package android.hardware.ver@2.0;\n\ninterface IVer {\n    void ping();\n};\n'
    );
    write(
      'src/VerHalService.kt',
      'package com.example.hal\n\n' +
        'import android.hardware.ver.V2_0.IVer\n\n' +
        'class VerHalService : IVer.Stub() {\n    override fun ping() {}\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IVer', 'hidl');

    expect(result.status).toBe('found');
    expect(result.declaration?.filePath).toBe('hardware/interfaces/ver/2.0/IVer.hal');
  });

  it('finds a native implementation candidate written in plain C, not just C++', async () => {
    write(
      'hardware/interfaces/baz/IBaz.aidl',
      'package android.hardware.baz;\ninterface IBaz {\n    void doWork();\n}\n'
    );
    write(
      'hardware/interfaces/baz/default/Baz.c',
      'struct Baz {\n    void (*doWork)(void);\n};\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findHalInterface(cg, dir, 'IBaz');

    expect(result.status).toBe('convention_derived_candidate');
    const nativeHit = result.implementations.find((c) => c.matchedPattern.includes('native impl candidate'));
    expect(nativeHit?.name).toBe('Baz');
  });

  describe('HAL declaration and candidate regressions', () => {
    it('parses a HIDL interface extending a VERSIONED parent', async () => {
      write(
        'hardware/interfaces/gnss/2.0/IGnssCallback.hal',
        'package android.hardware.gnss@2.0;\n\ninterface IGnssCallback extends @1.0::IGnssCallback {\n    ping();\n};\n'
      );
      write(
        'src/GnssCallbackImpl.kt',
        'package com.example.hal\n\n' +
          'import android.hardware.gnss.V2_0.IGnssCallback\n\n' +
          'class GnssCallbackImpl : IGnssCallback.Stub() {\n    override fun ping() {}\n}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findHalInterface(cg, dir, 'IGnssCallback', 'hidl');

      expect(result.declaration).not.toBeNull();
      expect(result.declaration?.filePath).toBe('hardware/interfaces/gnss/2.0/IGnssCallback.hal');
      expect(result.status).toBe('found');
    });

    it('does not treat an aidl_api frozen-version snapshot as a second, colliding declaration', async () => {
      write(
        'hardware/interfaces/foo/aidl/IFoo.aidl',
        'package android.hardware.foo;\ninterface IFoo {\n    void doWork();\n}\n'
      );
      write(
        'hardware/interfaces/foo/aidl/aidl_api/android.hardware.foo/1/android/hardware/foo/IFoo.aidl',
        'package android.hardware.foo;\ninterface IFoo {\n    void doWork();\n}\n'
      );
      write(
        'hardware/interfaces/foo/aidl/aidl_api/android.hardware.foo/current/android/hardware/foo/IFoo.aidl',
        'package android.hardware.foo;\ninterface IFoo {\n    void doWork();\n}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findHalInterface(cg, dir, 'IFoo');

      expect(result.declaration?.filePath).toBe('hardware/interfaces/foo/aidl/IFoo.aidl');
      expect(result.evidence.some((e) => e.includes('declaration(s) named'))).toBe(false);
    });

    it('finds a HAL implemented in Kotlin/Java as "FooImpl" (leading "I" dropped), matching aidl.ts\'s existing convention', async () => {
      write(
        'hardware/interfaces/qux/IQux.aidl',
        'package android.hardware.qux;\ninterface IQux {\n    void doWork();\n}\n'
      );
      write('src/QuxImpl.kt', 'package com.example.hal\n\nclass QuxImpl\n');

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findHalInterface(cg, dir, 'IQux');

      expect(result.status).toBe('convention_derived_candidate');
      const hit = result.implementations.find((c) => c.matchedPattern === 'QuxImpl');
      expect(hit?.name).toBe('QuxImpl');
    });

    it('walks into a hardware/interfaces/ subtree located under vendor/ instead of skipping the whole vendor/ subtree', async () => {
      write(
        'vendor/oem/hardware/interfaces/IVendorHal.aidl',
        'package com.oem.hardware;\ninterface IVendorHal {\n    void doWork();\n}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findHalInterface(cg, dir, 'IVendorHal');

      expect(result.declaration).not.toBeNull();
      expect(result.declaration?.filePath).toBe('vendor/oem/hardware/interfaces/IVendorHal.aidl');
    });

    it('does not truncate the method list at a nested enum\'s closing brace', async () => {
      write(
        'hardware/interfaces/nested/INested.hal',
        'package android.hardware.nested@1.0;\n\n' +
          'interface INested {\n' +
          '    enum Mode : int32_t { A, B };\n' +
          '    afterEnum(Mode mode);\n' +
          '};\n'
      );

      const declarations = parseHalDeclarations(dir, 'INested', '.hal');
      expect(declarations).toHaveLength(1);
      expect(declarations[0]?.methods).toContain('afterEnum');
    });

    it('prefers a genuinely package-verified declaration over an earlier unverifiable one', async () => {
      write('hardware/interfaces/amb/1.0/IAmb.hal', 'interface IAmb {\n    ping();\n};\n');
      write(
        'hardware/interfaces/amb/2.0/IAmb.hal',
        'package android.hardware.amb@2.0;\n\ninterface IAmb {\n    ping();\n};\n'
      );
      write(
        'src/AmbImpl.kt',
        'package com.example.hal\n\n' +
          'import android.hardware.amb.V2_0.IAmb\n\n' +
          'class AmbImpl : IAmb.Stub() {\n    override fun ping() {}\n}\n'
      );

      cg = CodeGraph.initSync(dir);
      await cg.indexAll();
      const result = findHalInterface(cg, dir, 'IAmb', 'hidl');

      expect(result.status).toBe('found');
      expect(result.declaration?.filePath).toBe('hardware/interfaces/amb/2.0/IAmb.hal');
    });
  });
});
