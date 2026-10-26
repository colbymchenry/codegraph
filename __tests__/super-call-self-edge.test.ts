/**
 * A `super` call inside an override calls the parent's implementation, never
 * the method making the call.
 *
 * Extraction keeps `super.didMoveToWindow()` under the bare method name, so
 * every strategy resolved it to the enclosing override itself — a self-edge
 * that made a view's lifecycle methods look recursive (eleven of one
 * expo-camera view's overrides). Real recursion keeps its edge.
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

async function project(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-super-self-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

/** `Owner.method` names of every method whose calls include itself. */
function selfCalling(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const kind of ['method', 'function'] as const) {
    for (const n of cg.getNodesByKind(kind)) {
      if (cg.getOutgoingEdges(n.id).some((e) => e.kind === 'calls' && e.target === n.id)) out.push(n.name);
    }
  }
  return out.sort();
}

describe('a super call is not a self-call', () => {
  it('Swift, Kotlin, Java, Python, TypeScript and C#', async () => {
    const cg = await project({
      'ios/CameraView.swift': `import UIKit
class CameraView: UIView {
  override func didMoveToWindow() {
    super.didMoveToWindow()
    setup()
  }
  func setup() {}
  func countdown(_ n: Int) {
    if n > 0 { countdown(n - 1) }
  }
}
`,
      'android/CameraView.kt': `package app
class CameraView(context: Context) : FrameLayout(context) {
  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
  }
}
`,
      'java/Service.java': `package app;
public class Service extends Base {
  @Override
  public void start() {
    super.start();
  }
}
`,
      'py/views.py': `class ProfileView(BaseView):
    def dispatch(self, request):
        return super().dispatch(request)
`,
      'ts/list.ts': `export class List extends Base {
  render(): string {
    return super.render() + '!';
  }
}
`,
      'cs/Handler.cs': `public class Handler : BaseHandler {
  public override void Handle() {
    base.Handle();
  }
}
`,
    });
    try {
      // Only the real recursion is left.
      expect(selfCalling(cg)).toEqual(['countdown']);
    } finally {
      cg.close();
    }
  });
});
