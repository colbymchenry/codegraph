/**
 * `Name.method()` where `Name` is a type the project doesn't declare —
 * `Arrays.asList(…)`, `Object.assign(…)`, Delphi's `Exception.Create(…)` — is
 * a call into that outside type, never the project's one same-named method.
 * commons-lang's `Integer.valueOf(…)` went to `StringUtils.valueOf` 804
 * times; horse's `Exception.Create` to its `EHorseException.Create`. Go's
 * exported variables (`FormPost.Bind`) and Pascal's capitalized locals and
 * parameters (`LRequest.GetValue`) are not type names.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-external-type-'));
  const files: Record<string, string> = {
    'src/main/java/app/StringUtils.java': `package app;
public class StringUtils {
  public static String valueOf(Object o) { return String.valueOf(o); }
}
`,
    'src/main/java/app/Use.java': `package app;
public class Use {
  public int run() {
    Integer.valueOf(1);
    return StringUtils.valueOf(2).length();
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

describe('a call on a type from outside the project', () => {
  it('is not the project’s same-named method; the project’s own type still is', () => {
    const run = cg.getNodesInFile('src/main/java/app/Use.java').find((n) => n.name === 'run')!;
    const valueOf = cg
      .getOutgoingEdges(run.id)
      .filter((e) => e.kind === 'calls' && cg.getNode(e.target)!.name === 'valueOf');
    // Exactly one: `StringUtils.valueOf(2)`, not `Integer.valueOf(1)`.
    expect(valueOf.map((e) => e.line)).toEqual([5]);
  });
});
