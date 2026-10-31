/**
 * Tauri IPC — the hop between a desktop app's web frontend and its Rust core.
 *
 * A Tauri app is two programs in one window: the page calls
 * `invoke('save_file', { path })` and the Rust `#[tauri::command] fn save_file`
 * answers, while the core sends `app.emit("saved", …)` back to a page that wrote
 * `listen('saved', …)`. Neither side names the other, and tree-sitter sees a
 * string and a function in two languages. The string is the evidence, as it is
 * for the cross-tier channels (`tier-synthesizer.ts`): this pass pairs the
 * literals and draws the hop the runtime makes.
 *
 * - **`tauri-command`** — the function a frontend call is written in → the Rust
 *   function that answers it. A command answers only if a handler list registers
 *   it (`generate_handler![…]`, tauri-specta's `collect_commands![…]`), so an
 *   `invoke` that names an unregistered function stays unlinked, as it fails at
 *   run time. tauri-specta's generated client needs nothing of its own when it
 *   is in the index: `commands.saveFile()` already reaches `bindings.ts`, whose
 *   body is an aliased `invoke('save_file')`. When it is not (a gitignored
 *   bindings file), the call is read by its camelCase name.
 * - **`tauri-event`** — an `emit` → the listeners of that event, in either
 *   language and between windows (`calls`), and a listener → the Rust struct
 *   deriving tauri-specta's `Event` (`references`), so a struct's callers list
 *   who subscribes. A typed `Struct { … }.emit(&app)` and an
 *   `events.struct.listen(…)` meet a raw `emit("struct")` / `listen('struct')`
 *   on the same wire name.
 *
 * A name is only as good as the app it is looked up in, so the table is per app:
 * a monorepo's two `greet`s stay apart, and a tie is nothing.
 */

