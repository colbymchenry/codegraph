/**
 * Delphi calls a parameterless routine without parentheses (#2514):
 * `Before;`, `Result := FProvider.Value + 1`, `if Ready then`, and a method
 * given to an event, `OnGet := FProvider.Value`. None of these was linked, so
 * callers, callees and impact missed most call sites in real Delphi code.
 * The same spelling reads a field, a property, a variable or a constant, so a
 * name is linked only when Delphi's scope rules reach a method or function of
 * that name: the routine's own declarations, its class and ancestors, the
 * unit, then the units it uses. Data of that name links nothing.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-parenless-'));
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

/** The calls and references a routine makes, as `kind Target::Name`. */
function edgesFrom(cg: CodeGraph, qualifiedName: string): string[] {
  const source = cg.getNodesByKind('function').concat(cg.getNodesByKind('method')).find((n) => n.qualifiedName === qualifiedName);
  expect(source, qualifiedName).toBeDefined();
  return cg
    .getOutgoingEdges(source!.id)
    .filter((e) => e.kind === 'calls' || e.kind === 'references')
    .map((e) => `${e.kind} ${cg.getNode(e.target)?.qualifiedName ?? '?'}`)
    .sort();
}

// The issue's own unit.
const UNIT_A = `unit UnitA;

interface

type
  TGetIntEvent = function: Integer of object;

  TProvider = class
  public
    function Value: Integer;
    function ValueParens(): Integer;
  end;

  TConsumer = class
  private
    FProvider: TProvider;
    FOnGet: TGetIntEvent;
  public
    function UseNoParens: Integer;
    function UseParens: Integer;
    function UseEvent: Integer;
    procedure Wire;
    property OnGet: TGetIntEvent read FOnGet write FOnGet;
  end;

implementation

function TProvider.Value: Integer;
begin
  Result := 1;
end;

function TProvider.ValueParens(): Integer;
begin
  Result := 2;
end;

function TConsumer.UseNoParens: Integer;
begin
  Result := FProvider.Value + 1;
end;

function TConsumer.UseParens: Integer;
begin
  Result := FProvider.ValueParens() + 1;
end;

procedure TConsumer.Wire;
begin
  OnGet := FProvider.Value;
end;

function TConsumer.UseEvent: Integer;
begin
  Result := FOnGet;
end;

end.
`;

