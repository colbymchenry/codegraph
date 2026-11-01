/**
 * A chained Java construction `new Util().run()` resolves on the same
 * visibility the bare `new Util()` applies (#2976): the class the written
 * name spells is the file's own package's, an explicit import's, or a
 * package an on-demand import covers. Before, the chained form — whose
 * import mappings don't list a wildcard — resolved to nothing when two
 * packages held a `Util`, while `new Util()` one line above went to the
 * imported package's class. A construction no visible class matches keeps
 * its previous answer (no edge).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('a chained new expression resolves by import visibility (#2976)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-chained-new-'));
    const src = path.join(dir, 'src', 'com', 'x');
    const util = (pkg: string) => `package com.x.${pkg};
public class Util {
    public static void log(String s) {}
    public void run() { System.out.println("run"); }
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
    void go() { new Util().run(); }
    void bare() { new Util(); }
}
`);
    fs.writeFileSync(path.join(src, 'm', 'Explicit.java'), `package com.x.m;
import com.x.b.Util;
public class Explicit {
    void go() { new Util().run(); }
}
`);
    // The same package as one of the utils: package visibility alone.
    fs.writeFileSync(path.join(src, 'a', 'Local.java'), `package com.x.a;
public class Local {
    void go() { new Util().run(); }
}
`);
    // No import at all: no visible Util in this package.
    fs.writeFileSync(path.join(src, 'm', 'Blind.java'), `package com.x.m;
public class Blind {
    void go() { new Util().run(); }
}
`);
    cg = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The `run` methods the named method's chained construction reaches, by file. */
  function runTargets(method: string, file: string): string[] {
    const fn = cg
      .getNodesByKind('method')
      .find((n) => n.name === method && n.filePath.replace(/\\/g, '/').endsWith(file));
    expect(fn, `${method} in ${file} should be in the index`).toBeDefined();
    return cg
      .getOutgoingEdges(fn!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target))
      .filter((n): n is NonNullable<typeof n> => !!n && n.name === 'run')
      .map((n) => n.filePath.replace(/\\/g, '/'))
      .sort();
  }

  it("the follow-up: a chained `new Util().run()` under a wildcard import reaches the imported package's run", () => {
    expect(runTargets('go', 'Main.java')).toEqual(['src/com/x/b/Util.java']);
  });

  it('the bare `new Util()` beside it keeps reaching the imported package', () => {
    const bare = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'bare' && n.filePath.replace(/\\/g, '/').endsWith('Main.java'))!;
    expect(bare).toBeDefined();
    const built = cg
      .getOutgoingEdges(bare.id)
      .filter((e) => e.kind === 'instantiates')
      .map((e) => cg.getNode(e.target))
      .filter((n): n is NonNullable<typeof n> => !!n && n.name === 'Util')
      .map((n) => n.filePath.replace(/\\/g, '/'))
      .sort();
    expect(built).toEqual(['src/com/x/b/Util.java']);
  });

  it('an explicit import keeps resolving the chained construction to its class', () => {
    expect(runTargets('go', 'Explicit.java')).toEqual(['src/com/x/b/Util.java']);
  });

  it('a chained construction in the class package resolves by package visibility alone', () => {
    expect(runTargets('go', 'Local.java')).toEqual(['src/com/x/a/Util.java']);
  });

  it('a construction no visible class matches keeps its previous answer (no edge)', () => {
    // No import, and com.x.m holds no Util: the chained form linked nothing
    // before, and still links nothing.
    expect(runTargets('go', 'Blind.java')).toEqual([]);
  });
});
