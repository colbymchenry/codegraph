/**
 * Source reads are bounded by the read itself, not only by a stat taken
 * before it (#1910). A file can grow between the stat and the read; the
 * reader must still never hold more than the limit plus one byte.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readBoundedSource, readBoundedSourceSync, MAX_SOURCE_FILE_SIZE_BYTES as LIMIT } from '../src/file-limits';

// Pass-through wrappers, so a test can inject a file growing mid-read into the
// exact calls file-limits.ts makes.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const dirs: string[] = [];
function sourceFile(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bounded-'));
  dirs.push(dir);
  const file = path.join(dir, 'source.ts');
  fs.writeFileSync(file, bytes);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bounded source reads (#1910)', () => {
  for (const size of [0, 100, LIMIT, LIMIT + 1]) {
    it(`returns the bytes up to the limit and null past it (${size} bytes)`, async () => {
      const file = sourceFile(Buffer.alloc(size, 0x61));
      for (const result of [readBoundedSourceSync(file), await readBoundedSource(file)]) {
        expect(result.stats.size).toBe(size);
        if (size > LIMIT) expect(result.bytes).toBeNull();
        else expect(result.bytes?.length).toBe(size);
      }
    });
  }

  it('stops at the limit when the file grows during a synchronous read', () => {
    const file = sourceFile(Buffer.from('hello'));
    const readSync = vi.mocked(fs.readSync);
    const original = readSync.getMockImplementation()!;
    let requested = 0;
    let grown = false;
    readSync.mockImplementation(((fd: number, buf: Buffer, off: number, len: number, pos: number) => {
      requested += len;
      if (!grown) {
        grown = true;
        fs.writeFileSync(file, Buffer.alloc(LIMIT + 10, 0x61));
      }
      return original(fd, buf, off, len, pos);
    }) as typeof fs.readSync);
    let result;
    try { result = readBoundedSourceSync(file); } finally { readSync.mockImplementation(original); }
    expect(grown).toBe(true);
    expect(requested).toBeLessThanOrEqual(LIMIT + 1);
    expect(result.bytes).toBeNull();
  });

  it('rechecks the open descriptor when the file grows between stat and open', async () => {
    const file = sourceFile(Buffer.from('hello'));
    const open = vi.mocked(fsp.open);
    const original = open.getMockImplementation()!;
    let grown = false;
    open.mockImplementationOnce((async (...args: Parameters<typeof fsp.open>) => {
      grown = true;
      fs.writeFileSync(file, Buffer.alloc(LIMIT + 1));
      return original(...args);
    }) as typeof fsp.open);
    expect((await readBoundedSource(file)).bytes).toBeNull();
    expect(grown).toBe(true);
  });

  it('returns multibyte source byte-for-byte', async () => {
    const text = 'export const greeting = "こんにちは 🌿";';
    const file = sourceFile(Buffer.from(text));
    expect((await readBoundedSource(file)).bytes?.toString('utf8')).toBe(text);
    expect(readBoundedSourceSync(file).bytes?.toString('utf8')).toBe(text);
  });

  it('refuses a path that is not a regular file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bounded-'));
    dirs.push(dir);
    expect(() => readBoundedSourceSync(dir)).toThrow(/not a regular file/);
  });
});
