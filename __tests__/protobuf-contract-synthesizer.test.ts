/**
 * Protobuf contract edges — a `.proto` declaration to the code generated from it.
 *
 * One field is implemented again in every target language, each of those sites
 * is machine-written, and the `.proto` is the only place the shape is authored.
 * Without these edges the contract has no link to anything that implements it,
 * and a whole family of defects lives in that gap: a field decoded but never
 * read, a field whose meaning changed while its name and tag did not, a field
 * the server stopped sending that a client still declares. Each is green in
 * every single-language check.
 *
 * The precision gate is the peer-file join: a field named `id` is matched only
 * inside the generated outputs OF ITS OWN proto, never repo-wide.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { generatedPeerStem, nameVariants } from '../src/resolution/protobuf-contract-synthesizer';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function hasSqliteBindings(): boolean {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}
const HAS_SQLITE = hasSqliteBindings();

describe('generatedPeerStem — discovery by convention, not configuration', () => {
  it('recognises the output names each generator produces', () => {
    expect(generatedPeerStem('py/gen/measurement_pb2.py')).toBe('measurement');
    expect(generatedPeerStem('py/gen/measurement_pb2.pyi')).toBe('measurement');
    expect(generatedPeerStem('py/gen/measurement_pb2_grpc.py')).toBe('measurement');
    expect(generatedPeerStem('go/gen/measurement.pb.go')).toBe('measurement');
    expect(generatedPeerStem('go/gen/measurement_grpc.pb.go')).toBe('measurement');
    expect(generatedPeerStem('ts/gen/measurement_pb.ts')).toBe('measurement');
    expect(generatedPeerStem('elixir/lib/measurement.pb.ex')).toBe('measurement');
  });

  it('rejects a hand-written file that merely sits beside the proto', () => {
    // Without a generator marker in the name there is nothing to distinguish
    // `measurement.ts` from any other source file, and treating it as
    // generated output would link the contract to hand-written code.
    expect(generatedPeerStem('ts/app/measurement.ts')).toBeNull();
    expect(generatedPeerStem('py/app/service.py')).toBeNull();
    expect(generatedPeerStem('proto/measurement.proto')).toBeNull();
  });
});

describe('nameVariants — the spellings a generator may choose', () => {
  it('covers the casings the target languages use', () => {
    const variants = nameVariants('observed_at');
    expect(variants).toEqual(expect.arrayContaining([
      'observed_at',  // Python, Elixir
      'observedAt',   // TypeScript (ts-proto)
      'ObservedAt',   // Go, C#
      'OBSERVED_AT',  // enum constants
    ]));
  });

  it('round-trips a name that is already camelCase', () => {
    expect(nameVariants('observedAt')).toEqual(expect.arrayContaining(['observed_at', 'ObservedAt']));
  });

  it('includes accessor spellings', () => {
    expect(nameVariants('value')).toEqual(expect.arrayContaining(['getValue', 'setValue']));
  });
});

describe.skipIf(!HAS_SQLITE)('protobuf contract edges — end to end', () => {
  let root: string;
  let cg: any;
  let edges: Array<Record<string, any>>;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-proto-contract-'));
    const write = (rel: string, body: string) => {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    };

    write('proto/measurement.proto', `syntax = "proto3";
package acme.v1;

message Measurement {
  string id = 1;
  string observed_at = 3;
}

service Reporting {
  rpc ListMeasurements(Measurement) returns (Measurement);
}
`);
    // Python: a modern `_pb2.py` is a serialized descriptor blob, so the `.pyi`
    // stub is where per-declaration Python symbols actually live.
    write('py/gen/measurement_pb2.pyi', `class Measurement:
    id: str
    observed_at: str

class Reporting:
    def ListMeasurements(self, request): ...
`);
    // TypeScript, in ts-proto shape — camelCase fields.
    write('ts/gen/measurement_pb.ts', `export interface Measurement {
  id: string;
  observedAt: string;
}
`);
    // Go, in protoc-gen-go shape — exported PascalCase fields.
    write('go/gen/measurement.pb.go', `package gen

type Measurement struct {
\tId string
\tObservedAt string
}
`);
    // A DECOY: hand-written code declaring the very same names. It must never
    // be linked — it is not a generated peer of this proto.
    write('ts/app/widget.ts', `export interface Measurement { id: string; observedAt: string; }
export function render(m: Measurement) { return m.id; }
`);

    const CodeGraph = (await import('../src/index')).default;
    cg = CodeGraph.initSync(root, {
      config: { include: ['**/*.proto', '**/*.py', '**/*.pyi', '**/*.ts', '**/*.go'], exclude: [] },
    });
    await cg.indexAll();
    const db = (cg as any).db.db;
    edges = db
      .prepare(
        `SELECT s.name src, s.language slang, s.file_path sfile,
                t.qualified_name tgt, t.kind tkind,
                json_extract(e.metadata,'$.match') matchKind,
                json_extract(e.metadata,'$.tag') tag,
                json_extract(e.metadata,'$.generatedIn') genIn
           FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
          WHERE json_extract(e.metadata,'$.synthesizedBy') = 'protobuf-contract'`
      )
      .all();
  }, 120000);

  afterEach(() => {
    cg?.destroy();
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('links a message to its generated type in every language', () => {
    const forMessage = edges.filter((e) => e.tgt === 'acme.v1.Measurement');
    expect(new Set(forMessage.map((e) => e.slang))).toEqual(
      new Set(['python', 'typescript', 'go'])
    );
    for (const e of forMessage) expect(e.matchKind).toBe('symbol');
  });

  it('links an rpc to the generated method itself, not just its service', () => {
    // Every generator emits a method per rpc, so this one resolves at member
    // level rather than falling back to the declaring type.
    const forRpc = edges.filter((e) => e.tgt === 'acme.v1.Reporting.ListMeasurements');
    expect(forRpc.length).toBeGreaterThan(0);
    for (const e of forRpc) {
      expect(e.matchKind).toBe('symbol');
      expect(e.src).toBe('ListMeasurements');
    }
  });

  it('links a field to the generated type that declares it, carrying its tag', () => {
    // Go struct fields, Python class annotations and TS interface members are
    // deliberately not extracted as nodes, so a field has no member-level peer
    // to match; the declaring type is the true and useful fallback.
    const forField = edges.filter((e) => e.tgt === 'acme.v1.Measurement.observed_at');
    expect(forField.length).toBeGreaterThan(0);
    for (const e of forField) {
      expect(e.matchKind).toBe('declaring-type');
      expect(e.tag).toBe(3);
    }
    expect(new Set(forField.map((e) => e.slang))).toEqual(new Set(['python', 'typescript', 'go']));
  });

  it('points from the generated code to the proto, the direction impact reads', () => {
    // Generated code is derived from the contract, so it is the dependent.
    // Emitted the other way round the relationship is recorded but "what else
    // moves when I change this field" stays unanswered.
    for (const e of edges) {
      expect(e.slang).not.toBe('proto');
      expect(e.tgt.startsWith('acme.v1.')).toBe(true);
    }
  });

  it('never links hand-written code that merely shares the names', () => {
    // The decoy declares `Measurement`, `id` and `observedAt` in a file that is
    // not a generated peer. Matching a name as common as `id` is only safe
    // because of the peer-file gate.
    for (const e of edges) expect(e.sfile).not.toMatch(/ts\/app\/widget\.ts$/);
  });

  it('answers "what else moves if I change this field" through impact', async () => {
    const field = cg.searchNodes('observed_at', { limit: 20 })
      .map((r: any) => r.node)
      .find((n: any) => n.language === 'proto');
    expect(field).toBeDefined();
    const impact = cg.getImpactRadius(field.id, 1);
    const files = [...impact.nodes.values()].map((n: any) => n.filePath);
    expect(files).toEqual(expect.arrayContaining([
      'py/gen/measurement_pb2.pyi',
      'ts/gen/measurement_pb.ts',
      'go/gen/measurement.pb.go',
    ]));
    expect(files).not.toContain('ts/app/widget.ts');
  }, 120000);

  it('produces nothing when a proto has no generated peers', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-proto-bare-'));
    try {
      fs.mkdirSync(path.join(bare, 'proto'), { recursive: true });
      fs.writeFileSync(
        path.join(bare, 'proto', 'lonely.proto'),
        'syntax = "proto3";\npackage p;\nmessage M { string a = 1; }\n'
      );
      const CodeGraph = (await import('../src/index')).default;
      const g = CodeGraph.initSync(bare, { config: { include: ['**/*.proto'], exclude: [] } });
      await g.indexAll();
      const rows = (g as any).db.db
        .prepare(
          `SELECT COUNT(*) n FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'protobuf-contract'`
        )
        .get();
      expect(rows.n).toBe(0);
      g.destroy();
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  }, 120000);
});

describe('generated peers whose declaration name is fully qualified', () => {
  // Generators for languages with dotted module names emit the FULL name as the
  // declaration's own name: protobuf-elixir writes `defmodule Acme.V1.Interval`,
  // so the node is named `Acme.V1.Interval` while the proto message is
  // `Interval`. Matching only the simple name made every such peer invisible,
  // and silently: a target language whose generator emits a bare name links
  // normally, so the result looks like a working feature with one language's
  // generator simply absent from the output.
  it('matches a dotted declaration name by its trailing segment', async () => {
    const { nameVariants } = await import('../src/resolution/protobuf-contract-synthesizer');
    // The synthesizer indexes a candidate under both its own spellings and its
    // trailing segment's; this is the property that makes that work.
    const dotted = 'Acme.V1.Interval';
    const trailing = dotted.slice(dotted.lastIndexOf('.') + 1);
    expect(trailing).toBe('Interval');
    expect(nameVariants(trailing)).toContain('Interval');
    // The full dotted name alone never yields the simple name.
    expect(nameVariants(dotted)).not.toContain('Interval');
  });
});
