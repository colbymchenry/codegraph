/**
 * AOSP extension — findLocalSocketIpc.
 *
 * Unlike Messenger/ContentProvider, this tool makes no claim a same-repo
 * counterpart exists — "found" only means the named class genuinely uses
 * LocalSocket/LocalServerSocket somewhere in its own body.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { findLocalSocketIpc } from '../src/aosp/local_socket';

describe('AOSP extension: findLocalSocketIpc', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-localsocket-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports "found" with role "client" for a class using new LocalSocket() — verified against real AAOS CarBugreportManagerService.java shape', async () => {
    write(
      'src/CarBugreportManagerService.java',
      'package com.example.services;\n\n' +
        'import android.net.LocalSocket;\n\n' +
        'class CarBugreportManagerService {\n' +
        '    private LocalSocket connectSocket(String name) {\n' +
        '        LocalSocket socket = new LocalSocket();\n' +
        '        return socket;\n' +
        '    }\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'CarBugreportManagerService');

    expect(result.matchedClass?.name).toBe('CarBugreportManagerService');
    expect(result.clientEvidence.length).toBeGreaterThan(0);
    expect(result.serverEvidence).toHaveLength(0);
    expect(result.role).toBe('client');
    expect(result.status).toBe('found');
  });

  it('reports "found" with role "server" for a class using new LocalServerSocket()', async () => {
    write(
      'src/SocketDaemon.java',
      'package com.example.services;\n\n' +
        'import android.net.LocalServerSocket;\n\n' +
        'class SocketDaemon {\n' +
        '    private LocalServerSocket serverSocket = new LocalServerSocket("mysocket");\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'SocketDaemon');

    expect(result.serverEvidence.length).toBeGreaterThan(0);
    expect(result.clientEvidence).toHaveLength(0);
    expect(result.role).toBe('server');
    expect(result.status).toBe('found');
  });

  it('reports role "both" when a class constructs both LocalSocket and LocalServerSocket', async () => {
    write(
      'src/BothRoles.java',
      'package com.example.services;\n\n' +
        'import android.net.LocalSocket;\n' +
        'import android.net.LocalServerSocket;\n\n' +
        'class BothRoles {\n' +
        '    LocalSocket client = new LocalSocket();\n' +
        '    LocalServerSocket server = new LocalServerSocket("x");\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'BothRoles');

    expect(result.role).toBe('both');
    expect(result.status).toBe('found');
  });

  it('accepts Kotlin bare-call constructor syntax (no "new" keyword) as construction evidence', async () => {
    write(
      'src/KotlinSocketUser.kt',
      'package com.example.services\n\n' +
        'import android.net.LocalSocket\n\n' +
        'class KotlinSocketUser {\n' +
        '    private val socket = LocalSocket()\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'KotlinSocketUser');

    expect(result.clientEvidence.length).toBeGreaterThan(0);
    expect(result.status).toBe('found');
  });

  it('reports "convention_derived_candidate" when the class exists but never constructs LocalSocket/LocalServerSocket', async () => {
    write('src/PlainClass.kt', 'package com.example.services\n\nclass PlainClass\n');

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'PlainClass');

    expect(result.matchedClass?.name).toBe('PlainClass');
    expect(result.role).toBe('unknown');
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('reports "no_local_socket_ipc_found" when nothing matches', async () => {
    write('src/Unrelated.kt', 'package com.example.services\n\nclass Unrelated\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'NonExistentClass');

    expect(result.matchedClass).toBeNull();
    expect(result.status).toBe('no_local_socket_ipc_found');
  });

  it('does not treat a LocalSocket construction in an unrelated class as evidence for the matched class (same-body scoping)', async () => {
    write('src/LonelyClass.kt', 'package com.example.services\n\nclass LonelyClass\n');
    write(
      'src/SomewhereElse.java',
      'package com.example.other;\n\n' +
        'import android.net.LocalSocket;\n\n' +
        'class SomewhereElse {\n' +
        '    LocalSocket socket = new LocalSocket();\n' +
        '}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'LonelyClass');

    expect(result.matchedClass?.name).toBe('LonelyClass');
    expect(result.clientEvidence).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('does not treat an unrelated same-named import as android.net.LocalSocket (Codex adversarial review, 2026-09-12, HIGH-1)', async () => {
    write(
      'src/SocketUser.java',
      'package p;\n\nimport unrelated.LocalSocket;\n\nclass SocketUser {\n    Object x = new LocalSocket();\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'SocketUser');

    expect(result.clientEvidence).toHaveLength(0);
    expect(result.status).not.toBe('found');
  });

  it('does not attribute a sibling class construction on the same source line to the matched class (Codex adversarial review, 2026-09-12, HIGH-2)', async () => {
    write(
      'src/Both.java',
      'import android.net.LocalSocket;\nclass EmptyService {} class Other { Object s = new LocalSocket(); }\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'EmptyService');

    expect(result.matchedClass?.name).toBe('EmptyService');
    expect(result.clientEvidence).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('does not attribute a nested static class construction to the enclosing class (Codex adversarial review, 2026-09-12, HIGH-2)', async () => {
    write(
      'src/OuterService.java',
      'import android.net.LocalSocket;\nclass OuterService {\n static class Independent {\n Object s = new LocalSocket();\n }\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'OuterService');

    expect(result.matchedClass?.name).toBe('OuterService');
    expect(result.clientEvidence).toHaveLength(0);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('still reaches "found" when android.net.LocalSocket itself is indexed (resolved-edge evidence)', async () => {
    write('android/net/LocalSocket.java', 'package android.net;\npublic class LocalSocket { public LocalSocket() {} }\n');
    write(
      'src/SocketUser.java',
      'package p;\n\nimport android.net.LocalSocket;\n\nclass SocketUser {\n    Object x = new LocalSocket();\n}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findLocalSocketIpc(cg, dir, 'SocketUser');

    expect(result.status).toBe('found');
  });
});
