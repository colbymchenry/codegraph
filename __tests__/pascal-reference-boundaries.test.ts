/**
 * Where a Delphi call or method pointer stops being what its spelling says
 * (#2550): a call through a chain of members and functions
 * (`FPanel.ActiveSeries.BeginUpdate;`, `TLogger.Create.Write('x')`) is a
 * method of what the chain's links are declared to be, never a namesake; a
 * method given to a field, a local or a property whose declared type is a
 * routine type is a method pointer whatever the target is called, and so is
 * `@Obj.Method`; a routine nested in another keeps its locals to itself; and
 * a nested routine declared `forward` is in scope from that declaration.
 *
 * The cases in the first two blocks are ported from @OleksiyPenkov's tests
 * in #2550, which found these bugs.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

let directory: string;
let graph: CodeGraph | undefined;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-boundaries-'));
});
afterEach(() => {
  graph?.close();
  graph = undefined;
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  graph = await CodeGraph.init(directory, { index: true });
  return graph;
}

function routine(qualifiedName: string) {
  const node = graph!.getNodesByKind('method').concat(graph!.getNodesByKind('function')).find((n) => n.qualifiedName === qualifiedName);
  expect(node, qualifiedName).toBeDefined();
  return node!;
}

/** The calls and references a routine makes, as `kind:Target`, once each. */
function dependencies(qualifiedName: string): string[] {
  return [...new Set(graph!.getOutgoingEdges(routine(qualifiedName).id)
    .filter((e) => e.kind === 'calls' || e.kind === 'references')
    .map((e) => `${e.kind}:${graph!.getNode(e.target)!.qualifiedName}`))].sort();
}

/** The routines that call a method, by name, once each. */
function callerNamesOf(qualifiedName: string): string[] {
  const target = graph!.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
  if (!target) return [];
  return [...new Set(graph!.getIncomingEdges(target.id).filter((e) => e.kind === 'calls')
    .map((e) => graph!.getNode(e.source)?.name).filter((n): n is string => !!n))].sort();
}

