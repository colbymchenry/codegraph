import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * `use App\Fields as Alias;` aliases a namespace, so `new Alias\X()` names
 * `App\Fields\X`. The alias is the first segment of the qualified name and
 * has to be expanded through the file's `use` map before the class lookup.
 */
describe('PHP instantiation through a namespace alias', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-ns-alias-'));
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (file: string, source: string) => {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };

  const firstName = (ns: string) => `<?php
namespace ${ns};

class FirstName
{
    public function label(): string { return 'First name'; }
}
`;

  const consumer = (use: string, expr: string) => `<?php
namespace App\\Blocks\\Personal;

${use}

class Personal
{
    public function fields(): array
    {
        return [${expr}];
    }
}
`;

  /** `instantiates` targets of the `fields` method, as `<qualifiedName>`. */
  const instantiated = async (): Promise<string[]> => {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const fields = cg.searchNodes('fields')
      .map(({ node }) => node)
      .find((n) => n.kind === 'method' && n.filePath === 'app/Blocks/Personal/Personal.php')!;
    expect(fields).toBeDefined();
    const db = (cg as any).db.db;
    const rows: { qn: string }[] = db
      .prepare(
        `SELECT t.qualified_name qn FROM edges e JOIN nodes t ON t.id = e.target
         WHERE e.source = ? AND e.kind = 'instantiates'`,
      )
      .all(fields.id);
    return rows.map((r) => r.qn).sort();
  };

  it('resolves `new Alias\\X()` when Alias is an imported namespace', async () => {
    write('app/Blocks/Personal/Fields/FirstName.php', firstName('App\\Blocks\\Personal\\Fields'));
    write('app/Blocks/Personal/Personal.php',
      consumer('use App\\Blocks\\Personal\\Fields as Field;', 'new Field\\FirstName()'));
    expect(await instantiated()).toEqual(['App\\Blocks\\Personal\\Fields::FirstName']);
  });

  it('picks the class in the aliased namespace over a same-named class elsewhere', async () => {
    write('app/Blocks/Personal/Fields/FirstName.php', firstName('App\\Blocks\\Personal\\Fields'));
    write('app/Blocks/Other/FirstName.php', firstName('App\\Blocks\\Other'));
    write('app/Blocks/Personal/Personal.php',
      consumer('use App\\Blocks\\Personal\\Fields as Field;', 'new Field\\FirstName()'));
    expect(await instantiated()).toEqual(['App\\Blocks\\Personal\\Fields::FirstName']);
  });

  it('expands the alias for a deeper qualified name', async () => {
    write('app/Blocks/Personal/Fields/Text/FirstName.php', firstName('App\\Blocks\\Personal\\Fields\\Text'));
    write('app/Blocks/Personal/Personal.php',
      consumer('use App\\Blocks\\Personal\\Fields as Field;', 'new Field\\Text\\FirstName()'));
    expect(await instantiated()).toEqual(['App\\Blocks\\Personal\\Fields\\Text::FirstName']);
  });

  it('leaves a qualified name whose first segment is not imported alone', async () => {
    write('app/Blocks/Personal/Fields/FirstName.php', firstName('App\\Blocks\\Personal\\Fields'));
    write('app/Blocks/Personal/Personal.php',
      consumer('use App\\Blocks\\Personal\\Fields as Field;', 'new Elsewhere\\FirstName()'));
    expect(await instantiated()).toEqual([]);
  });

  /** Non-`contains` edges out of a file, as `<source> <kind> <target qualifiedName>`. */
  const edgesFrom = async (file: string): Promise<string[]> => {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows: { s: string; k: string; t: string }[] = db
      .prepare(
        `SELECT s.name s, e.kind k, t.qualified_name t FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.file_path = ? AND e.kind NOT IN ('contains', 'imports')`,
      )
      .all(file);
    return rows.map((r) => `${r.s} ${r.k} ${r.t}`).sort();
  };

  const fields = `<?php
namespace App\\Fields;

interface Field {}
class Base {}
class FirstName extends Base implements Field
{
    public static function make(): self { return new self(); }
}
`;

  it('resolves extends, implements and static calls written through a namespace alias', async () => {
    write('app/Fields/FirstName.php', fields);
    write('app/Personal.php', `<?php
namespace App;

use App\\Fields as F;

class Personal extends F\\Base implements F\\Field
{
    public function make() { return F\\FirstName::make(); }
}
`);
    expect(await edgesFrom('app/Personal.php')).toEqual([
      'Personal extends App\\Fields::Base',
      'Personal implements App\\Fields::Field',
      'make calls App\\Fields::FirstName::make',
    ]);
  });

  it('reads a qualified name without an imported first segment relative to the current namespace', async () => {
    write('app/Fields/FirstName.php', fields);
    write('app/Personal.php', `<?php
namespace App;

class Personal extends Fields\\Base
{
    public function a() { return new Fields\\FirstName(); }
}
`);
    expect(await edgesFrom('app/Personal.php')).toEqual([
      'Personal extends App\\Fields::Base',
      'a instantiates App\\Fields::FirstName',
    ]);
  });

  it('reads a leading backslash as a fully qualified name', async () => {
    write('app/Fields/FirstName.php', fields);
    write('app/Other/FirstName.php', firstName('App\\Other'));
    write('app/Personal.php', `<?php
namespace App\\Other;

class Personal extends \\App\\Fields\\Base
{
    public function a() { return new \\App\\Fields\\FirstName(); }
    public function b() { return \\App\\Fields\\FirstName::make(); }
}
`);
    expect(await edgesFrom('app/Personal.php')).toEqual([
      'Personal extends App\\Fields::Base',
      'a instantiates App\\Fields::FirstName',
      'b calls App\\Fields::FirstName::make',
    ]);
  });

  it('does not bind a qualified name outside the project to a same-named project class', async () => {
    write('app/Fields/FirstName.php', fields);
    write('app/Personal.php', `<?php
namespace App;

use Vendor\\Lib as L;

class Personal extends L\\Base
{
    public function a() { return new \\Vendor\\Lib\\FirstName(); }
    public function b() { return L\\FirstName::make(); }
}
`);
    expect(await edgesFrom('app/Personal.php')).toEqual([]);
  });

  it('matches the namespace alias without regard to its case', async () => {
    write('app/Blocks/Personal/Fields/FirstName.php', firstName('App\\Blocks\\Personal\\Fields'));
    write('app/Blocks/Personal/Personal.php',
      consumer('use App\\Blocks\\Personal\\Fields as Field;', 'new field\\FirstName()'));
    expect(await instantiated()).toEqual(['App\\Blocks\\Personal\\Fields::FirstName']);
  });

  it('does not guess the first target when two namespace blocks bind one alias differently', async () => {
    write('app/Fields/FirstName.php', firstName('App\\Fields'));
    write('app/Other/FirstName.php', firstName('App\\Other'));
    write('app/Personal.php', `<?php
namespace One {
  use App\\Fields as Field;
  class Personal { public function a() { return new Field\\FirstName(); } }
}
namespace Two {
  use App\\Other as Field;
  class Another
  {
    public function b() { return new Field\\FirstName(); }
    public function c() { return new \\App\\Other\\FirstName(); }
  }
}
`);
    // The alias has two meanings in this file; the fully qualified name has one.
    expect(await edgesFrom('app/Personal.php')).toEqual(['c instantiates App\\Other::FirstName']);
  });
});
