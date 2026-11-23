/**
 * A bare Pascal call (`Max(A, B)`, `Check(…)`) links only to a routine its
 * scope declares: a member of a `with` statement's subject, then a routine
 * nested where it is made, a member of its class, a routine of its unit or
 * of a unit it uses. Before, a name no scope declared went to any routine of
 * that name in the project: HeidiSQL's `Max(a, b)`, from `System.Math`,
 * reached `SynEditMiscProcs.Max`, a stand-in for old compilers in a unit
 * `main.pas` doesn't use; DWScript's DUnit tests had their `Check(…)` calls
 * reach a test script's `TBase.Check`.
 *
 * In a `with` body a name is first a member of the subject's type: in
 * `with TJsonWriter.CreateOwnedStream(tmp) do SetText(result)`, the writer's
 * `SetText`, not another class's; one whose type the project doesn't declare
 * whole (`with Reg do OpenKeyReadOnly(…)`, `Reg: TRegistry`) may have the
 * name, so nothing out of scope is linked through it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILES: Record<string, string> = {
  // A stand-in for compilers without System.Math, in a unit Main.pas doesn't use.
  'MiscProcs.pas': `unit MiscProcs;

interface

{$IFNDEF HAS_MATH}
function Max(A, B: Integer): Integer;
function Min(A, B: Integer): Integer;
{$ENDIF}

implementation

{$IFNDEF HAS_MATH}
function Max(A, B: Integer): Integer;
begin
  if A > B then Result := A else Result := B;
end;

function Min(A, B: Integer): Integer;
begin
  if A < B then Result := A else Result := B;
end;
{$ENDIF}

end.
`,
  'Main.pas': `unit Main;

interface

uses
  System.Math, System.Classes;

type
  TMainForm = class
    procedure Layout;
  end;

implementation

procedure TMainForm.Layout;
var
  W: Integer;
begin
  W := Max(1, 2); // c-max
  W := Min(W, 3); // c-min
end;

end.
`,
  'Editor.pas': `unit Editor;

interface

uses
  MiscProcs;

type
  TEditor = class
    procedure Paint;
  end;

implementation

procedure TEditor.Paint;
var
  W: Integer;
begin
  W := Max(1, 2); // c-used-max
end;

end.
`,
  // A program whose `uses` clause pulls in more units through an include file.
  'Bench.dpr': `program Bench;

uses
  {$I bench.uses.inc}
  Editor;

var
  W: Integer;
begin
  W := Max(1, 2); // c-uses-include
end.
`,
  'bench.uses.inc': `{$ifdef FPC}
  MiscProcs, // the memory manager
{$endif}
`,
  // A test script that declares a namesake of DUnit's Check.
  'Script.pas': `unit Script;

interface

type
  TBase = class
    procedure Check(Cond: Boolean; const Msg: string = '');
  end;

implementation

procedure TBase.Check(Cond: Boolean; const Msg: string);
begin
end;

end.
`,
  'UtilsTests.pas': `unit UtilsTests;

interface

uses
  TestFramework;

type
  TUtilsTests = class(TTestCase)
  published
    procedure TestIt;
  end;

implementation

procedure TUtilsTests.TestIt;
begin
  Check(True, 'one'); // c-check
end;

end.
`,
  // A helper's methods reach the members of the class it helps by name.
  'Records.pas': `unit Records;

interface

type
  TRecord = class
  public
    function ExecQuery(const SQL: string): Integer;
  end;

  TRecordHelper = class helper for TRecord
  public
    function Count: Integer;
  end;

implementation

function TRecord.ExecQuery(const SQL: string): Integer;
begin
  Result := 0;
end;

function TRecordHelper.Count: Integer;

  function Twice(N: Integer): Integer;
  begin
    Result := N * 2;
  end;

var
  N: Integer;
begin
  N := ExecQuery('select count(*)'); // c-helper-member
  Result := Twice(N); // c-helper-nested
  Check(N > 0); // c-helper-outside
end;

end.
`,
  // Include files no unit includes, which an Inno Setup script pulls in with
  // `#include`: what they see is not known.
  'setup/Utils.inc': `function ReadNodeText(const Path: string): string; forward;

function ReadNodeText(const Path: string): string;
begin
  Result := Path;
end;
`,
  'setup/Project.inc': `function LoadProject(const Name: string): string;
begin
  Result := ReadNodeText(Name); // c-orphan-inc
end;
`,
  // An include file of a unit sees what the unit sees.
  'Layout.pas': `unit Layout;

interface

procedure Arrange;

implementation

{$I LayoutImpl.inc}

end.
`,
  'LayoutImpl.inc': `procedure Arrange;
var
  W: Integer;
begin
  W := Max(1, 2); // c-included-inc
end;
`,
  'Writers.pas': `unit Writers;

interface

type
  TBaseWriter = class
  public
    procedure SetText(var Dest: string);
    procedure AddDirect(C: Char);
  end;

  TWriter = class(TBaseWriter)
  public
    constructor CreateOwned(Size: Integer);
    procedure Add(const S: string); overload;
    procedure Add(const S: string; Count: Integer); overload;
  end;

  TWriterList = class
  public
    function GetItem(I: Integer): TWriter;
    property Items[I: Integer]: TWriter read GetItem; default;
  end;

  PPoint2 = ^TPoint2;
  TPoint2 = record
    X, Y: Integer;
    procedure Offset(DX: Integer);
  end;

  TWriterDynArray = array of TWriter;

  TBox = class
  public
    Writers: array of TWriter;
  end;

implementation

procedure TBaseWriter.SetText(var Dest: string);
begin
end;

procedure TBaseWriter.AddDirect(C: Char);
begin
end;

constructor TWriter.CreateOwned(Size: Integer);
begin
end;

procedure TWriter.Add(const S: string);
begin
end;

procedure TWriter.Add(const S: string; Count: Integer);
begin
end;

function TWriterList.GetItem(I: Integer): TWriter;
begin
  Result := nil;
end;

procedure TPoint2.Offset(DX: Integer);
begin
  Inc(X, DX);
end;

end.
`,
  'Jobs.pas': `unit Jobs;

interface

uses
  Writers, Registry, Generics.Collections;

type
  // Namesakes of the writer's members, in the calling unit.
  TStrList = class
  public
    procedure Add(const S: string);
    procedure SetText(var Dest: string);
    procedure AddDirect(C: Char);
    procedure OpenKeyReadOnly(const Key: string);
    procedure Offset(DX: Integer);
  end;

  // An ancestor outside the project.
  TMyList = class(TStringList)
  public
    procedure Sort2;
  end;

  TJob = class
  private
    FWriter: TWriter;
    FItems: TObjectList<TWriter>;
    FList: TWriterList;
    FDyn: TWriterDynArray;
  public
    procedure Indexed(Box: TBox);
    procedure Run(Obj: TObject);
    procedure Extent(Cond: Boolean);
    procedure Blocks(N: Integer);
    procedure Nested;
    procedure Param(Writer: TWriter; P: PPoint2);
    procedure Report;
    procedure Log(const S: string);
    function Make: TWriter;
  end;

  TCollector = class
  public
    procedure Add(const S: string);
    procedure Gather;
  end;

procedure Note(const S: string);

implementation

procedure Note(const S: string);
begin
end;

procedure TStrList.Add(const S: string);
begin
end;

procedure TStrList.SetText(var Dest: string);
begin
end;

procedure TStrList.AddDirect(C: Char);
begin
end;

procedure TStrList.OpenKeyReadOnly(const Key: string);
begin
end;

procedure TStrList.Offset(DX: Integer);
begin
end;

procedure TMyList.Sort2;
begin
end;

procedure TJob.Run(Obj: TObject);
var
  S: string;
  W: TWriter;
  Reg: TRegistry;
begin
  with TWriter.CreateOwned(16) do
  try
    Add('x'); // c-ctor-add
    AddDirect('"'); // c-ctor-inherited
    SetText(S); // c-ctor-settext
    Add('x', 2); // c-ctor-overload
  finally
    Free;
  end;
  with W do Add('y'); // c-local
  with FWriter do Add('z'); // c-field
  with TWriter(Obj) do Add('cast'); // c-typecast
  with Obj as TWriter do Add('as'); // c-as
  with FItems[0] do Add('item'); // c-generic-item
  with FList.Items[0] do Add('items'); // c-array-property
  Reg := TRegistry.Create;
  with Reg do OpenKeyReadOnly('Software'); // c-rtl-subject
  with TMyList.Create do Add('outside-ancestor'); // c-outside-ancestor
  with W do Note('n'); // c-unit-routine
end;

procedure TJob.Extent(Cond: Boolean);
var
  W: TWriter;
begin
  with W do
    Add('in'); // c-in
  Add('after'); // c-after
  if Cond then
    with W do
      Add('then') // c-then
  else
    Add('else'); // c-else
  with W do
    if Cond then
      Add('inner-then') // c-inner-then
    else
      Add('inner-else'); // c-inner-else
  Add('last'); // c-last
end;

procedure TJob.Blocks(N: Integer);
var
  W: TWriter;
begin
  case N of
    1: with W do
         Add('case-in'); // c-case-in
    2: Add('case-out'); // c-case-out
  end;
  repeat
    with W do
      Add('repeat-in') // c-repeat-in
  until N > 0;
  Add('repeat-out'); // c-repeat-out
  try
    with W do
      Add('try-in') // c-try-in
  except
    Add('except-out'); // c-except-out
  end;
  with W do
  begin
    Add('begin-in'); // c-begin-in
  end;
  Add('begin-out'); // c-begin-out
end;

procedure TJob.Nested;
var
  W: TWriter;
  Reg: TRegistry;
begin
  with W do
    with Reg do
      Add('inner-rtl'); // c-nested-blocked
  with Reg do
    with W do
      Add('inner-typed'); // c-nested-typed
  with W, Reg do
    Add('pair'); // c-pair-blocked
end;

procedure TJob.Param(Writer: TWriter; P: PPoint2);
begin
  with Writer do
    Add('param'); // c-param
  with P^ do
    Offset(1); // c-pointer-record
end;

procedure TJob.Report;
var
  Reg: TRegistry;
begin
  with Reg do
    Log('x'); // c-in-scope-blocked
  Log('y'); // c-own
end;

procedure TJob.Log(const S: string);
begin
end;

function TJob.Make: TWriter;
begin
  Result := TWriter.CreateOwned(1);
  with Result do
    Add('result'); // c-result
end;

procedure TJob.Indexed(Box: TBox);
begin
  with FDyn[0] do
    Add('dyn'); // c-dyn-alias
  with FList[0] do
    Add('default'); // c-default-property
  with Box do
    with Writers[0] do
      Add('outer'); // c-outer-subject
end;

procedure TCollector.Add(const S: string);
begin
end;

procedure TCollector.Gather;
var
  W: TWriter;
begin
  Add('own'); // c-own-add
  with W do
    Add('subject'); // c-shadow
end;

end.
`,
};

describe('a bare Pascal call links only to a routine its scope declares', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-out-of-scope-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** What the call on the line marked `// marker` in `file` reaches: `Owner::Name(signature)`, or nothing. */
  function reached(file: string, marker: string): string[] {
    const line = FILES[file]!.split('\n').findIndex((l) => l.endsWith(`// ${marker}`)) + 1;
    expect(line, marker).toBeGreaterThan(0);
    const targets: string[] = [];
    for (const node of cg!.getNodesInFile(file)) {
      for (const e of cg!.getOutgoingEdges(node.id)) {
        if (e.kind !== 'calls' || e.line !== line) continue;
        const t = cg!.getNode(e.target)!;
        targets.push(`${t.qualifiedName}${t.signature ?? ''}`);
      }
    }
    return targets;
  }

  it('links no routine a unit the calling unit does not use declares', () => {
    expect(reached('Main.pas', 'c-max')).toEqual([]);
    expect(reached('Main.pas', 'c-min')).toEqual([]);
  });

  it('still links a routine of a unit the calling unit uses', () => {
    expect(reached('Editor.pas', 'c-used-max')).toEqual(['Max(A, B: Integer): Integer']);
  });

  it('counts the units an include file in a uses clause lists as used', () => {
    expect(reached('Bench.dpr', 'c-uses-include')).toEqual(['Max(A, B: Integer): Integer']);
  });

  it('links no method of a class the calling class does not descend from', () => {
    expect(reached('UtilsTests.pas', 'c-check')).toEqual([]);
  });

  it('reaches the members of the class a helper helps, and what its methods nest, from the helper', () => {
    expect(reached('Records.pas', 'c-helper-member')).toEqual(['TRecord::ExecQuery(const SQL: string): Integer']);
    expect(reached('Records.pas', 'c-helper-nested')).toEqual(['TRecordHelper::Count::Twice(N: Integer): Integer']);
    expect(reached('Records.pas', 'c-helper-outside')).toEqual([]);
  });

  it('links out of scope only where the scope is known: in a unit and the include files it includes', () => {
    expect(reached('setup/Project.inc', 'c-orphan-inc')).toEqual(['ReadNodeText(const Path: string): string']);
    expect(reached('LayoutImpl.inc', 'c-included-inc')).toEqual([]);
  });

  describe('in a with body', () => {
    it('links the member of what a constructor called on a class makes, inherited ones too', () => {
      expect(reached('Jobs.pas', 'c-ctor-add')).toEqual(['TWriter::Add(const S: string)']);
      expect(reached('Jobs.pas', 'c-ctor-inherited')).toEqual(['TBaseWriter::AddDirect(C: Char)']);
      expect(reached('Jobs.pas', 'c-ctor-settext')).toEqual(['TBaseWriter::SetText(var Dest: string)']);
    });

    it('links the overload of the member its arguments fit', () => {
      expect(reached('Jobs.pas', 'c-ctor-overload')).toEqual(['TWriter::Add(const S: string; Count: Integer)']);
    });

    it('types a subject that is a local, a field, a parameter, a typecast or an as-cast', () => {
      for (const marker of ['c-local', 'c-field', 'c-typecast', 'c-as']) {
        expect(reached('Jobs.pas', marker), marker).toEqual(['TWriter::Add(const S: string)']);
      }
      expect(reached('Jobs.pas', 'c-param')).toEqual(['TWriter::Add(const S: string)']);
    });

    it("types a function's Result by the function's result type", () => {
      expect(reached('Jobs.pas', 'c-result')).toEqual(['TWriter::Add(const S: string)']);
    });

    it('types an element of an array alias and of a default array property, and a member of the subject around', () => {
      for (const marker of ['c-dyn-alias', 'c-default-property', 'c-outer-subject']) {
        expect(reached('Jobs.pas', marker), marker).toEqual(['TWriter::Add(const S: string)']);
      }
    });

    it('types an element of a generic list and of an array property', () => {
      expect(reached('Jobs.pas', 'c-generic-item')).toEqual(['TWriter::Add(const S: string)']);
      expect(reached('Jobs.pas', 'c-array-property')).toEqual(['TWriter::Add(const S: string)']);
    });

    it('reaches a record through a pointer to it', () => {
      expect(reached('Jobs.pas', 'c-pointer-record')).toEqual(['TPoint2::Offset(DX: Integer)']);
    });

    it('links nothing out of scope through a subject whose type the project does not declare whole', () => {
      expect(reached('Jobs.pas', 'c-rtl-subject')).toEqual([]);
      expect(reached('Jobs.pas', 'c-outside-ancestor')).toEqual([]);
    });

    it('still links what the scope declares when the subject does not declare it', () => {
      expect(reached('Jobs.pas', 'c-unit-routine')).toEqual(['Note(const S: string)']);
    });

    it('links the subject member before a member of the calling class', () => {
      expect(reached('Jobs.pas', 'c-own-add')).toEqual(['TCollector::Add(const S: string)']);
      expect(reached('Jobs.pas', 'c-shadow')).toEqual(['TWriter::Add(const S: string)']);
    });

    it('keeps a name the scope declares when a subject of unknown type comes first', () => {
      expect(reached('Jobs.pas', 'c-in-scope-blocked')).toEqual(['TJob::Log(const S: string)']);
      expect(reached('Jobs.pas', 'c-own')).toEqual(['TJob::Log(const S: string)']);
    });

    it('looks at the innermost subject first, and stops at one of unknown type', () => {
      expect(reached('Jobs.pas', 'c-nested-typed')).toEqual(['TWriter::Add(const S: string)']);
      expect(reached('Jobs.pas', 'c-nested-blocked')).toEqual([]);
      expect(reached('Jobs.pas', 'c-pair-blocked')).toEqual([]);
    });

    it('ends the body where the with statement ends', () => {
      const writer = ['TWriter::Add(const S: string)'];
      expect(reached('Jobs.pas', 'c-in')).toEqual(writer);
      expect(reached('Jobs.pas', 'c-after')).toEqual([]);
      expect(reached('Jobs.pas', 'c-then')).toEqual(writer);
      expect(reached('Jobs.pas', 'c-else')).toEqual([]);
      expect(reached('Jobs.pas', 'c-inner-then')).toEqual(writer);
      expect(reached('Jobs.pas', 'c-inner-else')).toEqual(writer);
      expect(reached('Jobs.pas', 'c-last')).toEqual([]);
    });

    it('ends the body with the case, repeat, try or begin block around it', () => {
      const writer = ['TWriter::Add(const S: string)'];
      for (const marker of ['c-case-in', 'c-repeat-in', 'c-try-in', 'c-begin-in']) {
        expect(reached('Jobs.pas', marker), marker).toEqual(writer);
      }
      for (const marker of ['c-case-out', 'c-repeat-out', 'c-except-out', 'c-begin-out']) {
        expect(reached('Jobs.pas', marker), marker).toEqual([]);
      }
    });
  });
});