describe('Delphi calls without parentheses (#2514)', () => {
  it('links the issue\'s paren-less call as a call and the event\'s method as a reference', async () => {
    await withIndex({ 'UnitA.pas': UNIT_A }, (cg) => {
      expect(edgesFrom(cg, 'TConsumer::UseNoParens')).toEqual(['calls TProvider::Value']);
      expect(edgesFrom(cg, 'TConsumer::UseParens')).toEqual(['calls TProvider::ValueParens']);
      expect(edgesFrom(cg, 'TConsumer::Wire')).toEqual(['references TProvider::Value']);
      // `FOnGet` is a field: reading it calls whatever was assigned, which the code doesn't say.
      expect(edgesFrom(cg, 'TConsumer::UseEvent')).toEqual([]);
    });
  });

  it('links a bare name to the class\'s method or the unit\'s routine, as a statement or for its value', async () => {
    const code = `unit Unit1;

interface

type
  TMin = class
  public
    procedure Before;
    procedure After;
    function Value: Integer;
    procedure UseValue;
  end;

procedure FreeProc;

implementation

procedure FreeProc;
begin
end;

procedure TMin.Before;
begin
end;

procedure TMin.After;
begin
  Before;
  freeproc;
end;

function TMin.Value: Integer;
begin
  Result := 1;
end;

procedure TMin.UseValue;
var
  X: Integer;
begin
  X := Value;
  if Value > 0 then
    Before;
end;

end.
`;
    await withIndex({ 'Unit1.pas': code }, (cg) => {
      // Pascal names are case-insensitive: `freeproc` is `FreeProc`.
      expect(edgesFrom(cg, 'TMin::After')).toEqual(['calls FreeProc', 'calls TMin::Before']);
      expect(edgesFrom(cg, 'TMin::UseValue')).toEqual(['calls TMin::Before', 'calls TMin::Value', 'calls TMin::Value']);
    });
  });

  it('never links a name that reads a field, property, variable, constant or parameter', async () => {
    const base = `unit Base;

interface

type
  TBase = class
  protected
    FReady: Boolean;
  public
    property Ready: Boolean read FReady;
  end;

implementation

end.
`;
    const decoys = `unit Decoys;

interface

function Ready: Boolean;
function Count: Integer;
function Items: Integer;
function Limit: Integer;
function Total: Integer;
function FItems: Integer;

implementation

function Ready: Boolean; begin Result := True; end;
function Count: Integer; begin Result := 0; end;
function Items: Integer; begin Result := 0; end;
function Limit: Integer; begin Result := 0; end;
function Total: Integer; begin Result := 0; end;
function FItems: Integer; begin Result := 0; end;

end.
`;
    const main = `unit Main;

interface

uses Decoys, Base;

type
  TList = class(TBase)
  private
    FItems: Integer;
    function GetCount: Integer;
  public
    property Count: Integer read GetCount;
    function Run(Total: Integer): Integer;
  end;

const
  Limit = 10;

var
  Items: Integer;

implementation

function TList.GetCount: Integer;
begin
  Result := 0;
end;

function TList.Run(Total: Integer): Integer;
begin
  Result := Count + Items + Limit + Total + FItems;
  if Ready then
    Result := 0;
end;

end.
`;
    await withIndex({ 'Base.pas': base, 'Decoys.pas': decoys, 'Main.pas': main }, (cg) => {
      // `Ready` is the inherited property, which the unit's own
      // `uses Decoys` doesn't reach past.
      expect(edgesFrom(cg, 'TList::Run')).toEqual([]);
    });
  });

  it('follows the class\'s ancestors and the units it uses, the last one first', async () => {
    const lib = `unit Lib;

interface

type
  TBase = class
  public
    procedure Setup;
  end;

procedure Helper;

implementation

procedure TBase.Setup; begin end;
procedure Helper; begin end;

end.
`;
    const other = `unit Other;

interface

procedure Helper;

implementation

procedure Helper; begin end;

end.
`;
    const unused = `unit Unused;

interface

procedure Teardown;

implementation

procedure Teardown; begin end;

end.
`;
    const main = `unit Main;

interface

uses Other, Lib;

type
  TChild = class(TBase)
  public
    procedure Run;
  end;

implementation

procedure TChild.Run;
begin
  Setup;
  Helper;
  Teardown;
end;

end.
`;
    await withIndex({ 'Lib.pas': lib, 'Other.pas': other, 'Unused.pas': unused, 'Main.pas': main }, (cg) => {
      const helpers = cg.getNodesByKind('function').filter((n) => n.name === 'Helper');
      const libHelper = helpers.find((n) => n.filePath.endsWith('Lib.pas'));
      const run = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'TChild::Run')!;
      const targets = cg.getOutgoingEdges(run.id).filter((e) => e.kind === 'calls').map((e) => e.target);
      // `Lib` is used last, so its `Helper` hides `Other`'s; `Unused` isn't used at all.
      expect(targets).toContain(libHelper!.id);
      expect(edgesFrom(cg, 'TChild::Run')).toEqual(['calls Helper', 'calls TBase::Setup']);
    });
  });

  it('links a function used as a receiver, through fields, parameters and locals of a declared type', async () => {
    // The issue's real project: `FProjectPanel.ActiveModelSeries.Visible`.
    const code = `unit Unit1;

interface

type
  TSeries = class
  public
    procedure BeginUpdate;
    function Visible: Boolean;
  end;

  TPanel = class
  public
    function ActiveSeries: TSeries;
  end;

  TForm1 = class
  private
    FPanel: TPanel;
    function CurrentPanel: TPanel;
  public
    procedure Run;
    procedure RunWith(APanel: TPanel);
  end;

implementation

procedure TSeries.BeginUpdate; begin end;
function TSeries.Visible: Boolean; begin Result := True; end;
function TPanel.ActiveSeries: TSeries; begin Result := nil; end;
function TForm1.CurrentPanel: TPanel; begin Result := FPanel; end;

procedure TForm1.Run;
begin
  FPanel.ActiveSeries.BeginUpdate;
  if CurrentPanel.ActiveSeries.Visible then
    Exit;
end;

procedure TForm1.RunWith(APanel: TPanel);
var
  S: TSeries;
begin
  S := APanel.ActiveSeries;
  if S.Visible then
    Exit;
end;

end.
`;
    await withIndex({ 'Unit1.pas': code }, (cg) => {
      expect(edgesFrom(cg, 'TForm1::Run')).toEqual([
        'calls TForm1::CurrentPanel',
        'calls TPanel::ActiveSeries',
        'calls TPanel::ActiveSeries',
        'calls TSeries::BeginUpdate',
        'calls TSeries::Visible',
      ]);
      expect(edgesFrom(cg, 'TForm1::RunWith')).toEqual(['calls TPanel::ActiveSeries', 'calls TSeries::Visible']);
    });
  });

  it('gives a method to an event or an argument as a reference, a method pointer', async () => {
    const code = `unit Unit1;

interface

type
  TNotify = procedure of object;

  TButton = class
  public
    OnClick: TNotify;
    procedure Click;
  end;

  TItem = class
  public
    constructor Create(AOwner: TObject);
  end;

  TForm1 = class
  private
    FButton: TButton;
    procedure ButtonClick;
    procedure Register(Handler: TNotify);
    function Title: string;
    function Compare(A, B: Integer): Integer;
    procedure Sort(Fn: TCompare);
  public
    procedure Setup;
    procedure SetupWith;
  end;

implementation

constructor TItem.Create(AOwner: TObject); begin end;
procedure TButton.Click; begin end;
procedure TForm1.ButtonClick; begin end;
procedure TForm1.Register(Handler: TNotify); begin end;
function TForm1.Title: string; begin Result := ''; end;
function TForm1.Compare(A, B: Integer): Integer; begin Result := A - B; end;
procedure TForm1.Sort(Fn: TCompare); begin end;

procedure TForm1.Setup;
var
  Item: TObject;
begin
  FButton.OnClick := ButtonClick;
  Register(ButtonClick);
  // A function that needs arguments, written without them, is its pointer.
  Sort(Compare);
  // A constructor written without the arguments it needs is an inherited
  // one outside the project, TObject.Create.
  Item := TItem.Create;
end;

procedure TForm1.SetupWith;
var
  S: string;
begin
  with FButton do
  begin
    Click;
    OnClick := ButtonClick;
    S := Title;
  end;
end;

end.
`;
    await withIndex({ 'Unit1.pas': code }, (cg) => {
      expect(edgesFrom(cg, 'TForm1::Setup')).toEqual([
        'calls TForm1::Register',
        'calls TForm1::Sort',
        'references TForm1::ButtonClick',
        'references TForm1::ButtonClick',
        'references TForm1::Compare',
      ]);
      // In a `with` body a name may be the `with` object's member: `Click`
      // is the button's, and `Title` could be. Only the event's method is
      // linked there.
      expect(edgesFrom(cg, 'TForm1::SetupWith')).toEqual(['references TForm1::ButtonClick']);
    });
  });

  it('finds the class of a generic class\'s method, whose node spells its constraints', async () => {
    const code = `unit Unit1;

interface

type
  TBox<T: class> = class
  public
    procedure Clear;
    procedure Reset;
  end;

  TOther = class
  public
    procedure Clear;
    procedure Reset;
  end;

implementation

procedure TOther.Clear; begin end;
procedure TOther.Reset; begin end;
procedure TBox<T>.Clear; begin end;

procedure TBox<T>.Reset;
begin
  Clear;
end;

end.
`;
    await withIndex({ 'Unit1.pas': code }, (cg) => {
      const reset = cg.getNodesByKind('method').filter((n) => n.name === 'Reset');
      const targets = reset.flatMap((r) => cg.getOutgoingEdges(r.id).filter((e) => e.kind === 'calls'))
        .map((e) => cg.getNode(e.target)?.qualifiedName);
      expect(targets).toEqual(['TBox<T: class>::Clear']);
    });
  });

  it('links a form\'s event handler named after its component, and a C library\'s function', async () => {
    const code = `unit Unit1;

interface

type
  TNotify = procedure(Sender: TObject) of object;

  TButton = class
  public
    OnClick: TNotify;
  end;

  TForm1 = class
  private
    btnOK: TButton;
  public
    procedure btnOKClick(Sender: TObject);
    procedure Setup;
    function Check: Integer;
  end;

function ERR_get_error: Cardinal; cdecl;
function mach_absolute_time: UInt64; cdecl;

implementation

function ERR_get_error: Cardinal; cdecl;
begin
  Result := 0;
end;

function mach_absolute_time: UInt64; cdecl;
begin
  Result := 0;
end;

procedure TForm1.btnOKClick(Sender: TObject);
begin
end;

procedure TForm1.Setup;
begin
  btnOK.OnClick := btnOKClick;
end;

function TForm1.Check: Integer;
begin
  Result := ERR_get_error + mach_absolute_time;
end;

end.
`;
    await withIndex({ 'Unit1.pas': code }, (cg) => {
      expect(edgesFrom(cg, 'TForm1::Setup')).toEqual(['references TForm1::btnOKClick']);
      expect(edgesFrom(cg, 'TForm1::Check')).toEqual(['calls ERR_get_error', 'calls mach_absolute_time']);
    });
  });

  it('reads an ancestor through a class the unit declares ahead (`TBase = class;`)', async () => {
    const code = `unit Unit1;

interface

type
  TChild = class;

  TBase = class
  public
    function Ready: Boolean;
  end;

  TChild = class(TBase)
  public
    procedure Run;
  end;

implementation

function TBase.Ready: Boolean;
begin
  Result := True;
end;

procedure TChild.Run;
begin
  if Ready then
    Exit;
end;

end.
`;
    await withIndex({ 'Unit1.pas': code }, (cg) => {
      expect(edgesFrom(cg, 'TChild::Run')).toEqual(['calls TBase::Ready']);
    });
  });

  it('links the calls of a unit\'s initialization and finalization sections', async () => {
    const code = `unit Unit1;

interface

procedure Setup;
procedure Teardown;

implementation

procedure Setup;
begin
end;

procedure Teardown;
begin
end;

initialization
  Setup;

finalization
  Teardown;

end.
`;
    await withIndex({ 'Unit1.pas': code }, (cg) => {
      const file = cg.getNodesByKind('file').find((n) => n.filePath.endsWith('Unit1.pas'))!;
      const targets = cg.getOutgoingEdges(file.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)?.name).sort();
      expect(targets).toEqual(['Setup', 'Teardown']);
    });
  });

  it('takes a name the class\'s code assigns or passes to Inc for a variable, as Delphi does', async () => {
    // `Run` is a field of a base class the project doesn't have (a VCL
    // highlighter's, say): the unit's `Run` function is not what it reads.
    const helpers = `unit Helpers;

interface

function Run: Integer;
function Limit: Integer;

implementation

function Run: Integer; begin Result := 0; end;
function Limit: Integer; begin Result := 0; end;

end.
`;
    const main = `unit Main;

interface

uses Helpers;

type
  TMyHighlighter = class(TSynCustomHighlighter)
  public
    procedure Next;
    procedure Reset;
    function Count: Integer;
  end;

implementation

procedure TMyHighlighter.Next;
var
  C: Char;
begin
  Inc(Run);
  C := FLine[Run];
  if Limit > 0 then
    Exit;
end;

procedure TMyHighlighter.Reset;
begin
  Limit := 0;
end;

function TMyHighlighter.Count: Integer;
begin
  Count := Run;
end;

end.
`;
    await withIndex({ 'Helpers.pas': helpers, 'Main.pas': main }, (cg) => {
      expect(edgesFrom(cg, 'TMyHighlighter::Next')).toEqual([]);
      expect(edgesFrom(cg, 'TMyHighlighter::Count')).toEqual([]);
    });
  });

  it('leaves out names a routine declares itself, even where a method shares the name', async () => {
    const code = `unit Unit1;

interface

type
  TMin = class
  public
    function Value: Integer;
    function Items: Integer;
    procedure Run(Value: Integer);
  end;

implementation

function TMin.Value: Integer; begin Result := 1; end;
function TMin.Items: Integer; begin Result := 1; end;

procedure TMin.Run(Value: Integer);
var
  X: Integer;
begin
  X := Value;
  for var Items in [1, 2] do
    X := X + Items;
end;

end.
`;
    await withIndex({ 'Unit1.pas': code }, (cg) => {
      expect(edgesFrom(cg, 'TMin::Run')).toEqual([]);
    });
  });
});
