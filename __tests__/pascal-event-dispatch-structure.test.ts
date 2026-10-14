import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Pascal event dispatch around unusual routine structure', () => {
  let directory: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pascal-events-structure-')); });
  afterEach(() => {
    graph?.close();
    graph = undefined;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  async function index(hostImplementation: string, ownerWire: string, ownerExtra = ''): Promise<void> {
    const files: Record<string, string> = {
      'Types.pas': `unit Types;
interface
type
 TGetEvent = function: Integer of object;
 TNotify = procedure(Sender: TObject) of object;
implementation
end.`,
      'Host.pas': `unit Host;
interface
uses Types;
type
 THost = class
 private
  FGet: TGetEvent;
  FNotify: TNotify;
 public
  property OnGet: TGetEvent read FGet write FGet;
  property OnNotify: TNotify read FNotify write FNotify;
  procedure Read;
  procedure Fire;
  procedure Async;
  procedure Pointer;
 end;
implementation
${hostImplementation}
end.`,
      'Owner.pas': `unit Owner;
interface
uses Types, Host;
type
 TOwner = class
 private
  FHost: THost;
  FObj: TObject;
${ownerExtra}
 public
  function GetValue: Integer;
  procedure Click(Sender: TObject);
  procedure Wire;
 end;
implementation
function TOwner.GetValue: Integer; begin Result := 1; end;
procedure TOwner.Click(Sender: TObject); begin end;
${ownerWire}
end.`,
    };
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

  const wire = 'procedure TOwner.Wire; begin FHost.OnNotify := Click; end;';
  const plainHost = `procedure THost.Read; begin end;
procedure THost.Async; begin end;
procedure THost.Pointer; begin end;`;

  it.each([
    ['an external routine', "function MessageBoxW(Wnd: Integer; Text: PChar): Integer; stdcall; external 'user32.dll';"],
    ['a forward routine', 'procedure Later(A: Integer; B: Integer); forward;'],
    ['a class declared in the implementation section',
      'type TWorker = class(TObject) protected procedure Execute; override; end;'],
    ['a procedural type declared in the implementation section', 'type TCb = procedure of object;'],
  ])('keeps scanning later routines after %s', async (_name, header) => {
    await index(`${header}\n${plainHost}\nprocedure THost.Fire; begin FNotify(Self); end;`, wire);
    expect(calls('THost::Fire')).toEqual(['TOwner::Click']);
  });

  it('attributes a dispatch after an anonymous procedure to its own method', async () => {
    await index(`${plainHost.replace('procedure THost.Async; begin end;', '')}
procedure THost.Async; begin TThread.Queue(nil, procedure begin Pointer; end); end;
procedure THost.Fire; begin FNotify(Self); end;`, wire);
    expect(calls('THost::Fire')).toEqual(['TOwner::Click']);
    expect(calls('THost::Async')).not.toContain('TOwner::Click');
  });

  it('does not bind a cast or indexed assignment target to the owner event of the same name', async () => {
    await index(`${plainHost}\nprocedure THost.Fire; begin end;`,
      `procedure TOwner.Wire; begin THost(FObj).OnGet := GetValue; end;
procedure TOwner.ReadOwn; var V: Integer; begin V := FOwnGet; end;`,
      '  FOwnGet: TGetEvent;\n public\n  property OnGet: TGetEvent read FOwnGet write FOwnGet;\n  procedure ReadOwn;');
    expect(calls('TOwner::ReadOwn')).toEqual([]);
  });

  it('does not bind an indexed assignment target to the owner event of the same name', async () => {
    await index(`${plainHost}\nprocedure THost.Fire; begin end;`,
      `procedure TOwner.Wire; var Hosts: array of THost; begin Hosts[0].OnGet := GetValue; end;
procedure TOwner.ReadOwn; var V: Integer; begin V := FOwnGet; end;`,
      '  FOwnGet: TGetEvent;\n public\n  property OnGet: TGetEvent read FOwnGet write FOwnGet;\n  procedure ReadOwn;');
    expect(calls('TOwner::ReadOwn')).toEqual([]);
  });

  it('attributes a dispatch inside a nested routine to that routine and not to its parent', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Inner; begin FNotify(Self); end;
begin Inner; end;`, wire);
    expect(calls('THost::Fire::Inner')).toEqual(['TOwner::Click']);
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Inner']);
  });

  it('does not treat a copy into an inline procedural variable as an invocation', async () => {
    await index(`procedure THost.Read; begin end;
procedure THost.Async; begin end;
procedure THost.Fire; begin end;
procedure THost.Pointer; var P: function: Integer of object; begin P := FGet; end;`,
      'procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;');
    expect(calls('THost::Pointer')).toEqual([]);
  });
});

describe('Pascal event dispatch nested local scope', () => {
  let directory: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pascal-events-nested-')); });
  afterEach(() => {
    graph?.close();
    graph = undefined;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  const unit = (body: string): string => `unit U;
interface
type
 TGetEvent = function: Integer of object;
 TOwner = class
 private
  FGet: TGetEvent;
 public
  function GetValue: Integer;
  procedure Wire;
  procedure Read;
 end;
implementation
function TOwner.GetValue: Integer; begin Result := 1; end;
procedure TOwner.Wire; begin FGet := GetValue; end;
${body}
end.`;

  async function callsOf(body: string, caller: string): Promise<string[]> {
    fs.writeFileSync(path.join(directory, 'U.pas'), unit(body));
    graph = await CodeGraph.init(directory, { index: true });
    const node = graph.getNodesByKind('method').concat(graph.getNodesByKind('function')).find(n => n.qualifiedName === caller)!;
    return [...new Set(graph.getOutgoingEdges(node.id).filter(e => e.kind === 'calls')
      .map(e => graph!.getNode(e.target)!.qualifiedName))].sort();
  }

  it('does not link a nested routine local that shadows the owner event', async () => {
    expect(await callsOf(`procedure TOwner.Read;
  procedure Inner; var FGet: Integer; begin FGet := FGet + 1; end;
begin Inner; end;`, 'TOwner::Read::Inner')).toEqual([]);
  });

  it('still links the owner event outside the nested routine that shadows it', async () => {
    expect(await callsOf(`procedure TOwner.Read; var V: Integer;
  procedure Inner; var FGet: Integer; begin FGet := 2; end;
begin Inner; V := FGet; end;`, 'TOwner::Read')).toContain('TOwner::GetValue');
  });
});
