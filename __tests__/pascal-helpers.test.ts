/**
 * Delphi class and record helpers (`TFooHelper = class helper for TFoo`) are
 * types of their own with methods. They were indexed as type aliases, their
 * methods not at all: the bodies' code belonged to the file, `node` and
 * `explore` couldn't show them, and nothing could link to them. Now a helper
 * is a class whose signature says what it helps (`class helper for TFoo`),
 * its methods are methods located at their bodies, and it references the type
 * it helps and extends the helper it descends from.
 *
 * A helper's method reaches the members of the type it helps by name, as its
 * own; and a value of a type reaches the methods the nearest helper in scope
 * adds to it (`R.Count` with `R: TRecord`), as Delphi applies the helper its
 * unit declares, or the one of the units it uses that it uses last.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILES: Record<string, string> = {
  'Records.pas': `unit Records;

interface

type
  TRecord = class
  public
    function ExecQuery(const SQL: string): Integer;
    procedure Refresh;
    function Describe: string;
  end;

  TRecordHelper = class helper for TRecord
  public
    function Count: Integer;
    function Total(Scale: Integer): Integer;
    function Describe: string;
  end;

  TMoreHelper = class helper(TRecordHelper) for TRecord
  public
    procedure Touch;
  end;

  // A descendant declaring a method a helper for its ancestor declares too.
  TSpecial = class(TRecord)
  public
    function Total(Scale: Integer): Integer;
  end;

  TPoint2 = record
    X, Y: Integer;
  end;

  TPoint2Helper = record helper for TPoint2
    procedure Offset(DX: Integer);
    procedure Add(DX, DY: Integer);
  end;

  // Overloads a call's argument count alone can't tell apart.
  TNodeList = class
    function Add(Value: TObject): Integer; overload;
    function Add(Kind: Integer = 0): TObject; overload;
  end;

  TStringsHelper = class helper for TStrings
    procedure AddAll;
  end;

implementation

function TRecord.ExecQuery(const SQL: string): Integer;
begin
  Result := 0;
end;

procedure TRecord.Refresh;
begin
  Total(2); // c-own-class-to-helper
  Describe; // c-own-describe
end;

function TRecord.Describe: string;
begin
  Result := 'record';
end;

function TSpecial.Total(Scale: Integer): Integer;
begin
  Result := Scale;
end;

function TRecordHelper.Describe: string;
begin
  Result := 'helper';
end;

function TRecordHelper.Count: Integer;

  function Twice(N: Integer): Integer;
  begin
    Result := N * 2;
  end;

begin
  Result := Twice(ExecQuery('select count(*)')); // c-helper-body
end;

function TRecordHelper.Total(Scale: Integer): Integer;
begin
  Result := Count * Scale; // c-helper-own-parenless
end;

procedure TMoreHelper.Touch;
begin
  Total(1); // c-parent-helper
  Refresh; // c-helped-parenless
end;

procedure TPoint2Helper.Offset(DX: Integer);
begin
  Inc(X, DX);
end;

procedure TPoint2Helper.Add(DX, DY: Integer);
begin
end;

function TNodeList.Add(Value: TObject): Integer;
begin
  Result := 0;
end;

function TNodeList.Add(Kind: Integer): TObject;
begin
  Result := nil;
end;

procedure TStringsHelper.AddAll;
begin
  Add('x'); // c-rtl-helped
end;

end.
`,
  // Namesakes of the helpers' methods on an unrelated class.
  'Ledger.pas': `unit Ledger;

interface

type
  TLedger = class
    function Total(Scale: Integer): Integer;
    function Count: Integer;
    procedure Offset(DX: Integer);
  end;

implementation

function TLedger.Total(Scale: Integer): Integer;
begin
  Result := Scale;
end;

function TLedger.Count: Integer;
begin
  Result := 0;
end;

procedure TLedger.Offset(DX: Integer);
begin
end;

end.
`,
  'Client.pas': `unit Client;

interface

uses
  Records, Ledger;

procedure Use(R: TRecord; var P: TPoint2);

implementation

procedure Use(R: TRecord; var P: TPoint2);
var
  N: Integer;
  S: string;
  Sp: TSpecial;
  List: TNodeList;
begin
  N := List.Add(R); // c-exact-arity
  N := Sp.Total(5); // c-descendant-own
  N := TSpecial(R).Total(6); // c-descendant-cast
  S := R.Describe(); // c-value-hides
  N := R.Total(3); // c-value-call
  N := R.Count; // c-value-parenless
  P.Offset(1); // c-record-value
  with R do
    N := Total(4); // c-with-subject
end;

end.
`,
  // A project class sharing its name with an RTL type that a helper elsewhere helps.
  'JsonLib.pas': `unit JsonLib;

interface

type
  TJsonObject = class
    procedure Clear;
  end;

implementation

procedure TJsonObject.Clear;
begin
end;

end.
`,
  'JsonHelpers.pas': `unit JsonHelpers;

interface

uses
  System.JSON;

type
  TJsonObjectHelper = class helper for TJsonObject
    procedure Reset;
  end;

implementation

procedure TJsonObjectHelper.Reset;
begin
  Clear(); // c-outside-helped
end;

end.
`,
  // A helper for a VCL type and a project class declaring the same method (HeidiSQL's TrySetFocus).
  'Controls2.pas': `unit Controls2;

interface

uses
  Vcl.Controls;

type
  TWinControlHelper = class helper for TWinControl
    procedure TrySetFocus;
  end;

implementation

procedure TWinControlHelper.TrySetFocus;
begin
end;

end.
`,
  'Trees.pas': `unit Trees;

interface

uses
  Vcl.Controls;

type
  TTree = class(TCustomControl)
    procedure TrySetFocus;
  end;

  TMemoX = class(TCustomControl)
    procedure Paint2;
  end;

implementation

procedure TTree.TrySetFocus;
begin
end;

procedure TMemoX.Paint2;
begin
end;

end.
`,
  'Form1.pas': `unit Form1;

interface

uses
  Trees, Controls2;

type
  TForm1 = class
    Tree: TTree;
    Memo: TMemoX;
    procedure Go;
  end;

implementation

procedure TForm1.Go;
begin
  Tree.TrySetFocus; // c-own-beside-outside-helper
  Memo.TrySetFocus; // c-outside-helper-unknown
end;

end.
`,
  // A FireMonkey canvas helper, and VCL code that doesn't use its unit.
  'FmxHelpers.pas': `unit FmxHelpers;

interface

uses
  FMX.Graphics;

type
  TFmxCanvasHelper = class helper for TCanvas
    procedure FillRect(const R: TRect);
  end;

implementation

procedure TFmxCanvasHelper.FillRect(const R: TRect);
begin
end;

end.
`,
  'Painter.pas': `unit Painter;

interface

uses
  Vcl.Controls, Vcl.Graphics;

type
  TBox = class(TCustomControl)
    procedure PaintBox(const R: TRect);
  end;

implementation

procedure TBox.PaintBox(const R: TRect);
begin
  Canvas.FillRect(R); // c-helper-unit-unused
end;

end.
`,
  // A helper in a unit Client2 doesn't use, for a method name no other type has.
  'Extras.pas': `unit Extras;

interface

uses
  Records;

type
  TRecordExtras = class helper for TRecord
    function Archive(Days: Integer): Integer;
  end;

implementation

function TRecordExtras.Archive(Days: Integer): Integer;
begin
  Result := Days;
end;

end.
`,
  'Client2.pas': `unit Client2;

interface

uses
  Records;

procedure Use2(R: TRecord);

implementation

procedure Use2(R: TRecord);
var
  N: Integer;
begin
  with R do
    N := Archive(1); // c-helper-not-in-scope
end;

end.
`,
};

describe('Pascal class and record helpers', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-helpers-'));
    for (const [rel, content] of Object.entries(FILES)) fs.writeFileSync(path.join(root, rel), content);
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function node(qualifiedName: string) {
    const found = ['class', 'method', 'function', 'type_alias'].flatMap((k) => cg!.getNodesByKind(k as never))
      .filter((n) => n.qualifiedName === qualifiedName);
    expect(found, qualifiedName).toHaveLength(1);
    return found[0]!;
  }

  /** What the calls and references on the line marked `// marker` in `file` reach, as `kind Owner::Name`. */
  function reached(file: string, marker: string): string[] {
    const line = FILES[file]!.split('\n').findIndex((l) => l.endsWith(`// ${marker}`)) + 1;
    expect(line, marker).toBeGreaterThan(0);
    const out: string[] = [];
    for (const n of cg!.getNodesInFile(file)) {
      for (const e of cg!.getOutgoingEdges(n.id)) {
        if ((e.kind !== 'calls' && e.kind !== 'references') || e.line !== line) continue;
        out.push(`${e.kind} ${cg!.getNode(e.target)!.qualifiedName}`);
      }
    }
    return out.sort();
  }

  it('indexes a helper as a class whose signature says what it helps', () => {
    expect(node('TRecordHelper').kind).toBe('class');
    expect(node('TRecordHelper').signature).toBe('class helper for TRecord');
    expect(node('TPoint2Helper').signature).toBe('record helper for TPoint2');
    expect(node('TMoreHelper').signature).toBe('class helper(TRecordHelper) for TRecord');
  });

  it("indexes a helper's methods at their bodies, nested routines inside them", () => {
    const count = node('TRecordHelper::Count');
    expect(count.kind).toBe('method');
    const lines = FILES['Records.pas']!.split('\n');
    expect(lines[count.startLine - 1]).toMatch(/^function TRecordHelper\.Count: Integer;/);
    expect(node('TRecordHelper::Count::Twice').kind).toBe('function');
    expect(node('TPoint2Helper::Offset').kind).toBe('method');
  });

  it('references the type a helper helps and extends the helper it descends from', () => {
    const edges = (qn: string) => cg!.getOutgoingEdges(node(qn).id)
      .filter((e) => e.kind === 'references' || e.kind === 'extends')
      .map((e) => `${e.kind} ${cg!.getNode(e.target)!.qualifiedName}`).sort();
    expect(edges('TRecordHelper')).toEqual(['references TRecord']);
    expect(edges('TMoreHelper')).toEqual(['extends TRecordHelper', 'references TRecord']);
  });

  it("calls from a helper's method reach its nested routines and the helped type's members", () => {
    expect(reached('Records.pas', 'c-helper-body')).toEqual(['calls TRecord::ExecQuery', 'calls TRecordHelper::Count::Twice']);
    expect(reached('Records.pas', 'c-helper-own-parenless')).toEqual(['calls TRecordHelper::Count']);
  });

  it('a helper descending from another reaches its members, then the helped type', () => {
    expect(reached('Records.pas', 'c-parent-helper')).toEqual(['calls TRecordHelper::Total']);
    expect(reached('Records.pas', 'c-helped-parenless')).toEqual(['calls TRecord::Refresh']);
  });

  it("the helped type's own methods reach a helper its unit declares", () => {
    expect(reached('Records.pas', 'c-own-class-to-helper')).toEqual(['calls TRecordHelper::Total']);
  });

  it('a value of the helped type reaches the methods of the helper in scope', () => {
    expect(reached('Client.pas', 'c-value-call')).toEqual(['calls TRecordHelper::Total']);
    expect(reached('Client.pas', 'c-value-parenless')).toEqual(['calls TRecordHelper::Count']);
    expect(reached('Client.pas', 'c-record-value')).toEqual(['calls TPoint2Helper::Offset']);
    expect(reached('Client.pas', 'c-with-subject')).toEqual(['calls TRecordHelper::Total']);
  });

  it("a helper's method hides the type's own of its name on a value, not in the type's own methods", () => {
    expect(reached('Client.pas', 'c-value-hides')).toEqual(['calls TRecordHelper::Describe']);
    expect(reached('Records.pas', 'c-own-describe')).toEqual(['calls TRecord::Describe']);
  });

  it("a descendant's own method comes before a helper for its ancestor", () => {
    expect(reached('Client.pas', 'c-descendant-own')).toEqual(['calls TSpecial::Total']);
    // The typecast is a use of the type as well.
    expect(reached('Client.pas', 'c-descendant-cast')).toEqual(['calls TSpecial::Total', 'references TSpecial']);
  });

  it('a helper the unit neither declares nor uses adds nothing', () => {
    expect(reached('Client2.pas', 'c-helper-not-in-scope')).toEqual([]);
    // Nor is its method a guess by name: the VCL canvas's FillRect is no FireMonkey helper's.
    expect(reached('Painter.pas', 'c-helper-unit-unused')).toEqual([]);
  });

  it("a call a helper's name settles by its receiver's type reaches the overload taking its arguments exactly", () => {
    expect(reached('Client.pas', 'c-exact-arity').map((e) => e)).toEqual(['calls TNodeList::Add']);
    const add = cg!.getOutgoingEdges(node('Use').id).find((e) => e.kind === 'calls' && cg!.getNode(e.target)!.qualifiedName === 'TNodeList::Add');
    expect(cg!.getNode(add!.target)!.signature).toBe('(Value: TObject): Integer');
  });

  it("a helper for a type outside the project reaches nothing of the project's by name", () => {
    expect(reached('Records.pas', 'c-rtl-helped')).toEqual([]);
    // `TJsonObject` is System.JSON's there, not JsonLib's, which the unit doesn't use.
    expect(reached('JsonHelpers.pas', 'c-outside-helped')).toEqual([]);
  });

  it("a receiver's type decides a name a helper for an outside type also declares", () => {
    expect(reached('Form1.pas', 'c-own-beside-outside-helper')).toEqual(['calls TTree::TrySetFocus']);
    // TMemoX declares none; the helper for the VCL's TWinControl may well be the one, which nothing here shows.
    expect(reached('Form1.pas', 'c-outside-helper-unknown')).toEqual([]);
  });
});
