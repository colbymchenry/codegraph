import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Pascal receiver scope in call resolution', () => {
  let directory: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pascal-receiver-scope-')); });
  afterEach(() => {
    graph?.close();
    graph = undefined;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  async function index(files: Record<string, string>): Promise<void> {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
    graph = await CodeGraph.init(directory, { index: true });
  }
  function calls(caller: string): string[] {
    const node = graph!.getNodesByKind('method').concat(graph!.getNodesByKind('function'))
      .find(n => n.qualifiedName === caller);
    if (!node) throw new Error(`missing node ${caller}`);
    return [...new Set(graph!.getOutgoingEdges(node.id).filter(e => e.kind === 'calls')
      .map(e => graph!.getNode(e.target)!.qualifiedName))].sort();
  }

  const logger = `unit Logger;
interface
type TLogger = class procedure Write(const S: string); end;
implementation
procedure TLogger.Write(const S: string); begin end;
end.`;

  it('keeps a field named like a unit as the receiver', async () => {
    await index({
      'Logger.pas': logger,
      'App.pas': `unit App;
interface
uses Logger;
type TApp = class
  Logger: TLogger;
  procedure Run;
 end;
implementation
procedure TApp.Run; begin Logger.Write('x'); end;
end.`,
    });
    expect(calls('TApp::Run')).toEqual(['TLogger::Write']);
  });

  it('keeps a local named like a unit as the receiver', async () => {
    await index({
      'Logger.pas': logger,
      'App.pas': `unit App;
interface
uses Logger;
implementation
procedure Run; var Logger: TLogger; begin Logger.Write('x'); end;
end.`,
    });
    expect(calls('Run')).toEqual(['TLogger::Write']);
  });

  it('still reads a unit-qualified routine receiver', async () => {
    await index({
      'Logger.pas': logger,
      'App.pas': `unit App;
interface
uses Logger;
implementation
procedure Run; begin Logger.TLogger.Create.Write('x'); end;
end.`,
    });
    expect(calls('Run')).toEqual(['TLogger::Write']);
  });

  const panels = `unit Panels;
interface
type
 TPanel = class procedure Clear; procedure Refresh; end;
 TPanels = class
 private
  function GetItem(I: Integer): TPanel;
 public
  property Items[I: Integer]: TPanel read GetItem; default;
  procedure Clear;
 end;
 TPanelArray = array of TPanel;
implementation
procedure TPanel.Clear; begin end;
procedure TPanel.Refresh; begin end;
function TPanels.GetItem(I: Integer): TPanel; begin Result := nil; end;
procedure TPanels.Clear; begin end;
end.`;

  it.each([
    ['a default indexed property container parameter', 'procedure Run(Panels: TPanels); begin Panels[0].Clear; end;'],
    ['an array alias parameter', 'procedure Run(Panels: TPanelArray); begin Panels[0].Clear; end;'],
    ['a dynamic array local', 'procedure Run; var Panels: array of TPanel; begin Panels[0].Clear; end;'],
  ])('calls the element method through %s', async (_name, routine) => {
    await index({
      'Panels.pas': panels,
      'App.pas': `unit App;
interface
uses Panels;
implementation
${routine}
end.`,
    });
    expect(calls('Run')).toEqual(['TPanel::Clear']);
  });

  it('calls the element method through an explicit indexed property', async () => {
    await index({
      'Panels.pas': panels,
      'App.pas': `unit App;
interface
uses Panels;
type TApp = class
  FPanels: TPanels;
  procedure Run;
 end;
implementation
procedure TApp.Run; begin FPanels.Items[0].Refresh; end;
end.`,
    });
    expect(calls('TApp::Run')).toEqual(['TPanel::Refresh']);
  });

  it('follows a same-name unit alias to the class it re-exports', async () => {
    await index({
      'UnitA.pas': `unit UnitA;
interface
type TFoo = class procedure Bar; end;
implementation
procedure TFoo.Bar; begin end;
end.`,
      'UnitB.pas': `unit UnitB;
interface
uses UnitA;
type TFoo = UnitA.TFoo;
implementation
procedure Run(F: TFoo); begin F.Bar; end;
end.`,
    });
    expect(calls('Run')).toEqual(['TFoo::Bar']);
  });
});