import type { Edge, Language, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ImportMapping, ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { blankStringContents, stripCommentsForRegex } from './strip-comments';
import { resolveImportPath } from './import-resolver';
import { isTestPath } from '../search/query-utils';
import { HOLE, readStringAt } from './frameworks/expo-router';
import { FN_KINDS, enclosingFn, enclosingValue, makeLineAt } from './synth-utils';
import { TIER_CLIENT_TO_SERVER, TIER_SERVER_TO_CLIENT } from './tier-synthesizer';
import { jsCodeBindsName } from './name-matcher';

const FRONTEND_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const FRONTEND_GATE = /invoke|listen|once|\bemit|\bcommands\b|\bevents\b|__TAURI/;
const RUST_GATE = /\btauri|generate_handler|collect_commands|\.\s*(?:emit|listen|once)/;

/** One command's platform variants: more than this and the name is not a command's. */
const MAX_VARIANTS = 6;

/** Above this many emitters or listeners, an event is too generic to read as a flow. */
const EVENT_FANOUT_CAP = 16;

const API_ROOT = '@tauri-apps/api';
const CORE_MODULES: ReadonlySet<string> = new Set([`${API_ROOT}/core`, `${API_ROOT}/tauri`, API_ROOT]);
const EVENT_MODULE = `${API_ROOT}/event`;
/** Modules whose handles (`getCurrentWindow()`, `appWindow`, …) have their own `listen` / `once` / `emit`. */
const HANDLE_MODULES: ReadonlySet<string> = new Set([`${API_ROOT}/window`, `${API_ROOT}/webviewWindow`, `${API_ROOT}/webview`]);

// =============================================================================
// Reading source
// =============================================================================

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CLOSER: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket closing the one at `open`, over text with its strings blanked; -1 if none. */
function closeBracket(code: string, open: number): number {
  const stack = [CLOSER[code[open]!]!];
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i]!;
    if (CLOSER[c]) stack.push(CLOSER[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Index of the bracket opening the one at `close`, over text with its strings blanked; -1 if none. */
function openBracket(code: string, close: number): number {
  const opener = code[close] === ')' ? '(' : code[close] === ']' ? '[' : '{';
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const c = code[i];
    if (c === code[close]) depth++;
    else if (c === opener && --depth === 0) return i;
  }
  return -1;
}

/** The `[start, end)` spans of the arguments of the call whose `(` is at `open`, split at depth-0 commas. */
function argumentSpans(code: string, open: number): Array<[number, number]> {
  const close = closeBracket(code, open);
  if (close < 0) return [];
  const spans: Array<[number, number]> = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = code[i]!;
    if (CLOSER[c]) {
      const end = closeBracket(code, i);
      if (end < 0) return spans;
      i = end;
    } else if (c === ',') {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  if (code.slice(start, close).trim()) spans.push([start, close]);
  return spans;
}

/** Index of the first non-space at or after `i`. */
function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

/** Past the `<…>` type arguments at `at`, an arrow's `>` not closing them; `at` when there are none. */
function skipTypeArguments(code: string, at: number): number {
  if (code[at] !== '<') return at;
  let depth = 0;
  const limit = Math.min(code.length, at + 40_000);
  for (let i = at; i < limit; i++) {
    const c = code[i];
    if (c === '<') depth++;
    else if (c === '>' && code[i - 1] !== '=' && --depth === 0) return skipSpace(code, i + 1);
  }
  return at;
}

// =============================================================================
// Names
// =============================================================================

/** The words of a Rust name, the way `heck` (tauri-specta's casing) splits them: `AIModelReady` → AI, Model, Ready. */
function words(name: string): string[] {
  return name.split('_').flatMap((part) => part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[0-9]+/g) ?? []);
}

/** `save_file` / `SaveFile` → `saveFile`. */
function toCamel(name: string): string {
  return words(name).map((w, i) => {
    const lower = w.toLowerCase();
    return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
}

/** `SaveFile` → `save-file`: an event struct's name on the wire. */
function toKebab(name: string): string {
  return words(name).map((w) => w.toLowerCase()).join('-');
}

// =============================================================================
// The Rust side
// =============================================================================

interface Command {
  /** One function, or one per platform: `#[cfg(target_os = "macos")] #[tauri::command] fn x` and its siblings. */
  nodes: Node[];
  /** Where it is wired in: `file:line`. */
  registeredAt: string;
}

/** A key with several answers is null: a tie links nothing. */
type CommandTable = Map<string, Command | null>;

interface TauriApp {
  /** The directory the app's code sits under; '' at the repository root. */
  root: string;
  commands: CommandTable;
  /** Every decorated function counts: a macro builds the handler list, so it can't be read. */
  openList: string | null;
}

interface EventStruct {
  node: Node;
  /** The name on the wire. */
  event: string;
  scope: string | null;
}

interface Endpoint {
  node: Node;
  event: string;
  file: string;
  line: number;
  column: number;
  rust: boolean;
  scope: string | null;
}

interface RustFile {
  file: string;
  source: string;
  /** Comments blanked, strings kept. */
  text: string;
  /** Comments and string contents blanked. */
  code: string;
  nodes: Node[];
  lineAt: (index: number) => number;
  offsetOfLine: (line: number) => number;
}

interface ListEntry {
  /** The path as written, with no turbofish: `cmd::save_file`. */
  segments: string[];
  line: number;
}

interface HandlerList {
  file: string;
  line: number;
  entries: ListEntry[];
  /** A `$…` metavariable in the list: the names are the macro's to fill in. */
  opaque: boolean;
  /** The plugin these commands are registered under, `plugin:<name>|<command>`. */
  plugin: string | null;
}

const HANDLER_LIST = /\b(?:generate_handler|collect_commands)\s*!\s*[[({]/g;
const PLUGIN_HEAD = /\bBuilder\s*(?:::\s*<[^;()]*>\s*)?::\s*(?:new\s*\(\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))|default\s*\()|\.\s*plugin_name\s*\(\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))/g;

/** Rust's own attributes and the usual tracing ones: none of them makes a function a command. */
const PLAIN_ATTRIBUTE = /^(?:cfg|cfg_attr|doc|allow|expect|warn|deny|forbid|inline|cold|must_use|deprecated|track_caller|test|ignore|no_mangle|rustfmt|clippy|instrument|tracing|specta|async_trait)\b/;

function readHandlerList(rust: RustFile, constants: ReadonlyMap<string, string | null>, at: number, open: number): HandlerList | null {
  const close = closeBracket(rust.code, open);
  if (close < 0) return null;
  const entries: ListEntry[] = [];
  let opaque = false;
  for (const [start, end] of argumentSpans(rust.code, open)) {
    // A `#[cfg(…)]` on an entry is the entry's business, not part of its name.
    const item = rust.code.slice(start, end).replace(/#\s*\[[^\]]*\]/g, ' ').trim();
    if (item.includes('$')) {
      opaque = true;
      continue;
    }
    const path = item.replace(/::\s*<[\s\S]*>$/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(path)) continue;
    const segments = path.split('::');
    const named = rust.code.indexOf(segments[segments.length - 1]!, end - item.length);
    entries.push({ segments, line: rust.lineAt(named >= start && named < end ? named : start) });
  }
  return { file: rust.file, line: rust.lineAt(at), entries, opaque, plugin: pluginOf(rust, constants, at) };
}

/** The plugin a handler list sits in: the nearest builder before it, when it names one. */
function pluginOf(rust: RustFile, constants: ReadonlyMap<string, string | null>, at: number): string | null {
  let plugin: string | null = null;
  PLUGIN_HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLUGIN_HEAD.exec(rust.text)) !== null && m.index < at) {
    const literal = m[1] ?? m[3];
    const constant = m[2] ?? m[4];
    plugin = literal ?? (constant ? constants.get(constant) ?? null : null);
  }
  return plugin;
}

/** The attributes written on and directly above the line a function starts on. */
function attributesAbove(lines: readonly string[], startLine: number): string[] {
  const out: string[] = [lines[startLine - 1]?.trim() ?? ''];
  for (let i = startLine - 2; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('#[') || line.endsWith(']') || line.endsWith(',') || line.endsWith('(')) {
      out.push(line);
      if (out.length > 16) break;
      continue;
    }
    break;
  }
  return out;
}

/**
 * Whether an attribute made this function a command. `generate_handler!` reads
 * what an attribute macro generates, so a plain function can't be registered:
 * a namesake of a list's entry that has none is some other function, the entry
 * being an external crate's. `#[tauri::command]` is on the node; `#[command]`
 * (with `use tauri::command`) and a project's own macro around it
 * (GitButler's `#[but_api]`) are read from the lines above it.
 */
function isCommandFunction(node: Node, ctx: ResolutionContext): boolean {
  return attributeNames(node, ctx).some((name) => !PLAIN_ATTRIBUTE.test(name));
}

/** The stricter reading, for a list nothing can be checked against: Tauri's own attribute. */
function isDeclaredCommand(node: Node, ctx: ResolutionContext): boolean {
  return attributeNames(node, ctx).some((name) => name === 'command' || name === 'tauri::command');
}

function attributeNames(node: Node, ctx: ResolutionContext): string[] {
  if (node.decorators?.includes('tauri::command')) return ['tauri::command'];
  const lines = ctx.getFileLines?.(node.filePath) ?? ctx.readFile(node.filePath)?.split('\n');
  if (!lines) return [];
  return attributesAbove(lines, node.startLine).flatMap((line) => {
    const name = /^#\[\s*([A-Za-z_][\w:]*)/.exec(line)?.[1];
    return name ? [name] : [];
  });
}

/**
 * The names a Rust file answers to in a path: its crate and its modules.
 * `crates/my-api/src/cmd/network.rs` → my_api, cmd, network.
 */
function moduleNames(file: string): Set<string> {
  const parts = file.replace(/\.rs$/, '').split('/');
  const src = parts.lastIndexOf('src');
  const names = src >= 0 ? parts.slice(Math.max(0, src - 1)).filter((_, i) => i !== 1 || src === 0) : parts.slice(-1);
  return new Set(names.map((n) => n.replace(/-/g, '_')));
}

/** How many segments of a registered path name `node`'s crate or modules: a module re-exported from its parent still counts its parent. */
function pathScore(segments: readonly string[], node: Node): number {
  const names = moduleNames(node.filePath);
  return segments.slice(0, -1).filter((s) => names.has(s)).length;
}

/** Where a crate starts: the nearest directory above `file` holding a `Cargo.toml`. */
function crateRoot(file: string, ctx: ResolutionContext, memo: Map<string, string>): string {
  const parts = file.split('/').slice(0, -1);
  const seen: string[] = [];
  for (let n = parts.length; n >= 0; n--) {
    const dir = parts.slice(0, n).join('/');
    const known = memo.get(dir);
    if (known !== undefined) {
      for (const d of seen) memo.set(d, known);
      return known;
    }
    seen.push(dir);
    if (ctx.fileExists(dir ? `${dir}/Cargo.toml` : 'Cargo.toml')) {
      for (const d of seen) memo.set(d, dir);
      return dir;
    }
  }
  for (const d of seen) memo.set(d, '');
  return '';
}

/** The directory above a `src-tauri` folder, the frontend's root by convention; null outside one. */
function conventionalRoot(file: string): string | null {
  const at = file.startsWith('src-tauri/') ? 0 : file.indexOf('/src-tauri/');
  if (at < 0) return null;
  return file.slice(0, at);
}

function isWithin(file: string, root: string): boolean {
  return root === '' || file.startsWith(`${root}/`);
}

function addCommand(table: CommandTable, key: string, command: Command): void {
  const known = table.get(key);
  if (known === undefined) table.set(key, command);
  else if (known !== null && !sameNodes(known.nodes, command.nodes)) table.set(key, null);
}

function sameNodes(a: readonly Node[], b: readonly Node[]): boolean {
  return a.length === b.length && a.every((n) => b.some((m) => m.id === n.id));
}

/**
 * The functions a list entry names. A name a list holds once can still be
 * several functions, a platform's each behind its own `#[cfg]` or module, and
 * every one of them is that command on its platform; a path that tells them
 * apart decides. Too many is a name, not a command.
 */
function commandsFor(entry: ListEntry, list: HandlerList, crates: Map<string, string>, ctx: ResolutionContext): Node[] {
  const name = entry.segments[entry.segments.length - 1]!;
  const named = ctx.getNodesByName(name).filter((n) => n.language === 'rust' && n.kind === 'function' && !isTestPath(n.filePath));
  let candidates = named.filter((n) => isCommandFunction(n, ctx));
  if (candidates.length > 1) {
    const scope = (file: string): string => conventionalRoot(file) ?? crateRoot(file, ctx, crates);
    const own = scope(list.file);
    const sameScope = candidates.filter((n) => scope(n.filePath) === own);
    if (sameScope.length > 0) candidates = sameScope;
  }
  if (candidates.length > 1) {
    const scores = candidates.map((n) => pathScore(entry.segments, n));
    const best = Math.max(...scores);
    candidates = candidates.filter((_, i) => scores[i] === best);
  }
  return candidates.length <= MAX_VARIANTS ? candidates : [];
}

interface RustSide {
  apps: TauriApp[];
  /** `plugin:<name>|<command>` → its command, wherever the plugin's crate sits. */
  plugins: CommandTable;
  /** Whole-repository view, for a frontend no app's folder holds. */
  anyApp: CommandTable;
  /** Event structs by wire name, by type name, and by the camelCase name of their `events.x`. */
  byEvent: Map<string, EventStruct[]>;
  byType: Map<string, EventStruct[]>;
  byCamel: Map<string, EventStruct[]>;
  emitters: Endpoint[];
  listeners: Endpoint[];
  /** The app folder `file` belongs to by convention; null outside every one, which pairs with any. */
  scopeOf: (file: string) => string | null;
}

function sameScope(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/** The struct of the file's own app, else one no app holds. */
function structInScope(found: readonly EventStruct[] | undefined, scope: string | null): EventStruct | null {
  return found?.find((s) => s.scope === scope) ?? found?.find((s) => sameScope(s.scope, scope)) ?? null;
}

function addStruct(index: Map<string, EventStruct[]>, key: string, struct: EventStruct): void {
  const known = index.get(key);
  if (known) known.push(struct);
  else index.set(key, [struct]);
}

/** `const NAME: &str = "value";` across the Rust files; a name given two values is null. */
const STR_CONST = /\b(?:const|static)\s+([A-Z][A-Z0-9_]*)\s*:\s*&\s*(?:'static\s+)?str\s*=\s*"([^"\n]*)"/g;

const EVENT_DERIVE = /#\s*\[\s*derive\s*\(([^)]*)\)\s*\]/g;
const EVENT_ITEM = /^(?:\s*#\s*\[(?:[^\]]|\][^\s])*\])*\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)/;
const EVENT_RENAME = /#\s*\[\s*tauri_specta\s*\(\s*event_name\s*=\s*"([^"]+)"\s*\)\s*\]/;

const EMIT_CALL = /\.\s*(emit(?:_str|_all|_to|_str_to|_filter|_str_filter|_and_trigger)?)\s*(?:::\s*<[^()]*>\s*)?\(/g;
const LISTEN_CALL = /\.\s*(?:listen|once)(?:_any|_global)?\s*(?:::\s*<[^()]*>\s*)?\(/g;
/** tauri-specta's typed form: `Saved::listen(app, |e| …)`. */
const TYPED_LISTEN_CALL = /\b([A-Z]\w*)\s*::\s*(?:listen|once)(?:_any)?\s*\(/g;

/** The string a Rust argument is: a literal, or a `&str` constant. */
function rustStringAt(rust: RustFile, span: [number, number] | undefined, constants: ReadonlyMap<string, string | null>): string | null {
  if (!span) return null;
  const raw = rust.text.slice(span[0], span[1]).trim();
  const literal = /^&?"([^"\\]*)"$/.exec(raw);
  if (literal) return literal[1]!;
  const name = /^(?:[a-z_]\w*::)*([A-Z][A-Z0-9_]*)$/.exec(raw)?.[1];
  return name ? constants.get(name) ?? null : null;
}

/** The last segment of the path ending at `end` that names a type: `events::Saved` → `Saved`. */
function typeAt(code: string, end: number): string | null {
  const head = /(?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*\s*$/.exec(code.slice(Math.max(0, end - 200), end + 1));
  if (!head) return null;
  const segments = head[0].split('::').map((s) => s.trim());
  for (let i = segments.length - 1; i >= 0; i--) if (/^[A-Z]/.test(segments[i]!)) return segments[i]!;
  return null;
}

/** The type `x` was given in the function around `at`: `let x = Saved { … }`, `let x: Saved`, `x: &Saved`. */
function localType(code: string, name: string, from: number, at: number): string | null {
  const n = escapeRe(name);
  const pattern = new RegExp(
    `\\blet\\s+(?:mut\\s+)?${n}\\s*(?::\\s*&?\\s*(?:[a-z_]\\w*::)*([A-Z]\\w*)[^=;]*)?=\\s*&?\\s*(?:[a-z_]\\w*::)*([A-Z]\\w*)|\\b${n}\\s*:\\s*&?\\s*(?:[a-z_]\\w*::)*([A-Z]\\w*)`,
    'g'
  );
  const body = code.slice(from, at);
  let found: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) found = m[1] ?? m[2] ?? m[3] ?? found;
  return found;
}

/**
 * The type a `<receiver>.emit(…)` is called on, read back from its `.`:
 * `Saved`, `Saved { … }`, `(Saved { … })`, `Saved(…)`, `Saved::new(…)`, or a
 * local one of those was put in.
 */
function receiverType(code: string, dot: number, functionStart: number): string | null {
  let i = dot - 1;
  while (i >= 0 && /\s/.test(code[i]!)) i--;
  if (i < 0) return null;
  const c = code[i]!;
  if (c === ')' || c === '}') {
    const open = openBracket(code, i);
    if (open < 0) return null;
    let before = open - 1;
    while (before >= 0 && /\s/.test(code[before]!)) before--;
    if (before >= 0 && /\w/.test(code[before]!)) return typeAt(code, before);
    // `(Saved { … })`: the parentheses only wrap it.
    return /^\s*&?\s*(?:[a-z_]\w*::)*([A-Z]\w*)/.exec(code.slice(open + 1, i))?.[1] ?? null;
  }
  if (!/\w/.test(c)) return null;
  const word = /[A-Za-z_]\w*$/.exec(code.slice(Math.max(0, i - 120), i + 1))?.[0];
  if (!word) return null;
  if (/^[A-Z]/.test(word)) return word;
  return localType(code, word, functionStart, i);
}

function ownerOf(nodes: readonly Node[], line: number, column: number): Node | null {
  let best: Node | null = null;
  for (const n of nodes) {
    if (!FN_KINDS.has(n.kind) || n.startLine > line || n.endLine < line) continue;
    if ((n.startLine === line && n.startColumn > column) || (n.endLine === line && n.endColumn <= column)) continue;
    if (!best || n.startLine > best.startLine || (n.startLine === best.startLine && n.startColumn >= best.startColumn)) best = n;
  }
  return best ?? enclosingValue(nodes, line) ?? nodes.find((n) => n.kind === 'file') ?? null;
}

function columnAt(text: string, index: number): number {
  return index - (text.lastIndexOf('\n', index - 1) + 1);
}

/** The offset a 1-based line starts at, from an index of line starts built on first use. */
function makeOffsetOfLine(source: string): (line: number) => number {
  let starts: number[] | null = null;
  return (line: number) => {
    if (!starts) {
      starts = [0];
      for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
    }
    return starts[Math.min(line, starts.length) - 1] ?? 0;
  };
}

function readRustFile(file: string, source: string, ctx: ResolutionContext): RustFile {
  const text = stripCommentsForRegex(source, 'rust');
  return {
    file, source, text, code: blankStringContents(text), nodes: ctx.getNodesInFile(file),
    lineAt: makeLineAt(source, 1), offsetOfLine: makeOffsetOfLine(source),
  };
}

function readEventStructs(rust: RustFile, out: RustSide): void {
  if (!rust.source.includes('tauri_specta')) return;
  EVENT_DERIVE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EVENT_DERIVE.exec(rust.code)) !== null) {
    if (!/\bEvent\b/.test(m[1]!)) continue;
    const item = EVENT_ITEM.exec(rust.code.slice(m.index + m[0].length, m.index + m[0].length + 4000));
    if (!item) continue;
    const name = item[1]!;
    const node = rust.nodes.find((n) => n.name === name && (n.kind === 'struct' || n.kind === 'enum'));
    if (!node) continue;
    const span = rust.text.slice(Math.max(0, m.index - 400), m.index + m[0].length + item[0].length);
    const event = EVENT_RENAME.exec(span.slice(span.lastIndexOf('}') + 1))?.[1] ?? toKebab(name);
    const struct: EventStruct = { node, event, scope: out.scopeOf(rust.file) };
    addStruct(out.byEvent, event, struct);
    addStruct(out.byType, name, struct);
    addStruct(out.byCamel, toCamel(name), struct);
  }
}

function readEmitters(rust: RustFile, constants: ReadonlyMap<string, string | null>, out: RustSide): void {
  EMIT_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMIT_CALL.exec(rust.code)) !== null) {
    const open = m.index + m[0].length - 1;
    const spans = argumentSpans(rust.code, open);
    const line = rust.lineAt(m.index);
    const column = columnAt(rust.source, m.index);
    const owner = enclosingFn(rust.nodes, line);
    if (!owner) continue;
    // `app.emit_to("main", "saved", payload)` names its target first, and a typed
    // `Saved { … }.emit_to(&app, "main")` has no event among its arguments.
    const targeted = /_to$/.test(m[1]!);
    let event = targeted && spans.length < 3 ? null : rustStringAt(rust, spans[targeted ? 1 : 0], constants);
    if (event === null) {
      const type = receiverType(rust.code, m.index, rust.offsetOfLine(owner.startLine));
      event = type ? structInScope(out.byType.get(type), out.scopeOf(rust.file))?.event ?? null : null;
    }
    if (event !== null) out.emitters.push({ node: owner, event, file: rust.file, line, column, rust: true, scope: out.scopeOf(rust.file) });
  }
}

function readListeners(rust: RustFile, constants: ReadonlyMap<string, string | null>, out: RustSide): void {
  LISTEN_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LISTEN_CALL.exec(rust.code)) !== null) {
    const open = m.index + m[0].length - 1;
    const spans = argumentSpans(rust.code, open);
    const event = rustStringAt(rust, spans[0], constants);
    if (event === null) continue;
    const line = rust.lineAt(m.index);
    const owner = enclosingFn(rust.nodes, line);
    if (owner) out.listeners.push({ node: owner, event, file: rust.file, line, column: columnAt(rust.source, m.index), rust: true, scope: out.scopeOf(rust.file) });
  }
  TYPED_LISTEN_CALL.lastIndex = 0;
  while ((m = TYPED_LISTEN_CALL.exec(rust.code)) !== null) {
    const event = structInScope(out.byType.get(m[1]!), out.scopeOf(rust.file))?.event;
    const line = rust.lineAt(m.index);
    const owner = event ? enclosingFn(rust.nodes, line) : null;
    if (event && owner) out.listeners.push({ node: owner, event, file: rust.file, line, column: columnAt(rust.source, m.index), rust: true, scope: out.scopeOf(rust.file) });
  }
}

async function readRustSide(ctx: ResolutionContext, onYield: MaybeYield): Promise<RustSide> {
  const files: RustFile[] = [];
  const conventional = new Set<string>();
  const constants = new Map<string, string | null>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const root = conventionalRoot(file);
    if (root !== null) conventional.add(root);
    if (isTestPath(file)) continue;
    if ((++scanned & 63) === 0) await onYield();
    const source = ctx.readFile(file);
    if (!source || !RUST_GATE.test(source)) continue;
    const rust = readRustFile(file, source, ctx);
    files.push(rust);
    STR_CONST.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STR_CONST.exec(rust.text)) !== null) {
      const known = constants.get(m[1]!);
      constants.set(m[1]!, known === undefined || known === m[2] ? m[2]! : null);
    }
  }

  const roots = [...conventional].sort((a, b) => b.length - a.length);
  const side: RustSide = {
    apps: [], plugins: new Map(), anyApp: new Map(), byEvent: new Map(), byType: new Map(), byCamel: new Map(), emitters: [], listeners: [],
    scopeOf: (file) => roots.find((root) => isWithin(file, root)) ?? null,
  };
  const apps = new Map<string, TauriApp>();
  const appAt = (root: string): TauriApp => {
    let app = apps.get(root);
    if (!app) {
      app = { root, commands: new Map(), openList: null };
      apps.set(root, app);
    }
    return app;
  };
  for (const root of conventional) appAt(root);

  const crates = new Map<string, string>();
  for (const rust of files) {
    await onYield();
    readEventStructs(rust, side);
    HANDLER_LIST.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HANDLER_LIST.exec(rust.code)) !== null) {
      const list = readHandlerList(rust, constants, m.index, m.index + m[0].length - 1);
      if (!list) continue;
      const app = appAt(conventionalRoot(rust.file) ?? crateRoot(rust.file, ctx, crates));
      if (list.opaque) app.openList = `${list.file}:${list.line}`;
      for (const entry of list.entries) {
        const nodes = commandsFor(entry, list, crates, ctx);
        if (nodes.length === 0) continue;
        const command: Command = { nodes, registeredAt: `${list.file}:${entry.line}` };
        const name = entry.segments[entry.segments.length - 1]!;
        if (list.plugin) addCommand(side.plugins, `plugin:${list.plugin}|${name}`, command);
        else addCommand(app.commands, name, command);
      }
    }
  }

  // A list a macro builds names nothing here, so what the app declares answers.
  for (const app of apps.values()) {
    if (app.openList === null) continue;
    const declared = new Map<string, Node[]>();
    for (const rust of files) {
      if (!isWithin(rust.file, app.root)) continue;
      for (const n of rust.nodes) {
        if (n.kind !== 'function' || !isDeclaredCommand(n, ctx)) continue;
        const same = declared.get(n.name);
        if (same) same.push(n);
        else declared.set(n.name, [n]);
      }
    }
    for (const [name, nodes] of declared) {
      if (nodes.length <= MAX_VARIANTS) addCommand(app.commands, name, { nodes, registeredAt: app.openList });
    }
  }

  // Emit sites come after every struct is known: a type can be used before its
  // file comes up.
  for (const rust of files) {
    await onYield();
    readEmitters(rust, constants, side);
    readListeners(rust, constants, side);
  }

  side.apps = [...apps.values()].sort((a, b) => b.root.length - a.root.length);
  for (const app of side.apps) {
    for (const [key, command] of app.commands) {
      if (command === null) side.anyApp.set(key, null);
      else addCommand(side.anyApp, key, command);
    }
  }
  return side;
}