describe('Pascal reference boundaries (#2550)', () => {
  it('keeps calls to overloaded methods on their declared receiver', async () => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TLog = class
  procedure Add(const S: string); overload;
  procedure Add(I: Integer); overload;
 end;
implementation
procedure TLog.Add(const S: string); begin end;
procedure TLog.Add(I: Integer); begin end;
procedure Run(Log: TLog); begin Log.Add('x'); end;
end.` });
    expect(dependencies('Run')).toEqual(['calls:TLog::Add']);
  });

  it.each([
    ['argument constructor', 'constructor Create(I: Integer);', 'constructor TBuilder.Create(I: Integer); begin end;', 'TBuilder.Create(1).Build;'],
    ['inherited constructor', '', '', 'TBuilder.Create().Build;'],
  ])('keeps the constructed receiver type for an %s', async (_name, declaration, implementation, call) => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TBuilder = class(TObject)
  ${declaration}
  procedure Build;
 end;
 TDecoy = class procedure Build; end;
implementation
 ${implementation}
procedure TBuilder.Build; begin end;
procedure TDecoy.Build; begin end;
procedure Run; begin ${call} end;
end.` });
    expect(dependencies('Run')).toContain('calls:TBuilder::Build');
    expect(dependencies('Run')).not.toContain('calls:TDecoy::Build');
  });

  it.each([
    ['plain', 'FPanel.Series.GetCount'],
    ['address-of', '@FPanel.Series.GetCount'],
  ])('evaluates intermediate receivers in a %s method-pointer assignment', async (_name, rhs) => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TGet = function: Integer of object;
 TSeries = class function GetCount: Integer; end;
 TPanel = class function Series: TSeries; end;
 TConsumer = class
  FPanel: TPanel;
  Callback: TGet;
  procedure Wire;
 end;
implementation
function TSeries.GetCount: Integer; begin Result := 1; end;
function TPanel.Series: TSeries; begin Result := nil; end;
procedure TConsumer.Wire; begin Callback := ${rhs}; end;
end.` });
    expect(dependencies('TConsumer::Wire')).toEqual(['calls:TPanel::Series', 'references:TSeries::GetCount']);
  });

  it('references procedure handlers even when the event type is external', async () => {
    await index({ 'Main.pas': `unit Main;
interface
uses System.Classes;
type
 TController = class procedure HandleClick(Sender: TObject); end;
 TConsumer = class
  FController: TController;
  Callback: TNotifyEvent;
  procedure Wire;
 end;
implementation
procedure TController.HandleClick(Sender: TObject); begin end;
procedure TConsumer.Wire; begin Callback := FController.HandleClick; end;
end.` });
    expect(dependencies('TConsumer::Wire')).toEqual(['references:TController::HandleClick']);
  });

  it('calls a factory that returns a callback instead of referencing the factory', async () => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TGet = function: Integer of object;
 TFactory = class function MakeHandler: TGet; end;
 TConsumer = class
  FFactory: TFactory;
  Callback: TGet;
  procedure Wire;
 end;
implementation
function TFactory.MakeHandler: TGet; begin Result := nil; end;
procedure TConsumer.Wire; begin Callback := FFactory.MakeHandler; end;
end.` });
    expect(dependencies('TConsumer::Wire')).toEqual(['calls:TFactory::MakeHandler']);
  });

  it.each([
    ['else', 'if Ready then Callback := FProvider.Value else Callback := nil;'],
    ['end', 'Callback := FProvider.Value'],
  ])('references a handler before %s without a semicolon', async (_name, body) => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TGet = function: Integer of object;
 TProvider = class function Value: Integer; end;
 TConsumer = class
  FProvider: TProvider;
  Callback: TGet;
  Ready: Boolean;
  procedure Wire;
 end;
implementation
function TProvider.Value: Integer; begin Result := 1; end;
procedure TConsumer.Wire; begin ${body} end;
end.` });
    expect(dependencies('TConsumer::Wire')).toEqual(['references:TProvider::Value']);
  });

  it('resolves chains through a forward-declared class', async () => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TModel = class;
 TPanel = class Model: TModel; end;
 TModel = class procedure Recalc; end;
implementation
procedure TModel.Recalc; begin end;
procedure Run(Panel: TPanel); begin Panel.Model.Recalc; end;
end.` });
    expect(dependencies('Run')).toEqual(['calls:TModel::Recalc']);
  });

  it('records a parameterless Self method used as a root receiver', async () => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TPanel = class procedure Refresh; end;
 TConsumer = class
  function ActivePanel: TPanel;
  procedure Run;
 end;
implementation
procedure TPanel.Refresh; begin end;
function TConsumer.ActivePanel: TPanel; begin Result := nil; end;
procedure TConsumer.Run; begin ActivePanel.Refresh; end;
end.` });
    expect(dependencies('TConsumer::Run')).toEqual(['calls:TConsumer::ActivePanel', 'calls:TPanel::Refresh']);
  });

  it('resolves a global receiver imported from another unit', async () => {
    await index({
      'Globals.pas': `unit Globals;
interface
type
 TPanel = class procedure Refresh; end;
 TApplication = class Panel: TPanel; end;
var MainForm: TApplication;
implementation
procedure TPanel.Refresh; begin end;
end.`,
      'Main.pas': `unit Main;
interface
uses Globals;
implementation
procedure Run; begin MainForm.Panel.Refresh; end;
end.`,
    });
    expect(dependencies('Run')).toEqual(['calls:TPanel::Refresh']);
  });

  it('resolves unit-qualified class receivers', async () => {
    await index({
      'Builders.pas': `unit Builders;
interface
type TBuilder = class procedure Build; end;
implementation
procedure TBuilder.Build; begin end;
end.`,
      'Main.pas': `unit Main;
interface
uses Builders;
implementation
procedure Run; begin Builders.TBuilder.Create().Build; end;
end.`,
    });
    expect(dependencies('Run')).toEqual(['calls:TBuilder::Build']);
  });

  it('does not use a field type when an inline local shadows that field', async () => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TField = class procedure Run; end;
 TLocal = class procedure Run; end;
 TConsumer = class
  Receiver: TField;
  procedure UseLocal;
 end;
implementation
procedure TField.Run; begin end;
procedure TLocal.Run; begin end;
procedure TConsumer.UseLocal;
begin
 var Receiver: TLocal;
 Receiver.Run;
end;
end.` });
    expect(dependencies('TConsumer::UseLocal')).toEqual(['calls:TLocal::Run']);
  });

  it('keeps typed as-cast receiver calls', async () => {
    await index({ 'Main.pas': `unit Main;
interface
type TPanel = class procedure Refresh; end;
implementation
procedure TPanel.Refresh; begin end;
procedure Run(Sender: TObject); begin (Sender as TPanel).Refresh; end;
end.` });
    expect(dependencies('Run')).toEqual(['calls:TPanel::Refresh']);
  });

  it('keeps calls on indexed receivers', async () => {
    await index({ 'Main.pas': `unit Main;
interface
type TPanel = class procedure Refresh; end;
implementation
procedure TPanel.Refresh; begin end;
procedure Run; var Panels: array of TPanel; begin Panels[0].Refresh; end;
end.` });
    expect(dependencies('Run')).toEqual(['calls:TPanel::Refresh']);
  });

  it('does not bind an external receiver to an unrelated same-named method', async () => {
    await index({ 'Main.pas': `unit Main;
interface
uses System.Classes;
type TDecoy = class procedure Clear; end;
implementation
procedure TDecoy.Clear; begin end;
procedure Run(List: TStringList); begin List.Clear; end;
end.` });
    expect(dependencies('Run')).toEqual([]);
  });

  it.each([
    ['after nested declaration', 'var Receiver: TLocal;', 'calls:TLocal::Run'],
    ['nested local does not escape', '', 'calls:TField::Run'],
  ])('scopes locals when a %s exists', async (_name, locals, expected) => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TField = class procedure Run; end;
 TLocal = class procedure Run; end;
 TConsumer = class Receiver: TField; procedure UseLocal; end;
implementation
procedure TField.Run; begin end;
procedure TLocal.Run; begin end;
procedure TConsumer.UseLocal;
 procedure Inner;
 var Receiver: TLocal;
 begin end;
 ${locals}
begin Receiver.Run; end;
end.` });
    expect(dependencies('TConsumer::UseLocal')).toEqual([expected]);
  });

  it('does not infer field types from unrelated method parameters', async () => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TGet = function: Integer of object;
 TProvider = class function Value: Integer; end;
 TDecoy = class function Value: Integer; end;
 TConsumer = class
  procedure Other(FProvider: TDecoy; Callback: TGet);
  FProvider: TProvider;
  Callback: Integer;
  procedure Evaluate;
 end;
implementation
function TProvider.Value: Integer; begin Result := 1; end;
function TDecoy.Value: Integer; begin Result := 2; end;
procedure TConsumer.Other(FProvider: TDecoy; Callback: TGet); begin end;
procedure TConsumer.Evaluate; begin Callback := FProvider.Value; end;
end.` });
    expect(dependencies('TConsumer::Evaluate')).toEqual(['calls:TProvider::Value']);
  });

  it('does not turn a field hiding an inherited method into a call', async () => {
    await index({ 'Main.pas': `unit Main;
interface
type
 TBase = class function Visible: Boolean; end;
 TSeries = class(TBase) Visible: Boolean; end;
 TConsumer = class
  Series: TSeries;
  function Evaluate: Boolean;
 end;
implementation
function TBase.Visible: Boolean; begin Result := True; end;
function TConsumer.Evaluate: Boolean; begin Result := Series.Visible; end;
end.` });
    expect(dependencies('TConsumer::Evaluate')).toEqual([]);
  });
});

