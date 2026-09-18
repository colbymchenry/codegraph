import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearProjectConfigCache,
  loadViewerMapConfig,
} from '../src/project-config';
import { defaultLogger, setLogger, type Logger } from '../src/errors';

describe('viewer map configuration (codegraph.json)', () => {
  let dir: string;
  let warnings: string[];
  let logger: Logger;
  let nextMtime: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-viewer-config-'));
    warnings = [];
    logger = {
      debug: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
    };
    setLogger(logger);
    clearProjectConfigCache();
    nextMtime = Date.now();
  });

  afterEach(() => {
    setLogger(defaultLogger);
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(config: unknown): void {
    const file = path.join(dir, 'codegraph.json');
    fs.writeFileSync(file, JSON.stringify(config));
    nextMtime += 2_000;
    const future = new Date(nextMtime);
    fs.utimesSync(file, future, future);
  }

  it('uses depth four and no named scopes by default', () => {
    expect(loadViewerMapConfig(dir)).toEqual({ maxDepth: 4, scopes: [] });
  });

  it('loads normalized named scopes and permits maxDepth through 32', () => {
    writeConfig({
      viewer: {
        map: {
          maxDepth: 32,
          scopes: [
            { label: 'Backend', root: './supabase/' },
            { label: 'Shared backend', root: 'supabase/functions/_shared' },
          ],
        },
      },
    });
    expect(loadViewerMapConfig(dir)).toEqual({
      maxDepth: 32,
      scopes: [
        { label: 'Backend', root: 'supabase' },
        { label: 'Shared backend', root: 'supabase/functions/_shared' },
      ],
    });
  });

  it('warns and falls back or skips invalid map settings deterministically', () => {
    writeConfig({
      viewer: {
        map: {
          maxDepth: 33,
          scopes: [
            { label: '', root: 'backend' },
            { label: 'Traversal', root: '../backend' },
            { label: 'Absolute', root: '/backend' },
            { label: 'Backend', root: 'backend' },
            { label: 'Backend', root: 'other' },
            { label: 'Duplicate root', root: 'backend' },
          ],
        },
      },
    });
    expect(loadViewerMapConfig(dir)).toEqual({
      maxDepth: 4,
      scopes: [{ label: 'Backend', root: 'backend' }],
    });
    expect(warnings).toHaveLength(6);
  });

  it.each([
    ['viewer array', { viewer: [] }],
    ['map array', { viewer: { map: [] } }],
    ['scope array entry', { viewer: { map: { scopes: [[]] } } }],
    ['non-string scope label', { viewer: { map: { scopes: [{ label: 1, root: 'backend' }] } } }],
    ['non-string scope root', { viewer: { map: { scopes: [{ label: 'Backend', root: 1 }] } } }],
    ['normalized Unix absolute root', { viewer: { map: { scopes: [{ label: 'Backend', root: './/backend' }] } } }],
    ['normalized Windows absolute root', { viewer: { map: { scopes: [{ label: 'Backend', root: './C:/backend' }] } } }],
    ['Windows absolute root', { viewer: { map: { scopes: [{ label: 'Backend', root: 'C:/backend' }] } } }],
  ])('warns and safely ignores a %s', (_case, config) => {
    writeConfig(config);
    expect(loadViewerMapConfig(dir)).toEqual({ maxDepth: 4, scopes: [] });
    expect(warnings).toHaveLength(1);
  });

  it('refreshes changed settings and returns to defaults after removal', () => {
    writeConfig({ viewer: { map: { maxDepth: 12, scopes: [{ label: 'Backend', root: 'backend' }] } } });
    expect(loadViewerMapConfig(dir).maxDepth).toBe(12);

    writeConfig({ viewer: { map: { maxDepth: 1 } } });
    expect(loadViewerMapConfig(dir)).toEqual({ maxDepth: 1, scopes: [] });

    fs.rmSync(path.join(dir, 'codegraph.json'));
    expect(loadViewerMapConfig(dir)).toEqual({ maxDepth: 4, scopes: [] });
  });
});
