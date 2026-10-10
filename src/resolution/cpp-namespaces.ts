/**
 * C and C++ namespaces the source spells in ways the index cannot see: a
 * namespace alias (`namespace py = pybind11;`) and a macro that opens a
 * namespace (`FMT_BEGIN_NAMESPACE`). Shared by name matching and the C++
 * class lookup (cpp-supertypes.ts).
 */
import type { ResolutionContext } from './types';
import { stripCommentsForRegex } from './strip-comments';

const CPP_NS_MACROS = new WeakMap<ResolutionContext, { openers: Map<string, string[]>; openerFns: Set<string>; closers: Map<string, number>; aliases: Map<string, string> }>();
const CPP_NS_FRAMES = new WeakMap<ResolutionContext, Map<string, Array<{ start: number; end: number; path: string[] }>>>();
/** A closing macro's body: `}` / `} }`, maybe beside a pragma macro (`PYBIND11_WARNING_POP }`). */
const CPP_CLOSER_BODY = /^(?:[A-Za-z_]\w*\s+)*\}(?:\s*\})*\s*;?$/;
const CPP_NS_ALIASES = new WeakMap<ResolutionContext, Map<string, string>>();

/** The project's namespace aliases: `namespace py = pybind11;`. */
export function cppNamespaceAliases(context: ResolutionContext): Map<string, string> {
  const hit = CPP_NS_ALIASES.get(context);
  if (hit) return hit;
  const aliases = new Map<string, string>();
  for (const file of context.getAllFiles()) {
    if (!/\.(?:h|hh|hpp|hxx|inl|c|cc|cpp|cxx)$/i.test(file)) continue;
    const source = context.readFile(file);
    if (!source || !source.includes('namespace')) continue;
    for (const m of source.matchAll(/^[ \t]*namespace[ \t]+([A-Za-z_]\w*)[ \t]*=[ \t]*(?:::)?([A-Za-z_][\w:]*)[ \t]*;/gm)) {
      if (!aliases.has(m[1]!)) aliases.set(m[1]!, m[2]!);
    }
  }
  CPP_NS_ALIASES.set(context, aliases);
  return aliases;
}

/**
 * The project's namespace-opening macros — `#define FMT_BEGIN_NAMESPACE
 * namespace fmt { inline namespace v12 {`, `#define RAPIDJSON_NAMESPACE_BEGIN
 * namespace RAPIDJSON_NAMESPACE {` (through `#define RAPIDJSON_NAMESPACE
 * rapidjson`) — as the namespace path each opens (inline namespaces are
 * transparent), and the closing macros as how many scopes each closes.
 */
function cppNamespaceMacros(context: ResolutionContext): { openers: Map<string, string[]>; openerFns: Set<string>; closers: Map<string, number>; aliases: Map<string, string> } {
  const hit = CPP_NS_MACROS.get(context);
  if (hit) return hit;
  const openers = new Map<string, string[]>();
  // `#define PYBIND11_NAMESPACE_BEGIN(name) namespace name {`, used as `PYBIND11_NAMESPACE_BEGIN(detail)`.
  const openerFns = new Set<string>();
  const closers = new Map<string, number>();
  const aliases = new Map<string, string>();
  const bodies: Array<[string, string]> = [];
  for (const file of context.getAllFiles()) {
    if (!/\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tcc)$/i.test(file)) continue;
    const raw = context.readFile(file);
    if (!raw || !raw.includes('#') || !raw.includes('define')) continue;
    const source = stripCommentsForRegex(raw.replace(/\\\r?\n/g, ' '), 'cpp');
    for (const m of source.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(\(\s*([A-Za-z_]\w*)?\s*\))?[ \t]+([^\n]*)$/gm)) {
      const body = m[4]!.trim();
      if (m[2] !== undefined) {
        // (a trailing pragma macro — `PYBIND11_WARNING_PUSH` — rides along)
        if (m[3] && new RegExp(`^namespace\\s+${m[3]}\\s*\\{[\\w\\s]*$`).test(body)) openerFns.add(m[1]!);
        else if (CPP_CLOSER_BODY.test(body)) closers.set(m[1]!, (body.match(/\}/g) ?? []).length);
        continue;
      }
      if (/^[A-Za-z_]\w*$/.test(body)) aliases.set(m[1]!, body);
      else if (CPP_CLOSER_BODY.test(body)) closers.set(m[1]!, (body.match(/\}/g) ?? []).length);
      // An inline namespace (transparent, and often named by a macro call) is skipped.
      else if (/^(?:inline\s+namespace\s+[^{}]*\{\s*|namespace\s+[A-Za-z_]\w*\s*\{\s*)+[\w\s]*$/.test(body)) bodies.push([m[1]!, body]);
    }
  }
  for (const [name, body] of bodies) {
    if (openers.has(name)) continue;
    const path = [...body.replace(/inline\s+namespace\s+[^{}]*\{/g, '').matchAll(/namespace\s+([A-Za-z_]\w*)/g)]
      .map((m) => aliases.get(m[1]!) ?? m[1]!);
    if (path.length > 0) openers.set(name, path);
  }
  const macros = { openers, openerFns, closers, aliases };
  CPP_NS_MACROS.set(context, macros);
  return macros;
}

/** The line ranges of a C / C++ file each namespace macro opens, with the namespace path it opens. */
export function cppMacroNamespaceFrames(file: string, context: ResolutionContext): Array<{ start: number; end: number; path: string[] }> {
  let memo = CPP_NS_FRAMES.get(context);
  if (!memo) {
    memo = new Map();
    CPP_NS_FRAMES.set(context, memo);
  }
  const hit = memo.get(file);
  if (hit) return hit;
  const frames: Array<{ start: number; end: number; path: string[] }> = [];
  const { openers, openerFns, closers, aliases } = cppNamespaceMacros(context);
  if (openers.size > 0 || openerFns.size > 0) {
    const lines = context.getFileLines?.(file) ?? context.readFile(file)?.split(/\r?\n/) ?? [];
    const open: Array<{ start: number; path: string[] }> = [];
    lines.forEach((text, i) => {
      const m = /^[ \t]*([A-Z_][A-Z0-9_]*)(?:\(\s*([A-Za-z_]\w*)?\s*\))?[ \t]*;?[ \t]*(?:\/\/.*|\/\*.*\*\/[ \t]*)?\r?$/.exec(text);
      const token = m?.[1];
      if (!token) return;
      const arg = m[2];
      const path = arg !== undefined && openerFns.has(token) ? [aliases.get(arg) ?? arg] : arg === undefined ? openers.get(token) : undefined;
      if (path) open.push({ start: i + 1, path });
      else if (closers.has(token) && open.length > 0) frames.push({ ...open.pop()!, end: i + 1 });
    });
    for (const frame of open) frames.push({ ...frame, end: lines.length });
  }
  memo.set(file, frames);
  return frames;
}

/** Drop the per-context namespace memos (see ReferenceResolver.clearCaches). */
export function clearCppNamespaceMemos(context: ResolutionContext): void {
  CPP_NS_MACROS.delete(context);
  CPP_NS_FRAMES.delete(context);
  CPP_NS_ALIASES.delete(context);
}
