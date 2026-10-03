/**
 * Salam resolution.
 *
 * Indexes small Salam projects end to end and checks that references land on
 * the right symbols: file imports (a package spans every file that declares
 * it), package imports, Persian aliases (`@fa`) and receivers typed by struct
 * literals, parameters or the return type of the function that made them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Salam resolution', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-salam-'));
  });

  afterEach(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function calleeNames(fromName: string, file: string): string[] {
    const from = cg.getNodesInFile(file).find((n) => n.name === fromName);
    if (!from) throw new Error(`no ${fromName} in ${file}`);
    return cg.getCallees(from.id).map((c) => `${c.node.filePath}#${c.node.name}`);
  }

  function referencedNames(fromName: string, file: string): string[] {
    const from = cg.getNodesInFile(file).find((n) => n.name === fromName);
    if (!from) throw new Error(`no ${fromName} in ${file}`);
    return cg
      .getOutgoingEdges(from.id)
      .filter((e) => e.kind === 'references')
      .map((e) => cg.getNode(e.target))
      .map((n) => `${n?.filePath}#${n?.name}`);
  }

  it('resolves calls through file imports, package spans, package aliases and Persian aliases', async () => {
    write('lib/geometry.salam', `@en "geometry"
@fa "هندسه"
package geometry

@en "Area"
@fa "مساحت"
pub func Area(w: int, h: int): int:
    ret w * h
end
`);
    write('lib/util.salam', `package util

pub func Twice(n: int): int:
    ret Helper(n) * 2
end
`);
    write('lib/util_more.salam', `package util

pub func Helper(n: int): int:
    ret n
end
`);
    write('app/main.salam', `import util "../lib/util.salam"
import geometry

func run(): int:
    ret util.Twice(2) + geometry.Area(2, 3)
end
`);
    write('lib/shapes.salam', `package shapes

pub struct Point:
    pub x: int
    pub func length(): int:
        ret this.x
    end
    pub func scale(k: int): int:
        ret this.x * k
    end
    pub func shift(k: int): int:
        ret this.x + k
    end
end

pub func Origin(): Point:
    ret Point { x = 0 }
end

pub enum Kind: Round, Square end
`);
    write('app/measure.salam', `import shapes

func measure(): int:
    a := shapes.Point { x = 1 }
    b := shapes.Origin()
    ret a.length() + b.scale(2)
end

func norm(p: shapes.Point): int:
    ret p.shift(1)
end

enum Mode: Fast, Slow end

func choose(): int:
    if norm(shapes.Origin()) == 0:
        ret shapes.Kind.Round as int
    end
    ret Mode.Slow as int
end
`);
    write('app/fa.salam', `// زبان: فارسی
واردسازی هندسه

روال ریشه:
    سرچاپ هندسه.مساحت(2, 3)
پایان
`);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.resolveReferences();

    expect(calleeNames('run', 'app/main.salam')).toEqual(
      expect.arrayContaining(['lib/util.salam#Twice', 'lib/geometry.salam#Area']),
    );
    // Helper lives in a sibling file of the same package
    expect(calleeNames('Twice', 'lib/util.salam')).toContain('lib/util_more.salam#Helper');
    // The Persian spelling reaches the same function
    expect(calleeNames('ریشه', 'app/fa.salam')).toContain('lib/geometry.salam#Area');
    // A receiver typed by a struct literal, by a factory's return type, and by a parameter
    expect(calleeNames('measure', 'app/measure.salam')).toEqual(
      expect.arrayContaining(['lib/shapes.salam#length', 'lib/shapes.salam#scale']),
    );
    expect(calleeNames('norm', 'app/measure.salam')).toContain('lib/shapes.salam#shift');
    // Enum members are linked, in the same package and through an import
    expect(referencedNames('choose', 'app/measure.salam')).toEqual(
      expect.arrayContaining(['lib/shapes.salam#Round', 'app/measure.salam#Slow']),
    );
  });

  it('links a switch statement\'s bare case labels to the subject enum\'s members', async () => {
    write('lib/color.salam', `package color

pub enum Color: Red, Green, Blue end
`);
    write('app/paint.salam', `import color

func paint(c: color.Color): str:
    switch c:
        Red:
            ret "warm"
        end
        Green, Blue:
            ret "cool"
        end
    end
    ret ""
end
`);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.resolveReferences();

    expect(referencedNames('paint', 'app/paint.salam')).toEqual(
      expect.arrayContaining([
        'lib/color.salam#Red',
        'lib/color.salam#Green',
        'lib/color.salam#Blue',
      ]),
    );
  });

  it('finds a symbol by its Persian alias', async () => {
    write('lib/geometry.salam', `@en "geometry"
@fa "هندسه"
package geometry

@en "Area"
@fa "مساحت"
pub func Area(w: int, h: int): int:
    ret w * h
end
`);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const hit = cg.searchNodes('مساحت').find((r) => r.node.name === 'Area');
    expect(hit).toBeDefined();
  });

  it('indexes .salam files as their own language', async () => {
    write('a.salam', 'func main:\n    println "hi"\nend\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    expect(cg.getStats().filesByLanguage.salam).toBe(1);
  });
});
