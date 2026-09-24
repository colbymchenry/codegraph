/**
 * AOSP extension — findMessengerIpc.
 *
 * Same same-file/same-class-body correlation discipline as
 * analyzeSystemService's publishBinderService check: naming convention
 * alone never reaches "found," only a real Messenger reference inside the
 * matched provider class's own body does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { findMessengerIpc } from '../src/aosp/messenger';

describe('AOSP extension: findMessengerIpc', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-messenger-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports "found" for a Java provider using new Messenger(...) in its own body', async () => {
    write(
      'src/AppCardService.java',
      'package com.example.services;\n\n' +
        'import android.os.Messenger;\n\n' +
        'class AppCardService {\n' +
        '    private final Messenger messenger = new Messenger(new IncomingHandler());\n' +
        '}\n'
    );
    write(
      'src/AppCardServiceManager.java',
      'package com.example.services;\n\n' +
        'import android.os.Messenger;\n\n' +
        'class AppCardServiceManager {\n' +
        '    private Messenger serviceMessenger;\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'AppCard');

    expect(result.providerClassName).toBe('AppCardService');
    expect(result.clientClassName).toBe('AppCardServiceManager');
    expect(result.providerClass?.name).toBe('AppCardService');
    expect(result.clientClass?.name).toBe('AppCardServiceManager');
    expect(result.providerEvidence.length).toBeGreaterThan(0);
    expect(result.status).toBe('found');
  });

  it('reports "found" for a Kotlin provider using bare Messenger(handler) constructor-call syntax (no "new" keyword) — verified against real AAOS AppCardService.kt', async () => {
    write(
      'src/AppCardService.kt',
      'package com.example.services\n\n' +
        'import android.os.Messenger\n\n' +
        'class AppCardService {\n' +
        '    private val messenger = Messenger(handler)\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'AppCard');

    expect(result.providerClass?.name).toBe('AppCardService');
    expect(result.providerEvidence.length).toBeGreaterThan(0);
    expect(result.status).toBe('found');
  });

  it('reports "convention_derived_candidate" when the provider class exists but never touches Messenger in its own body', async () => {
    write('src/PlainService.kt', 'package com.example.services\n\nclass PlainService\n');

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'Plain');

    expect(result.providerClass?.name).toBe('PlainService');
    expect(result.providerEvidence).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('reports "convention_derived_candidate" when only the client class matches, not the provider', async () => {
    write(
      'src/OnlyClientManager.kt',
      'package com.example.services\n\n' +
        'import android.os.Messenger\n\n' +
        'class OnlyClientManager {\n' +
        '    private var messenger: Messenger? = null\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'OnlyClient');

    expect(result.providerClass).toBeNull();
    expect(result.clientClass?.name).toBe('OnlyClientManager');
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('reports "no_messenger_ipc_found" when nothing matches', async () => {
    write('src/Unrelated.kt', 'package com.example.services\n\nclass Unrelated\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'NonExistentThing');

    expect(result.providerClass).toBeNull();
    expect(result.clientClass).toBeNull();
    expect(result.status).toBe('no_messenger_ipc_found');
  });

  it('does not treat a Messenger reference in an unrelated file/class as evidence for the matched provider (same-body scoping)', async () => {
    write('src/LonelyService.kt', 'package com.example.services\n\nclass LonelyService\n');
    write(
      'src/SomewhereElse.kt',
      'package com.example.other\n\n' +
        'import android.os.Messenger\n\n' +
        'class SomewhereElse {\n' +
        '    private val messenger = Messenger(handler)\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'Lonely');

    expect(result.providerClass?.name).toBe('LonelyService');
    expect(result.providerEvidence).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('does not treat an unrelated same-named import as android.os.Messenger (Codex adversarial review, 2026-09-12, HIGH-1)', async () => {
    write(
      'src/DecoyService.java',
      'package p;\n\nimport unrelated.Messenger;\n\nclass DecoyService {\n    Object x = new Messenger();\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'Decoy');

    expect(result.providerEvidence).toHaveLength(0);
    expect(result.status).not.toBe('found');
  });

  it('does not attribute a sibling class construction on the same source line to the matched class (Codex adversarial review, 2026-09-12, HIGH-2)', async () => {
    write(
      'src/Both.java',
      'import android.os.Messenger;\nclass EmptyService {} class Other { Object m = new Messenger(null); }\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'Empty');

    expect(result.providerClass?.name).toBe('EmptyService');
    expect(result.providerEvidence).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('does not attribute a nested static class construction to the enclosing class (Codex adversarial review, 2026-09-12, HIGH-2)', async () => {
    write(
      'src/OuterService.java',
      'import android.os.Messenger;\nclass OuterService {\n static class Independent {\n Object m = new Messenger(null);\n }\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'Outer');

    expect(result.providerClass?.name).toBe('OuterService');
    expect(result.providerEvidence).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('prefers a corroborated bare-name provider over an uncorroborated {Name}Service decoy (Codex adversarial review, 2026-09-12, MEDIUM-6)', async () => {
    write('src/DemoService.java', 'class DemoService {}\n');
    write(
      'src/Demo.java',
      'import android.os.Messenger;\nclass Demo { Object x = new Messenger(null); }\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'Demo');

    expect(result.providerClassName).toBe('Demo');
    expect(result.status).toBe('found');
  });

  it('does not treat a Messenger mention inside a comment or string literal as real code', async () => {
    write(
      'src/QuietService.java',
      'import android.os.Messenger;\nclass QuietService {\n // new Messenger(null);\n String text = "new Messenger(null);";\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'Quiet');

    expect(result.status).toBe('convention_derived_candidate');
  });

  it('still reaches "found" when android.os.Messenger itself is indexed (resolved-edge evidence)', async () => {
    write('android/os/Messenger.java', 'package android.os;\npublic final class Messenger { public Messenger(Object h) {} }\n');
    write(
      'src/DemoService.java',
      'package p;\n\nimport android.os.Messenger;\n\nclass DemoService {\n    Object x = new Messenger(null);\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findMessengerIpc(cg, dir, 'Demo');

    expect(result.status).toBe('found');
  });
});
