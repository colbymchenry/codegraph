/**
 * `codegraph ui` (alias `web`) is withheld until the viewer is released: every
 * way of reaching it is refused before startup, and it is left out of `--help`,
 * unless CODEGRAPH_UI=1 opts in (src/bin/viewer-gate.ts).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { requestedViewerCommand, viewerEnabled } from '../src/bin/viewer-gate';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runCli(args: string[], optIn: boolean): { code: number; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' };
  if (optIn) env.CODEGRAPH_UI = '1';
  else delete env.CODEGRAPH_UI;
  try {
    const output = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('viewer gate', () => {
  it('finds the viewer command however it is asked for, and nothing else', () => {
    expect(requestedViewerCommand(['ui'])).toBe('ui');
    expect(requestedViewerCommand(['web', '--port', '0'])).toBe('web');
    expect(requestedViewerCommand(['help', 'ui'])).toBe('ui');
    expect(requestedViewerCommand(['ui', '--help'])).toBe('ui');
    expect(requestedViewerCommand(['--no-color', 'ui', '.'])).toBe('ui');
    expect(requestedViewerCommand([])).toBeNull();
    expect(requestedViewerCommand(['help'])).toBeNull();
    expect(requestedViewerCommand(['explore', 'ui'])).toBeNull();
    expect(requestedViewerCommand(['query', 'web'])).toBeNull();
  });

  it('is enabled only by CODEGRAPH_UI=1', () => {
    expect(viewerEnabled({})).toBe(false);
    expect(viewerEnabled({ CODEGRAPH_UI: '0' })).toBe(false);
    expect(viewerEnabled({ CODEGRAPH_UI: 'true' })).toBe(false);
    expect(viewerEnabled({ CODEGRAPH_UI: '1' })).toBe(true);
  });

  it.each([['ui'], ['web'], ['help', 'ui'], ['ui', '--help'], ['--no-color', 'web', '--no-open']])(
    'refuses `codegraph %s` without the opt-in',
    (...args) => {
      const r = runCli(args, false);
      expect(r.code).toBe(1);
      expect(r.output).toMatch(/is not in this release yet/);
      expect(r.output).not.toMatch(/Listening|http:\/\/127\.0\.0\.1/);
    }
  );

  it('leaves the viewer out of --help unless opted in', () => {
    const hidden = runCli(['--help'], false);
    expect(hidden.code).toBe(0);
    expect(hidden.output).not.toMatch(/^\s+ui \[path\]/m);
    expect(hidden.output).toMatch(/^\s+explore /m);

    const shown = runCli(['--help'], true);
    expect(shown.code).toBe(0);
    expect(shown.output).toMatch(/^\s+ui\|web \[options\] \[path\]|^\s+ui \[options\] \[path\]/m);
  });

  it('with the opt-in, `ui --help` still describes the command', () => {
    const r = runCli(['ui', '--help'], true);
    expect(r.code).toBe(0);
    expect(r.output).toContain('--no-open');
  });
});
