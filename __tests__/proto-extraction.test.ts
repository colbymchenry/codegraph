/**
 * Protocol Buffers (`.proto`) extraction.
 *
 * A `.proto` is a contract: one field is implemented again in every generated
 * language, and each of those sites is machine-written. For the graph to answer
 * "what else moves when this changes", a field has to be a symbol — and two of
 * its properties have to survive extraction, because they are where protobuf's
 * real defects live:
 *
 *   - the TAG NUMBER is part of a field's identity. Renaming a field but
 *     keeping its tag is wire-compatible; keeping tag AND name while changing
 *     the type is a silent mis-decode that every single-language check passes;
 *   - `reserved` is semantic — a retired number must never be re-used, and a
 *     reader touching a reserved field is a defect.
 */

import { describe, it, expect } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { detectLanguage, isSourceFile, isLanguageSupported, getSupportedLanguages } from '../src/extraction/grammars';
import { blankProtoComments, parseField, parseRpc, typeReferences } from '../src/extraction/proto-extractor';
import { matchesSymbol } from '../src/graph/symbol-lookup';
import type { Node } from '../src/types';

const SAMPLE = `syntax = "proto3";

package acme.reporting.v1;

import "google/protobuf/timestamp.proto";
import public "acme/common/money.proto";

option go_package = "acme/reporting";

// A single reported measurement.
// Values are already normalised.
message Measurement {
  // Stable identifier.
  string id = 1;
  double value = 2;
  /* The unit the value is expressed in. */
  Unit unit = 3;
  repeated string tags = 4;
  map<string, double> breakdown = 5;
  acme.common.Money cost = 6;
  google.protobuf.Timestamp observed_at = 7;

  reserved 8, 9;
  reserved 12 to 15;
  reserved "legacy_value", "old_unit";

  oneof source {
    string manual_entry = 20;
    Ingest ingest = 21;
  }

  message Ingest {
    string pipeline = 1;
  }
}

// Units a measurement may carry.
enum Unit {
  UNIT_UNSPECIFIED = 0;
  UNIT_CURRENCY = 1;
}

message ListRequest { string filter = 1; }
message ListResponse { repeated Measurement measurements = 1; }

// Read-side API.
service ReportingService {
  // Page through measurements.
  rpc List(ListRequest) returns (ListResponse);
  rpc Stream(ListRequest) returns (stream Measurement) {
    option idempotency_level = NO_SIDE_EFFECTS;
  }
}
`;

function extract(source = SAMPLE) {
  return extractFromSource('proto/service.proto', source, 'proto');
}

function byQualified(nodes: Node[], qualified: string): Node | undefined {
  return nodes.find((n) => n.qualifiedName === qualified);
}

describe('proto — language registration', () => {
  it('detects .proto files', () => {
    expect(detectLanguage('proto/service.proto')).toBe('proto');
    expect(isSourceFile('proto/service.proto')).toBe(true);
  });

  it('reports proto as supported', () => {
    expect(isLanguageSupported('proto')).toBe(true);
    expect(getSupportedLanguages()).toContain('proto');
  });
});

describe('proto — pure parsing helpers', () => {
  it('blanks comments while preserving offsets and line numbers', () => {
    const src = 'a // note\nb /* x\ny */ c\n';
    const out = blankProtoComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('note');
  });

  it('does not treat a // inside a string literal as a comment', () => {
    // An option value is frequently a URL — mistaking it for a comment would
    // swallow the rest of the line, including its terminating semicolon.
    const src = 'option (x) = "http://example.com/a"; message M { string a = 1; }';
    const out = blankProtoComments(src);
    expect(out).toContain('http://example.com/a');
    const result = extract(src);
    expect(byQualified(result.nodes, 'M.a')).toBeDefined();
  });

  it('parses field declarations including label, map types and tag', () => {
    expect(parseField('string id = 1')).toMatchObject({ type: 'string', name: 'id', tag: 1 });
    expect(parseField('repeated Foo bar = 3')).toMatchObject({ label: 'repeated', type: 'Foo', name: 'bar', tag: 3 });
    expect(parseField('map<string, double> breakdown = 5')).toMatchObject({
      type: 'map<string, double>', name: 'breakdown', tag: 5,
    });
    expect(parseField('.acme.Money cost = 6')).toMatchObject({ type: '.acme.Money', tag: 6 });
    expect(parseField('not a field')).toBeNull();
  });

  it('parses rpc declarations including stream markers', () => {
    expect(parseRpc('rpc List(Req) returns (Res)')).toMatchObject({
      name: 'List', input: 'Req', output: 'Res', streamIn: false, streamOut: false,
    });
    expect(parseRpc('rpc S(stream Req) returns (stream Res)')).toMatchObject({
      streamIn: true, streamOut: true,
    });
    expect(parseRpc('message M')).toBeNull();
  });

  it('reports only declared types as references, never scalars', () => {
    expect(typeReferences('string')).toEqual([]);
    expect(typeReferences('Foo')).toEqual(['Foo']);
    expect(typeReferences('map<string, double>')).toEqual([]);
    expect(typeReferences('map<string, Money>')).toEqual(['Money']);
  });
});

