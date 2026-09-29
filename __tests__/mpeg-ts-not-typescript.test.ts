/**
 * An MPEG transport stream named `.ts` is not TypeScript (#1910).
 *
 * Golden video fixtures (`testdata/*.ts`) share TypeScript's extension; fed to
 * the tree-sitter TypeScript parser a 900 KB clip costs ~28 s of CPU for zero
 * symbols. The fix recognises the stream from the bytes it reads anyway (0x47
 * sync byte at each 188-byte packet boundary, and a binary head) and never
 * indexes it — not parsed, not stored, not reported as an unsupported
 * language, and never pending on a later sync.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { CodeGraph } from '../src';
import { scanDirectoryAsync, type ScanSkipStats } from '../src/extraction';
import { detectLanguage, isMpegTransportStream, MPEG_TS_SNIFF_BYTES } from '../src/extraction/grammars';

// A configurable `fs`, so a test can watch the opens discovery makes.
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

const PACKET = 188;

/** A synthetic transport stream: `packets` × 188 bytes, 0x47 then pseudo-random payload. */
function makeMpegTs(packets: number, seed = 1): Buffer {
  const buf = Buffer.alloc(packets * PACKET);
  let x = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = i % PACKET === 0 ? 0x47 : x >>> 24;
  }
  // Every real stream opens with PSI tables whose pointer field is 0x00.
  buf[4] = 0;
  return buf;
}

/**
 * Real TypeScript engineered to put the letter `G` (0x47) at the start of each
 * of its first `packets` 188-byte strides — the sync-byte pattern alone. With
 * `nul`, one raw NUL sits inside a comment (the review's counterexample on
 * #1915). It must stay TypeScript either way.
 */
function makeGammaSource(packets = 4, nul = false): string {
  let text = '';
  for (let i = 0; i < packets; i++) {
    const line = `Gamma${i}();` + (nul && i === 1 ? ' // \u0000' : '');
    const pad = PACKET - line.length - 1;
    text += line + ' '.repeat(pad) + '\n';
  }
  for (let i = 0; i < packets; i++) text += `export function Gamma${i}() { return ${i}; }\n`;
  text += 'export function realFn() { return 1; }\n';
  for (let off = 0; off < packets * PACKET; off += PACKET) {
    if (text.charCodeAt(off) !== 0x47) throw new Error(`fixture: expected G at ${off}`);
  }
  return text;
}

/** A stream that opens the usual way: PAT and PMT packets stuffed with 0xFF, then payload. */
function makePsiLedMpegTs(packets: number): Buffer {
  const buf = makeMpegTs(packets, 7);
  for (const start of [0, PACKET]) {
    buf.fill(0xff, start + 4, start + PACKET);
    buf[start + 1] = 0x40;
    buf[start + 2] = start === 0 ? 0x00 : 0x10;
    buf[start + 3] = 0x10;
  }
  return buf;
}

const tempDirs: string[] = [];
function createProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mpegts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('isMpegTransportStream', () => {
  it('recognises a transport stream from its head', () => {
    const ts = makeMpegTs(40);
    expect(isMpegTransportStream(ts.subarray(0, MPEG_TS_SNIFF_BYTES))).toBe(true);
    expect(isMpegTransportStream(ts)).toBe(true);
  });

  it('needs sixteen aligned sync bytes — a head too short, or one packet off, is not video', () => {
    const ts = makeMpegTs(40);
    expect(isMpegTransportStream(ts.subarray(0, 15 * PACKET))).toBe(false);
    for (const packet of [2, 15]) {
      const broken = Buffer.from(ts);
      broken[packet * PACKET] = 0x48;
      expect(isMpegTransportStream(broken)).toBe(false);
    }
    expect(isMpegTransportStream(Buffer.alloc(0))).toBe(false);
  });

  it('recognises a stream that opens with 0xFF-stuffed PAT and PMT packets', () => {
    expect(isMpegTransportStream(makePsiLedMpegTs(40).subarray(0, MPEG_TS_SNIFF_BYTES))).toBe(true);
  });

  it('does not take source text with G at every 188th byte for video', () => {
    const bytes = Buffer.from(makeGammaSource(), 'utf-8');
    expect(bytes[0]).toBe(0x47);
    expect(bytes[3 * PACKET]).toBe(0x47);
    expect(isMpegTransportStream(bytes)).toBe(false);
    expect(detectLanguage('gamma.ts', makeGammaSource())).toBe('typescript');
  });

  it('does not take source with G at every stride and a NUL in a comment for video (#1915 review)', () => {
    for (const packets of [4, 16, 20]) {
      const bytes = Buffer.from(makeGammaSource(packets, true), 'utf-8');
      expect(bytes.includes(0)).toBe(true);
      expect(isMpegTransportStream(bytes.subarray(0, MPEG_TS_SNIFF_BYTES))).toBe(false);
    }
  });
});

