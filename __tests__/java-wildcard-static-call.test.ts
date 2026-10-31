/**
 * A Java static call through an on-demand (wildcard) import resolves on the
 * same visibility the `new` path applies to a bare type name (#2976): the
 * class the receiver names is a candidate when it sits in the file's own
 * package, an explicit import of the file, or a package an on-demand import
 * covers. Before, `Util.log("x")` under `import com.x.b.*` went to whichever
 * same-tail method was indexed first — `com.x.a`'s, a package the file never
 * imports — while `new Util()` in the same file went to `com.x.b`. A call
 * whose receiver no visible class matches keeps its previous answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('a wildcard-imported static call resolves by import visibility (#2976)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-wildcard-static-'));
    const src = path.join(dir, 'src', 'com', 'x');
    const util = (pkg: string) => `package com.x.${pkg};
public class Util {
    public static void log(String s) {}
    public void run() {}
}
`;
    fs.mkdirSync(path.join(src, 'a'), { recursive: true });
    fs.mkdirSync(path.join(src, 'b'), { recursive: true });
    fs.mkdirSync(path.join(src, 'm'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a', 'Util.java'), util('a'));
    fs.writeFileSync(path.join(src, 'b', 'Util.java'), util('b'));
    fs.writeFileSync(path.join(src, 'm', 'Main.java'), `package com.x.m;
import com.x.b.*;
public class Main {
    void go() { Util.log("x"); }
    void make() { new Util().run(); }
}
`);
    fs.writeFileSync(path.join(src, 'm', 'Explicit.java'), `package com.x.m;
import com.x.b.Util;
public class Explicit {
    void goExplicit() { Util.log("x"); }
}
`);
    // The same package as one of the utils: package visibility alone.
    fs.writeFileSync(path.join(src, 'a', 'Local.java'), `package com.x.a;
public class Local {
    void goLocal() { Util.log("x"); }
}
`);
    // No import at all: no visible Util in this package.
    fs.writeFileSync(path.join(src, 'm', 'Blind.java'), `package com.x.m;
public class Blind {
    void goBlind() { Util.log("x"); }
}
`);
    cg = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The `log` methods the named method's call lands on, by file. */
  function logTargets(method: string, file: string): string[] {
    const fn = cg
      .getNodesByKind('method')
      .find((n) => n.name === method && n.filePath.replace(/\\/g, '/').endsWith(file));
    expect(fn, `${method} in ${file} should be in the index`).toBeDefined();
    return cg
      .getOutgoingEdges(fn!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target))
      .filter((n): n is NonNullable<typeof n> => !!n && n.name === 'log')
      .map((n) => n.filePath.replace(/\\/g, '/'))
      .sort();
  }

  it("the issue's repro: a wildcard import's static call goes to the imported package's Util", () => {
    expect(logTargets('go', 'Main.java')).toEqual(['src/com/x/b/Util.java']);
  });

  it('new of the same name in the same file goes to the imported package too', () => {
    const make = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'make' && n.filePath.replace(/\\/g, '/').endsWith('Main.java'))!;
    expect(make).toBeDefined();
    const built = cg
      .getOutgoingEdges(make.id)
      .filter((e) => e.kind === 'instantiates')
      .map((e) => cg.getNode(e.target))
      .filter((n): n is NonNullable<typeof n> => !!n && n.name === 'Util')
      .map((n) => n.filePath.replace(/\\/g, '/'))
      .sort();
    expect(built).toEqual(['src/com/x/b/Util.java']);
  });

  it('an explicit import keeps resolving the static call to its class', () => {
    expect(logTargets('goExplicit', 'Explicit.java')).toEqual(['src/com/x/b/Util.java']);
  });

  it('a static call in the class package resolves by package visibility alone', () => {
    expect(logTargets('goLocal', 'Local.java')).toEqual(['src/com/x/a/Util.java']);
  });

  it('a call whose receiver no visible class matches keeps its previous answer', () => {
    // No import, and com.x.m holds no Util: the first-indexed declaration is
    // what the call linked before, and still links.
    expect(logTargets('goBlind', 'Blind.java')).toEqual(['src/com/x/a/Util.java']);
  });
});
