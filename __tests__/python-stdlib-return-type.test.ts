/**
 * A local assigned from a call is typed by the called function's declared
 * return annotation (#3038): `made = make(q)` with `make` declared
 * `-> Path` makes `made` a pathlib.Path, so `made.stat()` links nothing —
 * `stat` is no project method, and an unrelated project method of that name
 * is no guess for one. A parameter annotated with the same type already
 * linked nothing; and when the annotation names a project class, the method
 * on the local is that class's own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

function callTargets(fromFunction: string): string[] {
  const fn = cg!.getNodesByKind('function').find((n) => n.name === fromFunction) ??
    cg!.getNodesByKind('method').find((n) => n.name === fromFunction)!;
  expect(fn, `${fromFunction} should be in the index`).toBeDefined();
  return cg!
    .getOutgoingEdges(fn.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.name}@${n.filePath}`)
    .sort();
}

async function indexed(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-stdlib-return-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const ARM = 'class Arm:\n    def stat(self, field: str) -> float:\n        return 1.0\n';

describe("a local's type is the callee's return annotation (#3038)", () => {
  it("the issue's repro: a local from a `-> Path` factory calls no project `stat`", async () => {
    await indexed({
      'arm.py': ARM,
      'use.py': `from pathlib import Path


def make(p: Path) -> Path:
    return p


def size(p: Path) -> int:
    return p.stat().st_size


def size_of_made(q: Path) -> int:
    made = make(q)
    return made.stat().st_size
`,
    });
    const targets = callTargets('size_of_made');
    expect(targets).not.toContain('method:stat@arm.py');
    // The call to the factory itself is real, and stays.
    expect(targets).toContain('function:make@use.py');
  });

  it('a parameter annotated with the same stdlib type still links nothing', async () => {
    await indexed({
      'arm.py': ARM,
      'use.py': `from pathlib import Path


def size(p: Path) -> int:
    return p.stat().st_size
`,
    });
    expect(callTargets('size')).toEqual([]);
  });

  it('an annotation naming a project class types the local for real', async () => {
    await indexed({
      'arm.py': ARM,
      'use.py': `from arm import Arm


def make_arm() -> Arm:
    return Arm()


def use(q) -> float:
    made = make_arm()
    return made.stat("f")
`,
    });
    expect(callTargets('use')).toContain('method:stat@arm.py');
  });

  it("a method's return annotation types a local bound from a self-call", async () => {
    await indexed({
      'arm.py': ARM,
      'use.py': `from pathlib import Path


class Writer:
    def _write(self, name: str) -> Path:
        return Path(name)

    def written_size(self) -> int:
        made = self._write("x")
        return made.stat().st_size
`,
    });
    const targets = callTargets('written_size');
    expect(targets).toContain('method:_write@use.py');
    expect(targets).not.toContain('method:stat@arm.py');
  });

  it('a call without a return annotation keeps its old strategies', async () => {
    await indexed({
      'arm.py': ARM,
      'use.py': `class Unannotated:
    def stat(self):
        return 1


def make_unannotated():
    return Unannotated()


def use(q):
    made = make_unannotated()
    return made.stat()
`,
    });
    // The callee says nothing of its return, so the call keeps the name-based
    // strategies it had — two project methods of the name, neither reached by
    // the receiver's words, link nothing.
    expect(callTargets('use').filter((t) => t.startsWith('method:stat@'))).toEqual([]);
  });
});
