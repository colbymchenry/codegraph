/**
 * A Pascal call to a name the compiler or the System unit gives meaning to,
 * like `SizeOf`, `TypeInfo`, `High`, `Inc`, `Move` or a typecast to a built-in
 * type such as `Pointer(P)`, linked to any project member of that name, and
 * the check that should have stopped it compared case: Pascal ignores it, so
 * `length(S)` and `dec(N)` went to a record's `length` field and a variable
 * named `dec`. A call that resolved to a field, a property or a variable
 * linked too, though only one holding a routine can run. Now such a call
 * links only to a declaration its scope reaches: a member of the class
 * (`Delete(I)` in a list class), or a routine of the unit or the units it
 * uses, and data only when its declared type is a routine's. That scope
 * takes in the include files a unit pulls in and the units whose header the
 * parser lost, and stops at the calling routine's own parameters and locals.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

async function withIndex(files: Record<string, string>, check: (cg: CodeGraph) => void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-system-'));
  try {
    for (const [name, code] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), code);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      check(cg);
    } finally {
      cg.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The calls a routine makes, as `line: Target::Name`. */
function callsFrom(cg: CodeGraph, qualifiedName: string): string[] {
  const source = cg.getNodesByKind('method').concat(cg.getNodesByKind('function')).find((n) => n.qualifiedName === qualifiedName);
  expect(source, qualifiedName).toBeDefined();
  return cg
    .getOutgoingEdges(source!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => `${e.line}: ${cg.getNode(e.target)?.qualifiedName ?? '?'}`)
    .sort();
}

// Namesakes of the System unit's names, elsewhere in the project.
const LIB = `unit Lib;

interface

type
  TRec = record
    length: Integer;
    high: Integer;
  end;

  TOther = class
  private
    FObj: TObject;
  public
    function TypeInfo: Pointer;
    procedure Move(A, B: Integer);
    function SizeOf: Integer;
    property Pointer: TObject read FObj;
  end;

var
  dec: Integer;

implementation

function TOther.TypeInfo: Pointer; begin Result := nil; end;
procedure TOther.Move(A, B: Integer); begin end;
function TOther.SizeOf: Integer; begin Result := 0; end;

end.
`;

