/**
 * A method calling its own name with arguments its own parameters cannot
 * take calls another overload — `toInstant(instant)` delegating to
 * `toInstant(instant, Instant.EPOCH)` — not itself: the self-edge hid the
 * convenience overloads from the full overload's callers (commons-lang had
 * 180 such, Newtonsoft 107).
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

describe('a method calling its own name', () => {
  it('Java: reaches the overload the arguments fit; real recursion stays', () => {
    expect(selfNamed('src/main/java/app/Instants.java', 'toInstant')).toEqual(['4 -> 8']);
    expect(selfNamed('src/main/java/app/Instants.java', 'depth')).toEqual(['12 -> 12']);
  });

  it('C#: reaches the overload the arguments fit', () => {
    expect(selfNamed('src/Json/Convert.cs', 'DeserializeXNode')).toEqual(['5 -> 10']);
  });
});
