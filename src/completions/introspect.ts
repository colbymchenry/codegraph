/**
 * Normalize a commander `Command` tree into a plain descriptor each
 * shell emitter walks. Keeps commander coupling in one place; if
 * commander's introspection surface changes, only this file moves.
 */

import type { Command, Option as CommanderOption, Argument as CommanderArgument } from 'commander';

export type CompletionHint = 'file' | 'directory' | 'none';

export interface OptionDesc {
  short?: string;       // e.g. "-p"
  long?: string;        // e.g. "--path"
  flags: string;        // raw flag spec: "-p, --path <path>"
  description: string;
  takesValue: boolean;
  valueName?: string;
  valueHint: CompletionHint;
  negate: boolean;      // --no-xxx
}

export interface ArgDesc {
  name: string;
  required: boolean;
  variadic: boolean;
  hint: CompletionHint;
}

export interface CommandDesc {
  name: string;
  aliases: string[];
  description: string;
  args: ArgDesc[];
  options: OptionDesc[];
  subcommands: CommandDesc[];
}

// Argument-name heuristic: positional names that look like filesystem
// paths get a `_files` hint. Names matter — commander doesn't expose
// per-argument completion metadata, so the name is all we have.
const FILE_HINT_NAMES = new Set(['path', 'file', 'files', 'source', 'output']);
const DIR_HINT_NAMES = new Set(['dir', 'directory', 'folder']);

const hintForName = (name: string | undefined): CompletionHint => {
  if (!name) return 'none';
  const lower = name.toLowerCase();
  if (DIR_HINT_NAMES.has(lower)) return 'directory';
  if (FILE_HINT_NAMES.has(lower)) return 'file';
  return 'none';
};

const describeOption = (opt: CommanderOption): OptionDesc => {
  // Commander's `Option` exposes `short`, `long`, `flags`, `description`,
  // `required` (value-required `<x>`), `optional` (value-optional `[x]`),
  // `negate` (--no-x), `mandatory` (option itself required).
  const takesValue = Boolean(opt.required || opt.optional);
  // Value name lives inside `flags`, e.g. "-p, --path <path>". Pull the
  // first `<...>` or `[...]` token; commander doesn't surface it directly.
  let valueName: string | undefined;
  if (takesValue) {
    const match = opt.flags.match(/[<[]([^>\]]+)[>\]]/);
    if (match) valueName = match[1];
  }
  return {
    short: opt.short ?? undefined,
    long: opt.long ?? undefined,
    flags: opt.flags,
    description: opt.description ?? '',
    takesValue,
    valueName,
    valueHint: hintForName(valueName),
    negate: Boolean(opt.negate),
  };
};

const describeArg = (arg: CommanderArgument): ArgDesc => ({
  name: arg.name(),
  required: arg.required,
  variadic: arg.variadic,
  hint: hintForName(arg.name()),
});

// Commander auto-registers `-h, --help` on every command but doesn't
// expose it via `cmd.options` (it lives behind internal helpOption
// machinery). Inject it explicitly so completion menus actually
// include it — every other CLI's user expects --help on Tab.
const helpOption: OptionDesc = {
  short: '-h',
  long: '--help',
  flags: '-h, --help',
  description: 'Display help for command',
  takesValue: false,
  valueHint: 'none',
  negate: false,
};

export const describeCommand = (cmd: Command): CommandDesc => ({
  name: cmd.name(),
  aliases: cmd.aliases(),
  description: cmd.description(),
  // `registeredArguments` is commander 10+ — the project pins ^14, so safe.
  args: (cmd as Command & { registeredArguments: CommanderArgument[] }).registeredArguments.map(describeArg),
  options: [...cmd.options.map(describeOption), helpOption],
  subcommands: cmd.commands.map(describeCommand),
});
