import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Pascal reference boundaries', () => {
  let directory: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pascal-boundaries-')); });
  afterEach(() => {
    graph?.close();
    graph = undefined;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  async function index(source: string): Promise<void> {
    fs.writeFileSync(path.join(directory, 'Main.pas'), source);
    graph = await CodeGraph.init(directory, { index: true });
  }
  function dependencies(caller: string): string[] {
    const node = graph!.getNodesByKind('method').concat(graph!.getNodesByKind('function')).find(n => n.name === caller)!;
    return [...new Set(graph!.getOutgoingEdges(node.id).filter(e => e.kind === 'calls' || e.kind === 'references')
      .map(e => `${e.kind}:${graph!.getNode(e.target)!.qualifiedName}`))].sort();
  }

  it('keeps calls to overloaded methods on their declared receiver', async () => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('Run')).toEqual(['calls:TLog::Add']);
  });

  it.each([
    ['argument constructor', 'constructor Create(I: Integer);', 'constructor TBuilder.Create(I: Integer); begin end;', 'TBuilder.Create(1).Build;'],
    ['inherited constructor', '', '', 'TBuilder.Create().Build;'],
  ])('keeps the constructed receiver type for an %s', async (_name, declaration, implementation, call) => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('Run')).toContain('calls:TBuilder::Build');
    expect(dependencies('Run')).not.toContain('calls:TDecoy::Build');
  });

  it.each([
    ['plain', 'FPanel.Series.GetCount'],
    ['address-of', '@FPanel.Series.GetCount'],
  ])('evaluates intermediate receivers in a %s method-pointer assignment', async (_name, rhs) => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('Wire')).toEqual(['calls:TPanel::Series', 'references:TSeries::GetCount']);
  });

  it('references procedure handlers even when the event type is external', async () => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('Wire')).toEqual(['references:TController::HandleClick']);
  });

  it('calls a factory that returns a callback instead of referencing the factory', async () => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('Wire')).toEqual(['calls:TFactory::MakeHandler']);
  });

  it.each([
    ['else', 'if Ready then Callback := FProvider.Value else Callback := nil;'],
    ['end', 'Callback := FProvider.Value'],
  ])('references a handler before %s without a semicolon', async (_name, body) => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('Wire')).toEqual(['references:TProvider::Value']);
  });

  it('resolves chains through a forward-declared class', async () => {
    await index(`unit Main;
interface
type
 TModel = class;
 TPanel = class Model: TModel; end;
 TModel = class procedure Recalc; end;
implementation
procedure TModel.Recalc; begin end;
procedure Run(Panel: TPanel); begin Panel.Model.Recalc; end;
end.`);
    expect(dependencies('Run')).toEqual(['calls:TModel::Recalc']);
  });

  it('records a parameterless Self method used as a root receiver', async () => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('Run')).toEqual(['calls:TConsumer::ActivePanel', 'calls:TPanel::Refresh']);
  });

  it('resolves a global receiver imported from another unit', async () => {
    fs.writeFileSync(path.join(directory, 'Globals.pas'), `unit Globals;
interface
type
 TPanel = class procedure Refresh; end;
 TApplication = class Panel: TPanel; end;
var MainForm: TApplication;
implementation
procedure TPanel.Refresh; begin end;
end.`);
    await index(`unit Main;
interface
uses Globals;
implementation
procedure Run; begin MainForm.Panel.Refresh; end;
end.`);
    expect(dependencies('Run')).toEqual(['calls:TPanel::Refresh']);
  });

  it('resolves unit-qualified class receivers', async () => {
    fs.writeFileSync(path.join(directory, 'Builders.pas'), `unit Builders;
interface
type TBuilder = class procedure Build; end;
implementation
procedure TBuilder.Build; begin end;
end.`);
    await index(`unit Main;
interface
uses Builders;
implementation
procedure Run; begin Builders.TBuilder.Create().Build; end;
end.`);
    expect(dependencies('Run')).toEqual(['calls:TBuilder::Build']);
  });

  it('does not use a field type when an inline local shadows that field', async () => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('UseLocal')).toEqual(['calls:TLocal::Run']);
  });

  it('keeps typed as-cast receiver calls', async () => {
    await index(`unit Main;
interface
type TPanel = class procedure Refresh; end;
implementation
procedure TPanel.Refresh; begin end;
procedure Run(Sender: TObject); begin (Sender as TPanel).Refresh; end;
end.`);
    expect(dependencies('Run')).toEqual(['calls:TPanel::Refresh']);
  });

  it('keeps calls on indexed receivers', async () => {
    await index(`unit Main;
interface
type TPanel = class procedure Refresh; end;
implementation
procedure TPanel.Refresh; begin end;
procedure Run; var Panels: array of TPanel; begin Panels[0].Refresh; end;
end.`);
    expect(dependencies('Run')).toEqual(['calls:TPanel::Refresh']);
  });

  it('does not bind an external receiver to an unrelated same-named method', async () => {
    await index(`unit Main;
interface
uses System.Classes;
type TDecoy = class procedure Clear; end;
implementation
procedure TDecoy.Clear; begin end;
procedure Run(List: TStringList); begin List.Clear; end;
end.`);
    expect(dependencies('Run')).toEqual([]);
  });

  it.each([
    ['after nested declaration', 'var Receiver: TLocal;', 'calls:TLocal::Run'],
    ['nested local does not escape', '', 'calls:TField::Run'],
  ])('scopes locals when a %s exists', async (_name, locals, expected) => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('UseLocal')).toEqual([expected]);
  });

  it('does not infer field types from unrelated method parameters', async () => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('Evaluate')).toEqual(['calls:TProvider::Value']);
  });

  it('does not turn a field hiding an inherited method into a call', async () => {
    await index(`unit Main;
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
end.`);
    expect(dependencies('Evaluate')).toEqual([]);
  });
});
