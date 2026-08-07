/**
 * Dynamic-dispatch boundary detection for codegraph_explore (#687).
 *
 * When the flow an agent asked about does NOT connect statically, the cause is
 * almost always a dynamic-dispatch site: a computed member call, getattr,
 * reflection, a string-keyed bus, a typed command/mediator dispatch. Guessing
 * the missing edge was rejected (silent beats wrong — a wrong edge poisons the
 * map and teaches abandonment). Instead, explore ANNOUNCES the boundary
 * honestly: the exact site where the static path ends, the dispatch form, and
 * — when a key is statically visible (string literal, `:symbol`, `new Type`)
 * — that key, so the caller can shortlist candidate targets.
 *
 * Detection is deterministic regex over the comment/string-stripped bodies of
 * the symbols the agent named, at QUERY TIME only. The graph is never mutated;
 * an unbroken flow never triggers a scan. Matching runs on the stripped text
 * (so commented-out / string-embedded code can't fire) but snippets and keys
 * are sliced from the ORIGINAL source at the same offsets — both strippers
 * blank contents in place, preserving offsets, precisely for this.
 * (`stripCommentsForRegex` blanks comments but deliberately KEEPS string
 * contents — framework extractors need route literals; here a dispatch shape
 * inside a string is a false positive, so {@link blankStringContents} blanks
 * them too, quotes preserved.)
 */
import { stripCommentsForRegex, type CommentLang } from '../resolution/strip-comments';

export interface BoundaryMatch {
  /** Stable form id, e.g. 'computed-call' — used for per-form dedupe. */
  form: string;
  /** Human label for the dispatch form, e.g. 'computed member call'. */
  label: string;
  /** One-line source snippet of the site (from the original, untrimmed text). */
  snippet: string;
  /** 1-based line within the scanned body's FILE (absolute, ready to print). */
  line: number;
  /**
   * Statically-visible dispatch key, when one exists: the string literal in
   * `handlers['save']`, the `:symbol` in ruby `send`, the type name in
   * `Send(new CreateCmd(...))`. Drives candidate lookup. Undefined when the
   * key is a runtime value (variable, computed expression).
   */
  key?: string;
  /** For typed-bus matches the key is a TYPE name (candidates ~ `${key}Handler`). */
  keyIsType?: boolean;
  /** Additional sites of the same form+key in this body beyond the reported one. */
  moreSites?: number;
}

interface FormSpec {
  form: string;
  label: string;
  /** Languages this form applies to; undefined = all. Node.language values. */
  langs?: Set<string>;
  re: RegExp;
  /**
   * Derive the dispatch key from the ORIGINAL-source snippet around the match
   * (match start .. match end + keyWindow). Return undefined when no static key.
   */
  keyFrom?: (orig: string) => { key: string; keyIsType?: boolean } | undefined;
  /**
   * Extra ORIGINAL chars after the match end handed to keyFrom, capped at the
   * first newline — for forms whose key trails the matched prefix, e.g.
   * `.getMethod(` → `"handlePing"`. Forms with $-anchored keyFrom regexes
   * must leave this unset (the anchor relies on the slice ending at the match).
   */
  keyWindow?: number;
}

const JS_FAMILY = new Set(['typescript', 'javascript', 'tsx', 'jsx', 'vue', 'svelte', 'astro', 'arkts']);
const PY = new Set(['python']);
const RB = new Set(['ruby']);
const PHP = new Set(['php']);
const JVM_CS_GO = new Set(['java', 'kotlin', 'scala', 'csharp', 'go']);
const SWIFT_OBJC = new Set(['swift', 'objc', 'objcpp', 'objective-c']);

