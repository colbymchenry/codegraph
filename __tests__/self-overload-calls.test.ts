/**
 * A call that lands on an overload its arguments cannot fit is to the one
 * sibling overload they do: `toInstant(instant)` delegating to
 * `toInstant(instant, Instant.EPOCH)` bound to itself (commons-lang had 180
 * such self-edges, Newtonsoft 107), and `HashCodeBuilder.reflectionHashCode(this)`
 * to the first overload indexed, a three-parameter one.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-self-overload-'));
  const files: Record<string, string> = {
    'src/main/java/app/Instants.java': `package app;

public class Instants {
  public static Object toInstant(final Object instant) {
    return toInstant(instant, null);
  }

  public static Object toInstant(final Object instant, final Object defaultInstant) {
    return instant != null ? instant : defaultInstant;
  }

  public static int depth(final int n) {
    return n <= 0 ? 0 : depth(n - 1);
  }
}
`,
    'src/main/java/app/HashCodeBuilder.java': `package app;

public class HashCodeBuilder {
  public static int reflectionHashCode(final int initial, final int multiplier, final Object object) {
    return initial * multiplier;
  }

  public static int reflectionHashCode(final Object object, final String... excludeFields) {
    return 1;
  }
}
`,
    'src/main/java/app/Point.java': `package app;

public class Point {
  public int hash() {
    return HashCodeBuilder.reflectionHashCode(this);
  }
}
`,
    'src/main/java/app/Util.java': `package app;

public class Util {
  public static String load(java.io.File f, String c, String b) { return b; }
  public static String load(java.io.File f, String c, String b, Parser p) { return b; }
  public static String load(java.nio.file.Path f, String c, String b, Parser p) { return b; }
}
`,
    'src/main/java/app/Parser.java': `package app;

public class Parser {
}
`,
    'src/main/java/app/Loader.java': `package app;

public class Loader {
  String run(java.io.File file, String c, String b, Parser p) {
    return Util.load(file, c, b, p);
  }
}
`,
    'src/Json/Reader.cs': `namespace App
{
    public static class Reader
    {
        public static string Read(string value)
        {
            return Read(value, null);
        }

        public static string Read(string value, string root)
        {
            return value + root;
        }

        public static string Read(string value, int depth)
        {
            return value;
        }
    }
}
`,
    'src/App/Util.cs': `namespace App
{
    public static class Util
    {
        public static string Load(string f, string c) { return c; }
        public static string Load(string f, string c, string b, int p) { return b; }
        public static string Load(int f, string c, string b, int p) { return b; }
    }

    public class Loader
    {
        public string Run(string f, string c, string b, int p)
        {
            return Util.Load(f, c, b, p);
        }
    }
}
`,
    'src/main/kotlin/app/Reader.kt': `package app

object Reader {
    fun read(value: String): String {
        return read(value, null)
    }

    fun read(value: String, root: String?): String {
        return value
    }

    fun read(value: String, depth: Int): String {
        return value
    }
}
`,
    'src/main/kotlin/app/KUtil.kt': `package app

object KUtil {
    fun load(f: String, c: String): String = c
    fun load(f: String, c: String, b: String, p: Int): String = b
    fun load(f: Int, c: String, b: String, p: Int): String = b
}

class KLoader {
    fun run(f: String, c: String, b: String, p: Int): String {
        return KUtil.load(f, c, b, p)
    }
}
`,
    'src/Json/Convert.cs': `namespace App
{
    public static class Convert
    {
        public static string DeserializeXNode(string value)
        {
            return DeserializeXNode(value, null);
        }

        public static string DeserializeXNode(string value, string root)
        {
            return value + root;
        }
    }
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `callerLine -> targetLine` of the calls between same-named methods of a file. */
const selfNamed = (file: string, name: string) => {
  const nodes = cg.getNodesInFile(file).filter((n) => n.name === name);
  const ids = new Set(nodes.map((n) => n.id));
  return cg.getOutgoingEdgesFrom([...ids]).filter((e) => e.kind === 'calls' && ids.has(e.target))
    .map((e) => `${cg.getNode(e.source)!.startLine} -> ${cg.getNode(e.target)!.startLine}`);
};

/** Target lines of the calls `from` in a file makes to methods named `to`. */
const callsFrom = (file: string, from: string, to: string) => {
  const src = cg.getNodesInFile(file).find((n) => n.name === from)!;
  return cg.getOutgoingEdges(src.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!)
    .filter((t) => t.name === to).map((t) => t.startLine);
};

describe('a method calling its own name', () => {
  it('Java: reaches the overload the arguments fit; real recursion stays', () => {
    expect(selfNamed('src/main/java/app/Instants.java', 'toInstant')).toEqual(['4 -> 8']);
    expect(selfNamed('src/main/java/app/Instants.java', 'depth')).toEqual(['12 -> 12']);
  });

  it('from another class: reaches the overload the arguments fit, not the first indexed', () => {
    const hash = cg.getNodesInFile('src/main/java/app/Point.java').find((n) => n.name === 'hash')!;
    const lines = cg.getOutgoingEdges(hash.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!)
      .filter((t) => t.name === 'reflectionHashCode').map((t) => t.startLine);
    expect(lines).toEqual([8]);
  });

  it('Java: with several overloads the arguments fit, stays among them, not the first declared (#3040)', () => {
    const run = cg.getNodesInFile('src/main/java/app/Loader.java').find((n) => n.name === 'run')!;
    const lines = cg.getOutgoingEdges(run.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!)
      .filter((t) => t.name === 'load').map((t) => t.startLine);
    expect(lines).toEqual([5]);
  });

  it('C#: with several overloads the arguments fit, a self-call leaves itself for the first of them', () => {
    expect(selfNamed('src/Json/Reader.cs', 'Read')).toEqual(['5 -> 10']);
  });

  it('C#: from another class, with several overloads the arguments fit, not the first declared', () => {
    expect(callsFrom('src/App/Util.cs', 'Run', 'Load')).toEqual([6]);
  });

  it('Kotlin: with several overloads the arguments fit, a self-call leaves itself for the first of them', () => {
    expect(selfNamed('src/main/kotlin/app/Reader.kt', 'read')).toEqual(['4 -> 8']);
  });

  it('Kotlin: from another class, with several overloads the arguments fit, not the first declared', () => {
    expect(callsFrom('src/main/kotlin/app/KUtil.kt', 'run', 'load')).toEqual([5]);
  });

  it('C#: reaches the overload the arguments fit', () => {
    expect(selfNamed('src/Json/Convert.cs', 'DeserializeXNode')).toEqual(['5 -> 10']);
  });
});