/** The deepest app whose folder holds `file`; a frontend beside its crate looks across every app. */
function tableFor(file: string, side: RustSide): CommandTable {
  return side.apps.find((app) => isWithin(file, app.root) && (app.root !== '' || side.apps.length === 1 || app.commands.size > 0))?.commands
    ?? side.anyApp;
}

// =============================================================================
// The frontend
// =============================================================================

interface FrontFile {
  file: string;
  /** Comments blanked, strings kept. */
  text: string;
  /** Comments and string contents blanked. */
  code: string;
  nodes: Node[];
  lineAt: (index: number) => number;
  offsetOfLine: (line: number) => number;
}

interface FrontScan {
  front: FrontFile;
  imports: readonly ImportMapping[];
  language: Language;
  bindings: FrontBindings;
}

/** A project function that takes a command as its first argument and hands it to `invoke`. */
interface Forwarder {
  name: string;
  file: string;
}

interface CallSite {
  /** Offset of the callee's first character. */
  at: number;
  /** Offset of its `(`. */
  open: number;
}

/** Every call of the callee `pattern` matches, from where the match ends; type arguments are skipped. */
function callsOf(front: FrontFile, pattern: RegExp): CallSite[] {
  const sites: CallSite[] = [];
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(front.code)) !== null) {
    const open = skipTypeArguments(front.code, skipSpace(front.code, m.index + m[0].length));
    if (front.code[open] === '(') sites.push({ at: m.index, open });
  }
  return sites;
}

