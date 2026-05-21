/**
 * Completion-emitter tests
 *
 * Builds a small commander program with every option/argument shape
 * the emitters need to handle, then asserts each shell's output
 * contains the expected lines. We don't snapshot the full script —
 * that would break every time someone edits a description — but we do
 * pin the structural pieces (function names, value hints, alias dispatch).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  emit,
  parseShell,
  SUPPORTED_SHELLS,
  detectInstallTarget,
} from '../src/completions';

const buildProgram = (): Command => {
  const program = new Command();
  program.name('codegraph').description('test program').version('0.0.0');

  program
    .command('init [path]')
    .description('Initialize CodeGraph')
    .option('-i, --index', 'Run initial indexing')
    .option('-v, --verbose', 'Verbose output')
    .action(() => {});

  program
    .command('query <search>')
    .description('Search for symbols')
    .option('-p, --path <path>', 'Project path')
    .option('-l, --limit <number>', 'Maximum results', '10')
    .option('-j, --json', 'Output as JSON')
    .action(() => {});

  program
    .command('affected [files...]')
    .description('Find affected tests')
    .alias('a')
    .option('--stdin', 'Read from stdin')
    .action(() => {});

  return program;
};

describe('completions/parseShell', () => {
  it('accepts supported shells case-insensitively', () => {
    for (const s of SUPPORTED_SHELLS) {
      expect(parseShell(s)).toBe(s);
      expect(parseShell(s.toUpperCase())).toBe(s);
    }
  });

  it('resolves common powershell aliases', () => {
    expect(parseShell('pwsh')).toBe('powershell');
    expect(parseShell('PS')).toBe('powershell');
    expect(parseShell('ps1')).toBe('powershell');
  });

  it('rejects unknown shells', () => {
    expect(parseShell('nushell')).toBeNull();
    expect(parseShell('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// detectInstallTarget — exercises each tier by manipulating env + tmp
// dirs so we don't depend on whether the test machine has oh-my-zsh,
// Homebrew, etc. Each test owns its own tmp tree to avoid cross-talk.
// ─────────────────────────────────────────────────────────────────────

describe('completions/detectInstallTarget', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-install-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('zsh', () => {
    it('tier 1: picks oh-my-zsh when $ZSH points to a writable dir', () => {
      const zshDir = path.join(tmpHome, '.oh-my-zsh');
      fs.mkdirSync(zshDir, { recursive: true });
      const target = detectInstallTarget('zsh', { ZSH: zshDir }, tmpHome);
      expect(target).not.toBeNull();
      expect(target!.source).toBe('oh-my-zsh');
      expect(target!.path).toBe(path.join(zshDir, 'completions', '_codegraph'));
      expect(target!.postInstallHint).toBeUndefined();
    });

    it('tier 3: falls back to ~/.zsh/completions with fpath hint when no signals', () => {
      // Empty env (no ZSH), and we pass a tmpHome that doesn't have
      // /opt/homebrew or /usr/local — but `detectZsh` checks real
      // filesystem paths for Homebrew, not under tmpHome. To make the
      // test deterministic regardless of host, we accept that
      // Homebrew tier may pick up if the test machine has it. The
      // assertion below holds either way: when no oh-my-zsh signal is
      // present, source is one of homebrew-zsh / zsh-fallback.
      const target = detectInstallTarget('zsh', {}, tmpHome);
      expect(target).not.toBeNull();
      expect(['zsh-site-functions', 'zsh-fallback']).toContain(target!.source);
      if (target!.source === 'zsh-fallback') {
        expect(target!.path).toBe(
          path.join(tmpHome, '.zsh', 'completions', '_codegraph'),
        );
        expect(target!.postInstallHint).toMatch(/fpath/);
      }
    });
  });

  describe('bash', () => {
    it('falls back to XDG bash-completion path under HOME when no Homebrew', () => {
      // Same caveat as zsh: if test machine has /opt/homebrew/etc/
      // bash_completion.d writable, that tier wins. Otherwise XDG.
      const target = detectInstallTarget('bash', {}, tmpHome);
      expect(target).not.toBeNull();
      expect(['homebrew-bash-completion', 'xdg-bash-completion']).toContain(
        target!.source,
      );
      if (target!.source === 'xdg-bash-completion') {
        expect(target!.path).toBe(
          path.join(
            tmpHome,
            '.local',
            'share',
            'bash-completion',
            'completions',
            'codegraph',
          ),
        );
      }
    });

    it('honors $XDG_DATA_HOME override', () => {
      const xdg = path.join(tmpHome, 'custom-xdg');
      fs.mkdirSync(xdg, { recursive: true });
      const target = detectInstallTarget('bash', { XDG_DATA_HOME: xdg }, tmpHome);
      // Only assert XDG-tier behavior; Homebrew tier (if it wins on
      // the host) doesn't read XDG_DATA_HOME so this check still
      // exercises the XDG branch on most dev machines.
      if (target?.source === 'xdg-bash-completion') {
        expect(target.path).toBe(
          path.join(xdg, 'bash-completion', 'completions', 'codegraph'),
        );
      }
    });
  });

  describe('fish', () => {
    it('always returns ~/.config/fish/completions/codegraph.fish', () => {
      const target = detectInstallTarget('fish', {}, tmpHome);
      expect(target).not.toBeNull();
      expect(target!.source).toBe('fish-config');
      expect(target!.path).toBe(
        path.join(tmpHome, '.config', 'fish', 'completions', 'codegraph.fish'),
      );
    });
  });

  describe('powershell', () => {
    it('returns a standalone .ps1 path + a profile path + a dot-source line', () => {
      const target = detectInstallTarget('powershell', {}, tmpHome);
      expect(target).not.toBeNull();
      expect(target!.source).toBe('pwsh-profile-dir');
      // Linux/macOS test runner — Windows branch tested in CI on win.
      expect(target!.path).toContain(path.join('.config', 'powershell'));
      expect(target!.path).toMatch(/codegraph\.ps1$/);
      expect(target!.profilePath).toMatch(/Microsoft\.PowerShell_profile\.ps1$/);
      expect(target!.profileLine).toMatch(/^\. '.*codegraph\.ps1'/);
      expect(target!.profileLine).toContain('# codegraph completions');
    });
  });
});

describe('completions/zsh', () => {
  const out = emit(buildProgram(), 'zsh');

  it('starts with #compdef directive', () => {
    expect(out.startsWith('#compdef codegraph\n')).toBe(true);
  });

  it('emits a per-subcommand function for each command', () => {
    expect(out).toContain('_codegraph_init()');
    expect(out).toContain('_codegraph_query()');
    expect(out).toContain('_codegraph_affected()');
  });

  it('emits paired short/long option specs with descriptions', () => {
    expect(out).toContain("'(-i --index)'{-i,--index}'[Run initial indexing]'");
  });

  it('emits value hints for options with <path>-style values', () => {
    // -p/--path takes a value; valueName is "path" which triggers _files hint.
    expect(out).toContain(':path:_files');
  });

  it('routes aliases to the same function as the canonical name', () => {
    // `affected` has alias `a` — both should dispatch to _codegraph_affected.
    expect(out).toMatch(/affected\|a\) _codegraph_affected/);
  });

  it('treats variadic positional as *', () => {
    expect(out).toContain("'*:files:");
  });
});

describe('completions/bash', () => {
  const out = emit(buildProgram(), 'bash');

  it('defines and registers _codegraph', () => {
    expect(out).toContain('_codegraph() {');
    expect(out).toContain('complete -F _codegraph codegraph');
  });

  it('lists all subcommands (canonical + alias) for top-level completion', () => {
    expect(out).toMatch(/init uninit|init query affected a/);
    // Loose check: every canonical name + the alias should appear in the
    // subcommand word list.
    for (const name of ['init', 'query', 'affected', 'a']) {
      expect(out).toContain(name);
    }
  });

  it('case-matches alias to the same arm', () => {
    expect(out).toMatch(/affected\|a\)/);
  });

  it('triggers file completion after an option whose value is path-like', () => {
    expect(out).toMatch(/-p\|--path\)\s*\n\s*COMPREPLY=\( \$\(compgen -f --/);
  });
});

describe('completions/fish', () => {
  const out = emit(buildProgram(), 'fish');

  it('starts with a comment header', () => {
    expect(out.startsWith('# Fish completion for codegraph.')).toBe(true);
  });

  it('emits a __fish_use_subcommand line per subcommand (canonical + alias)', () => {
    expect(out).toContain("-a 'init'");
    expect(out).toContain("-a 'affected'");
    expect(out).toContain("-a 'a'"); // alias
  });

  it('flags options that take a value with -r and value hints', () => {
    // --path uses -F (file hint) because valueName "path" is in the file set.
    expect(out).toContain('-l path -r -F');
    // --limit takes a value but valueName is "number" -> -x (no file hint).
    expect(out).toContain('-l limit -r -x');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Help/version coverage — guards the introspect layer's behavior of
// injecting --help/-h on every command (commander doesn't expose them
// via .options) and only emitting --version once (commander's
// .version() puts -V/--version on .options exactly once).
// ─────────────────────────────────────────────────────────────────────

describe('completions/help-version', () => {
  // Count occurrences of an exact-match flag token in the emitter output.
  // Looks for `--flag` either standalone, in option specs ('--flag'),
  // or in CompletionResult literals — each emitter has its own format
  // so we count distinct flag mentions rather than line counts.
  const countFlag = (out: string, flag: string): number => {
    // Match the flag bounded by non-flag characters or end-of-line.
    // Excludes prefix-overlaps (e.g. --version vs --version-foo).
    const re = new RegExp(`(?<![\\w-])${flag.replace('-', '\\-')}(?![\\w-])`, 'g');
    return (out.match(re) || []).length;
  };

  it('zsh: --version appears (commander auto-registered, not duplicated)', () => {
    const out = emit(buildProgram(), 'zsh');
    // Zsh paired-spec emits --version twice in the `'(-V --version)'{-V,--version}'[…]'`
    // syntax; that's intentional (it's one option spec). Hardcoded
    // duplicate would have produced two separate _arguments lines.
    expect(out).toMatch(/'\(-V --version\)'\{-V,--version\}/);
    // Should be exactly one matching pair, not two.
    expect((out.match(/'\(-V --version\)'/g) ?? []).length).toBe(1);
  });

  it('bash: --version appears once in the rootFlags list', () => {
    const out = emit(buildProgram(), 'bash');
    // The root-flag list is a single compgen -W "..." string; --version
    // should appear once. Duplicates would show as two tokens.
    const rootFlagsLine = out.match(/compgen -W "([^"]*)" -- "\$cur"/)?.[1] ?? '';
    expect(rootFlagsLine.split(/\s+/).filter((f) => f === '--version').length).toBe(1);
  });

  it('fish: --version appears once (as -l version spec, not literal)', () => {
    // Fish encodes flags via `-s X -l XX` rather than emitting the
    // literal `--X`. One occurrence of `-l version` per command path.
    const out = emit(buildProgram(), 'fish');
    expect((out.match(/-l version\b/g) ?? []).length).toBe(1);
  });

  it('powershell: --version appears once in root switch arm', () => {
    const out = emit(buildProgram(), 'powershell');
    // PS emits each CompletionResult as `[CompletionResult]::new('--version', '--version', …)`
    // — two text occurrences per emission. One emission = 2 matches.
    expect(countFlag(out, '--version')).toBe(2);
  });

  it('zsh: --help spec appears on root + every subcommand', () => {
    // Zsh emits `'(-h --help)'{-h,--help}'[…]'` per command via _arguments.
    // Test program: root + 3 subs = 4 total.
    const out = emit(buildProgram(), 'zsh');
    expect((out.match(/'\(-h --help\)'\{-h,--help\}/g) ?? []).length).toBe(4);
  });

  it('bash: --help appears in every flag-completion compgen list', () => {
    // Bash emits `compgen -W "<words>"` lists for both flag-completion
    // (where words look like `-x --xx -h --help`) and subcommand-name
    // completion (`init query affected a`). Only the flag lists need
    // --help; capture and filter on the word-list content (a flag list
    // is one where the first word starts with `-`).
    const out = emit(buildProgram(), 'bash');
    const wordLists: string[] = [];
    const re = /compgen -W "([^"]*)" -- "\$cur"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) wordLists.push(m[1]);
    const flagLists = wordLists.filter((w) => w.trim().startsWith('-'));
    expect(flagLists.length).toBeGreaterThanOrEqual(4); // root flags + 3 subs
    for (const list of flagLists) {
      expect(list.split(/\s+/)).toContain('--help');
    }
  });

  it('fish: -l help appears on root + every subcommand condition block', () => {
    // Fish emits one `complete -c codegraph -n '<cond>' -s h -l help …`
    // line per command path. Conditions can be `__fish_use_subcommand`
    // (root) or `__fish_seen_subcommand_from <name1> [<name2> …]`
    // (per-sub, possibly with aliases joined by spaces).
    const out = emit(buildProgram(), 'fish');
    expect((out.match(/-s h -l help\b/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('powershell: --help/-h appear in every switch arm', () => {
    const out = emit(buildProgram(), 'powershell');
    // Root arm + per-sub arms + per-alias arms. Each gets help injected.
    const arms = out.match(/'codegraph(;[^']+)?' \{[\s\S]*?break\n        \}/g) ?? [];
    expect(arms.length).toBeGreaterThanOrEqual(4);
    for (const arm of arms) {
      expect(arm).toContain("'--help'");
      expect(arm).toContain("'-h'");
    }
  });
});

describe('completions/powershell', () => {
  const out = emit(buildProgram(), 'powershell');

  it('opens with using-namespace declarations', () => {
    expect(out).toContain('using namespace System.Management.Automation');
    expect(out).toContain('using namespace System.Management.Automation.Language');
  });

  it('registers a Native completer for codegraph', () => {
    expect(out).toContain(
      "Register-ArgumentCompleter -Native -CommandName 'codegraph'",
    );
  });

  it('builds command path by joining elements with semicolons', () => {
    expect(out).toContain("-join ';'");
  });

  it('emits a switch arm for each canonical subcommand', () => {
    expect(out).toContain("'codegraph;init' {");
    expect(out).toContain("'codegraph;query' {");
    expect(out).toContain("'codegraph;affected' {");
  });

  it('emits a switch arm for each alias surface (so `a` works like `affected`)', () => {
    expect(out).toContain("'codegraph;a' {");
  });

  it('emits CompletionResult entries with ParameterName for flags', () => {
    expect(out).toMatch(
      /\[CompletionResult\]::new\('--index', '--index', \[CompletionResultType\]::ParameterName/,
    );
  });

  it('emits CompletionResult entries with ParameterValue for subcommands', () => {
    expect(out).toMatch(
      /\[CompletionResult\]::new\('init', 'init', \[CompletionResultType\]::ParameterValue/,
    );
  });

  it('filters by $wordToComplete prefix at the end', () => {
    expect(out).toContain('$_.CompletionText -like "$wordToComplete*"');
  });

  it("escapes single quotes in descriptions (PS '' escape rule)", () => {
    const prog = new Command();
    prog.name('foo').version('0');
    prog.command('weird').description("it's tricky").action(() => {});
    const psOut = emit(prog, 'powershell');
    expect(psOut).toContain("it''s tricky");
  });
});
