/**
 * An attribute on a Delphi routine parameter (#2545): `const [ref] AValue:
 * Integer`, `[ref] const Source: TVarData`, DelphiMVCFramework's
 * `const [MVCFromBody] Person: TPerson`.
 *
 * The Pascal grammar's parameter rule takes no attribute, so the parse broke
 * at the `[`: the method was lost, the parameter after the attribute became a
 * field of the class, and every member declared after it was missing until
 * the next class. The extractor's preParse now blanks such an attribute,
 * offsets kept, before the grammar parses the unit.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { preParsePascal } from '../src/extraction/languages/pascal-preparse';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

// The issue's own unit, with its bodies calling `Self.Before`.
const MIN_PAS = `unit Min;

interface

type
  TMin = class
  public
    procedure Before;
    procedure WithRef(const [ref] AValue: Integer; const AOther: string);
    procedure After;
  end;

  TNext = class
  public
    procedure Other;
  end;

const
  CAfterClass = 1;

implementation

procedure TMin.Before;
begin
end;

procedure TMin.WithRef(const [ref] AValue: Integer; const AOther: string);
begin
  Self.Before;
end;

procedure TMin.After;
begin
  Self.Before;
end;

procedure TNext.Other;
begin
end;

end.
`;

function members(code: string, file = 'Min.pas') {
  const result = extractFromSource(file, code);
  const of = (kind: string) =>
    result.nodes.filter((n) => n.kind === kind).map((n) => `${n.qualifiedName}:${n.startLine}`).sort();
  return { result, methods: of('method'), fields: of('field'), constants: of('constant') };
}

describe('Delphi parameter attributes (#2545)', () => {
  it('keeps every class member after a `const [ref]` parameter', () => {
    const { methods, fields, constants } = members(MIN_PAS);
    expect(methods).toEqual([
      'TMin::After:10',
      'TMin::Before:8',
      'TMin::WithRef:9',
      'TNext::Other:15',
    ]);
    // The parameter after the attribute is not a field of the class.
    expect(fields).toEqual([]);
    expect(constants).toEqual(['CAfterClass:19']);
  });

  it('keeps the member after a `[ref]` parameter that ends its list on its own line', () => {
    const code = MIN_PAS
      .replace('procedure WithRef(const [ref] AValue: Integer; const AOther: string);', 'procedure WithRef(const [ref] AValue: Integer);')
      .replace('procedure TMin.WithRef(const [ref] AValue: Integer; const AOther: string);', 'procedure TMin.WithRef(const [ref] AValue: Integer);');
    const { methods } = members(code);
    expect(methods).toEqual(['TMin::After:10', 'TMin::Before:8', 'TMin::WithRef:9', 'TNext::Other:15']);
  });

  it('keeps the attribute in the signature, as the source writes it', () => {
    const { result } = members(MIN_PAS);
    const withRef = result.nodes.find((n) => n.qualifiedName === 'TMin::WithRef');
    expect(withRef?.signature).toBe('(const [ref] AValue: Integer; const AOther: string)');
  });

  it('reads the calls in the body of a routine whose header has an attribute', () => {
    const { result } = members(MIN_PAS);
    const withRef = result.nodes.find((n) => n.qualifiedName === 'TMin::WithRef');
    const calls = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls' && r.fromNodeId === withRef?.id)
      .map((r) => `${r.referenceName}:${r.line}`);
    expect(calls).toEqual(['Self.Before:29']);
  });

  it('takes attributes before or after the modifier, with arguments, stacked or spanning lines', () => {
    const code = `unit People;

interface

type
  TRec = record
    A: Integer;
    class operator Implicit(const [ref] Src: TRec): Integer;
    procedure CopyFrom([ref] const Source: TRec);
    procedure AfterRec;
  end;

  TPeopleController = class(TMVCController)
  public
    [MVCPath('/people')]
    [MVCHTTPMethod([httpPOST])]
    function CreatePerson([MVCFromBody] const Person: TPerson): IMVCResponse;
    function Search(const [MVCFromQueryString('q', '')] Query: string;
      [MVCFromHeader('X-Page')] [MVCInject] Page: Integer;
      const [MVCFromQueryString('order',
        'name')] Order: string): IMVCResponse;
    function Find<T>(const [ref] Key: TKey): T;
    procedure Last;
  end;

implementation

end.
`;
    const { result, methods, fields } = members(code, 'People.pas');
    // A method's node starts at the attributes above it (CreatePerson's at 15).
    expect(methods).toEqual([
      'TPeopleController::CreatePerson:15',
      'TPeopleController::Find<T>:22',
      'TPeopleController::Last:23',
      'TPeopleController::Search:18',
      'TRec::AfterRec:10',
      'TRec::CopyFrom:9',
      'TRec::Implicit:8',
    ]);
    expect(fields).toEqual(['TRec::A:7']);
    const signatureOf = (qn: string) => result.nodes.find((n) => n.qualifiedName === qn)?.signature;
    expect(signatureOf('TPeopleController::CreatePerson')).toBe('([MVCFromBody] const Person: TPerson): IMVCResponse');
    expect(signatureOf('TRec::CopyFrom')).toBe('([ref] const Source: TRec)');
  });

  it('blanks only parameter attributes, keeping every offset', () => {
    const query = "[MVCFromQueryString('q', '')]";
    const page = "[MVCFromHeader('X-Page')]";
    const code = [`procedure Search(const ${query} Query: string;`, `  ${page}`, '  Page: Integer);'].join('\r\n');
    const out = preParsePascal(code);
    expect(out.length).toBe(code.length);
    expect(out.split('\r\n')).toEqual([
      `procedure Search(const ${' '.repeat(query.length)} Query: string;`,
      `  ${' '.repeat(page.length)}`,
      '  Page: Integer);',
    ]);
  });

  it('leaves brackets alone everywhere else', () => {
    const code = `unit Keep;

interface

type
  TOwner = class
  private
    [Weak] FOwner: TObject;
    FItems: array[0..1] of Integer;
  public
    [MVCPath('/x')]
    procedure Get(const Options: TOptions = [ooA, ooB]; Count: Integer = 1);
    property Items[Index: Integer]: Integer read GetItem;
  end;

implementation

{ procedure Old(const [ref] A: Integer); }
// function Older([ref] const A: Integer): Integer;

procedure TOwner.Get(const Options: TOptions = [ooA, ooB]; Count: Integer = 1);
begin
  Foo([1, 2]);
  Bar(Format('%d', [Count]), [ooA]);
  WriteLn('procedure Fake(const [ref] A: Integer)');
  FItems[0] := Ord(ooA in [ooA]);
  Count := Operator([1, 2]); // Delphi doesn't reserve \`operator\`
end;

end.
`;
    expect(preParsePascal(code)).toBe(code);
  });

  it('indexes the issue unit with TMin.After resolvable and no field from the parameter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-attr-'));
    try {
      fs.writeFileSync(path.join(dir, 'Min.pas'), MIN_PAS);
      const cg = await CodeGraph.init(dir, { index: true });
      try {
        const after = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'TMin::After');
        expect(after).toBeDefined();
        expect(cg.getNodesByKind('field').map((n) => n.name)).toEqual([]);
        const before = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'TMin::Before')!;
        const callers = cg
          .getIncomingEdges(before.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => cg.getNode(e.source)?.name)
          .sort();
        expect(callers).toEqual(['After', 'WithRef']);
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
