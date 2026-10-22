/**
 * Delphi syntax the Pascal grammar has no rule for, which broke whole units
 * of SynEdit, mORMot2, DWScript and HeidiSQL: a property re-published
 * without its type (`property OwnsObjects;`, SynEdit.pas from line 303), a
 * conditional right after a routine's header that holds no whole body, two
 * branches that open the same `begin`, a re-raise, a field or variable of an
 * anonymous record type, a label right before `end`, and alternative
 * statements where the grammar takes one (`OP_X: {$IFDEF U} … {$ELSE} …
 * {$ENDIF}`). The extractor's preParse blanks each, or writes a word the
 * grammar knows in its place, offsets kept, so the unit parses whole and the
 * routines after it keep their calls.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { preParsePascal } from '../src/extraction/languages/pascal-preparse';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

/** Whether the unit parses whole: a `unit` node and no error anywhere. */
function parsesWhole(code: string): boolean {
  const tree = getParser('pascal')!.parse(preParsePascal(code))!;
  try {
    return !tree.rootNode.hasError && tree.rootNode.namedChildren.some((c) => c.type === 'unit');
  } finally {
    tree.delete();
  }
}

/** Every routine's calls, as `Caller->Callee`, and every node's qualified name, from the unit's extraction. */
function extract(code: string, file: string): { calls: string[]; names: string[] } {
  const result = extractFromSource(file, code);
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  return {
    calls: result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => `${byId.get(r.fromNodeId)?.name}->${r.referenceName}`),
    names: result.nodes.map((n) => n.qualifiedName),
  };
}

const OVERRIDES = `unit Marks;

interface

type
  TMarkList = class(TObjectList)
  protected
    function GetItem(Index: Integer): TObject;
    property OwnsObjects;
  public
    constructor Create;
    property Items[Index: Integer]: TObject read GetItem; default;
  end;

  TEditor = class(TCustomControl)
  published
    property Align;
    property Cursor default crIBeam;
    class property Tag;
    property Lines: TStrings read FLines;
    procedure Paint;
  end;

implementation

procedure TEditor.Paint;
begin
  Refresh(1);
end;

end.
`;

const HEADERS = `unit Headers;

interface

procedure KeyUp;
function Size: Integer;
procedure Generate;

implementation

procedure KeyUp;
{$IFDEF LINUX}
var
  Code: Byte;
{$ENDIF}
begin
  Translate(1);
end;

function Size: Integer; {$IFDEF HASINLINE}inline;{$ENDIF}
begin
  Result := Measure(1);
end;

procedure Generate;
{$IFDEF LLVM}
{$IFDEF LLVM_EXECUTE}
var
  Engine: Pointer;
{$ENDIF}
{$ENDIF}
begin
  Emit(1);
end;

end.
`;

const BEGINS = `unit Begins;

interface

procedure Click;
procedure After;

implementation

procedure Click;
var
  I: Integer;
{$IFDEF FOLDING}
  Index: Integer;
begin
  Fold(1);
  if I > 0 then
  begin
    Exit;
  end;
{$ELSE}
begin
{$ENDIF}
  Paint(1);
end;

procedure After;
begin
  Finish(1);
end;

end.
`;

const ASSEMBLER = `unit Assembler;

interface

function Log2Of(const V: Double): Double;
function DivMod10(var Dividend: Cardinal): Cardinal;
procedure Fill(P: Pointer);
procedure After;

implementation

procedure Fill(P: Pointer);
{$IFDEF FPC}nostackframe; assembler; asm {$ELSE} asm .noframe {$ENDIF}
  mov eax, 1
end;

function Log2Of(const V: Double): Double;
{$IFDEF WIN32_ASM}
asm
  fld1
  fld V
  fyl2x
{$ELSE}
begin
  Result := Log2(V);
{$ENDIF}
end;

function DivMod10(var Dividend: Cardinal): Cardinal;
{$IFNDEF WIN32_ASM}
var
  Divided: Cardinal;
begin
  Divided := Dividend div 10;
  Result := Remainder(Dividend, Divided);
{$ELSE}
const
  C10: Cardinal = 10;
asm
  mov ecx, eax
  div C10
{$ENDIF}
end;

procedure After;
begin
  Finish(1);
end;

end.
`;

