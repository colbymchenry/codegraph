import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { declaredDependencies } from '../src/resolution/frameworks/package-deps';
import type { ResolutionContext } from '../src/resolution/types';
describe('dependency detection cache', () => {
  it('notices an equal-size replacement of the file list', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dependencies-'));
    try {
      for (const [directory, dependency] of [['web', 'react'], ['server', 'express']]) {
        fs.mkdirSync(path.join(root, directory));
        fs.writeFileSync(path.join(root, directory, 'package.json'), JSON.stringify({ dependencies: { [dependency!]: '*' } }));
      }
      let files: readonly string[] = Object.freeze(['web/app.ts']);
      const context = {
        getAllFiles: () => files,
        getProjectRoot: () => root,
        fileExists: (file: string) => fs.existsSync(path.join(root, file)),
        readFile: (file: string) => { try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return null; } },
      } as ResolutionContext;
      expect(declaredDependencies(context)).toEqual(new Set(['react']));
      files = Object.freeze(['server/app.ts']);
      expect(declaredDependencies(context)).toEqual(new Set(['express']));
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
