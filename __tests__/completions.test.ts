/**
 * Completion-emitter tests
 *
 * Builds a small commander program with every option/argument shape
 * the emitters need to handle, then asserts each shell's output
 * contains the expected lines. We don't snapshot the full script —
 * that would break every time someone edits a description — but we do
 * pin the structural pieces (function names, value hints, alias dispatch).
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { emit, parseShell, SUPPORTED_SHELLS, installPathFor } from '../src/completions';

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

  it('rejects unknown shells', () => {
    expect(parseShell('powershell')).toBeNull();
    expect(parseShell('')).toBeNull();
  });
});

describe('completions/installPathFor', () => {
  it('returns per-shell standard paths', () => {
    expect(installPathFor('zsh')).toMatch(/\.zsh\/completions\/_codegraph$/);
    expect(installPathFor('bash')).toMatch(
      /\.local\/share\/bash-completion\/completions\/codegraph$/,
    );
    expect(installPathFor('fish')).toMatch(/\.config\/fish\/completions\/codegraph\.fish$/);
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