describe('proto — declarations', () => {
  const result = extract();

  it('extracts messages, enums and services under the package name', () => {
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement')?.kind).toBe('struct');
    expect(byQualified(result.nodes, 'acme.reporting.v1.Unit')?.kind).toBe('enum');
    expect(byQualified(result.nodes, 'acme.reporting.v1.ReportingService')?.kind).toBe('interface');
  });

  it('nests a nested message under its parent, as protobuf names it', () => {
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.Ingest')?.kind).toBe('struct');
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.Ingest.pipeline')?.kind).toBe('field');
  });

  it('extracts enum values with their numbers', () => {
    const v = byQualified(result.nodes, 'acme.reporting.v1.Unit.UNIT_CURRENCY');
    expect(v?.kind).toBe('enum_member');
    expect(v?.decorators).toContain('number=1');
  });

  it('extracts rpcs as methods of their service, with the stream marker kept', () => {
    const list = byQualified(result.nodes, 'acme.reporting.v1.ReportingService.List');
    expect(list?.kind).toBe('method');
    expect(list?.signature).toBe('rpc List(ListRequest) returns (ListResponse)');
    const stream = byQualified(result.nodes, 'acme.reporting.v1.ReportingService.Stream');
    expect(stream?.signature).toContain('returns (stream Measurement)');
  });

  it('carries // and /* */ comments through as docstrings', () => {
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement')?.docstring)
      .toBe('A single reported measurement.\nValues are already normalised.');
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.id')?.docstring)
      .toBe('Stable identifier.');
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.unit')?.docstring)
      .toBe('The unit the value is expressed in.');
  });

  it('records imports, including the `public` form', () => {
    const imports = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(imports.map((r) => r.referenceName)).toEqual([
      'google/protobuf/timestamp.proto',
      'acme/common/money.proto',
    ]);
  });

  it('ignores syntax and option statements', () => {
    expect(result.nodes.some((n) => n.name === 'go_package')).toBe(false);
    expect(result.nodes.some((n) => n.name === 'idempotency_level')).toBe(false);
  });

  it('reports no extraction errors on a representative file', () => {
    expect(result.errors).toEqual([]);
  });
});

describe('proto — the tag number is part of a field identity', () => {
  const result = extract();

  it('records each field tag as a marker, not only as prose', () => {
    // A "same tag, changed type" check has to read the tag without re-parsing
    // the declaration.
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.id')?.decorators).toContain('tag=1');
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.observed_at')?.decorators).toContain('tag=7');
  });

  it('keeps the declaration verbatim so type and tag are both visible', () => {
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.observed_at')?.signature)
      .toBe('google.protobuf.Timestamp observed_at = 7');
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.tags')?.signature)
      .toBe('repeated string tags = 4');
  });

  it('marks repeated fields', () => {
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.tags')?.decorators).toContain('repeated');
  });

  it('distinguishes a renamed field from a retyped one at the same tag', () => {
    // Rename at the same tag: wire-compatible. Retype at the same tag and name:
    // a silent mis-decode. The graph must be able to tell these apart.
    const renamed = extract('message M { string b = 1; }');
    const retyped = extract('message M { int64 a = 1; }');
    const original = extract('message M { string a = 1; }');
    const tagOf = (r: ReturnType<typeof extract>, name: string) =>
      r.nodes.find((n) => n.name === name)?.decorators?.find((d) => d.startsWith('tag='));
    expect(tagOf(original, 'a')).toBe('tag=1');
    expect(tagOf(renamed, 'b')).toBe('tag=1');
    expect(tagOf(retyped, 'a')).toBe('tag=1');
    // Same tag either way — the difference is in the declaration text.
    expect(original.nodes.find((n) => n.name === 'a')?.signature).toBe('string a = 1');
    expect(retyped.nodes.find((n) => n.name === 'a')?.signature).toBe('int64 a = 1');
  });
});