/** What a JS argument is known to say: a literal with no holes, or a same-file constant holding one. */
function jsStringAt(front: FrontFile, span: [number, number] | undefined): string | null {
  if (!span) return null;
  const at = skipSpace(front.text, span[0]);
  const c = front.text[at];
  if (c === '"' || c === "'" || c === '`') {
    const value = readStringAt(front.text, at);
    if (value === null || value.includes(HOLE)) return null;
    // The whole argument, not the head of a concatenation.
    return front.text.slice(at, span[1]).trim().length === closedLength(front.text, at) ? value : null;
  }
  const name = /^[A-Za-z_$][\w$]*$/.exec(front.text.slice(span[0], span[1]).trim())?.[0];
  if (!name) return null;
  const constant = new RegExp(`\\bconst\\s+${escapeRe(name)}\\s*(?::[^=\\n]*)?=\\s*(['"\`])([^'"\`\\n$]*)\\1`).exec(front.text);
  if (!constant) return null;
  // Another function's local is not this argument.
  const declaredIn = ownerAt(front, constant.index);
  const local = declaredIn?.kind === 'function' || declaredIn?.kind === 'method';
  return local && declaredIn !== ownerAt(front, span[0]) ? null : constant[2]!;
}

function ownerAt(front: FrontFile, offset: number): Node | null {
  return ownerOf(front.nodes, front.lineAt(offset), columnAt(front.text, offset));
}

