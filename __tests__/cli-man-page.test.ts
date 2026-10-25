/** codegraph man -- generator test (#1828). */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { renderManPage, escapeRoff } from '../dist/bin/man-page';

function bareProgram() {
  const p = new Command();
  p.name('codegraph');
  p.description('Code intelligence and knowledge graph');
  p.version('1.6.2');
  return p;
}

describe('renderManPage', () => {
  const ver = '1.6.2';

  it('has all roff sections', () => {
    const p = bareProgram();
    p.command('init');
    const out = renderManPage(p, { version: ver, date: '2026-10-25' });
    expect(out).toContain('.TH CODEGRAPH 1');
    expect(out).toContain('.SH NAME');
    expect(out).toContain('.SH SYNOPSIS');
    expect(out).toContain('.SH COMMANDS');
    expect(out).toContain('.SH ENVIRONMENT');
    expect(out).toContain('.SH BUGS');
  });

  it('non-hidden appear, hidden do not', () => {
    const p = bareProgram();
    p.command('init'); p.command('sync');
    p.command('hcmd_xyz', { hidden: true });
    const out = renderManPage(p, { version: ver, date: '2026-10-25' });
    expect(out).toContain('init');
    expect(out).toContain('sync');
    expect(out).not.toContain('hcmd_xyz');
  });

  it('no bare-dot prose lines', () => {
    const p = bareProgram();
    p.command('init');
    const out = renderManPage(p, { version: ver, date: '2026-10-25' });
    for (const ln of out.split('\n')) {
      if (!ln.startsWith('.')) continue;
      const c2 = ln.charCodeAt(1) || 0, c3 = ln.charCodeAt(2) || 0;
      const ok = ln.startsWith(".TH") || ln.startsWith(".SH")
        || ln.startsWith(".TP") || ln.startsWith(".RS")
        || ln.startsWith(".RE") || ln.startsWith(".B ")
        || (c2 === 92 && c3 === 34);
      expect(ok).toBe(true);
    }
  });

  it('contains version', () => {
    const p = bareProgram();
    p.command('init');
    const out = renderManPage(p, { version: ver, date: '2026-10-25' });
    expect(out).toContain('codegraph 1.6.2');
  });

  it('escapeRoff escapes hyphens', () => {
    const bs = String.fromCharCode(92);
    expect(escapeRoff('a-b')).toBe('a' + bs + '-' + 'b');
  });
});