describe('MPEG-TS video named .ts is skipped, real TypeScript is indexed (#1910)', () => {
  it('never indexes the clip: no file record, no nodes, no unsupported-language report', async () => {
    const dir = createProject();
    fs.mkdirSync(path.join(dir, 'testdata'));
    fs.writeFileSync(path.join(dir, 'testdata', 'clip.ts'), makeMpegTs(40));
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export function greet(n: string) { return `hi ${n}`; }\n');
    fs.writeFileSync(path.join(dir, 'gamma.ts'), makeGammaSource());
    fs.writeFileSync(path.join(dir, 'gamma-nul.ts'), makeGammaSource(16, true));

    // Discovery lists every `.ts` by name and reads none of them: sniffing each
    // one's head there would be a random read per file per scan. The bytes are
    // judged where they are read anyway.
    const stats: ScanSkipStats = { unsupportedByExtension: new Map() };
    const scanned = await scanDirectoryAsync(dir, undefined, stats);
    expect(scanned.sort()).toEqual(['app.ts', 'gamma-nul.ts', 'gamma.ts', 'testdata/clip.ts']);
    expect(stats.unsupportedByExtension.size).toBe(0);

    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const files = cg.getFiles().map((f) => f.path).sort();
      expect(files).toEqual(['app.ts', 'gamma-nul.ts', 'gamma.ts']);
      expect(cg.searchNodes('greet').some((r) => r.node.name === 'greet')).toBe(true);
      expect(cg.searchNodes('Gamma2').some((r) => r.node.name === 'Gamma2')).toBe(true);
      // The review's counterexample: G at every stride and a NUL in a comment.
      expect(cg.searchNodes('realFn').filter((r) => r.node.filePath === 'gamma-nul.ts')).toHaveLength(1);

      // A named re-sync (the watcher / `sync` path hands files in by name) must
      // not let the clip back in either.
      await cg.sync({ paths: ['testdata/clip.ts', 'app.ts'] });
      expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['app.ts', 'gamma-nul.ts', 'gamma.ts']);
    } finally {
      await cg.close();
    }
  });

  it('discovery opens no file, on the directory walk or the git path', async () => {
    for (const withGit of [false, true]) {
      const dir = createProject();
      fs.writeFileSync(path.join(dir, 'clip.ts'), makeMpegTs(40));
      fs.writeFileSync(path.join(dir, 'app.ts'), 'export const a = 1;\n');
      if (withGit) {
        const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
        git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
        git('add', '.'); git('commit', '-qm', 'init');
      }
      const opened: string[] = [];
      const real = fs.openSync;
      const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
        opened.push(String(file));
        return (real as (...args: unknown[]) => number)(file, ...rest);
      }) as typeof fs.openSync);
      let scanned: string[];
      try {
        scanned = await scanDirectoryAsync(dir);
      } finally {
        spy.mockRestore();
      }
      expect(scanned.sort()).toEqual(['app.ts', 'clip.ts']);
      expect(opened.filter((f) => f.endsWith('.ts'))).toEqual([]);
    }
  });

  it('reports nothing skipped for a project of only source and video', async () => {
    const dir = createProject();
    fs.writeFileSync(path.join(dir, 'clip.ts'), makeMpegTs(40));
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const a = 1;\n');
    const cg = await CodeGraph.init(dir);
    try {
      const result = await cg.indexAll();
      expect(result.filesSkippedUnsupported).toBeUndefined();
      expect(result.topUnsupportedExtensions).toBeUndefined();
      expect(result.errors.filter((e) => e.filePath === 'clip.ts')).toEqual([]);
      expect(cg.getFiles().map((f) => f.path)).toEqual(['app.ts']);
    } finally {
      await cg.close();
    }
  });

  it('indexes past a 900 KB clip in well under two seconds', async () => {
    const dir = createProject();
    fs.mkdirSync(path.join(dir, 'testdata'));
    fs.writeFileSync(path.join(dir, 'testdata', 'golden.ts'), makeMpegTs(Math.ceil((900 * 1024) / PACKET)));
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export function greet(n: string) { return `hi ${n}`; }\n');
    const cg = await CodeGraph.init(dir);
    try {
      const t0 = Date.now();
      const result = await cg.indexAll();
      const elapsed = Date.now() - t0;
      expect(result.filesIndexed).toBe(1);
      expect(cg.getFiles().map((f) => f.path)).toEqual(['app.ts']);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await cg.close();
    }
  });
});

describe('a video .ts never stays pending (#1910)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const gitProject = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mpegts-git-'));
    dirs.push(dir);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const a = 1;\n');
    git('add', '.'); git('commit', '-qm', 'init');
    return dir;
  };

  it('an untracked clip is not reported as added, before or after sync', async () => {
    const dir = gitProject();
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      fs.writeFileSync(path.join(dir, 'clip.ts'), makeMpegTs(40));
      expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
      await cg.sync();
      expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
      expect(cg.getFiles().map((f) => f.path)).toEqual(['app.ts']);
    } finally {
      cg.close();
    }
  });

  it('a tracked TypeScript file that becomes a clip is removed, on the git path and on a scoped sync', async () => {
    for (const scoped of [false, true]) {
      const dir = gitProject();
      fs.writeFileSync(path.join(dir, 'clip.ts'), 'export const clip = 1;\n');
      const cg = await CodeGraph.init(dir, { index: true });
      try {
        expect(cg.getNodesInFile('clip.ts').some((n) => n.name === 'clip')).toBe(true);
        fs.writeFileSync(path.join(dir, 'clip.ts'), makeMpegTs(40));
        if (!scoped) expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: ['clip.ts'] });
        await (scoped ? cg.sync({ paths: ['clip.ts'] }) : cg.sync());
        expect(cg.getFiles().map((f) => f.path)).toEqual(['app.ts']);
        expect(cg.getNodesInFile('clip.ts')).toEqual([]);
        expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
      } finally {
        cg.close();
      }
    }
  });
});
