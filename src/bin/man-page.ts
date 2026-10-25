/**
 * `codegraph.1` - the man page, generated from the live commander tree (#1828).
 *
 * The page is rendered from the command tree instead of being checked in as
 * hand-written roff. A static copy drifts from the CLI within a release or two,
 * and a second transcription of the help text is the thing #529 was opened
 * about: one source of truth for what the CLI documents.
 *
 * Everything goes through commander's public `Help` surface - `visibleCommands`
 * (which already drops `hidden` commands), `commandUsage`, `commandDescription`,
 * `visibleOptions`, `optionTerm`, `optionDescription` - so a command added to
 * the tree appears in the page, a hidden one stays out of both, and neither
 * copies the other.
 */
import { Command, Help, Option } from 'commander';

/**
 * roff spells every escape with a backslash: a literal hyphen, the zero-width
 * guard that keeps a line from being read as a request, the font changes. Naming
 * the character once keeps those literals out of the templates below, where a
 * doubled backslash in source is the kind of thing review reads past.
 */
const ESC = String.fromCharCode(92);
/** Prose is wrapped here; roff would otherwise break lines at its own pace. */
const TEXT_WIDTH = 78;

/**
 * Escape text that ends up as roff argument text (`.B foo`): a backslash would
 * start a font or escape sequence, and `-` is a hyphenation/count request in
 * some contexts, so `--flag` and `codegraph` both want the literal hyphen.
 */
export function escapeRoff(text: string): string {
  return text.replaceAll(ESC, ESC + ESC).replaceAll('-', `${ESC}-`);
}

/**
 * A line starting with `.` or `'` is a roff request, so prose that starts with
 * one (a description opening with `.codegraph/`, say) needs the zero-width guard
 * in front or it silently becomes a macro.
 */
