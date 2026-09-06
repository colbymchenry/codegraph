/**
 * FiveM string-keyed dispatch bridge (Lua + JS resources).
 *
 * A FiveM pack is many resources (dirs with `fxmanifest.lua`) that call each other only by
 * string: `TriggerServerEvent('res:evt')` → `RegisterNetEvent('res:evt', function … end)`,
 * `exports['res']:Fn()` → `exports('Fn', function … end)`, `lib.callback.await('c')` →
 * `lib.callback.register('c', …)`. Handlers are inline anonymous functions, so nothing is a
 * node for them until `frameworks/fivem.ts` `extract()` makes one per registration site;
 * `fivem-synthesizer.ts` then links every literal dispatch site to those nodes. Proves the
 * precision gates: an unregistered key, a commented-out dispatch, and a computed key all
 * contribute no edge, and a Lua project with no manifest contributes nothing at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { stripLuaComments } from '../src/resolution/frameworks/fivem';

const write = (dir: string, rel: string, body: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

describe('fivem-dispatch synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fivem-dispatch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('bridges events, exports and callbacks across resources; ignores unregistered, commented, computed keys', async () => {
    write(dir, 'resources/[core]/qb-inventory/fxmanifest.lua', `fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server/main.lua'\n`);
    write(dir, 'resources/[core]/qb-inventory/server/main.lua', `local Inventory = {}

RegisterNetEvent('qb-inventory:server:AddItem', function(item, amount)
    Inventory[item] = (Inventory[item] or 0) + amount
end)

RegisterNetEvent('qb-inventory:server:RemoveItem', function(item, amount)
    Inventory[item] = (Inventory[item] or 0) - amount
end)

exports('AddItem', function(src, item, amount)
    TriggerEvent('qb-inventory:server:AddItem', item, amount)
end)

lib.callback.register('qb-inventory:getCount', function(source, item)
    return Inventory[item] or 0
end)
`);
    write(dir, 'resources/[core]/qb-shops/fxmanifest.lua', `fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client/main.lua'\nserver_script 'server/main.lua'\n`);
    write(dir, 'resources/[core]/qb-shops/client/main.lua', `local function BuyItem(item)
    TriggerServerEvent('qb-inventory:server:AddItem', item, 1)     -- cross-resource event
    -- TriggerServerEvent('qb-inventory:server:RemoveItem', item, 1)   commented out: no edge
    local count = lib.callback.await('qb-inventory:getCount', false, item)
    TriggerServerEvent('qb-shops:server:nothingRegistered', item)  -- no handler anywhere: no edge
    return count
end

local function Refund(item)
    local evt = 'qb-inventory:server:' .. 'RemoveItem'
    TriggerServerEvent(evt, item, 1)                               -- computed key: no edge
end
`);
    write(dir, 'resources/[core]/qb-shops/client/ui.js', `const socket = connect();
socket.on('connect', () => { console.log('ui up'); });          // member .on: not FiveM, no node
onNet('qb-shops:client:refresh', (item) => {
  emitNet('qb-inventory:server:AddItem', item, 1);               // JS side, inside a JS handler
});
`);
    write(dir, 'resources/[core]/qb-shops/client/nui.lua', `RegisterNUICallback('getStock', function(data, cb)
    cb(lib.callback.await('qb-inventory:getCount', false, data.item))
end)
`);
    write(dir, 'resources/[core]/qb-shops/html/app.js', `on('hook:destroyed', () => {});                              // browser code: never a FiveM handler
function loadStock(item) {
  return fetch(\`https://qb-shops/getStock\`, { body: JSON.stringify({ item }) });   // literal host
}
function loadStockOwn(item) {
  return fetch(\`https://\${GetParentResourceName()}/getStock\`, { method: 'POST' });   // the usual form: own resource
}
async function loadStockLib(item) {
  return fetchNui('getStock', { item });                                             // ox_lib helper
}
`);
    write(dir, 'resources/[core]/qb-shops/server/main.lua', `local function Restock(src, item)
    exports['qb-inventory']:AddItem(src, item, 10)                 -- cross-resource export
    exports.qb_inventory:AddItem(src, item, 1)                     -- wrong resource name: no edge
end
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const handlers = db.prepare(`SELECT name, file_path fp, start_line sl FROM nodes WHERE id LIKE 'fivem:%' ORDER BY name`).all();
    expect(handlers.map((h: any) => h.name)).toEqual([
      'callback:qb-inventory:getCount',
      'event:qb-inventory:server:AddItem',
      'event:qb-inventory:server:RemoveItem',
      'event:qb-shops:client:refresh',
      'export:AddItem',
      'nui:getStock',
    ]);
    expect(handlers.some((h: any) => h.name === 'event:hook:destroyed')).toBe(false);
    expect(handlers.find((h: any) => h.name === 'event:qb-inventory:server:AddItem').sl).toBe(3);
    const ends = db.prepare(`SELECT name, end_line el FROM nodes WHERE id LIKE 'fivem:%'`).all();
    expect(ends.find((h: any) => h.name === 'event:qb-inventory:server:AddItem').el).toBe(5); // `end)` closes on line 5
    expect(ends.find((h: any) => h.name === 'export:AddItem').el).toBe(13);
    expect(ends.find((h: any) => h.name === 'event:qb-shops:client:refresh').el).toBe(5); // JS arrow body closes on line 5

    const edges = db
      .prepare(
        `SELECT s.name source, t.name target, json_extract(e.metadata,'$.via') via, json_extract(e.metadata,'$.registeredAt') at
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'fivem-dispatch'`
      )
      .all();
    const targets = (src: string) => edges.filter((r: any) => r.source === src).map((r: any) => r.target).sort();

    // BuyItem: the event and the callback, nothing for the commented / unregistered lines.
    expect(targets('BuyItem')).toEqual(['callback:qb-inventory:getCount', 'event:qb-inventory:server:AddItem']);
    // Restock: the export by the right resource name only (exports.qb_inventory names a resource that does not exist).
    expect(targets('Restock')).toEqual(['export:AddItem']);
    expect(edges.find((r: any) => r.source === 'Restock').via).toBe('export:qb-inventory/AddItem');
    // Refund built its key at runtime — boundary, not an edge.
    expect(targets('Refund')).toEqual([]);
    // RemoveItem is registered but only ever dispatched from a comment.
    expect(edges.some((r: any) => r.target === 'event:qb-inventory:server:RemoveItem')).toBe(false);
    // The AddItem export's body dispatches the AddItem event: an intra-resource edge whose source is the handler node itself.
    expect(edges.some((r: any) => r.source === 'export:AddItem' && r.target === 'event:qb-inventory:server:AddItem')).toBe(true);
    // NUI: the browser's fetch reaches the Lua RegisterNUICallback; the NUI callback body's own callback dispatch chains on.
    expect(targets('loadStock')).toEqual(['nui:getStock']);
    expect(edges.find((r: any) => r.source === 'loadStock').via).toBe('nui:qb-shops/getStock');
    expect(targets('loadStockOwn')).toEqual(['nui:getStock']);   // `${GetParentResourceName()}` → own resource
    expect(targets('loadStockLib')).toEqual(['nui:getStock']);   // fetchNui('name') → own resource
    expect(targets('nui:getStock')).toEqual(['callback:qb-inventory:getCount']);
    // JS: a dispatch inside an onNet arrow handler attributes to that handler node.
    expect(targets('event:qb-shops:client:refresh')).toEqual(['event:qb-inventory:server:AddItem']);
    // registeredAt points at the handler line.
    const e = edges.find((r: any) => r.source === 'BuyItem' && r.via === 'event:qb-inventory:server:AddItem');
    expect(e.at).toMatch(/qb-inventory[\\/]server[\\/]main\.lua:3$/);

    cg.close?.();
  });

  it('contributes nothing to a Lua project with no manifest (clean control)', async () => {
    write(dir, 'init.lua', `local M = {}
function M.setup()
    TriggerServerEvent('foo:bar')       -- not FiveM; no manifest anywhere
    RegisterNetEvent('foo:bar', function() end)
end
return M
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    expect(db.prepare(`SELECT count(*) c FROM nodes WHERE id LIKE 'fivem:%'`).get().c).toBe(0);
    expect(db.prepare(`SELECT count(*) c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'fivem-dispatch'`).get().c).toBe(0);
    cg.close?.();
  });
});

describe('stripLuaComments', () => {
  it('blanks line and block comments, keeps strings and line count', () => {
    const src = `a = 1 -- comment\n--[[ block\nspanning ]] b = "-- not a comment"\nc = [[long -- string]]\n`;
    const out = stripLuaComments(src);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('-- comment');
    expect(out).not.toContain('block');
    expect(out).not.toContain('spanning');
    expect(out).toContain('b = "-- not a comment"');
    expect(out).toContain('c = [[long -- string]]');
  });
});