/** Exactly one quoted literal and no concatenation → that literal is the key. */
function singleStringLiteral(text: string): string | undefined {
  const m = text.match(/^[^'"`]*(['"`])([\w.:-]{2,64})\1[^'"`]*$/);
  return m ? m[2] : undefined;
}

const FORMS: FormSpec[] = [
  {
    // handlers[action.type](payload) / registry[key](args) / table[k](...) —
    // the `](` adjacency is the gate; a word/`)`/`]` char must precede `[` so
    // array literals and markdown-ish text in prose can't fire.
    form: 'computed-call',
    label: 'computed member call',
    re: /[\w$)\]]\s*\[([^[\]\n]{1,80})\]\s*\(/g,
    keyFrom: (orig) => {
      const inner = orig.match(/\[([^[\]\n]{1,80})\]\s*\($/);
      const key = inner ? singleStringLiteral(inner[1]!) : undefined;
      return key ? { key } : undefined;
    },
  },
  {
    // import(expr) / require(expr) with a NON-literal argument → runtime module
    // choice. Literal imports are ordinary edges and never reach this scanner.
    form: 'dynamic-import',
    label: 'dynamic import',
    langs: JS_FAMILY,
    re: /\b(?:import|require)\s*\(\s*(?![\s'"`)])/g,
  },
  {
    form: 'dynamic-import',
    label: 'dynamic import',
    langs: PY,
    re: /\bimportlib\.import_module\s*\(|\b__import__\s*\(/g,
  },
  {
    // obj.send(:method_name) / public_send / method(:name) — ruby metaprogramming.
    form: 'ruby-send',
    label: 'send dispatch',
    langs: RB,
    re: /\.(?:public_)?send\s*\(\s*:?\w+|\bmethod\s*\(\s*:\w+\s*\)/g,
    keyFrom: (orig) => {
      const m = orig.match(/:(\w+)/);
      return m ? { key: m[1]! } : undefined;
    },
  },
  {
    // call_user_func([$this, 'method']) / $this->$method() / $callback() —
    // PHP variable functions and callables.
    form: 'php-dynamic',
    label: 'dynamic call',
    langs: PHP,
    re: /\bcall_user_func(?:_array)?\s*\(|\$this\s*->\s*\$\w+\s*\(|\$\w+\s*\(/g,
    keyWindow: 80,
    keyFrom: (orig) => {
      const key = singleStringLiteral(orig);
      return key ? { key } : undefined;
    },
  },
  {
    // Reflection: Method.invoke / getMethod("x") / Class.forName / Go
    // reflect MethodByName / C# Activator.CreateInstance, GetMethod.
    form: 'reflection',
    label: 'reflective dispatch',
    langs: JVM_CS_GO,
    re: /\.invoke\s*\(|\.get(?:Declared)?Method\s*\(|\.GetMethod\s*\(|MethodByName\s*\(|Activator\.CreateInstance|Class\.forName\s*\(/g,
    keyWindow: 80,
    keyFrom: (orig) => {
      const key = singleStringLiteral(orig);
      return key ? { key } : undefined;
    },
  },
  {
    // new Proxy(target, handler) / Reflect.get|apply — JS metaobject dispatch.
    form: 'proxy-reflect',
    label: 'Proxy/Reflect dispatch',
    langs: JS_FAMILY,
    re: /\bnew\s+Proxy\s*\(|\bReflect\.(?:get|apply|construct)\s*\(/g,
  },
  {
    // mediator.Send(new CreateTodoItemCommand(...)) / bus.publish(new OrderEvent(...))
    // — typed message dispatch (MediatR/CQRS/event-bus). The request TYPE is the
    // key; the conventional target is `<Type>Handler`.
    form: 'typed-bus',
    label: 'typed message dispatch',
    re: /\.(?:[Ss]end|[Pp]ublish|[Dd]ispatch|[Ee]xecute|[Pp]ost|[Ee]mit)(?:Async)?\s*(?:<[^<>\n]{0,80}>)?\s*\(\s*new\s+([A-Z]\w*)/g,
    keyFrom: (orig) => {
      const m = orig.match(/new\s+([A-Z]\w*)$/);
      return m ? { key: m[1]!, keyIsType: true } : undefined;
    },
  },
  {
    // emitter.emit(eventVar, ...) / store.dispatch(action) — string-keyed
    // dispatch where the key is a RUNTIME value. (Literal-keyed emits are the
    // synthesizer's territory and connect statically when a handler matches.)
    form: 'var-key-dispatch',
    label: 'string-keyed dispatch (runtime key)',
    re: /\.(?:emit|dispatch|trigger|fire|publish|broadcast)\s*\(\s*[A-Za-z_$][\w$]*(?:\.[\w$]+){0,3}\s*[,)]/g,
  },
  {
    // Swift/ObjC: #selector(name) / NSClassFromString — runtime selector dispatch.
    form: 'selector',
    label: 'selector dispatch',
    langs: SWIFT_OBJC,
    re: /#selector\s*\(\s*([\w.]+)|NSClassFromString\s*\(/g,
    keyFrom: (orig) => {
      const m = orig.match(/#selector\s*\(\s*([\w.]+)/);
      if (!m) return undefined;
      const segs = m[1]!.split('.');
      return { key: segs[segs.length - 1]! };
    },
  },
];

/** Map a Node.language to the comment-stripper's language set. */
function commentLang(language: string): CommentLang | null {
  switch (language) {
    case 'python': return 'python';
    case 'ruby': return 'ruby';
    case 'rust': return 'rust';
    case 'php': return 'php';
    case 'go': return 'go';
    case 'javascript':
    case 'jsx':
      return 'javascript';
    case 'typescript':
    case 'tsx':
    case 'vue':
    case 'svelte':
    case 'astro':
    case 'arkts':
      return 'typescript';
    case 'java':
    case 'kotlin':
    case 'scala':
    case 'dart':
      return 'java';
    case 'csharp': return 'csharp';
    case 'swift': return 'swift';
    case 'c':
    case 'cpp':
    case 'objc':
    case 'objcpp':
      return 'java'; // C-style comments + double-quoted strings — close enough for blanking
    default: return null;
  }
}

const MAX_MATCHES_PER_BODY = 3;
const MAX_BODY_CHARS = 60_000; // a god-function tail is still scannable; beyond this, truncate

/**
 * Blank the CONTENTS of string literals (quotes preserved, offsets preserved)
 * so dispatch-shaped prose — docs, error messages, template text — can't fire
 * a matcher. Run AFTER comment stripping (comments are already spaces).
 * Backslash escapes are honored; `'`/`"` strings end at a newline (treated as
 * unterminated, matching the comment stripper); backticks span lines, and
 * `${...}` interpolations inside them are blanked too — missing a dispatch
 * inside a template literal is acceptable, false-firing on prose is not.
 */
export function blankStringContents(text: string): string {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < n) {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (quote !== '`' && text[i] === '\n') break; // unterminated — stop blanking
        if (text[i] !== '\n') out[i] = ' ';           // keep newlines for line math
        i++;
      }
      if (i < n && text[i] === quote) i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Scan one symbol's body for dynamic-dispatch sites.
 *
 * @param body       the symbol's source text (sliced from the file)
 * @param language   Node.language of the symbol
 * @param fileStartLine 1-based line where `body` starts in its file — returned
 *                      line numbers are absolute file lines.
 */
export function scanDynamicDispatch(body: string, language: string, fileStartLine: number): BoundaryMatch[] {
  const original = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  const lang = commentLang(language);
  const stripped = blankStringContents(lang ? stripCommentsForRegex(original, lang) : original);

  const out: BoundaryMatch[] = [];
  const seen = new Map<string, BoundaryMatch>(); // form+key → first match (counts extras)

  if (language === 'python') scanPythonGetattr(stripped, original, fileStartLine, out, seen);

  for (const spec of FORMS) {
    if (out.length >= MAX_MATCHES_PER_BODY) break;
    if (spec.langs && !spec.langs.has(language)) continue;
    spec.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = spec.re.exec(stripped)) !== null) {
      let sliceEnd = m.index + m[0].length;
      if (spec.keyWindow) {
        const windowEnd = Math.min(original.length, sliceEnd + spec.keyWindow);
        const nl = original.indexOf('\n', sliceEnd);
        sliceEnd = nl !== -1 && nl < windowEnd ? nl : windowEnd;
      }
      const origSlice = original.slice(m.index, sliceEnd);
      const derived = spec.keyFrom?.(origSlice);
      const dedupeKey = `${spec.form}|${derived?.key ?? ''}`;
      const prior = seen.get(dedupeKey);
      if (prior) {
        prior.moreSites = (prior.moreSites ?? 0) + 1;
        continue;
      }
      const line = fileStartLine + countNewlines(original, m.index);
      const match: BoundaryMatch = {
        form: spec.form,
        label: spec.label,
        snippet: snippetAround(original, m.index),
        line,
        ...(derived ?? {}),
      };
      seen.set(dedupeKey, match);
      out.push(match);
      if (out.length >= MAX_MATCHES_PER_BODY) return out;
    }
  }
  return out;
}

/**
 * Python getattr dispatch — handled in code, not the FORMS table, because real
 * getattr calls have nested-call arguments spanning lines
 * (`getattr(self, request.method.lower(),\n  self.http_method_not_allowed)` —
 * DRF's APIView.dispatch) that a regex argument class can't bound. Two shapes:
 *   getattr(obj, name)(args)                      → immediate call
 *   handler = getattr(obj, name) ... handler(...)  → assigned, called later
 */
const GETATTR_RE = /\bgetattr\s*\(/g;
const MAX_GETATTR_ARGS = 300;

function scanPythonGetattr(stripped: string, original: string, fileStartLine: number, out: BoundaryMatch[], seen: Map<string, BoundaryMatch>): void {
  GETATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GETATTR_RE.exec(stripped)) !== null && out.length < MAX_MATCHES_PER_BODY) {
    const open = m.index + m[0].length - 1;
    const close = matchBalancedParen(stripped, open);
    if (close === -1) continue;

    let form: string | undefined;
    let label = '';
    // Immediate call: getattr(...)(
    const after = stripped.slice(close + 1, close + 8);
    if (/^\s*\(/.test(after)) {
      form = 'getattr-call';
      label = 'getattr dispatch';
    } else {
      // Assigned form: look back for `name =` and forward for `name(`.
      const lineStart = stripped.lastIndexOf('\n', m.index) + 1;
      const before = stripped.slice(lineStart, m.index);
      const assign = before.match(/(\w+)\s*=\s*$/);
      if (assign && new RegExp(`\\b${assign[1]}\\s*\\(`).test(stripped.slice(close + 1))) {
        form = 'getattr-assign';
        label = 'getattr dispatch (assigned, called later)';
      }
    }
    if (!form) continue;

    const key = singleStringLiteral(original.slice(open + 1, close));
    const dedupeKey = `${form}|${key ?? ''}`;
    const prior = seen.get(dedupeKey);
    if (prior) {
      prior.moreSites = (prior.moreSites ?? 0) + 1;
      continue;
    }
    const match: BoundaryMatch = {
      form,
      label,
      snippet: snippetAround(original, m.index),
      line: fileStartLine + countNewlines(original, m.index),
      ...(key ? { key } : {}),
    };
    seen.set(dedupeKey, match);
    out.push(match);
  }
}

/** Index of the `)` balancing `text[open]`, or -1 (cap: MAX_GETATTR_ARGS chars). */
function matchBalancedParen(text: string, open: number): number {
  let depth = 0;
  const end = Math.min(text.length, open + MAX_GETATTR_ARGS);
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

function countNewlines(text: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The full source line containing `index`, trimmed and capped for display. */
function snippetAround(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  let lineEnd = text.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd).trim();
  return line.length > 120 ? line.slice(0, 117) + '...' : line;
}
