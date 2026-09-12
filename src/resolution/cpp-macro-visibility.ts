import * as path from 'path';
import type { ResolutionContext, UnresolvedRef } from './types';
import { resolveImportPath } from './import-resolver';
import { stripCommentsForRegex } from './strip-comments';

type Truth = boolean | undefined;
type Event = { line: number; defined: Truth };
type Definition = { defined: Truth; value: Truth; assumedDefined: boolean; assumedValue: Truth; scope: string[] };
type Cache = { roots: Map<string, Map<string, Event[]>>; lines: Map<string, string[]>; includes: Map<string, string | null> };
const memo = new WeakMap<ResolutionContext, Cache>();
const and = (a: Truth, b: Truth): Truth => a === false || b === false ? false : a === true && b === true ? true : undefined;
const or = (a: Truth, b: Truth): Truth => a === true || b === true ? true : a === false && b === false ? false : undefined;
const not = (a: Truth): Truth => a === undefined ? undefined : !a;

export function clearCppMacroVisibility(context: ResolutionContext): void { memo.delete(context); }

/** Textual include order and locally decidable branches, not a full C preprocessor. */
export function isVisibleCppMacro(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (!['c', 'cpp'].includes(ref.language) || ref.referenceKind !== 'calls' || !/^\w+$/.test(ref.referenceName)) return false;
  if (!context.getNodesByName(ref.referenceName).some(n =>
    n.kind === 'constant' && /^\s*#\s*define\b/.test(n.signature ?? ''))) return false;
  let cache = memo.get(context);
  if (!cache) { cache = { roots: new Map(), lines: new Map(), includes: new Map() }; memo.set(context, cache); }
  const rootKey = `${ref.language}\0${ref.filePath}`;
  let timeline = cache.roots.get(rootKey);
  if (!timeline) {
    timeline = new Map();
    const definitions = new Map<string, Definition>();
    const visiting = new Set<string>();
    const once = new Set<string>();
    const lookup = (name: string, scope: string[], field: 'defined' | 'value'): Truth => {
      const def = definitions.get(name);
      if (!def) return undefined;
      // A definition under an unknown guard is certain while we remain on
      // that same hypothetical path, but uncertain after leaving it.
      if (def[field] === undefined && def.scope.every((part, i) => scope[i] === part)) {
        return field === 'defined' ? def.assumedDefined : def.assumedValue;
      }
      return def[field];
    };
    const condition = (expression: string, scope: string[]): Truth => {
      const text = expression.trim();
      if (/^(?:0x[\da-f]+|\d+)[uUlL]*$/i.test(text)) return Number(text.replace(/[uUlL]+$/, '')) !== 0;
      const def = text.match(/^(!)?\s*defined\s*(?:\(\s*(\w+)\s*\)|(\w+))$/);
      if (def) { const known = lookup(def[2] ?? def[3]!, scope, 'defined'); return def[1] ? not(known) : known; }
      return /^\w+$/.test(text) ? lookup(text, scope, 'value') : undefined;
    };
    const scan = (file: string, inherited: Truth, inheritedScope: string[], includeLine?: number): void => {
      if (visiting.has(file) || once.has(file)) return;
      visiting.add(file);
      let lines = cache!.lines.get(file);
      if (!lines) { lines = stripCommentsForRegex(context.readFile(file) ?? '', 'cpp').split(/\r?\n/); cache!.lines.set(file, lines); }
      const frames: Array<{ parent: Truth; taken: Truth; scope: string[] }> = [];
      let active = inherited;
      let scope = inheritedScope;
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i]!;
        const branch = text.match(/^\s*#\s*(ifdef|ifndef|if|elif|else|endif)\b(.*)$/);
        if (branch) {
          const op = branch[1];
          if (op === 'if' || op === 'ifdef' || op === 'ifndef') {
            const test = op === 'if' ? condition(branch[2]!, scope) : lookup(branch[2]!.trim(), scope, 'defined');
            const selected = op === 'ifndef' ? not(test) : test;
            frames.push({ parent: active, taken: selected, scope }); active = and(active, selected);
            if (selected === undefined) scope = [...scope, `${file}:${i}`];
          } else if (op === 'endif') { const frame = frames.pop(); active = frame?.parent ?? inherited; scope = frame?.scope ?? inheritedScope; }
          else {
            const frame = frames[frames.length - 1];
            if (frame) {
              const test = op === 'else' ? true : condition(branch[2]!, frame.scope);
              const selected = and(not(frame.taken), test);
              active = and(frame.parent, selected); frame.taken = or(frame.taken, test);
              scope = selected === undefined ? [...frame.scope, `${file}:${i}`] : frame.scope;
            }
          }
          continue;
        }
        if (active === false) continue;
        if (/^\s*#\s*pragma\s+once\b/.test(text) && active === true) once.add(file);
        const directive = text.match(/^\s*#\s*(define|undef)\s+(\w+)\b/);
        if (directive) {
          const name = directive[2]!;
          const defining = directive[1] === 'define';
          const previous = definitions.get(name);
          // An absent entry is false; an existing unknown must stay unknown.
          const prior = previous ? previous.defined : false;
          const defined = defining ? or(prior, active) : and(prior, not(active));
          const assumedValue = defining ? condition(text.slice(directive[0].length), scope) : false;
          const value = active === true ? assumedValue : undefined;
          definitions.set(name, { defined, value, assumedDefined: defining, assumedValue, scope: [...scope] });
          const events = timeline!.get(name) ?? [];
          events.push({ line: includeLine ?? i + 1, defined }); timeline!.set(name, events);
        }
        const include = text.match(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/);
        if (include) {
          const spec = include[2]!;
          const key = `${ref.language}\0${file}\0${include[1]}${spec}`;
          let target = cache!.includes.get(key);
          if (target === undefined) {
            const local = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec.replace(/\\/g, '/')));
            target = include[1] === '"' && !local.startsWith('../') && !path.posix.isAbsolute(local) && context.fileExists(local)
              ? local : resolveImportPath(spec, file, ref.language, context);
            if (!target) {
              const matches = context.getAllFiles().filter(f => f === spec || f.endsWith('/' + spec));
              if (matches.length === 1) target = matches[0]!;
            }
            cache!.includes.set(key, target);
          }
          if (target) scan(target, active, scope, includeLine ?? i + 1);
        }
      }
      visiting.delete(file);
    };
    scan(ref.filePath, true, []);
    // Bound root timelines; cache only COMPLETE translation-unit walks, never
    // a child truncated by an include cycle or evaluated with different flags.
    if (cache.roots.size >= 128) cache.roots.delete(cache.roots.keys().next().value!);
    cache.roots.set(rootKey, timeline);
  }
  const before = (timeline.get(ref.referenceName) ?? []).filter(e => e.line <= ref.line);
  // An unknown build-flag arm remains possible, so it cannot justify an ordinary call.
  return before.length > 0 && before[before.length - 1]!.defined !== false;
}
