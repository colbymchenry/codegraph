/**
 * An MPEG transport stream named `.ts` is not TypeScript (#1910).
 *
 * Golden video fixtures (`testdata/*.ts`) share TypeScript's extension; fed to
 * the tree-sitter TypeScript parser a 900 KB clip costs ~28 s of CPU for zero
 * symbols. The fix recognises the stream from the head of the file (0x47 sync
 * byte at each 188-byte packet boundary, plus a NUL byte no UTF-8 source has)
 * and drops it at discovery — not indexed, not parsed, not counted, not
 * reported as an unsupported language.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { scanDirectoryAsync, type ScanSkipStats } from '../src/extraction';
import { detectLanguage, isMpegTransportStream, MPEG_TS_SNIFF_BYTES } from '../src/extraction/grammars';

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
 * Real TypeScript engineered to put the letter `G` (0x47) at offsets 0, 188,
 * 376 and 564 — the sync-byte pattern alone. It must stay TypeScript.
 */
function makeGammaSource(): string {
  const lines: string[] = [];
  let text = '';
  for (let i = 0; i < 4; i++) {
    const line = `Gamma${i}();`;
    const pad = PACKET - line.length - 1;
    text += line + ' '.repeat(pad) + '\n';
    lines.push(line);
  }
  text += 'export function Gamma0() { return 0; }\n';
  text += 'export function Gamma1() { return 1; }\n';
  text += 'export function Gamma2() { return 2; }\n';
  text += 'export function Gamma3() { return 3; }\n';
  for (const off of [0, PACKET, 2 * PACKET, 3 * PACKET]) {
    if (text.charCodeAt(off) !== 0x47) throw new Error(`fixture: expected G at ${off}`);
  }
  void lines;
  return text;
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

  it('needs four aligned sync bytes — a head too short, or one packet off, is not video', () => {
    const ts = makeMpegTs(40);
    expect(isMpegTransportStream(ts.subarray(0, 3 * PACKET))).toBe(false);
    const broken = Buffer.from(ts);
    broken[2 * PACKET] = 0x48;
    expect(isMpegTransportStream(broken)).toBe(false);
    expect(isMpegTransportStream(Buffer.alloc(0))).toBe(false);
  });

  it('does not take source text with G at every 188th byte for video', () => {
    const bytes = Buffer.from(makeGammaSource(), 'utf-8');
    expect(bytes[0]).toBe(0x47);
    expect(bytes[3 * PACKET]).toBe(0x47);
    expect(isMpegTransportStream(bytes)).toBe(false);
    expect(detectLanguage('gamma.ts', makeGammaSource())).toBe('typescript');
  });
});

describe('MPEG-TS video named .ts is skipped, real TypeScript is indexed (#1910)', () => {
  it('drops the clip at discovery: no file record, no nodes, no unsupported-language report', async () => {
    const dir = createProject();
    fs.mkdirSync(path.join(dir, 'testdata'));
    fs.writeFileSync(path.join(dir, 'testdata', 'clip.ts'), makeMpegTs(40));
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export function greet(n: string) { return `hi ${n}`; }\n');
    fs.writeFileSync(path.join(dir, 'gamma.ts'), makeGammaSource());

    const stats: ScanSkipStats = { unsupportedByExtension: new Map() };
    const scanned = await scanDirectoryAsync(dir, undefined, stats);
    expect(scanned.sort()).toEqual(['app.ts', 'gamma.ts']);
    expect(stats.unsupportedByExtension.size).toBe(0);

    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const files = cg.getFiles().map((f) => f.path).sort();
      expect(files).toEqual(['app.ts', 'gamma.ts']);
      expect(cg.searchNodes('greet').some((r) => r.node.name === 'greet')).toBe(true);
      expect(cg.searchNodes('Gamma2').some((r) => r.node.name === 'Gamma2')).toBe(true);

      // A named re-sync (the watcher / `sync` path hands files in by name) must
      // not let the clip back in either.
      await cg.sync({ paths: ['testdata/clip.ts', 'app.ts'] });
      expect(cg.getFiles().map((f) => f.path).sort()).toEqual(['app.ts', 'gamma.ts']);
    } finally {
      await cg.close();
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
