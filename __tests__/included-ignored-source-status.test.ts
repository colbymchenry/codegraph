import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodeGraph } from '../src';

describe('Explicitly included gitignored source status', () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  const write = (rel: string, source: string) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-included-status-'));
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports included additions, edits with preserved metadata, and deletions', async () => {
    write('local/Device.java', 'package p; public class Device { public void run() {} }');
    write('local/excluded/Noise.java', 'public class Noise {}');
    write('.gitignore', 'local/\n');
    write('codegraph.json', JSON.stringify({ include: ['local/'], exclude: ['local/excluded/'] }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=a@b.c', 'commit', '-qm', 'base'], { cwd: dir });
    cg = await CodeGraph.init(dir, { index: true });
    expect(cg.getNodesByName('Device')).toHaveLength(1);
    expect(cg.getNodesByName('Noise')).toHaveLength(0);
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });

    const file = path.join(dir, 'local/Device.java');
    const originalStat = fs.statSync(file);
    // Git never reports this ignored file, and metadata cannot prove it unchanged.
    write('local/Device.java', 'package p; public class Device { public void end() {} }');
    fs.utimesSync(file, originalStat.atime, originalStat.mtime);
    expect(fs.statSync(file).size).toBe(originalStat.size);
    expect(cg.getChangedFiles().modified).toEqual(['local/Device.java']);

    write('local/New.java', 'package p; public class New {}');
    write('local/excluded/NewNoise.java', 'public class NewNoise {}');
    expect(cg.getChangedFiles().added).toEqual(['local/New.java']);
    fs.rmSync(file);
    expect(cg.getChangedFiles().removed).toEqual(['local/Device.java']);
  });
});