const RERAISES = `unit Reraises;

interface

procedure Load;
procedure Parse;

implementation

procedure Load;
begin
  try
    Read(1);
  except
    Log(1);
    raise;
  end
end;

procedure Parse;
begin
  try
    Scan(1);
  except
    on E: EConvertError do
      Recover(1);
    else raise
  end;
end;

end.
`;

const RECORDS = `unit Records;

interface

type
  TClient = class
  private
    fIn: record
      Headers: Pointer;
      URL, Method: string;
    end;
    fRows: array of packed record
      Id: Integer;
    end;
    fCount: Integer;
  public
    procedure Send;
  end;

  TCaches = array[1..4] of record
    Size: Integer;
  end;

  TState = record
    Seed: Integer;
    Data: record
      case Integer of
        0: (Lc: Pointer)
    end
  end;

var
  PosixInject: record
    GetSmbios: function(Index: Integer): string;
    OnIdle: procedure of object;
  end;
  Ready: Boolean;

const
  Origin: record X, Y: Integer; end = (X: 0; Y: 0);

implementation

procedure TClient.Send;
begin
  Post(fIn.URL);
end;

end.
`;

const LABELS = `unit Labels;

interface

function Find(P: PChar): Integer;
procedure After;

implementation

function Find(P: PChar): Integer;
label
  fnd, quit;
begin
  Result := 0;
  if P = nil then
    goto quit;
  if Match(P) then
    goto fnd;
  goto quit;
fnd:
  Result := 1;
quit:
end;

procedure After;
begin
  Finish(1);
end;

end.
`;

const ALTERNATIVES = `unit Alternatives;

interface

function Repeated(Op: Integer): Integer;
function Pick(Lookup: Pointer): Integer;

implementation

function Repeated(Op: Integer): Integer;
begin
  Result := 0;
  case Op of
    1:
      {$IFDEF UNICODE}
      begin
        CountWide(Result);
      end;
      {$ELSE}
      while Result < 10 do
        CountAnsi(Result);
      {$ENDIF}
    2:
      Result := 2;
  end;
end;

function Pick(Lookup: Pointer): Integer;
begin
  if Lookup = nil then
    {$IFDEF ASMX86}
    Result := PosAsm(0)
    {$ELSE}
    Result := PosPas(0)
    {$ENDIF}
  else
    Result := PosLookup(Lookup);
end;

end.
`;

