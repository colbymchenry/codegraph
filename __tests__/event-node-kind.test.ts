/**
 * Dedicated `event` node kind and search ranking (#3440).
 *
 * Event declarations (Solidity `event`, VB.NET `Event` / `Custom Event`) used
 * to be stored as `field`, which gave them `kindBonus` +3 vs +10 for functions
 * and methods — a 7-point penalty that buried events beneath same-named
 * functions and excluded them from high-value context kinds.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { NODE_KINDS } from '../src/types';
import { kindBonus } from '../src/search/query-utils';
import { parseQuery } from '../src/search/query-parser';
import { RELEVANCE_KIND_WEIGHT } from '../src/mcp/tools';
import { oneSymbolDefinitions } from '../src/mcp/explore-one-symbol';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-event-kind-'));
  const files: Record<string, string> = {
    'contracts/slot/SlotContract.sol': `pragma solidity ^0.8.20;

contract SlotContract {
    event slot(uint256 id);
    error BadSlot();

    function trigger(uint256 id) external {
        emit slot(id);
    }
}
`,
    'vb/Bus.vb': `Imports System

Namespace App.Events
    Public Class Bus
        Public Event SlotFired(ByVal id As Integer)

        Public Custom Event CustomSlot As EventHandler
            AddHandler(ByVal value As EventHandler)
                TrackHandler()
            End AddHandler
            RemoveHandler(ByVal value As EventHandler)
            End RemoveHandler
            RaiseEvent(ByVal sender As Object, ByVal e As EventArgs)
            End RaiseEvent
        End Event

        Public Sub TrackHandler()
        End Sub
    End Class
End Namespace
`,
    'vb/Holder.vb': `Namespace App.State
    Public Class Holder
        Private slot As Integer
        Private SlotFired As Integer
    End Class
End Namespace
`,
    'src/worker.rs': `pub fn slot() -> i32 {
    1
}
`,
  };

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }

  cg = await CodeGraph.init(root);
  await cg.indexAll();
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root && fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('event node kind contract and scoring (#3440)', () => {
  it('appends event to NODE_KINDS without reordering existing kinds', () => {
    expect(NODE_KINDS).toContain('event');
    expect(NODE_KINDS[NODE_KINDS.length - 1]).toBe('event');
    expect(NODE_KINDS.indexOf('union')).toBe(NODE_KINDS.indexOf('event') - 1);
  });

  it('parses kind:event in search queries', () => {
    const parsed = parseQuery('slot kind:event');
    expect(parsed.text).toBe('slot');
    expect(parsed.kinds).toEqual(['event']);
  });

  it('scores event close to method/function and well above field/property', () => {
    expect(kindBonus('event')).toBe(9);
    expect(kindBonus('event')).toBeGreaterThan(kindBonus('field'));
    expect(kindBonus('event')).toBeGreaterThan(kindBonus('property'));
    expect(kindBonus('event')).toBeGreaterThan(kindBonus('variable'));
    expect(kindBonus('method') - kindBonus('event')).toBeLessThanOrEqual(1);
    expect(RELEVANCE_KIND_WEIGHT.event).toBe(1);
  });
});

describe('Solidity and VB.NET event extraction (#3440)', () => {
  it('extracts Solidity event_definition as event, keeps error_declaration as field, and resolves emit', () => {
    const solNodes = cg.getNodesInFile('contracts/slot/SlotContract.sol');
    const slotEvent = solNodes.find((n) => n.name === 'slot');
    expect(slotEvent).toBeDefined();
    expect(slotEvent?.kind).toBe('event');

    const badSlot = solNodes.find((n) => n.name === 'BadSlot');
    expect(badSlot?.kind).toBe('field');

    const trigger = solNodes.find((n) => n.name === 'trigger' && n.kind === 'method');
    expect(trigger).toBeDefined();
    const outgoing = cg.getOutgoingEdges(trigger!.id);
    expect(outgoing.some((e) => e.target === slotEvent!.id)).toBe(true);
  });

  it('extracts VB.NET Event and Custom Event as event and keeps Custom Event body edges', () => {
    const vbNodes = cg.getNodesInFile('vb/Bus.vb');
    const slotFired = vbNodes.find((n) => n.name === 'SlotFired');
    const customSlot = vbNodes.find((n) => n.name === 'CustomSlot');
    const trackHandler = vbNodes.find((n) => n.name === 'TrackHandler' && n.kind === 'method');

    expect(slotFired?.kind).toBe('event');
    expect(customSlot?.kind).toBe('event');
    expect(trackHandler).toBeDefined();

    const outgoing = cg.getOutgoingEdges(customSlot!.id);
    expect(outgoing.some((e) => e.target === trackHandler!.id)).toBe(true);
  });

  it('includes event nodes in oneSymbolDefinitions for codegraph_explore', () => {
    const defs = oneSymbolDefinitions(cg, 'CustomSlot');
    expect(defs).not.toBeNull();
    expect(defs?.map((d) => `${d.kind}:${d.name}`)).toEqual(['event:CustomSlot']);
  });
});

describe('event search ranking (#3440)', () => {
  it('filters to only event declarations with kind:event', () => {
    const results = cg.searchNodes('slot kind:event');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.node.kind === 'event')).toBe(true);
    expect(results.some((r) => r.node.name === 'slot' && r.node.language === 'solidity')).toBe(true);
  });

  it('ranks an event declaration above a same-named field', () => {
    const results = cg.searchNodes('SlotFired');
    const eventIdx = results.findIndex((r) => r.node.name === 'SlotFired' && r.node.kind === 'event');
    const fieldIdx = results.findIndex((r) => r.node.name === 'SlotFired' && r.node.kind === 'field');
    expect(eventIdx).toBeGreaterThanOrEqual(0);
    expect(fieldIdx).toBeGreaterThanOrEqual(0);
    expect(eventIdx).toBeLessThan(fieldIdx);
  });

  it('allows an event with path relevance to outrank a same-named function', () => {
    // contracts/slot/SlotContract.sol matches the query in its path; previously
    // the 7-point field penalty (3 vs 10) let a same-named function still beat
    // an event even when the event's directory matched.
    const results = cg.searchNodes('slot');
    const eventIdx = results.findIndex((r) => r.node.name === 'slot' && r.node.kind === 'event');
    const fnIdx = results.findIndex((r) => r.node.name === 'slot' && r.node.kind === 'function');
    const fieldIdx = results.findIndex((r) => r.node.name === 'slot' && r.node.kind === 'field');
    expect(eventIdx).toBeGreaterThanOrEqual(0);
    expect(fnIdx).toBeGreaterThanOrEqual(0);
    expect(fieldIdx).toBeGreaterThanOrEqual(0);
    expect(eventIdx).toBeLessThan(fnIdx);
    expect(eventIdx).toBeLessThan(fieldIdx);
  });
});
