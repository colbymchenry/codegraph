import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanDirectory } from '../src/extraction';
import { detectLanguage, isSourceFile } from '../src/extraction/grammars';
import { looksLikeShellScript } from '../src/extraction/shebang';
import { FileWatcher, __emitWatchEventForTests } from '../src/sync/watcher';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('extensionless shell script detection', () => {
  it('recognizes direct and env shell shebangs within the bounded first line', () => {
    expect(looksLikeShellScript('#!/bin/bash\necho ok\n')).toBe(true);
    expect(looksLikeShellScript('#!/bin/dash\necho ok\n')).toBe(true);
    expect(looksLikeShellScript('#!/usr/bin/env -S bash -eu\necho ok\n')).toBe(true);
    expect(looksLikeShellScript('#!/usr/bin/python3\nprint(1)\n')).toBe(false);
    expect(looksLikeShellScript('echo no shebang\n')).toBe(false);
  });

  it('uses file content only when a root is supplied', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shebang-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'deploy'), '#!/bin/sh\nhelper\n');

    expect(isSourceFile('deploy')).toBe(false);
    expect(isSourceFile('deploy', root)).toBe(true);
    expect(detectLanguage('deploy', '#!/bin/sh\nhelper\n')).toBe('bash');
  });

  it('finds and parses extensionless shell scripts in the filesystem scan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shebang-scan-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'deploy'), '#!/usr/bin/env bash\nmain() { helper; }\n');
    fs.writeFileSync(path.join(root, 'README'), 'not source\n');

    expect(scanDirectory(root)).toEqual(['deploy']);
  });

  it('passes extensionless shell changes through the watcher filter', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shebang-watch-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'deploy'), '#!/bin/sh\necho ok\n');
    const sync = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 1 });
    const watcher = new FileWatcher(root, sync, { inertForTests: true, debounceMs: 1 });
    watcher.start();

    __emitWatchEventForTests(root, 'deploy');
    await new Promise((resolve) => setTimeout(resolve, 150));
    watcher.stop();

    expect(sync).toHaveBeenCalledWith(['deploy']);
  });
});
