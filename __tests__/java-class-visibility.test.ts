/**
 * A Java class named at a call is the one the calling file can see, as javac
 * looks a simple type name up: the file's own type, a single-type import, the
 * file's package, then its on-demand (`.*`) imports. With `com.x.a.Util` and
 * `com.x.b.Util` both in the project, a call under `import com.x.b.*;` went to
 * whichever `Util` was indexed first: a static call `Util.log(…)` (#2976), a
 * call through a typed local `Util u = …; u.run()` (#3291), and a chained
 * `new Util().run()` linked nothing (#2976). A fully qualified receiver,
 * `com.x.b.Util.log(…)`, names its class outright, whatever the file imports
 * (#3290). Two on-demand imports that both supply the name make it ambiguous,
 * which javac rejects, so such a call links nothing.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const util = (pkg: string) => `package ${pkg};
public class Util {
    public static void log(String s) {}
    public void run() {}
}
`;

const main = (pkg: string, cls: string, imports: string, body: string) => `package ${pkg};
${imports}
public class ${cls} {
    void go() { ${body} }
}
`;

const FILES: Record<string, string> = {
  'src/com/x/a/Util.java': util('com.x.a'),
  'src/com/x/b/Util.java': util('com.x.b'),
  // #2976
  'src/com/x/m/Wildcard.java': main('com.x.m', 'Wildcard', 'import com.x.b.*;', 'Util.log("x"); new Util().run();'),
  // #3291
  'src/com/x/m/Typed.java': main('com.x.m', 'Typed', 'import com.x.b.*;', 'Util u = new Util(); u.run();'),
  // #3290, under each import
  'src/com/x/m/QualifiedOther.java': main('com.x.m', 'QualifiedOther', 'import com.x.a.*;', 'com.x.b.Util.log("q");'),
  'src/com/x/m/QualifiedBare.java': main('com.x.m', 'QualifiedBare', '', 'com.x.b.Util.log("q");'),
  'src/com/x/m/QualifiedSingle.java': main('com.x.m', 'QualifiedSingle', 'import com.x.a.Util;', 'com.x.b.Util.log("q");'),
  // javac's order: the file's package before an on-demand import, a single-type import before both.
  'src/com/x/a/SamePackage.java': main('com.x.a', 'SamePackage', 'import com.x.b.*;', 'Util.log("x"); Util u = new Util(); u.run(); new Util().run();'),
  'src/com/x/a/Single.java': main('com.x.a', 'Single', 'import com.x.b.Util;', 'Util.log("x"); Util u = new Util(); u.run();'),
  // Two on-demand imports that both supply `Util`: ambiguous.
  'src/com/x/m/Ambiguous.java': main('com.x.m', 'Ambiguous', 'import com.x.a.*;\nimport com.x.b.*;', 'Util.log("x");'),
  // A nested type written through its package and owner.
  'src/com/x/c/Outer.java': `package com.x.c;
public class Outer {
    public static class Inner {
        public static void ping() {}
    }
}
`,
  'src/com/x/d/Inner.java': `package com.x.d;
public class Inner {
    public static void ping() {}
}
`,
  'src/com/x/m/Nested.java': main('com.x.m', 'Nested', 'import com.x.d.*;', 'com.x.c.Outer.Inner.ping();'),
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-class-visibility-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The qualified names `calls` edges from `<cls>::go` reach. */
function calls(pkg: string, cls: string): string[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ q: string }> } } } }).db;
  return db.getDb().prepare(`
    SELECT t.qualified_name q FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND s.qualified_name = ?`).all(`${pkg}::${cls}::go`).map((r) => r.q).sort();
}

describe('a Java call reaches the class its file can see', () => {
  it('#2976: a static call and a chained new under a wildcard import', () => {
    expect(calls('com.x.m', 'Wildcard')).toEqual(['com.x.b::Util::log', 'com.x.b::Util::run']);
  });

  it('#3291: a call through a local typed by a wildcard-imported class', () => {
    expect(calls('com.x.m', 'Typed')).toEqual(['com.x.b::Util::run']);
  });

  it('#3290: a fully qualified static call, whatever the file imports', () => {
    expect(calls('com.x.m', 'QualifiedOther')).toEqual(['com.x.b::Util::log']);
    expect(calls('com.x.m', 'QualifiedBare')).toEqual(['com.x.b::Util::log']);
    expect(calls('com.x.m', 'QualifiedSingle')).toEqual(['com.x.b::Util::log']);
    expect(calls('com.x.m', 'Nested')).toEqual(['com.x.c::Outer::Inner::ping']);
  });

  it("follows javac's order: own package before a wildcard, a single-type import before both", () => {
    expect(calls('com.x.a', 'SamePackage')).toEqual(['com.x.a::Util::log', 'com.x.a::Util::run', 'com.x.a::Util::run']);
    expect(calls('com.x.a', 'Single')).toEqual(['com.x.b::Util::log', 'com.x.b::Util::run']);
  });

  it('links nothing for a name two wildcard imports both supply', () => {
    expect(calls('com.x.m', 'Ambiguous')).toEqual([]);
  });
});