function guardLineStart(line: string): string {
  const first = line.charAt(0);
  return first === '.' || first === "'" ? `${ESC}&${line}` : line;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** A free-standing paragraph: escaped, wrapped, and guarded against macros. */
function paragraph(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  return wrap(flat, TEXT_WIDTH).map((line) => guardLineStart(escapeRoff(line)));
}

/**
 * One `.TP` entry of OPTIONS: `-l, --limit <number>` and its prose, including
 * the default commander keeps out of the description. Booleans default to
 * false and are better left unsaid.
 */
function optionBlock(option: Option, help: Help): string[] {
  const lines = ['.TP', `.B ${escapeRoff(help.optionTerm(option))}`];
  let description = help.optionDescription(option);
  if (option.defaultValue !== undefined && option.defaultValue !== false) {
    description += ` (default: ${String(option.defaultValue)})`;
  }
  lines.push(...paragraph(description));
  return lines;
}

/** One `.TP` entry of COMMANDS: the usage line, its prose, its own options. */
function commandBlock(command: Command, help: Help): string[] {
  const lines = ['.TP', `.B ${escapeRoff(help.commandUsage(command))}`];
  lines.push(...paragraph(help.commandDescription(command)));
  const aliases = command.aliases();
  if (aliases.length > 0) {
    lines.push(...paragraph(`Alias: ${aliases.join(', ')}.`));
  }
  const options = help.visibleOptions(command);
  if (options.length > 0) {
    lines.push('.RS');
    for (const option of options) lines.push(...optionBlock(option, help));
    lines.push('.RE');
  }
  return lines;
}


/**
 * The `CODEGRAPH_*` knobs a reader reaches for from `man codegraph`: the ones
 * that change where the index lives, how it syncs, and what leaves the machine.
 * The tuning and benchmarking variables stay in the README.
 */
const ENVIRONMENT: ReadonlyArray<readonly [string, string]> = [
  ['CODEGRAPH_DIR', 'Name of the per-project index directory (default: .codegraph). Set it to keep a second index, e.g. .codegraph-wsl.'],
  ['CODEGRAPH_NO_DAEMON=1', 'Run each MCP server in its own process instead of sharing one background daemon per project.'],
  ['CODEGRAPH_NO_WATCH=1', 'Disable the file watcher, so the index only advances on an explicit sync or index.'],
  ['CODEGRAPH_WATCH_DEBOUNCE_MS', 'Debounce window before a burst of edits triggers a re-index, clamped to 100ms-60s (default: 2000).'],
  ['CODEGRAPH_MCP_TOOLS', 'Comma-separated MCP tools to advertise beyond the default (e.g. explore,node,search).'],
  ['CODEGRAPH_TELEMETRY=0', 'Turn anonymous usage telemetry off; DO_NOT_TRACK=1 does the same.'],
  ['CODEGRAPH_UI=1', 'Enable the browser viewer commands (codegraph ui, codegraph web), which are gated off until they ship.'],
  ['CODEGRAPH_WAL_VALVE_MB', 'Soft ceiling for the SQLite write-ahead log while indexing.'],
  ['CODEGRAPH_WAL_HEAL_MB', 'Resting size the write-ahead log is trimmed back to.'],
  ['CODEGRAPH_NO_UPDATE_CHECK=1', 'Skip the background check for a newer CodeGraph release.'],
  ['CODEGRAPH_ALLOW_UNSAFE_NODE=1', 'Run on a Node.js major version CodeGraph does not support (it refuses by default).'],
];

export interface ManPageOptions {
  /** The version the page announces; `codegraph --version` prints the same one. */
  version: string;
  /** Page date, ISO `YYYY-MM-DD`. Defaults to today (generation time). */
  date?: string;
}

/**
 * Render the complete `codegraph.1` roff source for `program`.
 *
 * Pure: the same tree and version in give the same bytes out, the date excepted,
 * which is what lets the test assert behaviour rather than freeze a snapshot.
 */
export function renderManPage(program: Command, options: ManPageOptions): string {
  const help = new Help();
  const name = program.name();
  const description = program.description();
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  lines.push(`.${ESC}" Generated from the ${name} commander tree (src/bin/man-page.ts, #1828).`);
  lines.push(`.${ESC}" Do not edit by hand: run the codegraph man command to regenerate.`);
  lines.push(`.TH ${name.toUpperCase()} 1 "${date}" "${name} ${options.version}" "User Commands"`);

  lines.push('.SH NAME');
  lines.push(`${escapeRoff(name)} ${ESC}- ${escapeRoff(description)}`);

  lines.push('.SH SYNOPSIS');
  lines.push(`.B ${escapeRoff(name)}`);
  lines.push(`${ESC}fIoptions${ESC}fR ${ESC}fIcommand${ESC}fR [${ESC}fIcommand options${ESC}fR]`);

  lines.push('.SH DESCRIPTION');
  lines.push(...paragraph(`${description}. Commands print human-readable output by default; the query-style commands take --json where a script needs it.`));

  lines.push('.SH COMMANDS');
  for (const command of help.visibleCommands(program)) {
    lines.push(...commandBlock(command, help));
  }

  const globalOptions = help.visibleOptions(program);
  if (globalOptions.length > 0) {
    lines.push('.SH OPTIONS');
    for (const option of globalOptions) lines.push(...optionBlock(option, help));
  }

  lines.push('.SH ENVIRONMENT');
  lines.push(...paragraph('CodeGraph reads the environment variables below. The README documents the rest of the tuning and debugging knobs.'));
  for (const [variable, purpose] of ENVIRONMENT) {
    lines.push('.TP');
    lines.push(`.B ${escapeRoff(variable)}`);
    lines.push(...paragraph(purpose));
  }

  lines.push('.SH FILES');
  lines.push('.TP');
  lines.push('.B <project>/.codegraph/');
  lines.push(...paragraph('The SQLite index, the daemon state and the writer lock for one project, created by codegraph init and updated by index and sync.'));

  lines.push('.SH "SEE ALSO"');
  lines.push(`Every command also answers ${ESC}fB${escapeRoff(name)} <command> --help${ESC}fR, and ${ESC}fB${escapeRoff(name)} help${ESC}fR lists the commands.`);

  lines.push('.SH BUGS');
  lines.push('https://github.com/colbymchenry/codegraph/issues');

  return `${lines.join('\n')}\n`;
}