describe('Pascal calls without parentheses, from #2550\'s resolution cases', () => {
  it('extracts paren-less method calls inside expressions', async () => {
    await index({ 'UnitA.pas': `unit UnitA;
interface
type
  TProvider = class
  public
    function Value: Integer;
    function ValueParens(): Integer;
  public
    Count: Integer;
    property Total: Integer read Value;
  end;
  TConsumer = class
  private
    FProvider: TProvider;
  public
    function UseNoParens: Integer;
    function UseParens: Integer;
    function UseFieldRead: Integer;
  end;
implementation
function TProvider.Value: Integer; begin Result := 1; end;
function TProvider.ValueParens(): Integer; begin Result := 2; end;
function TConsumer.UseNoParens: Integer;
begin
  Result := FProvider.Value + 1;
end;
function TConsumer.UseParens: Integer;
begin
  Result := FProvider.ValueParens() + 1;
end;
function TConsumer.UseFieldRead: Integer;
begin
  Result := FProvider.Count + FProvider.Total;
end;
end.
` });
    expect(callerNamesOf('TProvider::ValueParens')).toEqual(['UseParens']);
    // Reading the field `Count` or the property `Total` draws no call.
    expect(callerNamesOf('TProvider::Value')).toEqual(['UseNoParens']);
    expect(graph!.getOutgoingEdges(routine('TConsumer::UseFieldRead').id).filter((e) => e.kind === 'calls')).toEqual([]);
  });

  it('records each method evaluated in an instance receiver chain', async () => {
    await index({ 'Chain.pas': `unit Chain;
interface
type
  TSeries = class
    Visible: Boolean;
    procedure BeginUpdate;
  end;
  TPanel = class
    function ActiveModelSeries: TSeries;
  end;
  TConsumer = class
    FProjectPanel: TPanel;
    procedure UseStatement;
    procedure UseExplicit;
    function UseCondition: Boolean;
    function UseAssignment: TSeries;
  end;
  TDecoy = class
    function Visible: Boolean;
    procedure BeginUpdate;
  end;
implementation
procedure TSeries.BeginUpdate; begin end;
function TPanel.ActiveModelSeries: TSeries; begin Result := nil; end;
procedure TConsumer.UseStatement;
begin FProjectPanel.ActiveModelSeries.BeginUpdate; end;
procedure TConsumer.UseExplicit;
begin FProjectPanel.ActiveModelSeries().BeginUpdate(); end;
function TConsumer.UseCondition: Boolean;
begin
  if FProjectPanel.ActiveModelSeries.Visible then Result := True;
end;
function TConsumer.UseAssignment: TSeries;
begin Result := FProjectPanel.ActiveModelSeries; end;
function TDecoy.Visible: Boolean; begin Result := False; end;
procedure TDecoy.BeginUpdate; begin end;
end.` });
    expect(callerNamesOf('TPanel::ActiveModelSeries')).toEqual(['UseAssignment', 'UseCondition', 'UseExplicit', 'UseStatement']);
    expect(callerNamesOf('TSeries::BeginUpdate')).toEqual(['UseExplicit', 'UseStatement']);
    expect(callerNamesOf('TDecoy::BeginUpdate')).toEqual([]);
    expect(callerNamesOf('TDecoy::Visible')).toEqual([]);
  });

  it('distinguishes method-pointer assignments from evaluated function results', async () => {
    await index({
      'Provider.pas': `unit Provider;
interface
type
  TGetIntEvent = function: Integer of object;
  TEventAlias = TGetIntEvent;
  TProvider = class
    function Value: Integer;
  end;
  TEvents = class
    FOnGet: TEventAlias;
    property OnGet: TEventAlias read FOnGet write FOnGet;
  end;
implementation
function TProvider.Value: Integer; begin Result := 1; end;
end.`,
      'Consumer.pas': `unit Consumer;
interface
uses Provider;
type
  TConsumer = class
    FProvider: TProvider;
    FEvents: TEvents;
    FOnGet: TGetIntEvent;
    procedure Wire;
    function Evaluate: Integer;
    property OnGet: TGetIntEvent read FOnGet write FOnGet;
  end;
implementation
procedure TConsumer.Wire;
var Callback: TEventAlias;
begin
  OnGet :=
    FProvider.Value;
  FOnGet := FProvider.Value;
  FEvents.OnGet := FProvider.Value;
  Callback := FProvider.Value;
end;
function TConsumer.Evaluate: Integer;
var Number: Integer;
begin
  Number := FProvider.Value;
  Result := FProvider.Value;
end;
end.`,
    });
    const value = routine('TProvider::Value');
    const wire = graph!.getOutgoingEdges(routine('TConsumer::Wire').id).filter((e) => e.target === value.id);
    const evaluate = graph!.getOutgoingEdges(routine('TConsumer::Evaluate').id).filter((e) => e.target === value.id);
    expect(wire.filter((e) => e.kind === 'calls')).toEqual([]);
    expect(wire.filter((e) => e.kind === 'references').map((e) => e.line).sort((a, b) => a! - b!)).toEqual([18, 19, 20, 21]);
    expect(evaluate.filter((e) => e.kind === 'calls').map((e) => e.line).sort((a, b) => a! - b!)).toEqual([26, 27]);
  });
});

