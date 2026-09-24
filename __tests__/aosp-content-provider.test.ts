/**
 * AOSP extension — findContentProviderImpl.
 *
 * Reuses aidl.ts's findUnresolvedExtendsCandidates verbatim for the primary
 * signal (a real `extends ContentProvider` clause), same discipline as
 * find_aidl_impl's Stub-subclass check.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { findContentProviderImpl } from '../src/aosp/content_provider';

describe('AOSP extension: findContentProviderImpl', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-aosp-provider-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports "found" for a real extends ContentProvider class, with manifest authorities attached', async () => {
    write(
      'src/BugStorageProvider.java',
      'package com.example.bugreport;\n\n' +
        'import android.content.ContentProvider;\n\n' +
        'class BugStorageProvider extends ContentProvider {\n' +
        '}\n'
    );
    write(
      'AndroidManifest.xml',
      '<manifest>\n' +
        '  <application>\n' +
        '    <provider android:name="com.example.bugreport.BugStorageProvider"\n' +
        '              android:authorities="com.example.bugreport"\n' +
        '              android:exported="false" />\n' +
        '  </application>\n' +
        '</manifest>\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'BugStorageProvider');

    expect(result.providerClass?.name).toBe('BugStorageProvider');
    expect(result.manifestDeclarations).toHaveLength(1);
    expect(result.manifestDeclarations[0]!.authorities).toEqual(['com.example.bugreport']);
    expect(result.status).toBe('found');
  });

  it('matches a manifest android:name using Android\'s package-relative shorthand (a leading dot)', async () => {
    write(
      'src/ClusterContentProvider.java',
      'package com.example.cluster;\n\n' +
        'import android.content.ContentProvider;\n\n' +
        'class ClusterContentProvider extends ContentProvider {\n' +
        '}\n'
    );
    write(
      'AndroidManifest.xml',
      '<manifest>\n' +
        '  <application>\n' +
        '    <provider android:name=".cluster.ClusterContentProvider"\n' +
        '         android:authorities="com.example.cluster.clustercontentprovider"\n' +
        '         android:grantUriPermissions="true"\n' +
        '         android:exported="true"/>\n' +
        '  </application>\n' +
        '</manifest>\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'ClusterContentProvider');

    expect(result.manifestDeclarations).toHaveLength(1);
    expect(result.manifestDeclarations[0]!.authorities).toEqual(['com.example.cluster.clustercontentprovider']);
    expect(result.status).toBe('found');
  });

  it('splits a semicolon-separated multi-authority declaration into separate authorities', async () => {
    write(
      'src/MultiAuthorityProvider.java',
      'package com.example.multi;\n\n' +
        'import android.content.ContentProvider;\n\n' +
        'class MultiAuthorityProvider extends ContentProvider {\n' +
        '}\n'
    );
    write(
      'AndroidManifest.xml',
      '<manifest>\n' +
        '  <application>\n' +
        '    <provider android:name="com.example.multi.MultiAuthorityProvider"\n' +
        '              android:authorities="com.example.multi.a;com.example.multi.b" />\n' +
        '  </application>\n' +
        '</manifest>\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'MultiAuthorityProvider');

    expect(result.manifestDeclarations[0]!.authorities).toEqual(['com.example.multi.a', 'com.example.multi.b']);
  });

  it('reports "convention_derived_candidate" for a manifest declaration with no matching extends ContentProvider class', async () => {
    write(
      'AndroidManifest.xml',
      '<manifest>\n' +
        '  <application>\n' +
        '    <provider android:name="com.example.ghost.GhostProvider" android:authorities="com.example.ghost" />\n' +
        '  </application>\n' +
        '</manifest>\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'GhostProvider');

    expect(result.providerClass).toBeNull();
    expect(result.manifestDeclarations).toHaveLength(1);
    expect(result.status).toBe('convention_derived_candidate');
  });

  it('reports "no_content_provider_found" when nothing matches', async () => {
    write('src/Unrelated.java', 'package com.example;\n\nclass Unrelated {}\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'NonExistentProvider');

    expect(result.providerClass).toBeNull();
    expect(result.manifestDeclarations).toHaveLength(0);
    expect(result.status).toBe('no_content_provider_found');
  });

  it('does not confuse two different ContentProvider subclasses that share no name overlap', async () => {
    write(
      'src/FirstProvider.java',
      'package com.example.a;\n\nimport android.content.ContentProvider;\n\nclass FirstProvider extends ContentProvider {}\n'
    );
    write(
      'src/SecondProvider.java',
      'package com.example.b;\n\nimport android.content.ContentProvider;\n\nclass SecondProvider extends ContentProvider {}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'FirstProvider');

    expect(result.providerClass?.name).toBe('FirstProvider');
    expect(result.status).toBe('found');
  });

  it('does not treat an unrelated same-named import as android.content.ContentProvider', async () => {
    write(
      'src/DemoProvider.java',
      'package p;\n\nimport unrelated.ContentProvider;\n\nclass DemoProvider extends ContentProvider {}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'DemoProvider');

    expect(result.providerClass).toBeNull();
    expect(result.status).not.toBe('found');
  });

  it('recognizes a fully qualified "extends android.content.ContentProvider" clause with no import', async () => {
    write(
      'src/FqProvider.java',
      'package p;\n\nclass FqProvider extends android.content.ContentProvider {}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'FqProvider');

    expect(result.providerClass?.name).toBe('FqProvider');
    expect(result.status).toBe('found');
  });

  it('handles single-quoted XML attributes in a <provider> declaration', async () => {
    write(
      'AndroidManifest.xml',
      "<manifest><application><provider android:name='Demo' android:authorities='p.demo' /></application></manifest>\n"
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'Demo');

    expect(result.manifestDeclarations).toHaveLength(1);
    expect(result.manifestDeclarations[0]!.authorities).toEqual(['p.demo']);
  });

  it('does not read a nested <meta-data> child element name as the enclosing <provider>\'s own name', async () => {
    write(
      'AndroidManifest.xml',
      '<manifest><application><provider android:name="RealProvider" android:authorities="real.provider">' +
        '<meta-data android:name="GhostProvider" android:value="unused" /></provider></application></manifest>\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'GhostProvider');

    expect(result.manifestDeclarations).toHaveLength(0);
    expect(result.status).toBe('no_content_provider_found');
  });

  it('finds an ordinary same-line ContentResolver content:// URI client call', async () => {
    write(
      'src/DemoProvider.java',
      'import android.content.ContentProvider;\nclass DemoProvider extends ContentProvider {}\n'
    );
    write(
      'AndroidManifest.xml',
      '<manifest><application><provider android:name="DemoProvider" android:authorities="p.demo" /></application></manifest>\n'
    );
    write(
      'src/Client.java',
      'class Client { void f() { getContentResolver().query(Uri.parse("content://p.demo/items"), null, null, null, null); } }\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'DemoProvider');

    expect(result.clientUsageSites).toHaveLength(1);
  });

  it('still reaches "found" when android.content.ContentProvider itself is indexed (resolved-edge evidence)', async () => {
    write('android/content/ContentProvider.java', 'package android.content;\npublic abstract class ContentProvider {}\n');
    write(
      'src/DemoProvider.java',
      'package p;\n\nimport android.content.ContentProvider;\n\nclass DemoProvider extends ContentProvider {}\n'
    );

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = findContentProviderImpl(cg, dir, 'DemoProvider');

    expect(result.status).toBe('found');
  });
});
