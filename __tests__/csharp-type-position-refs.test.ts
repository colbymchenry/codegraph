/**
 * A C# type position names a type. `Type sourceType`, `List<int>`, `new
 * TypeMap()` used to resolve to whichever same-named member was nearest: on
 * AutoMapper `Type` bound to an attribute's `Type` property, `List<…>` to a
 * test class's `List` property (519 dependents), and `TypeMap typeMap` to a
 * `TypeMap` property sitting beside the `TypeMap` class.
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
  'src/TypeMap.cs': `namespace App;
public class TypeMap {
    public string Name { get; set; }
}
public class MemberMap {
    public MemberMap() { }
}
`,
  'src/Attrs.cs': `namespace App;
public class ValueConverterAttribute {
    public System.Type Type { get; set; }
}
public class Source {
    public System.Collections.Generic.List<int> List { get; set; }
}
`,
  'src/Profile.cs': `namespace App;
using System;
using System.Collections.Generic;
public class Profile {
    public TypeMap TypeMap { get; set; }
    public void Configure(TypeMap typeMap, MemberMap memberMap, Type sourceType) {
        var items = new List<int>();
        var copy = new TypeMap();
    }
}
`,
};

describe('C#: a type position names a type', () => {
  it('never a property, method or case that shares the name', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-type-refs-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const configure = cg.getNodesByName('Configure').find((n) => n.kind === 'method')!;
      const targets = cg
        .getOutgoingEdgesFrom([configure.id], ['references', 'instantiates', 'type_of'])
        .map((e) => cg.getNode(e.target))
        .map((n) => `${n!.kind}:${n!.name}`);
      expect(targets).toContain('class:TypeMap');
      expect(targets).toContain('class:MemberMap');
      // A property, a constructor, or a type the project only has a member named after.
      expect(targets.filter((t) => t.startsWith('property:') || t.startsWith('method:'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('never a constant that shares the name', async () => {
    // `const` and `static readonly` fields are constants: jellyfin's `new
    // Version(5, 18)` (System.Version) bound to a `const string Version`
    // claim name, and serilog's `static readonly Meter Meter = new(…)`
    // instantiated itself.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-type-refs-'));
    roots.push(root);
    const files: Record<string, string> = {
      'src/Claims.cs': `namespace App;
public static class ClaimTypes {
    public const string Version = "v";
}
`,
      'src/Encoder.cs': `namespace App;
using System;
public class ValueFormatter { }
public class Encoder {
    private static readonly Version MinVersion = new Version(5, 18);
    private static readonly Meter Meter = new("app");
    private static readonly ValueFormatter ValueFormatter = new();
    public void Check() { var v = new Version(1, 0); }
}
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const members = cg.getNodesInFile('src/Encoder.cs').filter((n) => n.kind !== 'file');
      const targets = cg
        .getOutgoingEdgesFrom(members.map((n) => n.id), ['references', 'instantiates', 'type_of'])
        .map((e) => `${cg.getNode(e.source)!.name} ${e.kind} ${cg.getNode(e.target)!.kind}:${cg.getNode(e.target)!.qualifiedName}`)
        .sort();
      expect(targets.filter((t) => t.includes(' constant:'))).toEqual([]);
      expect(targets).toContain('ValueFormatter instantiates class:App::ValueFormatter');
    } finally {
      cg.close();
    }
  });
});
