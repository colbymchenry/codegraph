/**
 * AOSP extension — analyze_system_service (Phase 3).
 *
 * Same same-file correlation discipline as find_jni_bridge's post-review fix:
 * the service class and its supporting evidence must share a file for
 * "found"; anything else is convention_derived_candidate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { analyzeSystemService } from '../src/aosp/system_service';

describe('AOSP extension: analyzeSystemService', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-svc-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports "found" when the service class and its registration are in the same file', async () => {
    write(
      'src/FooManagerService.kt',
      'package com.example.services\n\n' +
        'class FooManagerService {\n' +
        '    fun onStart() {\n' +
        '        ServiceManager.addService("foo", this)\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'foo');

    expect(result.serviceClassName).toBe('FooManagerService');
    expect(result.serviceClass?.name).toBe('FooManagerService');
    expect(result.registrations.length).toBeGreaterThan(0);
    expect(result.status).toBe('found');
  });

  it('title-cases underscore-separated service names for the class lookup', async () => {
    write(
      'src/DevicePolicyManagerService.kt',
      'package com.example.services\n\n' +
        'class DevicePolicyManagerService {\n' +
        '    fun onStart() {\n' +
        '        ServiceManager.addService("device_policy", this)\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'device_policy');

    expect(result.serviceClassName).toBe('DevicePolicyManagerService');
    expect(result.serviceClass?.name).toBe('DevicePolicyManagerService');
    expect(result.status).toBe('found');
  });

  it('recovers internal camel-case boundaries from a compressed lowercase name', async () => {
    write(
      'src/CarPropertyService.kt',
      'package com.example.services\n\nclass CarPropertyService\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'carproperty');

    expect(result.serviceClassName).toBe('CarPropertyService');
    expect(result.serviceClass?.name).toBe('CarPropertyService');
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('finds a service class using a common suffix other than ManagerService', async () => {
    write(
      'src/AudioService.kt',
      'package com.example.services\n\n' +
        'class AudioService {\n' +
        '    fun onStart() {\n' +
        '        ServiceManager.addService("audio", this)\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'audio');

    expect(result.serviceClassName).toBe('AudioService');
    expect(result.serviceClass?.name).toBe('AudioService');
    expect(result.status).toBe('found');
  });

  it('does not treat a same-file getSystemService lookup as registration evidence', async () => {
    write(
      'src/LookupManagerService.kt',
      'package com.example.services\n\n' +
        'class LookupManagerService {\n' +
        '    fun inspect(context: Context) {\n' +
        '        context.getSystemService("lookup")\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'lookup');

    expect(result.clientUsageSites.length).toBeGreaterThan(0);
    expect(result.registrations).toHaveLength(0);
    expect(result.startupSites).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('reports "convention_derived_candidate", not "found", when the registration is in a different file', async () => {
    write('src/BarManagerService.kt', 'package com.example.services\n\nclass BarManagerService\n');
    write(
      'src/SystemServer.kt',
      'package com.example.services\n\n' +
        'class SystemServer {\n' +
        '    fun startAll() {\n' +
        '        ServiceManager.addService("bar", BarManagerService())\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'bar');

    expect(result.serviceClass).not.toBeNull();
    expect(result.registrations.length).toBeGreaterThan(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('reports "no_service_found" when nothing matches', async () => {
    write('src/Unrelated.kt', 'package com.example.services\n\nclass Unrelated\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'nonexistent');

    expect(result.status).toBe('no_service_found');
    expect(result.serviceClass).toBeNull();
  });

  it('reports "found" when a cross-file startup site names the exact class, even without same-file evidence (Codex cross-review finding, 2026-09-04: JNI\'s same-file rule does not fit the AOSP shape where SystemServer starts the service from a different file than the service class itself)', async () => {
    write('src/BazManagerService.kt', 'package com.example.services\n\nclass BazManagerService\n');
    write(
      'src/SystemServer.kt',
      'package com.example.services\n\n' +
        'class SystemServer {\n' +
        '    fun startAll() {\n' +
        '        startService(BazManagerService::class.java)\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'baz');

    expect(result.serviceClass).not.toBeNull();
    expect(result.startupSites.length).toBeGreaterThan(0);
    expect(result.status).toBe('found');
  });

  it('does NOT report "found" from a bare diagnostic log line mentioning the class name — only an actual start<...>(...) call site counts (Blue Team round-2 finding, 2026-09-04)', async () => {
    write('src/QuxManagerService.kt', 'package com.example.services\n\nclass QuxManagerService\n');
    write(
      'src/SomeUnrelatedFile.kt',
      'package com.example.other\n\n' +
        'class SomeUnrelatedFile {\n' +
        '    fun logStatus() {\n' +
        '        Log.d(TAG, "waiting for start of QuxManagerService before continuing")\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'qux');

    expect(result.serviceClass).not.toBeNull();
    expect(result.startupSites).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('does not treat method declarations or proto.start calls as service startup sites', async () => {
    write('src/WindowManagerService.kt', 'package com.example.services\n\nclass WindowManagerService\n');
    write(
      'src/UnrelatedHelpers.kt',
      'package com.example.other\n\n' +
        'class UnrelatedHelpers {\n' +
        '    fun startNonAppWindowAnimations(service: WindowManagerService) {}\n' +
        '    fun startService(service: WindowManagerService) {}\n' +
        '    fun writeProto(proto: WindowManagerServiceDumpProto) {\n' +
        '        proto.start(WindowManagerServiceDumpProto())\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'window');

    expect(result.startupSites).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('requires an exact registered service name instead of accepting a prefix', async () => {
    write(
      'src/PowerManagerService.kt',
      'package com.example.services\n\n' +
        'class PowerManagerService {\n' +
        '    fun onStart() {\n' +
        '        ServiceManager.addService("power_save", this)\n' +
        '        LocalServices.addService("power", this)\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'power');

    expect(result.registrations).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('does not throw and does not over-match on a service name containing regex metacharacters (Codex cross-review finding, 2026-09-04: unescaped interpolation)', async () => {
    write(
      'src/Foo.BarManagerService.kt',
      'package com.example.services\n\nclass FooXBarManagerService\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    expect(() => analyzeSystemService(cg, dir, 'foo.bar')).not.toThrow();
    const result = analyzeSystemService(cg, dir, 'foo.bar');

    // exact class match requires "FooBarManagerService" via titleCase — this
    // fixture has no such class, so the point is purely that a `.` in the
    // service name is NOT treated as a regex wildcard when searching
    // addService/getSystemService call sites.
    expect(result.status).toBe('no_service_found');
  });

  it('does not duplicate an overlapping suffix when the queried name already ends with it (e.g. a name ending in "Manager")', async () => {
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = analyzeSystemService(cg, dir, 'AppCardServiceManager');

    // Before the fix, appending "ManagerService"/"Manager" unconditionally
    // produced "AppCardServiceManagerManagerService" — the overlapping
    // "Manager" word doubled up. The reported candidate name should read
    // like a real AOSP class, not something with a repeated word.
    expect(result.serviceClassName).toBe('AppCardServiceManagerService');
    expect(result.serviceClassName).not.toMatch(/ManagerManager/);
    expect(result.status).toBe('no_service_found');
  });

  it('documents that system-service needs registration or startup evidence', () => {
    const manual = fs.readFileSync(path.join(process.cwd(), 'docs/design/android-platform-analysis.md'), 'utf8');
    const contract = manual.match(/- \*\*`system-service`\*\*:[\s\S]*?(?=\n- \*\*|$)/)?.[0] ?? '';

    expect(contract).toContain('registration');
    expect(contract).toContain('startup');
    expect(contract).toContain('Client usage alone does not promote a candidate');
  });
});