/** The edges a routine makes, as `line kind:Target`, in line order. */
function edgesByLine(qualifiedName: string): string[] {
  return graph!.getOutgoingEdges(routine(qualifiedName).id)
    .filter((e) => e.kind === 'calls' || e.kind === 'references')
    .map((e) => `${e.line} ${e.kind}:${graph!.getNode(e.target)!.qualifiedName}`)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

describe('Delphi chains, method pointers, nested scopes and forward routines (#2550)', () => {
  it('calls the method of what a constructor makes, the class\'s own or inherited', async () => {
    await index({ 'Wire.pas': `unit Wire;
interface
type
 TLogger2 = class procedure Emit(const S: string); procedure Write(const S: string); end;
 TBuilder = class constructor Make(N: Integer); procedure Build; end;
 TDecoy = class procedure Emit(const S: string); procedure Write(const S: string); procedure Build; end;
 TWirer = class procedure CallEmit; end;
implementation
procedure TLogger2.Emit(const S: string); begin end;
procedure TLogger2.Write(const S: string); begin end;
constructor TBuilder.Make(N: Integer); begin end;
procedure TBuilder.Build; begin end;
procedure TDecoy.Emit(const S: string); begin end;
procedure TDecoy.Write(const S: string); begin end;
procedure TDecoy.Build; begin end;
procedure TWirer.CallEmit;
begin
  TLogger2.Create.Emit('x');
  TLogger2.Create.Write('y');
  TBuilder.Make(1).Build;
end;
end.` });
    expect(edgesByLine('TWirer::CallEmit')).toEqual([
      '18 calls:TLogger2::Emit', '19 calls:TLogger2::Write', '20 calls:TBuilder::Build', '20 calls:TBuilder::Make',
    ]);
  });

  it('reads a class its unit\'s name qualifies, through its constructor', async () => {
    await index({
      'Logger.pas': `unit Logger;
interface
type TLogger = class procedure Write(const S: string); end;
implementation
procedure TLogger.Write(const S: string); begin end;
end.`,
      'Scope.pas': `unit Scope;
interface
uses Logger;
implementation
procedure RunLog; begin Logger.TLogger.Create.Write('x'); end;
procedure RunLog2; begin Logger.TLogger.Create().Write('x'); end;
end.`,
    });
    expect(dependencies('RunLog')).toEqual(['calls:TLogger::Write']);
    expect(dependencies('RunLog2')).toEqual(['calls:TLogger::Write']);
  });

  it('reads a routine a dotted unit name qualifies', async () => {
    await index({
      'My.Core.Utils.pas': `unit My.Core.Utils;
interface
function Helper(N: Integer): Integer;
procedure Reset;
implementation
function Helper(N: Integer): Integer; begin Result := N; end;
procedure Reset; begin end;
end.`,
      'App.pas': `unit App;
interface
uses My.Core.Utils;
implementation
procedure Run;
var X: Integer;
begin
  X := My.Core.Utils.Helper(1);
  My.Core.Utils.Reset;
end;
end.`,
    });
    expect(dependencies('Run')).toEqual(['calls:Helper', 'calls:Reset']);
  });

  it('links no namesake for a chain through a type from outside the project', async () => {
    await index({ 'Main.pas': `unit Main;
interface
uses Vcl.ExtCtrls;
type
 TDecoy = class procedure Clear; procedure Refresh(N: Integer); end;
 TOwner = class
  FPanel: TPanel;
  procedure Run;
 end;
implementation
procedure TDecoy.Clear; begin end;
procedure TDecoy.Refresh(N: Integer); begin end;
procedure TOwner.Run;
begin
  FPanel.Controls.Clear;
  FPanel.Parent.Refresh(1);
end;
end.` });
    expect(dependencies('TOwner::Run')).toEqual([]);
  });

  it('gives a method pointer to a local of a routine type, named, aliased or written out', async () => {
    await index({ 'Wire.pas': `unit Wire;
interface
type
 TGet = function: Integer of object;
 TGetAlias = TGet;
 TProvider = class function Value: Integer; end;
 TWirer = class
  FProvider: TProvider;
  procedure Locals;
 end;
implementation
function TProvider.Value: Integer; begin Result := 1; end;
procedure TWirer.Locals;
var
  Named: TGet;
  Aliased: TGetAlias;
  Written: function: Integer of object;
  Closure: reference to function: Integer;
  Number: Integer;
begin
  Named := FProvider.Value;
  Aliased := FProvider.Value;
  Written := FProvider.Value;
  Closure := FProvider.Value;
  Number := FProvider.Value;
end;
end.` });
    expect(edgesByLine('TWirer::Locals')).toEqual([
      '21 references:TProvider::Value', '22 references:TProvider::Value', '23 references:TProvider::Value',
      '24 references:TProvider::Value', '25 calls:TProvider::Value',
    ]);
  });

  it('takes `@Obj.Method` for a method pointer, whatever it is given to', async () => {
    await index({ 'Wire.pas': `unit Wire;
interface
type
 TGet = function: Integer of object;
 TProvider = class function Value: Integer; end;
 TWirer = class
  FProvider: TProvider;
  Callback: TGet;
  FOnGet: TGet;
  function Own: Integer;
  procedure AtOnNamed;
  procedure AtCallback;
  procedure AtBareOwn;
 end;
implementation
function TProvider.Value: Integer; begin Result := 1; end;
function TWirer.Own: Integer; begin Result := 2; end;
procedure TWirer.AtOnNamed; begin FOnGet := @FProvider.Value; end;
procedure TWirer.AtCallback; begin Callback := @FProvider.Value; end;
procedure TWirer.AtBareOwn; begin Callback := @Own; end;
end.` });
    expect(dependencies('TWirer::AtOnNamed')).toEqual(['references:TProvider::Value']);
    expect(dependencies('TWirer::AtCallback')).toEqual(['references:TProvider::Value']);
    expect(dependencies('TWirer::AtBareOwn')).toEqual(['references:TWirer::Own']);
  });

  it('calls a function given to a target named like an event that holds data', async () => {
    await index({ 'Wire.pas': `unit Wire;
interface
type
 TProvider = class function Value: Integer; function IsTop: Boolean; end;
 TWirer = class
  FProvider: TProvider;
  FOnCount: Integer;
  FOnTop: Boolean;
  procedure Wire;
 end;
implementation
function TProvider.Value: Integer; begin Result := 1; end;
function TProvider.IsTop: Boolean; begin Result := True; end;
procedure TWirer.Wire;
begin
  FOnCount := FProvider.Value;
  FOnTop := FProvider.IsTop;
end;
end.` });
    expect(edgesByLine('TWirer::Wire')).toEqual(['16 calls:TProvider::Value', '17 calls:TProvider::IsTop']);
  });

  it('keeps a nested routine\'s locals to it, and the routine around it its own', async () => {
    await index({ 'Scope.pas': `unit Scope;
interface
type
 TField = class procedure Run; end;
 TLocal = class procedure Run; end;
 TScoped = class Receiver: TField; procedure UseLocalNested; end;
implementation
procedure TField.Run; begin end;
procedure TLocal.Run; begin end;
procedure TScoped.UseLocalNested;
 procedure Inner;
 var Receiver: TLocal;
 begin Receiver.Run; end;
begin Receiver.Run; end;
end.` });
    expect(dependencies('TScoped::UseLocalNested::Inner')).toEqual(['calls:TLocal::Run']);
    expect(dependencies('TScoped::UseLocalNested')).toEqual(['calls:TField::Run']);
  });

  it('types a receiver by the routine\'s own name list, not a nested routine\'s parameter', async () => {
    await index({ 'Docs.pas': `unit Docs;
interface
type
 TDocData = class procedure Clear; end;
 TOther = class procedure Clear; end;
 TItem = class procedure Clear; end;
 TTests = class procedure Run; end;
implementation
procedure TDocData.Clear; begin end;
procedure TOther.Clear; begin end;
procedure TItem.Clear; begin end;
procedure TTests.Run;
  procedure Check(var Item: TOther);
  begin
    Item.Clear;
  end;
var
  Item, Spare: TDocData;
begin
  Item.Clear;
  Spare.Clear;
end;
end.` });
    expect(dependencies('TTests::Run::Check')).toEqual(['calls:TOther::Clear']);
    expect(edgesByLine('TTests::Run')).toEqual(['20 calls:TDocData::Clear', '21 calls:TDocData::Clear']);
  });

  it('calls a class method through a class reference type', async () => {
    await index({ 'Meta.pas': `unit Meta;
interface
type
 TFoo = class
   class function Make(N: Integer): TFoo;
 end;
 TFooClass = class of TFoo;
 TOther = class
   class function Make(N: Integer): TOther;
 end;
procedure Run(Cls: TFooClass);
implementation
class function TFoo.Make(N: Integer): TFoo; begin Result := nil; end;
class function TOther.Make(N: Integer): TOther; begin Result := nil; end;
procedure Run(Cls: TFooClass);
begin
  Cls.Make(1);
end;
end.` });
    expect(dependencies('Run')).toEqual(['calls:TFoo::Make']);
  });

  it('reads no other routine\'s name list for a receiver', async () => {
    await index({ 'Mongo.pas': `unit Mongo;
interface
type
  RawUtf8 = type AnsiString;
  TMongoDatabase = class
    procedure RunCommand(const Cmd: string);
  end;
  TMongoRequest = class
    constructor Create(const Database, Collection: RawUtf8);
  end;
  TMongoCollection = class
    function GetDatabase: TMongoDatabase;
    property Database: TMongoDatabase read GetDatabase;
    procedure Aggregate;
  end;
implementation
procedure TMongoDatabase.RunCommand(const Cmd: string); begin end;
constructor TMongoRequest.Create(const Database, Collection: RawUtf8); begin end;
function TMongoCollection.GetDatabase: TMongoDatabase; begin Result := nil; end;
procedure TMongoCollection.Aggregate;
begin
  Database.RunCommand('x');
end;
end.` });
    expect(dependencies('TMongoCollection::Aggregate')).toEqual(['calls:TMongoDatabase::RunCommand']);
  });

  it('calls the record\'s method through a pointer to it, declared alone or in a name list', async () => {
    await index({ 'Ptr.pas': `unit Ptr;
interface
type
  PBigInt = ^TBigInt;
  TBigInt = record
    procedure RightShift(N: Integer);
  end;
  TOther = class
    procedure RightShift(N: Integer);
  end;
procedure Single(q: PBigInt);
procedure Listed;
implementation
procedure TBigInt.RightShift(N: Integer); begin end;
procedure TOther.RightShift(N: Integer); begin end;
procedure Single(q: PBigInt);
begin
  q.RightShift(2);
end;
procedure Listed;
var
  q, r1: PBigInt;
begin
  q.RightShift(2);
end;
end.` });
    expect(dependencies('Single')).toEqual(['calls:TBigInt::RightShift']);
    expect(dependencies('Listed')).toEqual(['calls:TBigInt::RightShift']);
  });

  it('reads a chain through a class reference type and an explicit dereference', async () => {
    await index({ 'Logs.pas': `unit Logs;
interface
type
  TSynLog = class
    class function Add: TSynLog;
    procedure Log(const Msg: string);
  end;
  TSynLogClass = class of TSynLog;
  ISynLogLike = interface
    procedure Log(const Msg: string);
  end;
  PBigInt = ^TBigInt;
  TBigInt = record
    function Copy: PBigInt;
    function MultiplyLow(Other: PBigInt): PBigInt;
  end;
  TDecoy = class
    function MultiplyLow(Other: Pointer): Pointer;
  end;
var
  DBLog: TSynLogClass;
procedure Run(a, b: PBigInt);
implementation
class function TSynLog.Add: TSynLog; begin Result := nil; end;
procedure TSynLog.Log(const Msg: string); begin end;
function TBigInt.Copy: PBigInt; begin Result := @Self; end;
function TBigInt.MultiplyLow(Other: PBigInt): PBigInt; begin Result := @Self; end;
function TDecoy.MultiplyLow(Other: Pointer): Pointer; begin Result := nil; end;
procedure Run(a, b: PBigInt);
begin
  DBLog.Add.Log('x');
  a^.Copy.MultiplyLow(b);
end;
end.` });
    const run = dependencies('Run');
    expect(run).toEqual(expect.arrayContaining(['calls:TSynLog::Add', 'calls:TSynLog::Log', 'calls:TBigInt::MultiplyLow']));
    expect(run).not.toContain('calls:ISynLogLike::Log');
    expect(run).not.toContain('calls:TDecoy::MultiplyLow');
  });

  it('reads a chain in a with body only from a name the routine declares', async () => {
    await index({ 'Emf.pas': `unit Emf;
interface
type
  TCanvas2 = class procedure Stroke; end;
  TEnum = class Canvas: TCanvas2; end;
  TDecoy = class procedure Stroke; end;
  TRec = record X: Integer; end;
  PRec = ^TRec;
  THost = class
    FEnum: TEnum;
    procedure Run(R: PRec; E: TEnum);
  end;
implementation
procedure TCanvas2.Stroke; begin end;
procedure TDecoy.Stroke; begin end;
procedure THost.Run(R: PRec; E: TEnum);
begin
  with R^ do
  begin
    E.Canvas.Stroke;
    FEnum.Canvas.Stroke;
  end;
end;
end.` });
    // `FEnum` may be the with object's member, which only its type could say.
    expect(edgesByLine('THost::Run')).toEqual(['20 calls:TCanvas2::Stroke']);
  });

  it('reads a chain through pointer types, which Delphi dereferences', async () => {
    await index({ 'Tree.pas': `unit Tree;
interface
type
  PNode = ^TNode;
  TNode = record
    LastChild: PNode;
    procedure SetNextSibling(Value: PNode);
  end;
  TDecoy = class
    procedure SetNextSibling(Value: Pointer);
  end;
procedure Attach(Node, Child: PNode);
implementation
procedure TNode.SetNextSibling(Value: PNode); begin end;
procedure TDecoy.SetNextSibling(Value: Pointer); begin end;
procedure Attach(Node, Child: PNode);
begin
  Node.LastChild.SetNextSibling(Child);
end;
end.` });
    expect(dependencies('Attach')).toEqual(['calls:TNode::SetNextSibling']);
  });

  it('keeps a nested routine\'s locals to it where the unit\'s tree has errors', async () => {
    // The old-style `begin … end.` initialization breaks the unit's parse,
    // so the routines' names come from the source text.
    await index({ 'Brk.pas': `unit Brk;

interface

type
  TField = class
    function Value: Integer;
  end;
  TLocal = class
    function Value: Integer;
  end;
  TScoped = class
    Receiver: TField;
    function UseLocal: Integer;
  end;

implementation

function TField.Value: Integer;
begin
  Result := 1;
end;

function TLocal.Value: Integer;
begin
  Result := 2;
end;

function TScoped.UseLocal: Integer;

  procedure Inner;
  var
    Receiver: TLocal;
  begin
    Receiver := nil;
  end;

var
  N: Integer;
begin
  N := Receiver.Value;
  Result := N;
end;

begin
end.
` });
    expect(dependencies('TScoped::UseLocal')).toEqual(['calls:TField::Value']);
  });

  it('calls a nested routine declared forward above the call', async () => {
    await index({ 'Scope.pas': `unit Scope;
interface
type
 TScoped = class procedure Fire; end;
implementation
procedure TScoped.Fire;
  procedure Late; forward;
  function Later(N: Integer;
    M: Integer): Integer; forward;
  procedure Early;
  begin
    Late;
    Later(1, 2);
  end;
  procedure Late; begin end;
  function Later(N: Integer; M: Integer): Integer; begin Result := N + M; end;
begin
  Early;
end;
end.` });
    expect(dependencies('TScoped::Fire::Early')).toEqual(['calls:TScoped::Fire::Late', 'calls:TScoped::Fire::Later']);
    expect(dependencies('TScoped::Fire')).toEqual(['calls:TScoped::Fire::Early']);
  });
});
