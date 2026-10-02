import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type CodeGraph from '../src';
import type { QueryBuilder } from '../src/db/queries';

const built = path.join(__dirname, '..', 'dist', 'index.js');
const kernel = path.join(__dirname, '..', 'codegraph-kernel', 'prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node');

// Source-mode suites cannot exercise the compiled parse/store worker boundary.
describe.runIf(fs.existsSync(built))('literal persistence through compiled indexing', () => {
  let dir: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.unstubAllEnvs();
  });

  for (const mode of ['native-worker', 'native-main', 'wasm-worker']) {
    it.runIf(mode === 'wasm-worker' || fs.existsSync(kernel))(`${mode}: fresh, unchanged, and migrated indexes retain exact owners`, async () => {
      vi.stubEnv('CODEGRAPH_PARSE_WORKERS', '1');
      vi.stubEnv('CODEGRAPH_KERNEL', mode === 'wasm-worker' ? '0' : '1');
      vi.stubEnv('CODEGRAPH_NO_STORE_WORKER', mode === 'native-main' ? '1' : '0');
      const BuiltCodeGraph: typeof CodeGraph = require(built).default;
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-literal-compiled-'));
      fs.writeFileSync(path.join(dir, 'cache.py'), "def persist():\n    return 'cache.write'\n");
      fs.writeFileSync(path.join(dir, 'siblings.ts'), "/* café 😀 */ export function writer(){return 'sibling.write';} export function reader(){return 'sibling.read';}\n");
      cg = await BuiltCodeGraph.init(dir, { silent: true });
      const names = (key: string) => cg!.findLiteralSeedIds(key).map(id => cg!.getNode(id)?.name);
      const assertOwners = () => {
        expect(names('cache.write')).toEqual(['persist']);
        expect(names('sibling.write')).toEqual(['writer']);
        expect(names('sibling.read')).toEqual(['reader']);
      };
      await cg.indexAll();
      assertOwners();
      await cg.indexAll();
      assertOwners();

      // A schema-only migration has no literal data; unchanged source still needs backfill.
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      queries.replaceLiteralsForFile('cache.py', []);
      queries.replaceLiteralsForFile('siblings.ts', []);
      queries.setMetadata('indexed_with_extraction_version', '26');
      expect(cg.isIndexStale()).toBe(true);
      await cg.indexAll();
      assertOwners();
      expect(cg.isIndexStale()).toBe(false);
      fs.rmSync(path.join(dir, 'cache.py'));
      await cg.indexAll();
      expect(names('cache.write')).toEqual([]);
      expect(names('sibling.write')).toEqual(['writer']);
    });
  }
});
