import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import { ANALYZER_MODULES, cachedLuaAnalysis, cachedRustAnalysis, cachedRustModules, pruneStoredAnalyses } from '../src/resolution/bridge-analysis-cache';
import type { ResolutionContext } from '../src/resolution/types';

describe('stored bridge analyses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bridge-store-'));
  const context = { getProjectRoot: () => dir } as unknown as ResolutionContext;
  const store = () => path.join(dir, '.codegraph', 'bridge-analyses');
  const entries = () => fs.existsSync(store())
    ? fs.readdirSync(store()).flatMap(version => fs.readdirSync(path.join(store(), version)).map(file => path.join(store(), version, file)))
    : [];
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

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
    const { exports } = await cachedRustAnalysis(context, 'cache.rs', '#[no_mangle]\npub extern "C" fn ping() {}', live);
    expect(exports.map(exp => exp.symbolName)).toEqual(['ping']);
    expect(cachedRustModules(context, 'lib.rs', 'pub mod engine;\nmod inner { mod deep {} }', live).modules).toEqual([
      ['', [{ name: 'engine', inline: false, customPath: false }, { name: 'inner', inline: true, customPath: false }]],
      ['inner', [{ name: 'deep', inline: true, customPath: false }]],
    ]);
    expect(entries()).toHaveLength(5);
    expect(live.size).toBe(5);
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

  it('fingerprints every module an analysis is computed by', () => {
    // These only find the store, or load a grammar the fingerprint reads itself.
    const locating = new Set(['../directory', '../extraction/grammars']);
    const resolution = path.join(__dirname, '..', 'src', 'resolution');
    const unlisted: string[] = [];
    for (const name of ANALYZER_MODULES) {
      const source = fs.readFileSync(path.join(resolution, `${name}.ts`), 'utf8');
      for (const [, spec] of source.matchAll(/^import\s+(?!type\b)[^;]*?\bfrom\s+'(\.{1,2}\/[^']+)'/gm)) {
        const imported = path.posix.join(path.posix.dirname(name), spec!);
        if (!ANALYZER_MODULES.includes(imported) && !locating.has(imported)) unlisted.push(`${name} imports ${imported}`);
      }
    }
    expect(unlisted).toEqual([]);
  });
});
