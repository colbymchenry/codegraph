/**
 * PHP namespaced receivers in static-member and constructor position.
 *
 * `Foo\Bar::class` and `Foo\Bar::CONST` reach extractStaticMemberRef as a
 * `class_constant_access_expression` whose receiver is a `qualified_name` —
 * the node kind PHP uses for EVERY namespaced name, whether it came from an
 * import alias (`use App\SoapTypes as Type;` → `Type\Bankverbindung::class`),
 * a fully-qualified path (`\App\SoapTypes\Bankverbindung::class`) or a
 * namespace-relative one (`SoapTypes\Bankverbindung::class`). A bare
 * `Bankverbindung::class` is a `name`; the qualified forms are pushed verbatim
 * and resolvePhpQualifiedClassRef reads them the way PHP does (#2256).
 *
 * `new Foo\Bar()` is resolved upstream by the same resolver; its case stays
 * here as a guard against an extractor change that strips the qualifier.
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
    // Mutation: as above — no import needed for the branch to fire. The name is
    // relative to `namespace Vendor`, so it is `Vendor\SoapTypes\Bankverbindung`.
    write('src/Types.php', types);
    write('src/Consumer.php', `<?php
namespace Vendor;

class Consumer {
    public function rel() { return SoapTypes\\Bankverbindung::class; }
}
`);
    expect(await load()).toContain('references rel -> Bankverbindung');
  });

  it('does not bind a relative name that PHP reads into another namespace', async () => {
    // Mutation: reduce the pushed name to its last segment. Inside
    // `namespace Vendor\App`, `SoapTypes\Bankverbindung` is
    // `Vendor\App\SoapTypes\Bankverbindung`, which does not exist.
    write('src/Types.php', types);
    write('src/Consumer.php', consumer('    public function rel() { return SoapTypes\\Bankverbindung::class; }'));
    expect(await load()).not.toContain('references rel -> Bankverbindung');
  });

  it('binds a qualified constructor', async () => {
    // Mutation: make resolvePhpQualifiedClassRef skip `instantiates` refs.
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