describe('Pascal calls to the System unit and to data', () => {
  it('links an intrinsic, a System routine or a built-in typecast to no project namesake, whatever its case', async () => {
    const main = `unit Main;

interface

uses Lib;

type
  TList2 = class
  public
    procedure Run(const S: string; var A: array of Integer);
  end;

implementation

procedure TList2.Run(const S: string; var A: array of Integer);
var
  P: Pointer;
  N: Integer;
begin
  N := length(S) + High(A) + SIZEOF(N);
  dec(N);
  P := TypeInfo(TList2);
  Move(P, P, 0);
  P := Pointer(Self);
end;

end.
`;
    await withIndex({ 'Lib.pas': LIB, 'Main.pas': main }, (cg) => {
      expect(callsFrom(cg, 'TList2::Run')).toEqual([]);
    });
  });

  it('takes `system.` for the System unit whatever its case, and a lowercase `data.` for a variable', async () => {
    const main = `unit Main;

interface

uses Lib;

type
  TStore = class
  public
    function GetObjectFrom(const Name: string): TObject;
  end;

procedure Run(data: TStore);

implementation

function TStore.GetObjectFrom(const Name: string): TObject; begin Result := nil; end;

procedure Run(data: TStore);
var
  P: Pointer;
begin
  P := system.TypeInfo(TStore);
  data.GetObjectFrom('setting');
end;

end.
`;
    await withIndex({ 'Lib.pas': LIB, 'Main.pas': main }, (cg) => {
      expect(callsFrom(cg, 'Run')).toEqual(['24: TStore::GetObjectFrom']);
    });
  });

  it('links one to the declaration that shadows it in the call\'s scope', async () => {
    const main = `unit Main;

interface

uses Lib;

type
  TList2 = class
  public
    procedure Delete(Index: Integer);
    procedure Clear;
  end;

function Length(const S: string): Integer;
procedure Tidy;

implementation

function Length(const S: string): Integer; begin Result := 0; end;

procedure TList2.Delete(Index: Integer); begin end;

procedure TList2.Clear;
begin
  Delete(0);
end;

procedure Tidy;
begin
  Length('x');
end;

end.
`;
    await withIndex({ 'Lib.pas': LIB, 'Main.pas': main }, (cg) => {
      // The list's own `Delete`, and the unit's own `Length`.
      expect(callsFrom(cg, 'TList2::Clear')).toEqual(['25: TList2::Delete']);
      expect(callsFrom(cg, 'Tidy')).toEqual(['30: Length']);
    });
  });

  it('takes a unit\'s stand-in declared under a condition for the System unit\'s own', async () => {
    const lib = `unit Lib;

interface

type
{$IFNDEF UNICODE}
  UnicodeString = WideString;
{$ENDIF}
  RawUtf8 = type AnsiString;

{$IFNDEF COMPILER_3_UP}
procedure Assert(Expr: Boolean); { stub for Delphi 2 }
{$ENDIF}
function UpperCase(const S: RawUtf8): RawUtf8;

implementation

{$IFNDEF COMPILER_3_UP}
procedure Assert(Expr: Boolean); begin end;
{$ENDIF}
function UpperCase(const S: RawUtf8): RawUtf8; begin Result := S; end;

end.
`;
    const main = `unit Main;

interface

uses SysUtils, Lib;

procedure Run(P: Pointer; const S: RawUtf8);

implementation

procedure Run(P: Pointer; const S: RawUtf8);
begin
  Assert(P <> nil);
  if UnicodeString(P) <> '' then
    UpperCase(S);
end;

end.
`;
    await withIndex({ 'Lib.pas': lib, 'Main.pas': main }, (cg) => {
      // The used unit's `UpperCase` hides SysUtils' one; `Assert` and
      // `UnicodeString` are the compiler's.
      expect(callsFrom(cg, 'Run')).toEqual(['15: UpperCase']);
      const run = cg.getNodesByKind('function').find((n) => n.qualifiedName === 'Run')!;
      expect(cg.getOutgoingEdges(run.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)?.name))
        .not.toContain('UnicodeString');
    });
  });

  it('reaches a class\'s ancestor through a type alias', async () => {
    const base = `unit Base;

interface

type
  TSearchEvent = procedure(Sender: TObject; const Text: string) of object;

  TBaseTree = class
  private
    FOnSearch: TSearchEvent;
  public
    function Ready: Boolean;
    property OnSearch: TSearchEvent read FOnSearch write FOnSearch;
  end;

implementation

function TBaseTree.Ready: Boolean; begin Result := True; end;

end.
`;
    const main = `unit Main;

interface

uses Base;

type
  TAncestor = TBaseTree;

  TStringTree = class(TAncestor)
  public
    procedure Search(const Text: string);
  end;

implementation

procedure TStringTree.Search(const Text: string);
begin
  if Ready then
    OnSearch(Self, Text);
end;

end.
`;
    await withIndex({ 'Base.pas': base, 'Main.pas': main }, (cg) => {
      const search = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'TStringTree::Search')!;
      const targets = cg.getOutgoingEdges(search.id).filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.target)?.qualifiedName).sort();
      // `TAncestor = TBaseTree;` names the class the tree descends from: its
      // `Ready` runs, and so does what its `OnSearch` event holds.
      expect(targets).toEqual(['TBaseTree::OnSearch', 'TBaseTree::Ready']);
    });
  });

  it('links a name its scope doesn\'t declare to the one routine-holding field of that name, unless the routine declares it', async () => {
    const lib = `unit Lib;

interface

type
  THandleAlloc = function(Parent: Pointer; var Handle: Pointer): Integer;
  THasher = function(Crc: Cardinal; Buf: Pointer; Len: Cardinal): Cardinal;

  TOciLib = class
  public
    HandleAlloc: THandleAlloc;
  end;

  TDynHasher = class
  private
    FHasher: THasher;
  public
    property Hasher: THasher read FHasher;
    property Direct: THasher read FHasher;
  end;

implementation

end.
`;
    const main = `unit Main;

interface

uses Lib;

type
  TConn = class
  private
    FOci: TOciLib;
    FEnv: Pointer;
  public
    procedure Connect;
  end;

function Hash(Item: Pointer; Hasher: THasher): Cardinal;
procedure Test;

implementation

procedure TConn.Connect;
begin
  with FOci do
    HandleAlloc(nil, FEnv);
end;

function Hash(Item: Pointer; Hasher: THasher): Cardinal;
begin
  Result := Hasher(0, Item, 4);
end;

procedure Test;

  procedure Direct(const Url: string);
  begin
  end;

begin
  Direct('/root');
end;

end.
`;
    await withIndex({ 'Lib.pas': lib, 'Main.pas': main }, (cg) => {
      // The `with` object's member, which the class's scope doesn't hold.
      expect(callsFrom(cg, 'TConn::Connect')).toEqual(['24: TOciLib::HandleAlloc']);
      // A parameter and a nested routine, not the properties named so.
      expect(callsFrom(cg, 'Hash')).toEqual([]);
      expect(callsFrom(cg, 'Test')).toEqual(['39: Test::Direct']);
    });
  });

  it('takes a parameter or a local of the calling routine for what its name calls', async () => {
    const lib = `unit Lib;

interface

type
  TLoad = procedure(Data: Pointer);

var
  load: TLoad;

implementation

end.
`;
    const main = `unit Main;

interface

uses Classes, Lib;

type
  TFoo = class
  private
    FOnChange: TNotifyEvent;
  public
    procedure Fire(OnChange: TNotifyEvent);
    procedure Run(Data: Pointer);
    property OnChange: TNotifyEvent read FOnChange;
  end;

implementation

procedure TFoo.Fire(OnChange: TNotifyEvent);
begin
  OnChange(Self);
end;

procedure TFoo.Run(Data: Pointer);
var
  load: TLoad;
begin
  load := nil;
  load(Data);
end;

end.
`;
    await withIndex({ 'Lib.pas': lib, 'Main.pas': main }, (cg) => {
      expect(callsFrom(cg, 'TFoo::Fire')).toEqual([]);
      expect(callsFrom(cg, 'TFoo::Run')).toEqual([]);
    });
  });

  it('reads a routine type declared on two lines, generic, or as an alias of another', async () => {
    const main = `unit Main;

interface

uses SysUtils;

type
  THelperEvent =
    procedure(const Value: Variant) of object;
  TSetParams<T: class> = reference to procedure(const Obj: T);
  TFormatter = TFunc<Exception, string>;
  TCounter = Integer;
  TCount = TCounter;

  TWriter<T: class> = class
  private
    FOnHelp: THelperEvent;
    FSetParams: TSetParams<T>;
    FFormatter: TFormatter;
    FCount: TCount;
  public
    procedure Write(Obj: T; E: Exception);
  end;

implementation

procedure TWriter<T>.Write(Obj: T; E: Exception);
begin
  FOnHelp(1);
  FSetParams(Obj);
  FFormatter(E);
  FCount(1);
end;

end.
`;
    await withIndex({ 'Main.pas': main }, (cg) => {
      expect(callsFrom(cg, 'TWriter<T: class>::Write')).toEqual([
        '29: TWriter<T: class>::FOnHelp',
        '30: TWriter<T: class>::FSetParams',
        '31: TWriter<T: class>::FFormatter',
      ]);
    });
  });

  it('sees the declarations of a used unit whose header the parser lost', async () => {
    // The `{$IFDEF}` around a local `var` section costs the parse its `unit`
    // node; the unit is still the one its file is named after.
    const lib = `unit Lib;

interface

type
  THasher = function(Crc: Cardinal; Buf: Pointer; Len: Cardinal): Cardinal;

var
  crc32c: THasher;

function FileSize(const FileName: string): Int64;

implementation

function FileSize(const FileName: string): Int64;
{$IFDEF MSWINDOWS}
var
  Handle: THandle;
{$ENDIF}
begin
  Result := 0;
end;

end.
`;
    const main = `unit Main;

interface

uses Lib;

procedure Run(const Name: string);

implementation

procedure Run(const Name: string);
begin
  if FileSize(Name) > 0 then
    crc32c(0, nil, 0);
end;

end.
`;
    await withIndex({ 'Lib.pas': lib, 'Main.pas': main }, (cg) => {
      expect(cg.getNodesByKind('module').map((n) => n.name)).toEqual(['Main']);
      expect(callsFrom(cg, 'Run')).toEqual(['13: FileSize', '14: crc32c']);
    });
  });

  it('gives an include file\'s code the scope of the unit that includes it', async () => {
    const hash = `unit Hash;

interface

type
  THasher = function(Crc: Cardinal; Buf: Pointer; Len: Cardinal): Cardinal;

var
  DefaultHasher: THasher;

implementation

end.
`;
    const os = `unit Os;

interface

uses Hash;

procedure Entropy;
procedure Init;

implementation

{$I Os.windows.inc}

procedure Init;
begin
  OsLog('init');
end;

end.
`;
    const extra = `unit Extra;

interface

var
  ExtraLog: procedure(const S: string);

implementation

end.
`;
    // An include file may open with a `uses` clause of its own.
    const inc = `uses
  Extra;

var
  OsLog: procedure(const S: string);

procedure Entropy;
var
  Seed: Cardinal;
begin
  Seed := DefaultHasher(0, nil, 0);
  ExtraLog('seeded');
end;
`;
    await withIndex({ 'Hash.pas': hash, 'Extra.pas': extra, 'Os.pas': os, 'Os.windows.inc': inc }, (cg) => {
      const entropy = cg.getNodesByKind('function').find((n) => n.name === 'Entropy' && n.filePath.endsWith('.inc'));
      expect(entropy).toBeDefined();
      expect(cg.getOutgoingEdges(entropy!.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)?.qualifiedName).sort())
        .toEqual(['DefaultHasher', 'ExtraLog']);
      // And the unit's own code sees what its include file declares.
      expect(callsFrom(cg, 'Init')).toEqual(['16: OsLog']);
    });
  });

  it('takes no member of a class such a unit\'s parse lost for a routine of the unit', async () => {
    // The anonymous record ends the class early, so `Insert` comes out as a
    // routine of the unit, indented as no routine of the unit is.
    const lib = `unit Lib;

interface

type
  TClient = class
    Items: array of record
      Name: string;
    end;
    procedure Insert(Index: Integer; const S: string);
  end;

procedure Log(const S: string);

implementation

procedure TClient.Insert(Index: Integer; const S: string); begin end;

procedure Log(const S: string);
{$IFDEF MSWINDOWS}
var
  Handle: THandle;
{$ENDIF}
begin
end;

end.
`;
    const main = `unit Main;

interface

uses Lib;

procedure Run(var S: string);

implementation

procedure Run(var S: string);
begin
  Insert('x', S, 1);
  Log(S);
end;

end.
`;
    await withIndex({ 'Lib.pas': lib, 'Main.pas': main }, (cg) => {
      const insert = cg.getNodesByKind('function').find((n) => n.name === 'Insert');
      expect(insert?.startColumn).toBe(4);
      expect(callsFrom(cg, 'Run')).toEqual(['14: Log']);
    });
  });

  it('leaves out such a call in a `with` body, which may be the `with` object\'s', async () => {
    const main = `unit Main;

interface

type
  TItem = class
  public
    procedure Delete(Index: Integer);
  end;

  TItems = class
  public
    function Add: TItem;
    procedure Delete(Index: Integer);
    procedure Assign(Source: TObject);
  end;

implementation

procedure TItem.Delete(Index: Integer); begin end;
function TItems.Add: TItem; begin Result := nil; end;
procedure TItems.Delete(Index: Integer); begin end;

procedure TItems.Assign(Source: TObject);
begin
  with Add do
    Delete(0);
  Delete(1);
end;

end.
`;
    await withIndex({ 'Main.pas': main }, (cg) => {
      // In the `with` body, `Delete` is the item's, not the list's; after it, the list's.
      expect(callsFrom(cg, 'TItems::Assign')).toEqual(['28: TItems::Delete']);
    });
  });

  it('links a call to data only when the data holds a routine and the call\'s scope reaches it', async () => {
    const lib = `unit Lib;

interface

type
  TNotifyEvent = procedure(Sender: TObject) of object;

  TStranger = class
  private
    FOnChange: TNotifyEvent;
  end;

implementation

end.
`;
    const main = `unit Main;

interface

uses Lib;

type
  TList2 = class
  private
    FOnChange: TNotifyEvent;
    FCount: Integer;
    FProc: procedure of object;
    FGetter: reference to function: Integer;
    FOnLoad,                 // a list's type comes at its end
    FOnSave: TNotifyEvent;
  public
    procedure Run;
    procedure Other;
    property OnChange: TNotifyEvent read FOnChange write FOnChange;
  end;

  TOtherList = class
  public
    procedure Fire;
  end;

var
  GLog: procedure(const Msg: string);
  GCount: Integer;

implementation

procedure TList2.Run;
begin
  FOnChange(Self);
  OnChange(Self);
  FProc();
  FGetter();
  GLog('x');
  FCount(1);
  GCount(1);
  FOnLoad(Self);
end;

procedure TList2.Other; begin end;

procedure TOtherList.Fire;
begin
  FOnChange(Self);
end;

end.
`;
    await withIndex({ 'Lib.pas': lib, 'Main.pas': main }, (cg) => {
      expect(callsFrom(cg, 'TList2::Run')).toEqual([
        '35: TList2::FOnChange',
        '36: TList2::OnChange',
        '37: TList2::FProc',
        '38: TList2::FGetter',
        '39: GLog',
        '42: TList2::FOnLoad',
      ]);
      // No class this method's scope reaches declares `FOnChange`.
      expect(callsFrom(cg, 'TOtherList::Fire')).toEqual([]);
    });
  });
});
