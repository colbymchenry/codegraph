/**
 * AOSP extension — permission and broadcast evidence.
 *
 * Both are pure text-candidate search with no found/not-found status — these
 * tests check that the right files/lines are returned, not a status field.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { tracePermission, traceBroadcast } from '../src/aosp/permission_broadcast';

describe('AOSP extension: tracePermission / traceBroadcast', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-perm-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tracePermission finds a manifest definition and check/enforcement call sites', async () => {
    write(
      'AndroidManifest.xml',
      '<manifest><uses-permission android:name="android.permission.CAMERA"/></manifest>\n'
    );
    write(
      'src/Guard.kt',
      'package com.example\n\n' +
        'class Guard {\n' +
        '    fun check() {\n' +
        '        checkPermission("android.permission.CAMERA")\n' +
        '        enforcePermission("android.permission.CAMERA")\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = tracePermission(cg, dir, 'android.permission.CAMERA');

    expect(result.xmlMatches.length).toBeGreaterThan(0);
    expect(result.xmlMatches[0]?.filePath).toBe('AndroidManifest.xml');
    expect(result.checkPoints.length).toBeGreaterThan(0);
    expect(result.enforcement.length).toBeGreaterThan(0);
  });

  it('finds calling and calling-or-self permission APIs', async () => {
    write(
      'src/CallerGuard.kt',
      'package com.example\n\n' +
        'class CallerGuard {\n' +
        '    fun check() {\n' +
        '        checkCallingPermission("android.permission.CAMERA")\n' +
        '        enforceCallingOrSelfPermission("android.permission.CAMERA")\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = tracePermission(cg, dir, 'android.permission.CAMERA');

    expect(result.checkPoints).toHaveLength(1);
    expect(result.enforcement).toHaveLength(1);
  });

  it('tracePermission returns empty arrays (not an error) when nothing matches', async () => {
    write('src/Plain.kt', 'package com.example\n\nclass Plain\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = tracePermission(cg, dir, 'android.permission.NEVER_USED');

    expect(result.xmlMatches).toHaveLength(0);
    expect(result.checkPoints).toHaveLength(0);
    expect(result.enforcement).toHaveLength(0);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('ignores a match inside a line comment', async () => {
    write(
      'src/Old.kt',
      'package com.example\n\n' +
        'class Old {\n' +
        '    fun check() {\n' +
        '        // checkPermission("android.permission.CAMERA") — removed, no longer used\n' +
        '    }\n' +
        '}\n'
    );
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = tracePermission(cg, dir, 'android.permission.CAMERA');

    expect(result.checkPoints).toHaveLength(0);
  });

  it('ignores a match inside an XML comment', async () => {
    write(
      'AndroidManifest.xml',
      '<manifest>\n    <!-- <uses-permission android:name="android.permission.REMOVED"/> -->\n</manifest>\n'
    );
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = tracePermission(cg, dir, 'android.permission.REMOVED');

    expect(result.xmlMatches).toHaveLength(0);
  });

  it('traceBroadcast finds a sendBroadcast call site', async () => {
    write(
      'src/Sender.kt',
      'package com.example\n\n' +
        'class Sender {\n' +
        '    fun boot() {\n' +
        '        sendBroadcast(Intent("android.intent.action.BOOT_COMPLETED"))\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = traceBroadcast(cg, dir, 'android.intent.action.BOOT_COMPLETED');

    expect(result.senders.length).toBeGreaterThan(0);
    expect(result.senders[0]?.filePath).toBe('src/Sender.kt');
  });

  it('documents that well-formed XML comments are stripped before permission scanning', () => {
    const manual = fs.readFileSync(path.join(process.cwd(), 'docs/design/android-platform-analysis.md'), 'utf8');
    const section = manual.match(/- \*\*`trace-permission`\*\*:[\s\S]*?(?=\n- \*\*`trace-broadcast`)/)?.[0] ?? '';

    expect(section).toContain('well-formed XML comments are stripped');
    expect(section).not.toContain('a comment');
  });
});
