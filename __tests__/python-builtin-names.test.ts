/**
 * A Python builtin written bare — `raise TimeoutError(…)`, `sorted(xs)`,
 * `class Bad(ValueError)` — in a file that neither defines nor imports the
 * name, nor star-imports a module that might, can only be the builtin (#3232).
 * It must not link a project class or function of that name in a file it
 * doesn't import. Where the file does define or import the name, or calls a
 * method of that name on something, the name is resolved as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string | undefined;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-3232-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/** Every edge out of the nodes of `file`, but `contains`, as `kind target@file`. */
function edgesFrom(file: string): string[] {
  return [...cg!.getNodesByKind('file'), ...cg!.getNodesByKind('function'), ...cg!.getNodesByKind('method'), ...cg!.getNodesByKind('class')]
    .filter((n) => n.filePath === file)
    .flatMap((n) => cg!.getOutgoingEdges(n.id))
    .filter((e) => e.kind !== 'contains')
    .map((e) => {
      const t = cg!.getNode(e.target);
      return `${e.kind} ${t?.qualifiedName}@${t?.filePath}`;
    })
    .sort();
}

const FAR = 'class TimeoutError(Exception):\n    pass\n\n\nclass ValueError(Exception):\n    pass\n\n\nclass KeyError(Exception):\n    pass\n';

describe('a Python builtin written bare (#3232)', () => {
  it("the issue's repro: raising or returning a builtin exception links no project class", async () => {
    await index({
      'other/far.py': FAR,
      't.py': [
        'def run():',
        '    raise TimeoutError("late")',
        '',
        '',
        'def run2():',
        '    raise ValueError("bad")',
        '',
        '',
        'def run3():',
        '    raise KeyError("k")',
        '',
        '',
        'def run4():',
        '    return TimeoutError("late")',
        '',
        '',
        'class Bad(ValueError):',
        '    pass',
        '',
      ].join('\n'),
    });
    expect(edgesFrom('t.py').filter((e) => e.includes('other/far.py'))).toEqual([]);
  });

  it('nor does a builtin function call link a project function of its name', async () => {
    await index({
      'other/tools.py': 'def filter(rows, pred):\n    return rows\n\n\ndef compile(src):\n    return src\n\n\ndef sorted(rows):\n    return rows\n\n\ndef format(x):\n    return x\n',
      't.py': 'def go(rows):\n    a = list(filter(None, rows))\n    b = compile("1", "<s>", "eval")\n    c = sorted(rows)\n    return format(a, "")\n',
    });
    expect(edgesFrom('t.py').filter((e) => e.includes('other/tools.py'))).toEqual([]);
  });

  it('still links the name a file imports', async () => {
    await index({
      'other/__init__.py': '',
      'other/far.py': FAR,
      't.py': 'from other.far import TimeoutError\n\n\ndef run():\n    raise TimeoutError("late")\n',
    });
    expect(edgesFrom('t.py')).toContain('instantiates TimeoutError@other/far.py');
  });

  it('still links the class a file defines itself', async () => {
    await index({
      'other/far.py': FAR,
      't.py': 'class TimeoutError(Exception):\n    pass\n\n\ndef run():\n    raise TimeoutError("late")\n',
    });
    expect(edgesFrom('t.py')).toContain('instantiates TimeoutError@t.py');
    expect(edgesFrom('t.py').filter((e) => e.includes('other/far.py'))).toEqual([]);
  });

  it('leaves a name a star import may bring as it was', async () => {
    await index({
      'other/__init__.py': '',
      'other/far.py': FAR,
      't.py': 'from other.far import *\n\n\ndef run():\n    raise TimeoutError("late")\n',
    });
    expect(edgesFrom('t.py')).toContain('instantiates TimeoutError@other/far.py');
  });

  it('still links a method of that name called on self', async () => {
    await index({
      't.py': 'class Report:\n    def format(self):\n        return ""\n\n    def render(self):\n        return self.format()\n',
    });
    expect(edgesFrom('t.py')).toContain('calls Report::format@t.py');
  });
});
