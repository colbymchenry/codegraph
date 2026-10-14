import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Node } from '../src/types';
import { CodeGraph } from '../src';

describe('Pascal nested routines', () => {
  let directory: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pascal-nested-routines-')); });
  afterEach(() => {
    graph?.close();
    graph = undefined;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  function write(files: Record<string, string>): void {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  }

  const host = (implementation: string): string => `unit Host;
interface
uses Types;
type
 THost = class
 private
  FNotify: TNotify;
  FGet: TGetEvent;
 public
  property OnNotify: TNotify read FNotify write FNotify;
  property OnGet: TGetEvent read FGet write FGet;
  procedure Read;
  function Next: THost;
  Peer: TDecoy;
  procedure Fire;
  procedure Async;
 end;
implementation
${implementation}
end.`;

  const owner = (wire: string, extra = ''): string => `unit Owner;
interface
uses Types, Host;
type
 TOwner = class
 private
  FHost: THost;
 public
  procedure Click(Sender: TObject);
  procedure Wire;
 end;
implementation
procedure TOwner.Click(Sender: TObject); begin end;
${extra}
${wire}
end.`;

  const plainHost = `procedure THost.Read; begin end;
procedure THost.Async; begin end;
function THost.Next: THost; begin Result := Self; end;`;
  const wire = 'procedure TOwner.Wire; begin FHost.OnNotify := Click; end;';

  const units = (hostImplementation: string, ownerWire = wire, ownerExtra = ''): Record<string, string> => ({
    'Types.pas': `unit Types;
interface
type
 TNotify = procedure(Sender: TObject) of object;
 TGetEvent = function: Integer of object;
 TDecoy = class
 public
  procedure Async;
 end;
implementation
procedure TDecoy.Async; begin end;
end.`,
    'Host.pas': host(hostImplementation),
    'Owner.pas': owner(ownerWire, ownerExtra),
  });

  async function index(hostImplementation: string, ownerWire = wire, ownerExtra = ''): Promise<void> {
    write(units(hostImplementation, ownerWire, ownerExtra));
    graph = await CodeGraph.init(directory, { index: true });
  }

  function routines(): Node[] {
    return graph!.getNodesByKind('method').concat(graph!.getNodesByKind('function'));
  }

  function find(qualifiedName: string) {
    const node = routines().find(n => n.qualifiedName === qualifiedName);
    if (!node) throw new Error(`missing node ${qualifiedName}`);
    return node;
  }

  function targets(caller: string): string[] {
    return [...new Set(graph!.getOutgoingEdges(find(caller).id).filter(e => e.kind === 'calls')
      .map(e => graph!.getNode(e.target)!))]
      .map(n => `${path.basename(n.filePath)}:${n.qualifiedName}`).sort();
  }

  function calls(caller: string): string[] {
    return targets(caller).map(t => t.slice(t.indexOf(':') + 1));
  }

  it('indexes a nested routine as a function qualified under its parent and contained by it', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Inner; begin end;
begin Inner; end;`);
    const inner = find('THost::Fire::Inner');
    expect(inner.kind).toBe('function');
    const contains = graph!.getOutgoingEdges(find('THost::Fire').id).filter(e => e.kind === 'contains');
    expect(contains.map(e => e.target)).toContain(inner.id);
  });

  it('attributes a dispatch to the nested routine that fires it, reached through the call', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Inner; begin FNotify(Self); end;
begin Inner; end;`);
    expect(calls('THost::Fire::Inner')).toEqual(['TOwner::Click']);
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Inner']);
  });

  it('never links the parent to a handler fired only by an uncalled nested routine', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Inner; begin FNotify(Self); end;
begin end;`);
    expect(calls('THost::Fire::Inner')).toEqual(['TOwner::Click']);
    expect(calls('THost::Fire')).toEqual([]);
  });

  it('keeps the parent and its nested routine apart when both dispatch', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Inner; begin end;
begin Inner; FNotify(Self); end;`);
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Inner', 'TOwner::Click']);
    expect(calls('THost::Fire::Inner')).toEqual([]);
  });

  it('follows calls and dispatch through several nesting levels', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Level1;
    procedure Level2; begin FNotify(Self); end;
  begin Level2; end;
begin Level1; end;`);
    expect(find('THost::Fire::Level1::Level2').kind).toBe('function');
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Level1']);
    expect(calls('THost::Fire::Level1')).toEqual(['THost::Fire::Level1::Level2']);
    expect(calls('THost::Fire::Level1::Level2')).toEqual(['TOwner::Click']);
  });

  it('resolves a nested routine calling itself to itself', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Again(N: Integer);
  begin
    if N > 0 then Again(N - 1);
    FNotify(Self);
  end;
begin Again(2); end;`);
    expect(calls('THost::Fire::Again')).toEqual(['THost::Fire::Again', 'TOwner::Click']);
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Again']);
  });

  it('resolves a parameterless self-call written without parentheses', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Again; begin Again; end;
begin Again; end;`);
    expect(calls('THost::Fire::Again')).toEqual(['THost::Fire::Again']);
  });

  it('resolves a call to an earlier sibling and not the reverse', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure First; begin FNotify(Self); end;
  procedure Second; begin First; end;
begin Second; end;`);
    expect(calls('THost::Fire::Second')).toEqual(['THost::Fire::First']);
    expect(calls('THost::Fire::First')).toEqual(['TOwner::Click']);
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Second']);
  });

  it('resolves a call from a deeper routine to a routine of an outer scope', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Shared; begin FNotify(Self); end;
  procedure Outer;
    procedure Deep; begin Shared; end;
  begin Deep; end;
begin Outer; end;`);
    expect(calls('THost::Fire::Outer::Deep')).toEqual(['THost::Fire::Shared']);
  });

  it('does not let a routine see the nested routines of another routine', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Outer;
    procedure Hidden(N: Integer); begin end;
  begin Hidden(1); end;
  procedure Peer; begin Hidden(2); end;
begin Outer; Peer; end;`);
    expect(calls('THost::Fire::Outer')).toEqual(['THost::Fire::Outer::Hidden']);
    expect(calls('THost::Fire::Peer')).toEqual([]);
  });

  it('keeps same-named nested routines of different owners apart', async () => {
    await index(`procedure THost.Read;
  procedure Inner; begin end;
begin Inner; end;
procedure THost.Async; begin end;
procedure THost.Fire;
  procedure Inner; begin FNotify(Self); end;
begin Inner; end;`);
    expect(calls('THost::Read')).toEqual(['THost::Read::Inner']);
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Inner']);
    expect(calls('THost::Read::Inner')).toEqual([]);
    expect(calls('THost::Fire::Inner')).toEqual(['TOwner::Click']);
  });

  it('resolves a name no enclosing routine nests to the unit routine, never to another owner nested one', async () => {
    await index(`procedure Helper(N: Integer); begin end;
procedure THost.Read;
  procedure Helper(N: Integer); begin end;
begin Helper(1); end;
procedure THost.Fire;
  procedure Helper(N: Integer); begin end;
begin Helper(2); end;
procedure THost.Async; begin Helper(3); end;`);
    expect(targets('THost::Read')).toEqual(['Host.pas:THost::Read::Helper']);
    expect(targets('THost::Fire')).toEqual(['Host.pas:THost::Fire::Helper']);
    expect(targets('THost::Async')).toEqual(['Host.pas:Helper']);
  });

  it('keeps a nested routine of one unit from answering a call in another unit', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Helper(N: Integer); begin end;
begin Helper(1); end;`,
    'procedure TOwner.Wire; begin Helper(1); end;',
    'procedure Helper(N: Integer); begin end;');
    expect(targets('THost::Fire')).toEqual(['Host.pas:THost::Fire::Helper']);
    expect(targets('TOwner::Wire')).toEqual(['Owner.pas:Helper']);
  });

  it('does not link a nested routine to a call whose name a nearer local or parameter shadows', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Inner; begin end;
  procedure ByLocal; var Inner: Integer; begin Inner := 1; Inner := Inner + 1; end;
  procedure ByParameter(Inner: Integer); var V: Integer; begin V := Inner; end;
  procedure Plain; begin Inner; end;
begin ByLocal; ByParameter(1); Plain; end;`);
    expect(calls('THost::Fire::ByLocal')).toEqual([]);
    expect(calls('THost::Fire::ByParameter')).toEqual([]);
    expect(calls('THost::Fire::Plain')).toEqual(['THost::Fire::Inner']);
  });

  it('keeps a captured local of a nested routine out of the owner event dispatch', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Inner; var FNotify: Integer; begin FNotify := 2; end;
begin Inner; end;`);
    expect(calls('THost::Fire::Inner')).toEqual([]);
  });

  it('registers a handler assigned inside a nested routine of the owner', async () => {
    await index(`${plainHost}
procedure THost.Fire; begin FNotify(Self); end;`,
    `procedure TOwner.Wire;
  procedure Attach; begin FHost.OnNotify := Click; end;
begin Attach; end;`);
    expect(calls('THost::Fire')).toEqual(['TOwner::Click']);
    expect(calls('TOwner::Wire')).toEqual(['TOwner::Wire::Attach']);
  });

  it('registers the visible nested routine that shadows an owner method as the handler', async () => {
    await index(`${plainHost}
procedure THost.Fire; begin FNotify(Self); end;`,
    `procedure TOwner.Wire;
  procedure Click(Sender: TObject); begin end;
begin FHost.OnNotify := Click; end;`);
    expect(calls('THost::Fire')).toEqual(['TOwner::Wire::Click']);
  });

  it.each([['plain', ''], ['address-of', '@']])('links a nested handler assigned %s with a reference, not a call', async (_name, prefix) => {
    await index(`${plainHost}
procedure THost.Fire; begin FNotify(Self); end;`,
    `procedure TOwner.Wire;
  procedure Handler(Sender: TObject); begin end;
begin FHost.OnNotify := ${prefix}Handler; end;`);
    const edges = graph!.getOutgoingEdges(find('TOwner::Wire').id).filter(e => e.kind === 'calls' || e.kind === 'references');
    expect(edges.map(e => `${e.kind}:${graph!.getNode(e.target)!.qualifiedName}`).sort())
      .toEqual(['references:TOwner::Wire::Handler']);
    expect(calls('THost::Fire')).toEqual(['TOwner::Wire::Handler']);
  });

  it.each([
    ['plain', 'FHost.OnGet := Provide;', ''],
    ['cast', 'THost(FHost).OnGet := Provide;', ''],
    ['indexed', 'Hosts[0].OnGet := Provide;', 'var Hosts: array of THost;'],
    ['cast with address-of', 'THost(FHost).OnGet := @Provide;', ''],
    ['indexed with address-of', 'Hosts[0].OnGet := @Provide;', 'var Hosts: array of THost;'],
  ])('links a nested function handler registered through a %s target with a reference and no call', async (_name, assignment, vars) => {
    await index(`procedure THost.Read; begin end;
procedure THost.Async; begin end;
procedure THost.Fire; var V: Integer; begin V := FGet; end;`,
    `procedure TOwner.Wire;
${vars}
  function Provide: Integer; begin Result := 1; end;
begin ${assignment} end;`);
    const edges = graph!.getOutgoingEdges(find('TOwner::Wire').id).filter(e => e.kind === 'calls' || e.kind === 'references');
    expect(edges.map(e => `${e.kind}:${graph!.getNode(e.target)!.qualifiedName}`).sort())
      .toEqual(['references:TOwner::Wire::Provide']);
    expect(calls('THost::Fire')).toEqual(['TOwner::Wire::Provide']);
  });

  it('does not see a sibling declared after the routine that names it', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Early; begin Late; end;
  procedure Late; begin FNotify(Self); end;
begin Early; Late; end;`);
    expect(calls('THost::Fire::Early')).toEqual([]);
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Early', 'THost::Fire::Late']);
  });

  it('sees a later sibling that a forward declaration announces', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  procedure Late; forward;
  procedure Early; begin Late; end;
  procedure Late; begin FNotify(Self); end;
begin Early; end;`);
    expect(calls('THost::Fire::Early')).toEqual(['THost::Fire::Late']);
  });

  it('falls back to the unit routine when the nested one of that name is declared too late', async () => {
    await index(`procedure Helper(N: Integer); begin end;
${plainHost}
procedure THost.Fire;
  procedure Early; begin Helper(1); end;
  procedure Helper(N: Integer); begin end;
begin Early; end;`);
    expect(targets('THost::Fire::Early')).toEqual(['Host.pas:Helper']);
  });

  it('removes a nested routine and its edges when the source drops it, and restores them', async () => {
    const withNested = `${plainHost}
procedure THost.Fire;
  procedure Inner; begin FNotify(Self); end;
begin Inner; end;`;
    const without = `${plainHost}
procedure THost.Fire; begin end;`;
    await index(withNested);
    expect(calls('THost::Fire::Inner')).toEqual(['TOwner::Click']);

    write({ 'Host.pas': host(without) });
    await graph!.sync();
    expect(routines().some(n => n.qualifiedName === 'THost::Fire::Inner')).toBe(false);
    expect(calls('THost::Fire')).toEqual([]);

    write({ 'Host.pas': host(withNested) });
    await graph!.sync();
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Inner']);
    expect(calls('THost::Fire::Inner')).toEqual(['TOwner::Click']);

    write({ 'Owner.pas': owner('procedure TOwner.Wire; begin FHost := nil; end;') });
    await graph!.sync();
    expect(calls('THost::Fire::Inner')).toEqual([]);
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Inner']);
  });

  it('keeps scanning after a routine whose body is pure assembler', async () => {
    await index(`${plainHost}
procedure Spin; assembler; asm nop end;
procedure THost.Fire; begin FNotify(Self); end;`);
    expect(calls('THost::Fire')).toEqual(['TOwner::Click']);
  });

  it('does not read a record method as a routine nested in the next one', async () => {
    await index(`${plainHost}
type TRec = record A: Integer; procedure Go; end;
procedure THost.Fire; begin FNotify(Self); end;`);
    expect(calls('THost::Fire')).toEqual(['TOwner::Click']);
  });

  it('does not call a callback copied into the Result of a nested function', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  function Pick: TNotify; begin Result := FNotify; end;
begin Pick; end;`);
    expect(calls('THost::Fire::Pick')).toEqual([]);
  });

  it('resolves a method on a bare nested function receiver to the function result type', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  function Peer: THost; begin Result := Self; end;
begin Peer.Async; end;`);
    expect(calls('THost::Fire')).toContain('THost::Async');
    expect(calls('THost::Fire')).not.toContain('TDecoy::Async');
  });

  it('follows a nested function result through a longer chain to an event invocation', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  function Peer: THost; begin Result := Self; end;
begin Peer.Next.OnNotify(Self); end;`);
    expect(calls('THost::Fire')).toEqual(['THost::Fire::Peer', 'THost::Next', 'TOwner::Click']);
  });

  it('links the receiver evaluated before a method call to the nested function, not an owner member', async () => {
    await index(`${plainHost}
procedure THost.Fire;
  function Peer: THost; begin Result := Self; end;
begin Peer.Async; end;`);
    expect(calls('THost::Fire')).toContain('THost::Fire::Peer');
    expect(calls('THost::Fire')).not.toContain('THost::Peer');
  });
});
