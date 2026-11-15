import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { isLuaRustBridgeInput } from '../src/resolution/callback-synthesizer';
import { cachedLuaAnalysis, cachedRustAnalysis, pruneStoredAnalyses } from '../src/resolution/bridge-analysis-cache';
import type { ResolutionContext } from '../src/resolution/types';

describe('Lua/Rust bridge inputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bridge-store-'));
  const context = { getProjectRoot: () => dir } as unknown as ResolutionContext;
  const store = () => path.join(dir, '.codegraph', 'bridge-analyses');
  const entries = () => fs.existsSync(store())
    ? fs.readdirSync(store()).flatMap(version => fs.readdirSync(path.join(store(), version)).map(file => path.join(store(), version, file)))
    : [];
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('refreshes the bridge only for Lua and Rust files of projects with both languages', () => {
    const both = new Set(['lua', 'rust', 'typescript']);
    expect(isLuaRustBridgeInput('lua', both)).toBe(true);
    expect(isLuaRustBridgeInput('rust', both)).toBe(true);
    expect(isLuaRustBridgeInput('typescript', both)).toBe(false);
    expect(isLuaRustBridgeInput(undefined, both)).toBe(false);
    expect(isLuaRustBridgeInput('lua', new Set(['lua']))).toBe(false);
    expect(isLuaRustBridgeInput('rust', new Set(['rust', 'typescript']))).toBe(false);
    // A project's first file of the other language starts the bridge.
    expect(isLuaRustBridgeInput('rust', new Set(['lua']))).toBe(true);
    expect(isLuaRustBridgeInput('lua', new Set(['rust']))).toBe(true);
  });

  const lua = 'local ffi = require("ffi")\nffi.cdef[[ void ping(void); ]]\nfunction ping() ffi.C.ping() end';

  it('never stores an analysis made without its grammar', () => {
    expect(cachedLuaAnalysis(context, 'cache.lua', lua).partial).toBe(true);
    expect(entries()).toEqual([]);
  });

  it('stores each analysis in the index and reads the stored copy back', async () => {
    await loadGrammarsForLanguages(['lua', 'rust']);
    const live = new Set<string>();
    expect(cachedLuaAnalysis(context, 'cache.lua', lua, live).cdefSymbols).toEqual({ ping: ['ping'] });
    const [stored] = entries();
    expect(entries()).toHaveLength(1);
    // A later process reads the stored analysis instead of analyzing again.
    fs.writeFileSync(stored!, JSON.stringify({ ...JSON.parse(fs.readFileSync(stored!, 'utf8')), cdefSymbols: { stored: ['copy'] } }));
    expect(cachedLuaAnalysis(context, 'cache.lua', lua).cdefSymbols).toEqual({ stored: ['copy'] });
    // Changed text, or the same text at another path, is another analysis.
    cachedLuaAnalysis(context, 'cache.lua', `${lua}\n`, live);
    cachedLuaAnalysis(context, 'other.lua', lua, live);
    await cachedRustAnalysis(context, 'cache.rs', '#[no_mangle]\npub extern "C" fn ping() {}', live);
    expect(entries()).toHaveLength(4);
    expect(live.size).toBe(4);
  });

  it('prunes entries no current file uses and every other analyzer version', () => {
    const [version] = fs.readdirSync(store());
    fs.mkdirSync(path.join(store(), 'retired'));
    fs.writeFileSync(path.join(store(), 'retired', 'old.json'), '{}');
    const live = new Set<string>();
    cachedLuaAnalysis(context, 'other.lua', lua, live);
    pruneStoredAnalyses(context, live);
    expect(fs.readdirSync(store())).toEqual([version]);
    expect(entries()).toHaveLength(1);
  });
});
