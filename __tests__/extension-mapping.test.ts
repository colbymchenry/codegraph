/**
 * Custom extension → language mapping (#906).
 *
 * A project can map non-standard file extensions to a supported language via a
 * committed `codegraph.json` at the repo root, so files that would otherwise be
 * silently skipped get indexed under the right grammar. These tests cover the
 * two choke-point functions (detectLanguage / isSourceFile) honoring an override
 * map, the loader's validation/normalization/caching of `codegraph.json`, and a
 * full index proving a custom-extension file is actually extracted — while the
 * zero-config path stays byte-identical (the file is NOT indexed without config).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { detectLanguage, isSourceFile } from '../src/extraction/grammars';
import { loadExtensionOverrides, clearProjectConfigCache } from '../src/project-config';

describe('custom extension → language mapping (#906)', () => {
  describe('detectLanguage / isSourceFile overrides argument', () => {
    it('maps a custom extension only when present in the overrides', () => {
      expect(detectLanguage('a/b.foo')).toBe('unknown');
      expect(isSourceFile('a/b.foo')).toBe(false);

      expect(detectLanguage('a/b.foo', undefined, { '.foo': 'typescript' })).toBe('typescript');
      expect(isSourceFile('a/b.foo', { '.foo': 'typescript' })).toBe(true);
    });

    it('lets a user mapping take precedence over a built-in extension', () => {
      expect(detectLanguage('x.h')).toBe('c');
      expect(detectLanguage('x.h', undefined, { '.h': 'cpp' })).toBe('cpp');
    });

    it('is byte-identical to zero-config behavior when no overrides are passed', () => {
      expect(detectLanguage('x.ts')).toBe('typescript');
      expect(detectLanguage('x.py')).toBe('python');
      expect(isSourceFile('x.ts')).toBe(true);
      expect(isSourceFile('x.unknownext')).toBe(false);
    });
  });

  describe('loadExtensionOverrides (codegraph.json)', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extmap-'));
      clearProjectConfigCache();
    });
    afterEach(() => {
      clearProjectConfigCache();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const writeConfig = (obj: unknown) =>
      fs.writeFileSync(
        path.join(dir, 'codegraph.json'),
        typeof obj === 'string' ? obj : JSON.stringify(obj)
      );

    it('returns an empty map when there is no codegraph.json', () => {
      expect(loadExtensionOverrides(dir)).toEqual({});
    });

    it('loads and validates a well-formed extensions map', () => {
      writeConfig({ extensions: { '.foo': 'typescript', '.bar': 'python' } });
      expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'typescript', '.bar': 'python' });
    });

    it('normalizes keys (adds a leading dot, lowercases)', () => {
      writeConfig({ extensions: { foo: 'lua', '.BAR': 'go' } });
      expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'lua', '.bar': 'go' });
    });

    it('skips entries whose target is not a supported language', () => {
      writeConfig({ extensions: { '.foo': 'typescript', '.bad': 'pyhton', '.x': 'unknown' } });
      expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'typescript' });
    });

    it('skips multi-part and otherwise unusable extension keys', () => {
      writeConfig({ extensions: { '.d.ts': 'typescript', 'a/b': 'go', '.': 'lua', '.ok': 'rust' } });
      expect(loadExtensionOverrides(dir)).toEqual({ '.ok': 'rust' });
    });

    it('ignores malformed JSON without throwing', () => {
      writeConfig('{ not: valid json ');
      expect(loadExtensionOverrides(dir)).toEqual({});
    });

    it('ignores a non-object extensions field', () => {
      writeConfig({ extensions: 'nope' });
      expect(loadExtensionOverrides(dir)).toEqual({});
    });

    it('picks up a changed config (mtime-invalidated cache)', () => {
      writeConfig({ extensions: { '.foo': 'typescript' } });
      expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'typescript' });

      writeConfig({ extensions: { '.foo': 'go' } });
      // Force a distinct mtime in case the filesystem clock is coarse.
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(path.join(dir, 'codegraph.json'), future, future);

      expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'go' });
    });
  });

  describe('indexAll honors codegraph.json end-to-end', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extmap-idx-'));
      clearProjectConfigCache();
    });
    afterEach(() => {
      clearProjectConfigCache();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const write = (rel: string, body: string) => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    const indexAndQuery = async () => {
      const cg = await CodeGraph.init(dir, { silent: true });
      await cg.indexAll();
      const db = (cg as any).db.db;
      const nodes = db
        .prepare('SELECT name, kind, file_path, language FROM nodes WHERE file_path = ?')
        .all('widget.foo');
      const files = db
        .prepare('SELECT path, language FROM files WHERE path = ?')
        .all('widget.foo');
      cg.close?.();
      return { nodes, files };
    };

    const SOURCE = 'export function widgetHandler(x: number): number { return x + 1; }\n';

    it('indexes a custom-extension file mapped to a supported language', async () => {
      write('codegraph.json', JSON.stringify({ extensions: { '.foo': 'typescript' } }));
      write('widget.foo', SOURCE);

      const { nodes, files } = await indexAndQuery();

      expect(files.length).toBe(1);
      expect(files[0].language).toBe('typescript');
      expect(nodes.some((n: any) => n.name === 'widgetHandler' && n.language === 'typescript')).toBe(true);
    });

    it('does NOT index the same file without codegraph.json (zero-config preserved)', async () => {
      write('widget.foo', SOURCE);

      const { nodes, files } = await indexAndQuery();

      expect(files.length).toBe(0);
      expect(nodes.length).toBe(0);
    });
  });
});
