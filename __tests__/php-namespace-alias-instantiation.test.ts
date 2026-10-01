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
});