/** The length of the string literal at `at`, its quotes included. */
function closedLength(text: string, at: number): number {
  const q = text[at];
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === q) return i - at + 1;
  }
  return text.length - at;
}

/** A relative or aliased specifier, never a package from npm: a project's own bindings file. */
const PROJECT_SPECIFIER = /^(?:\.{1,2}\/|[~@]\/|#\/|[#$]\w)/;

interface FrontBindings {
  /** Local names of Tauri's `invoke`. */
  invoke: Set<string>;
  /** Local names of a namespace holding `invoke`: `core.invoke(…)`. */
  invokeHolders: Set<string>;
  listen: Set<string>;
  emit: Set<string>;
  /** The names in `emit` that are `emitTo(target, 'x', payload)`. */
  emitTo: Set<string>;
  /** Names bound by `const { invoke } = await import(…)`: a local that is the binding, not a shadow of it. */
  dynamic: Set<string>;
  /** Local names of a namespace holding `listen` / `once` / `emit`: `event.listen(…)`. */
  eventHolders: Set<string>;
  /** The file holds a window or webview handle: `appWindow.listen('x', …)`. */
  handles: boolean;
  /** tauri-specta's `commands`, its module not in the index. */
  typedCommands: Set<string>;
  /** tauri-specta's `events`. */
  typedEvents: Set<string>;
}

const GLOBAL_API = String.raw`(?:window\s*\.\s*)?__TAURI(?:_INTERNALS)?__`;
const GLOBAL_INVOKE = new RegExp(String.raw`(?<![\w$.])${GLOBAL_API}\s*\.\s*(?:(?:core|tauri)\s*\.\s*)?invoke\b`, 'g');
const GLOBAL_INVOKE_BINDING = new RegExp(
  String.raw`\b(?:const|let|var)\s*(?:\{[^}]*?\binvoke\b(?:\s*:\s*([\w$]+))?[^}]*\}\s*=\s*${GLOBAL_API}(?:\s*\.\s*(?:core|tauri))?\b|([\w$]+)\s*=\s*${GLOBAL_API}(?:\s*\.\s*(?:core|tauri))?\s*\.\s*invoke\b)`,
  'g'
);
const DYNAMIC_IMPORT = /\{([^{}]*)\}\s*=\s*await\s+import\(\s*['"](@tauri-apps\/api[^'"]*)['"]\s*\)/g;
const GLOBAL_EVENT_BINDING = new RegExp(
  String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${GLOBAL_API}\s*\.\s*event\b`,
  'g'
);

function readBindings(front: FrontFile, imports: readonly ImportMapping[], language: Language, ctx: ResolutionContext): FrontBindings {
  const b: FrontBindings = {
    invoke: new Set(), invokeHolders: new Set(), listen: new Set(), emit: new Set(), emitTo: new Set(), dynamic: new Set(), eventHolders: new Set(),
    handles: false, typedCommands: new Set(), typedEvents: new Set(),
  };
  const dynamic: ImportMapping[] = [];
  for (const m of front.text.matchAll(DYNAMIC_IMPORT)) {
    for (const part of m[1]!.split(',')) {
      const [name, local] = part.split(':').map((p) => p.trim());
      if (!name) continue;
      dynamic.push({ localName: local || name, exportedName: name, source: m[2]!, isDefault: false, isNamespace: false });
      b.dynamic.add(local || name);
    }
  }
  for (const m of [...imports, ...dynamic]) {
    if (m.source === API_ROOT && m.exportedName === 'tauri') b.invokeHolders.add(m.localName);
    else if (m.source === API_ROOT && m.exportedName === 'event') b.eventHolders.add(m.localName);
    else if (CORE_MODULES.has(m.source)) {
      if (m.isNamespace) b.invokeHolders.add(m.localName);
      else if (m.exportedName === 'invoke') b.invoke.add(m.localName);
    } else if (m.source === EVENT_MODULE) {
      if (m.isNamespace) b.eventHolders.add(m.localName);
      else if (m.exportedName === 'listen' || m.exportedName === 'once') b.listen.add(m.localName);
      else if (m.exportedName === 'emit' || m.exportedName === 'emitTo') {
        b.emit.add(m.localName);
        if (m.exportedName === 'emitTo') b.emitTo.add(m.localName);
      }
    } else if (HANDLE_MODULES.has(m.source)) b.handles = true;
    else if (m.exportedName === 'commands') {
      if (PROJECT_SPECIFIER.test(m.source) && resolveImportPath(m.source, front.file, language, ctx) === null) b.typedCommands.add(m.localName);
    } else if (m.exportedName === 'events') {
      if (PROJECT_SPECIFIER.test(m.source) || resolveImportPath(m.source, front.file, language, ctx) !== null) b.typedEvents.add(m.localName);
    }
  }
  GLOBAL_INVOKE_BINDING.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GLOBAL_INVOKE_BINDING.exec(front.code)) !== null) b.invoke.add(m[1] ?? m[2] ?? 'invoke');
  GLOBAL_EVENT_BINDING.lastIndex = 0;
  while ((m = GLOBAL_EVENT_BINDING.exec(front.code)) !== null) {
    for (const part of m[1]!.split(',')) {
      const [name, local] = part.split(':').map((s) => s.trim());
      if (name === 'listen' || name === 'once') b.listen.add(local || name);
      else if (name === 'emit' || name === 'emitTo') {
        b.emit.add(local || name);
        if (name === 'emitTo') b.emitTo.add(local || name);
      }
    }
  }
  return b;
}

/** Whether a local or parameter hides the imported name at the call. */
function shadowed(name: string, owner: Node, front: FrontFile, line: number, column: number, ctx: ResolutionContext): boolean {
  if (owner.kind !== 'function' && owner.kind !== 'method') return false;
  if (jsCodeBindsName(name, owner, front.file, line, ctx)) return true;
  // Destructured, which that check leaves alone: `const { invoke } = api`, `({ invoke }) => …`.
  const before = front.code.slice(front.offsetOfLine(owner.startLine) + owner.startColumn, front.offsetOfLine(line) + column);
  const n = escapeRe(name);
  return new RegExp(`(?:\\b(?:const|let|var)\\s*|\\(\\s*)[{[][^=;(){}]*?(?<![\\w$:.])${n}(?![\\w$])`).test(before);
}

/** The node a JS handler argument names, else the function the listener is written in. */
function handlerOf(front: FrontFile, span: [number, number] | undefined, imports: readonly ImportMapping[], language: Language, owner: Node, ctx: ResolutionContext): Node {
  if (!span) return owner;
  const name = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(front.text.slice(span[0], span[1]).trim())?.[1];
  if (!name) return owner;
  const here = front.nodes.find((n) => n.name === name && FN_KINDS.has(n.kind));
  if (here) return here;
  const imported = imports.find((m) => m.localName === name);
  if (!imported) return owner;
  const path = resolveImportPath(imported.source, front.file, language, ctx);
  if (!path) return owner;
  return ctx.getNodesInFile(path).find((n) => n.name === imported.exportedName && FN_KINDS.has(n.kind)) ?? owner;
}

interface Collected {
  edges: Edge[];
  seen: Set<string>;
  emitters: Endpoint[];
  listeners: Endpoint[];
  /** The listening function → the event struct, once per pair. */
  subscribed: Map<string, { owner: Node; struct: EventStruct; line: number; column: number }>;
}

function pushCommand(out: Collected, owner: Node, key: string, command: Command, callee: string, line: number, column: number): void {
  for (const target of command.nodes) {
    const pair = `${owner.id}>${target.id}`;
    if (out.seen.has(pair)) continue;
    out.seen.add(pair);
    out.edges.push({
      source: owner.id,
      target: target.id,
      kind: 'calls',
      line,
      column,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'tauri-command',
        channel: 'ipc',
        tier: TIER_CLIENT_TO_SERVER,
        callee,
        command: key,
        registeredAt: command.registeredAt,
      },
    });
  }
}

/** A callee's bare name, not a member of something else. */
function bareCallee(name: string): RegExp {
  return new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`, 'g');
}

/** The first parameter `node` declares, read from its head. */
function firstParameter(front: FrontFile, node: Node): string | null {
  const start = front.offsetOfLine(node.startLine) + node.startColumn;
  const head = front.code.slice(start, start + 600);
  return /^[^(]*\(\s*([A-Za-z_$][\w$]*)/.exec(head)?.[1] ?? null;
}

/**
 * The project's own functions around `invoke`, found by what they do: one that
 * hands its first parameter on as the command (`safeInvoke(cmd, args)`,
 * GitButler's `tauriInvoke`), or a field set to one (`invoke = tauriInvoke`).
 * Their callers hold the literal, and they need not mention Tauri at all. A
 * function that only shares `invoke`'s name forwards nothing.
 */
function findForwarders(scans: readonly FrontScan[], ctx: ResolutionContext): Forwarder[] {
  const found = new Map<string, Forwarder>();
  const forwardersIn = (scan: FrontScan): Forwarder[] => {
    const here = new Map<string, Forwarder>();
    const callees: RegExp[] = [
      ...[...scan.bindings.invoke].map(bareCallee),
      ...[...scan.bindings.invokeHolders].map((h) => new RegExp(`(?<![\\w$.])${escapeRe(h)}\\s*\\.\\s*invoke(?![\\w$])`, 'g')),
      GLOBAL_INVOKE,
    ];
    for (const forwarder of found.values()) {
      const local = localForwarder(forwarder, scan, ctx);
      if (local) callees.push(bareCallee(local));
      callees.push(new RegExp(`\\.\\s*${escapeRe(forwarder.name)}(?![\\w$])`, 'g'));
    }
    for (const callee of callees) {
      for (const call of callsOf(scan.front, callee)) {
        const span = argumentSpans(scan.front.code, call.open)[0];
        const argument = span ? scan.front.code.slice(span[0], span[1]).trim() : '';
        if (!/^[A-Za-z_$][\w$]*$/.test(argument)) continue;
        const line = scan.front.lineAt(call.at);
        const owner = ownerOf(scan.front.nodes, line, columnAt(scan.front.text, call.at));
        if (!owner || (owner.kind !== 'function' && owner.kind !== 'method') || owner.name === '<anonymous>') continue;
        if (firstParameter(scan.front, owner) === argument) here.set(owner.name, { name: owner.name, file: scan.front.file });
      }
    }
    return [...here.values()];
  };
  const aliasesOf = (forwarder: Forwarder, scan: FrontScan): void => {
    const alias = new RegExp(`(?:^|[\\s;{])(?:(?:public|private|protected|readonly|static)\\s+)*([A-Za-z_$][\\w$]*)\\s*(?::[^=;\\n]*)?=\\s*${escapeRe(forwarder.name)}\\s*[;\\n]`, 'g');
    for (const m of scan.front.code.matchAll(alias)) {
      if (!found.has(m[1]!)) found.set(m[1]!, { name: m[1]!, file: forwarder.file });
    }
  };
  // A wrapper of a wrapper: a few rounds, since nobody writes a tall stack.
  for (let round = 0; round < 3; round++) {
    const before = found.size;
    for (const scan of scans) {
      for (const forwarder of forwardersIn(scan)) if (!found.has(forwarder.name)) found.set(forwarder.name, forwarder);
      for (const forwarder of [...found.values()]) if (forwarder.file === scan.front.file) aliasesOf(forwarder, scan);
    }
    if (found.size === before) break;
  }
  return [...found.values()];
}

/** The name a forwarder has in this file: its own, or the one an import gives it. */
function localForwarder(forwarder: Forwarder, scan: FrontScan, ctx: ResolutionContext): string | null {
  if (forwarder.file === scan.front.file) return forwarder.name;
  const imported = scan.imports.find((m) => m.exportedName === forwarder.name);
  if (!imported) return null;
  return resolveImportPath(imported.source, scan.front.file, scan.language, ctx) !== null ? imported.localName : null;
}

function readFrontend(scan: FrontScan, forwarders: readonly Forwarder[], side: RustSide, ctx: ResolutionContext, out: Collected): void {
  const { front, imports, language, bindings: b } = scan;
  const table = tableFor(front.file, side);
  const scope = side.scopeOf(front.file);

  /** A local or parameter that hides `binding` where the call is. */
  const hidden = (binding: string | null, at: { owner: Node; line: number; column: number }): boolean =>
    binding !== null && !b.dynamic.has(binding) && shadowed(binding, at.owner, front, at.line, at.column, ctx);
  const site = (call: CallSite): { owner: Node; line: number; column: number } | null => {
    const line = front.lineAt(call.at);
    const column = columnAt(front.text, call.at);
    const owner = ownerOf(front.nodes, line, column);
    return owner ? { owner, line, column } : null;
  };
  const command = (key: string): Command | null => {
    const plugin = key.startsWith('plugin:');
    return (plugin ? side.plugins.get(key) : table.get(key)) ?? null;
  };

  const invokeCall = (call: CallSite, binding: string | null, callee: string): void => {
    const key = jsStringAt(front, argumentSpans(front.code, call.open)[0]);
    if (key === null) return;
    const target = command(key);
    if (!target) return;
    const at = site(call);
    if (!at || hidden(binding, at)) return;
    pushCommand(out, at.owner, key, target, callee, at.line, at.column);
  };

  for (const name of b.invoke) {
    for (const call of callsOf(front, bareCallee(name))) invokeCall(call, name, name);
  }
  for (const holder of b.invokeHolders) {
    for (const call of callsOf(front, new RegExp(`(?<![\\w$.])${escapeRe(holder)}\\s*\\.\\s*invoke(?![\\w$])`, 'g'))) invokeCall(call, holder, `${holder}.invoke`);
  }
  for (const call of callsOf(front, GLOBAL_INVOKE)) invokeCall(call, null, 'invoke');
  for (const forwarder of forwarders) {
    const local = localForwarder(forwarder, scan, ctx);
    if (local) for (const call of callsOf(front, bareCallee(local))) invokeCall(call, local, local);
    for (const call of callsOf(front, new RegExp(`\\.\\s*${escapeRe(forwarder.name)}(?![\\w$])`, 'g'))) invokeCall(call, null, forwarder.name);
  }

  // `commands.saveFile()` with no bindings file to walk through.
  for (const holder of b.typedCommands) {
    const camel = new Map<string, string>();
    for (const key of table.keys()) camel.set(toCamel(key), key);
    const pattern = new RegExp(`(?<![\\w$.])${escapeRe(holder)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(front.code)) !== null) {
      const key = camel.get(m[1]!);
      const open = skipTypeArguments(front.code, skipSpace(front.code, m.index + m[0].length));
      if (!key || front.code[open] !== '(') continue;
      const target = table.get(key);
      const at = site({ at: m.index, open });
      if (!target || !at || shadowed(holder, at.owner, front, at.line, at.column, ctx)) continue;
      pushCommand(out, at.owner, key, target, `${holder}.${m[1]!}`, at.line, at.column);
    }
  }

  const listenCall = (call: CallSite, binding: string | null, event: string | null, handlerIndex: number): void => {
    const spans = argumentSpans(front.code, call.open);
    const name = event ?? jsStringAt(front, spans[0]);
    if (name === null || name.startsWith('tauri://')) return;
    const at = site(call);
    if (!at || hidden(binding, at)) return;
    out.listeners.push({
      node: handlerOf(front, spans[handlerIndex], imports, language, at.owner, ctx),
      event: name, file: front.file, line: at.line, column: at.column, rust: false, scope,
    });
    const struct = structInScope(side.byEvent.get(name), scope);
    if (struct) {
      const key = `${at.owner.id}>${struct.node.id}`;
      if (!out.subscribed.has(key)) out.subscribed.set(key, { owner: at.owner, struct, line: at.line, column: at.column });
    }
  };
  const emitCall = (call: CallSite, binding: string | null, event: string | null, eventIndex: number): void => {
    const name = event ?? jsStringAt(front, argumentSpans(front.code, call.open)[eventIndex]);
    if (name === null) return;
    const at = site(call);
    if (!at || hidden(binding, at)) return;
    out.emitters.push({ node: at.owner, event: name, file: front.file, line: at.line, column: at.column, rust: false, scope });
  };

  for (const name of b.listen) {
    for (const call of callsOf(front, bareCallee(name))) listenCall(call, name, null, 1);
  }
  for (const name of b.emit) {
    for (const call of callsOf(front, bareCallee(name))) emitCall(call, name, null, b.emitTo.has(name) ? 1 : 0);
  }
  for (const holder of b.eventHolders) {
    for (const call of callsOf(front, new RegExp(`(?<![\\w$.])${escapeRe(holder)}\\s*\\.\\s*(?:listen|once)(?![\\w$])`, 'g'))) listenCall(call, holder, null, 1);
    for (const call of callsOf(front, new RegExp(`(?<![\\w$.])${escapeRe(holder)}\\s*\\.\\s*emit(?![\\w$])`, 'g'))) emitCall(call, holder, null, 0);
  }
  if (b.handles) {
    // A window or webview handle has the same three, and is often a call away.
    for (const call of callsOf(front, /\.\s*(?:listen|once)(?![\w$])/g)) listenCall(call, null, null, 1);
    for (const call of callsOf(front, /\.\s*emit(?![\w$])/g)) emitCall(call, null, null, 0);
  }
  for (const holder of b.typedEvents) {
    // `events.fileSaved.listen(fn)`, `events.fileSaved(appWindow).once(fn)`.
    const pattern = new RegExp(`(?<![\\w$.])${escapeRe(holder)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(front.code)) !== null) {
      let end = skipSpace(front.code, m.index + m[0].length);
      if (front.code[end] === '(') {
        const close = closeBracket(front.code, end);
        if (close < 0) continue;
        end = skipSpace(front.code, close + 1);
      }
      const member = /^\.\s*(listen|once|emit)(?![\w$])/.exec(front.code.slice(end, end + 32));
      if (!member) continue;
      const open = skipSpace(front.code, end + member[0].length);
      if (front.code[open] !== '(') continue;
      const struct = structInScope(side.byCamel.get(m[1]!), scope);
      if (!struct) continue;
      if (member[1] === 'emit') emitCall({ at: m.index, open }, holder, struct.event, 0);
      else listenCall({ at: m.index, open }, holder, struct.event, 0);
    }
  }
}

function languageOf(file: string): Language {
  if (file.endsWith('.svelte')) return 'svelte';
  if (file.endsWith('.vue')) return 'vue';
  return 'typescript';
}

function pairEvents(emitters: Endpoint[], listeners: Endpoint[], out: Collected): void {
  const emitting = new Map<string, Endpoint[]>();
  for (const e of emitters) {
    const list = emitting.get(e.event);
    if (list) list.push(e);
    else emitting.set(e.event, [e]);
  }
  const listening = new Map<string, Endpoint[]>();
  for (const l of listeners) {
    const list = listening.get(l.event);
    if (list) list.push(l);
    else listening.set(l.event, [l]);
  }
  for (const [event, from] of emitting) {
    const to = listening.get(event);
    if (!to || distinctNodes(from) > EVENT_FANOUT_CAP || distinctNodes(to) > EVENT_FANOUT_CAP) continue;
    for (const e of from) {
      for (const l of to) {
        if (e.node.id === l.node.id || !sameScope(e.scope, l.scope)) continue;
        const pair = `${e.node.id}>${l.node.id}`;
        if (out.seen.has(pair)) continue;
        out.seen.add(pair);
        const tier = e.rust === l.rust ? undefined : e.rust ? TIER_SERVER_TO_CLIENT : TIER_CLIENT_TO_SERVER;
        out.edges.push({
          source: e.node.id,
          target: l.node.id,
          kind: 'calls',
          line: e.line,
          column: e.column,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'tauri-event',
            channel: 'event',
            ...(tier ? { tier } : {}),
            event,
            registeredAt: `${l.file}:${l.line}`,
          },
        });
      }
    }
  }
}

function distinctNodes(ends: readonly Endpoint[]): number {
  return new Set(ends.map((e) => e.node.id)).size;
}

/**
 * Whether this project has a Tauri core at all, from two indexed lookups: a
 * Rust `use tauri…` is an import node, and a `#[tauri::command]` is a decorator.
 * A Rust + TypeScript project that has neither pays for nothing else here.
 */
function hasTauriCore(queries: QueryBuilder, ctx: ResolutionContext): boolean {
  return ['tauri', 'tauri_specta'].some((name) => ctx.getNodesByName(name).some((n) => n.kind === 'import' && n.language === 'rust')) ||
    queries.hasDecoratedFunction('rust', 'tauri::command');
}

export async function tauriEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  if (!hasTauriCore(queries, ctx)) return [];
  const side = await readRustSide(ctx, onYield);
  const out: Collected = { edges: [], seen: new Set(), emitters: [...side.emitters], listeners: [...side.listeners], subscribed: new Map() };

  const frontendFiles = ctx.getAllFiles().filter((file) => FRONTEND_FILE.test(file) && !isTestPath(file));
  const scans = new Map<string, FrontScan>();
  const scanFile = (file: string, source: string): void => {
    const text = stripCommentsForRegex(source, 'typescript');
    const language = languageOf(file);
    const imports = ctx.getImportMappings(file, language);
    const front: FrontFile = {
      file, text, code: blankStringContents(text), nodes: ctx.getNodesInFile(file),
      lineAt: makeLineAt(source, 1), offsetOfLine: makeOffsetOfLine(source),
    };
    scans.set(file, { front, imports, language, bindings: readBindings(front, imports, language, ctx) });
  };
  let scanned = 0;
  for (const file of frontendFiles) {
    if ((++scanned & 63) === 0) await onYield();
    const source = ctx.readFile(file);
    if (source && FRONTEND_GATE.test(source)) scanFile(file, source);
  }
  const forwarders = findForwarders([...scans.values()], ctx);
  if (forwarders.length > 0) {
    // A wrapper's callers need not mention Tauri.
    for (const file of frontendFiles) {
      if (scans.has(file)) continue;
      if ((++scanned & 63) === 0) await onYield();
      const source = ctx.readFile(file);
      if (source && forwarders.some((f) => source.includes(f.name))) scanFile(file, source);
    }
  }
  for (const scan of scans.values()) {
    if ((++scanned & 63) === 0) await onYield();
    readFrontend(scan, forwarders, side, ctx, out);
  }

  pairEvents(out.emitters, out.listeners, out);
  for (const { owner, struct, line, column } of out.subscribed.values()) {
    out.edges.push({
      source: owner.id,
      target: struct.node.id,
      kind: 'references',
      line,
      column,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'tauri-event',
        channel: 'event',
        event: struct.event,
        registeredAt: `${struct.node.filePath}:${struct.node.startLine}`,
      },
    });
  }
  return out.edges;
}

/** Files this pass reads as input; a sync that changes one draws the links again. */
export function hasTauriPattern(filePath: string, content: string): boolean {
  if (filePath.endsWith('.rs')) return /\btauri|generate_handler|collect_commands|\.\s*(?:emit|listen|once)\w*\s*\(/.test(content);
  if (!FRONTEND_FILE.test(filePath)) return false;
  return /@tauri-apps\/|__TAURI|[iI]nvoke\w*\s*[<(]|\b(?:commands|events)\s*\.\s*\w/.test(content);
}
