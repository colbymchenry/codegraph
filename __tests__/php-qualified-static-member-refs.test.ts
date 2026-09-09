/**
 * PHP namespaced receivers in static-member and constructor position.
 *
 * `Foo\Bar::class` and `Foo\Bar::CONST` reach extractStaticMemberRef as a
 * `class_constant_access_expression` whose receiver is a `qualified_name` —
 * the node kind PHP uses for EVERY namespaced name, whether it came from an
 * import alias (`use App\SoapTypes as Type;` → `Type\Bankverbindung::class`),
 * a fully-qualified path (`\App\SoapTypes\Bankverbindung::class`) or a
 * namespace-relative one (`SoapTypes\Bankverbindung::class`). A bare
 * `Bankverbindung::class` is a `name` and was always handled; the qualified
 * forms produced no edge AND no unresolved ref, so a class referenced only
 * that way looked like nothing depended on it.
 *
 * `new Foo\Bar()` is the same gap one function over: extractInstantiation
 * strips a `.` or `::` qualifier but not PHP's `\`, so the ref was pushed as
 * the unresolvable literal `Foo\Bar`.
 *
 * Both now match on the trailing simple name, which is what walkPhpTypePosition
 * already does for type hints and what the class node is stored as. That makes
 * the alias moot rather than resolved — `Type\Bankverbindung` and
 * `\App\SoapTypes\Bankverbindung` both reduce to `Bankverbindung` — so a
 * same-named class in another namespace stays ambiguous here, exactly as it is
 * for a type hint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('PHP qualified static-member and constructor refs', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-qual-recv-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  /** Every non-`contains` edge as `<kind> <source-name> -> <target-name>`. */
  const load = async (): Promise<string[]> => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows: { kind: string; src: string; tgt: string }[] = db
      .prepare(
        `SELECT e.kind kind, s.name src, t.name tgt
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind IN ('references', 'instantiates')`,
      )
      .all();
    cg.close?.();
    return rows.map((r) => `${r.kind} ${r.src} -> ${r.tgt}`);
  };

  const types = `<?php
namespace Vendor\\SoapTypes;
class Bankverbindung { public $iban; }
`;

  const consumer = (body: string) => `<?php
namespace Vendor\\App;

use Vendor\\SoapTypes as Type;

class Consumer {
${body}
}
`;

  it('binds an aliased qualified receiver in ::class position', async () => {
    // Mutation: drop the `qualified_name` branch in extractStaticMemberRef.
    write('src/Types.php', types);
    write('src/Consumer.php', consumer('    public function aliased() { return Type\\Bankverbindung::class; }'));
    expect(await load()).toContain('references aliased -> Bankverbindung');
  });

  it('binds a fully-qualified receiver in ::class position', async () => {
    // Mutation: as above — a leading `\` is the same qualified_name node.
    write('src/Types.php', types);
    write('src/Consumer.php', consumer('    public function fq() { return \\Vendor\\SoapTypes\\Bankverbindung::class; }'));
    expect(await load()).toContain('references fq -> Bankverbindung');
  });

  it('binds a namespace-relative receiver in ::class position', async () => {
    // Mutation: as above — no import needed for the branch to fire.
    write('src/Types.php', types);
    write('src/Consumer.php', consumer('    public function rel() { return SoapTypes\\Bankverbindung::class; }'));
    expect(await load()).toContain('references rel -> Bankverbindung');
  });

  it('binds a qualified constructor', async () => {
    // Mutation: remove `className.lastIndexOf('\\')` from extractInstantiation's
    // qualifier strip — the ref is then pushed as the literal `Type\Bankverbindung`
    // and resolves to nothing.
    write('src/Types.php', types);
    write('src/Consumer.php', consumer('    public function make() { return new Type\\Bankverbindung(); }'));
    expect(await load()).toContain('instantiates make -> Bankverbindung');
  });

  it('leaves a lowercase-headed qualified receiver alone', async () => {
    // Mutation: drop the /^[A-Z]/ test in the new branch. `$conn::TIMEOUT` on a
    // namespaced variable is not a type reference, and emitting one would let
    // bare-name matching bind it to an unrelated same-named symbol.
    write('src/Types.php', types);
    write('src/Consumer.php', consumer('    public function low() { return config\\bankverbindung::TIMEOUT; }'));
    expect(await load()).not.toContain('references low -> Bankverbindung');
  });
});
