import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReferenceResolver } from '../src/resolution';
import type { QueryBuilder } from '../src/db/queries';
import type { ResolutionContext } from '../src/resolution/types';

describe('resolution file reads', () => {
  let root: string;
  let context: ResolutionContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolution-read-'));
    const resolver = new ReferenceResolver(root, {} as QueryBuilder);
    context = (resolver as unknown as { context: ResolutionContext }).context;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads normal source files', () => {
    fs.writeFileSync(path.join(root, 'small.ts'), 'export const answer = 42;\n');
    expect(context.readFile('small.ts')).toBe('export const answer = 42;\n');
  });

  it('rejects an oversized package archive before decoding it as UTF-8', () => {
    const relative = 'node_modules/example/react_native_openharmony.har';
    const archive = path.join(root, relative);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const fd = fs.openSync(archive, 'w');
    try {
      fs.writeSync(fd, Buffer.from([0x1f, 0x8b]));
      fs.ftruncateSync(fd, 2 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }

    expect(context.readFile(relative)).toBeNull();
  });
});