describe('Delphi syntax the Pascal grammar has no rule for', () => {
  it.each([
    ['re-published properties', OVERRIDES],
    ['conditionals after routine headers', HEADERS],
    ['branches that open the same begin', BEGINS],
    ['an assembler and a Pascal version of a body', ASSEMBLER],
    ['re-raises', RERAISES],
    ['anonymous records', RECORDS],
    ['a label that ends a block', LABELS],
    ['alternative statements where one goes', ALTERNATIVES],
  ])('parses a unit whole past %s', (_name, code) => {
    expect(parsesWhole(code)).toBe(true);
  });

  it('keeps a class whole past its re-published properties', () => {
    const { calls, names } = extract(OVERRIDES, 'Marks.pas');
    expect(names).toEqual(expect.arrayContaining([
      'TMarkList::GetItem', 'TMarkList::Create', 'TMarkList::Items', 'TEditor::Lines', 'TEditor::Paint',
    ]));
    // An override declares nothing new.
    expect(names).not.toContain('TMarkList::OwnsObjects');
    expect(names).not.toContain('TEditor::Align');
    expect(calls).toEqual(['Paint->Refresh']);
  });

  it('gives each routine its calls past a conditional after its header', () => {
    expect(extract(HEADERS, 'Headers.pas').calls.sort()).toEqual(['Generate->Emit', 'KeyUp->Translate', 'Size->Measure']);
    expect(extract(BEGINS, 'Begins.pas').calls.sort()).toEqual(['After->Finish', 'Click->Fold', 'Click->Paint']);
    expect(extract(ASSEMBLER, 'Assembler.pas').calls.sort()).toEqual(['After->Finish', 'DivMod10->Remainder', 'Log2Of->Log2']);
  });

  it('gives each routine its calls past a re-raise and a label that ends a block', () => {
    expect(extract(RERAISES, 'Reraises.pas').calls.sort()).toEqual(['Load->Log', 'Load->Read', 'Parse->Recover', 'Parse->Scan']);
    expect(extract(LABELS, 'Labels.pas').calls.sort()).toEqual(['After->Finish', 'Find->Match']);
  });

  it('keeps a declaration of an anonymous record type, and every declaration after it', () => {
    const { calls, names } = extract(RECORDS, 'Records.pas');
    expect(names).toEqual(expect.arrayContaining([
      'TClient::fIn', 'TClient::fRows', 'TClient::fCount', 'TClient::Send', 'TCaches', 'TState::Seed', 'TState::Data',
      'PosixInject', 'Ready', 'Origin',
    ]));
    // The record's own fields are no members of the class around it.
    expect(names).not.toContain('TClient::URL');
    expect(names).not.toContain('GetSmbios');
    expect(calls).toEqual(['Send->Post']);
  });

  it('reads alternative statements where one goes as one block, keeping the calls of each', () => {
    expect(extract(ALTERNATIVES, 'Alternatives.pas').calls.sort()).toEqual([
      'Pick->PosAsm', 'Pick->PosLookup', 'Pick->PosPas', 'Repeated->CountAnsi', 'Repeated->CountWide',
    ]);
  });

  it('keeps every offset and line, CRLF included', () => {
    for (const code of [OVERRIDES, HEADERS, BEGINS, ASSEMBLER, RERAISES, RECORDS, LABELS, ALTERNATIVES]) {
      const crlf = code.replace(/\n/g, '\r\n');
      const out = preParsePascal(crlf);
      expect(out.length).toBe(crlf.length);
      const breaks = (s: string) => [...s.matchAll(/\r\n/g)].map((m) => m.index);
      expect(breaks(out)).toEqual(breaks(crlf));
    }
  });

  it('writes the words it needs where the grammar reads them', () => {
    const blank = (s: string) => s.replace(/[^\r\n]/g, ' ');
    expect(preParsePascal('  1: {$IFDEF U} A(1); {$ELSE} B(2); {$ENDIF}\n'))
      .toBe('  1: begin      A(1); ;       B(2); end;    \n');
    expect(preParsePascal('  Data: record X: Integer; end;\n')).toBe(`  Data: string${blank(' X: Integer; end')};\n`);
    expect(preParsePascal('  Data: packed record X: Integer; end end;\n')).toBe(`  Data: string${blank(' record X: Integer; ')};   end;\n`);
    expect(preParsePascal('  else raise\n  end;\n')).toBe('  else ;    \n  end;\n');
  });

  it('leaves alone what the grammar reads as it is', () => {
    const code = `unit Keep;

interface

type
  TList<T: record> = class
    property Items[Index: Integer]: T read GetItem; default;
    property Count: Integer read FCount;
    Value: {$IFDEF CPU64} Int64 {$ELSE} Integer {$ENDIF};
  end;
  TRec = record
    X: Integer;
  end;

function Load: Integer;

implementation

function Load: Integer;
{$IFDEF PUREPASCAL}
var
  I: Integer;
begin
  Result := Read(I);
end;
{$ELSE}
asm
  mov eax, 1
end;
{$ENDIF}

procedure Run;
begin
  with List do
    {$IFDEF CPU64}
    if A = B then
    {$ELSE}
    if C = D then
    {$ENDIF}
      Exit;
  if Ready then {$IFDEF X} Go(1); {$ELSE} Stay(1); {$ENDIF}
  raise EAbort.Create('stop');
  WriteLn('raise; property X; quit:');
end;

end.
`;
    expect(preParsePascal(code)).toBe(code);
  });

  it('links a routine past a conditional after its header to what it calls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-delphi-syntax-'));
    try {
      fs.writeFileSync(path.join(dir, 'Lib.pas'), `unit Lib;

interface

procedure Translate(N: Integer);
procedure Emit(N: Integer);

implementation

procedure Translate(N: Integer); begin end;
procedure Emit(N: Integer); begin end;

end.
`);
      fs.writeFileSync(path.join(dir, 'Headers.pas'), HEADERS.replace('implementation\n', 'implementation\n\nuses Lib;\n'));
      const cg = await CodeGraph.init(dir, { index: true });
      try {
        const callers = (name: string) => {
          const target = cg.getNodesByKind('function').find((n) => n.qualifiedName === name && n.filePath === 'Lib.pas');
          return target ? cg.getIncomingEdges(target.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.source)?.name) : [];
        };
        expect(callers('Translate')).toEqual(['KeyUp']);
        expect(callers('Emit')).toEqual(['Generate']);
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
