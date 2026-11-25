/**
 * A bare Java call reaches a method of a class around it, a supertype of that
 * class, or a static import — not another class's method that shares the name.
 * halo's Mockito `verify(…)` bound 1,038 calls to `EmailVerificationService.verify`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'src/main/java/app/EmailVerificationService.java': `package app;
public class EmailVerificationService {
  public boolean verify(String token) { return true; }
}
`,
  'src/main/java/app/Util.java': `package app;
public class Util {
  public static String format(String s) { return s; }
}
`,
  'src/main/java/app/Base.java': `package app;
public class Base {
  protected void helper() {}
}
`,
  'src/main/java/app/Child.java': `package app;
import static app.Util.format;
public class Child extends Base {
  public void run() {
    helper();
    format("x");
    own();
  }
  private void own() {}
}
`,
  'src/test/java/app/ChildTest.java': `package app;
import static org.mockito.Mockito.verify;
public class ChildTest {
  public void sends(Object mock) {
    verify(mock);
  }
}
`,
};

describe('Java: a bare call reaches what is in scope', () => {
  it('own class, a supertype, a static import — not a same-named method elsewhere', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-bare-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const callsFrom = (name: string): string[] => {
        const from = cg.getNodesByName(name).find((n) => n.kind === 'method')!;
        return cg.getOutgoingEdgesFrom([from.id], ['calls']).map((e) => cg.getNode(e.target)!.name).sort();
      };
      expect(callsFrom('sends')).not.toContain('verify');
      expect(callsFrom('run')).toEqual(['format', 'helper', 'own']);
    } finally {
      cg.close();
    }
  });
});