describe('proto — reserved is kept, not discarded as syntax', () => {
  const result = extract();
  const reserved = result.nodes.filter((n) => n.decorators?.includes('reserved'));

  it('records reserved numbers individually', () => {
    expect(reserved.map((n) => n.name)).toEqual(
      expect.arrayContaining(['reserved 8', 'reserved 9'])
    );
  });

  it('records reserved ranges as written', () => {
    expect(reserved.map((n) => n.name)).toContain('reserved 12 to 15');
    // A range must not also be double-counted as its two endpoints.
    expect(reserved.map((n) => n.name)).not.toContain('reserved 12');
    expect(reserved.map((n) => n.name)).not.toContain('reserved 15');
  });

  it('records reserved names so a lookup for a retired name finds the reservation', () => {
    expect(reserved.map((n) => n.name)).toEqual(
      expect.arrayContaining(['reserved legacy_value', 'reserved old_unit'])
    );
  });

  it('never lets a reservation be mistaken for a live field', () => {
    for (const n of reserved) expect(n.kind).not.toBe('field');
    expect(result.nodes.some((n) => n.kind === 'field' && n.name === 'legacy_value')).toBe(false);
  });
});

describe('proto — oneof members belong to the enclosing message', () => {
  const result = extract();

  it('does not add the oneof name as a level in the qualified name', () => {
    // On the wire a oneof member IS a field of the message; a `.source.` level
    // would not match the name any generator uses.
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.manual_entry')?.kind).toBe('field');
    expect(byQualified(result.nodes, 'acme.reporting.v1.Measurement.source.manual_entry')).toBeUndefined();
  });

  it('still marks them as oneof members and keeps their tags', () => {
    const node = byQualified(result.nodes, 'acme.reporting.v1.Measurement.manual_entry');
    expect(node?.decorators).toContain('oneof');
    expect(node?.decorators).toContain('tag=20');
  });
});

describe('proto — dependencies between declarations', () => {
  const result = extract();
  const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');

  it('links a field to the message or enum it is typed with', () => {
    expect(refs.map((r) => r.referenceName)).toEqual(
      expect.arrayContaining(['Unit', 'acme.common.Money', 'google.protobuf.Timestamp', 'Ingest'])
    );
  });

  it('does not emit references for scalar field types', () => {
    for (const scalar of ['string', 'double', 'int64', 'bool', 'bytes']) {
      expect(refs.map((r) => r.referenceName)).not.toContain(scalar);
    }
  });

  it('links an rpc to both its request and response messages', () => {
    const names = refs.map((r) => r.referenceName);
    expect(names).toEqual(expect.arrayContaining(['ListRequest', 'ListResponse', 'Measurement']));
  });

  it('strips protobufs leading-dot absolute marker from a reference', () => {
    const absolute = extract('package p;\nmessage M { .other.pkg.Thing t = 1; }');
    const names = absolute.unresolvedReferences.map((r) => r.referenceName);
    expect(names).toContain('other.pkg.Thing');
    expect(names).not.toContain('.other.pkg.Thing');
  });
});

describe('proto — a fully-qualified protobuf name is a usable query', () => {
  const result = extract();

  it('matches a field by its dotted protobuf FQN', () => {
    const field = byQualified(result.nodes, 'acme.reporting.v1.Measurement.observed_at')!;
    expect(matchesSymbol(field, 'acme.reporting.v1.Measurement.observed_at')).toBe(true);
    // A partial suffix on a separator boundary is how people actually type it.
    expect(matchesSymbol(field, 'Measurement.observed_at')).toBe(true);
  });

  it('does not match a field of a different message', () => {
    const field = byQualified(result.nodes, 'acme.reporting.v1.Measurement.Ingest.pipeline')!;
    expect(matchesSymbol(field, 'ListRequest.pipeline')).toBe(false);
  });
});
