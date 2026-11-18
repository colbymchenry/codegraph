/**
 * ASP.NET attribute routing: the routes a controller's actions serve, read
 * the way ASP.NET Core builds them (#2905).
 *
 *  - A controller's templates are its own `[Route]` attributes, each one a
 *    template of its own, or else those of the nearest base class that
 *    declares any. One in another file is read once the whole project is
 *    indexed (inheritedControllerRoutes).
 *  - An action's routes come from its `[HttpGet]` … `[HttpOptions]`,
 *    `[AcceptVerbs]` and `[Route]` attributes, in one attribute list or
 *    several: a verb attribute with a template is a route of its own; a
 *    `[Route]` takes the verbs of the attributes that name no template (any
 *    verb when none does); verb attributes alone take the controller's
 *    template.
 *  - An action template starting with `/` or `~/` stands alone; any other is
 *    joined to each of the controller's templates, and `[controller]`,
 *    `[action]` and `[area]` are replaced by the controller's name without
 *    its `Controller` suffix, the action's name (`[ActionName]`, or the
 *    method's without an `Async` suffix) and the controller's `[Area]`.
 *
 * Read from text with comments blanked; a template that is not a string
 * literal (`[HttpGet(Routes.List)]`) gives no route, as before.
 */

/** A route an action serves: its verb (`ANY` for every verb), path, and the line of the attribute that declares it. */
export interface AspnetRoute {
  method: string;
  path: string;
  line: number;
  /** The source length of the `[…]` section that declares it. */
  length: number;
  /** The action's method name, which the route references. */
  handler: string;
  /**
   * Set when the controller declares no template of its own but derives from
   * a class: that base's name, and what the route needs to be named again
   * once the base's templates are known.
   */
  inherit?: { base: string; controller: string; action: string; template: string | null };
}

const VERB_ATTRIBUTES: ReadonlyMap<string, string> = new Map([
  ['HttpGet', 'GET'],
  ['HttpPost', 'POST'],
  ['HttpPut', 'PUT'],
  ['HttpPatch', 'PATCH'],
  ['HttpDelete', 'DELETE'],
  ['HttpHead', 'HEAD'],
  ['HttpOptions', 'OPTIONS'],
]);

/** Whether a file can hold an attribute route at all: a cheap gate before the scan. */
const ROUTING_ATTRIBUTE = /\[\s*(?:[A-Za-z_][\w.]*\.)?(?:Http(?:Get|Post|Put|Patch|Delete|Head|Options)|Route|AcceptVerbs)\b/;

interface CsAttribute {
  /** The attribute's last name segment without an `Attribute` suffix: `HttpGet`, `Route`. */
  name: string;
  /** Positional string-literal arguments, unquoted; `undefined` for a positional argument that is not one. */
  positional: Array<string | undefined>;
  /** Named arguments (`Name = …`, `template: …`), string literals unquoted, other values as written. */
  named: Map<string, string | undefined>;
  line: number;
  /** The source length of the `[…]` section it is written in. */
  length: number;
}

interface CsClass {
  name: string;
  /** The first type its base list names, generic arguments and namespace dropped. */
  base: string | null;
  attributes: CsAttribute[];
  /** The `{` and `}` of its body. */
  open: number;
  close: number;
}

interface CsAction {
  method: string;
  attributes: CsAttribute[];
  /** Where its attributes start. */
  at: number;
}

/** What a C# source declares that attribute routing reads: its classes, and the attributed methods in them. */
interface CsScan {
  classes: CsClass[];
  actions: CsAction[];
}

/**
 * The index just past the string or char literal that starts at `i` — `"…"`,
 * `@"…"`, `$"…"`, `$@"…"`, a raw `"""…"""`, `'x'` — or `i` when none does.
 */
function literalEnd(s: string, i: number): number {
  let j = i;
  let verbatim = false;
  while (s[j] === '$' || s[j] === '@') {
    if (s[j] === '@') verbatim = true;
    j++;
  }
  if (j === i && s[i] === "'") {
    let k = i + 1;
    while (k < s.length && s[k] !== "'" && s[k] !== '\n') k += s[k] === '\\' ? 2 : 1;
    return k < s.length && s[k] === "'" ? k + 1 : i + 1;
  }
  if (s[j] !== '"') return i;
  if (s.startsWith('"""', j)) {
    let quotes = 0;
    while (s[j + quotes] === '"') quotes++;
    const end = s.indexOf('"'.repeat(quotes), j + quotes);
    return end < 0 ? s.length : end + quotes;
  }
  for (let k = j + 1; k < s.length; k++) {
    const c = s[k];
    if (verbatim) {
      if (c === '"') {
        if (s[k + 1] === '"') k++;
        else return k + 1;
      }
    } else if (c === '\\') k++;
    else if (c === '"') return k + 1;
    else if (c === '\n') return k;
  }
  return s.length;
}

/** The value of a C# string literal written as `raw`, or undefined when `raw` is no plain or verbatim literal. */
function stringValue(raw: string): string | undefined {
  const t = raw.trim();
  const verbatim = /^@"([\s\S]*)"$/.exec(t);
  if (verbatim) return verbatim[1]!.replace(/""/g, '"');
  const plain = /^"((?:[^"\\\n]|\\.)*)"$/.exec(t);
  return plain ? plain[1]!.replace(/\\(.)/g, '$1') : undefined;
}

/** `text` split at its top-level commas: none inside brackets, parentheses, braces or literals. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; ) {
    const end = literalEnd(text, i);
    if (end !== i) {
      i = end;
      continue;
    }
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** The attributes of one `[…]` section's inside, `line` being the section's first line. */
function parseSection(inside: string, firstLine: number, lineOf: (offset: number) => number, offset: number): CsAttribute[] {
  const length = inside.length + 2;
  // An attribute target (`[return: Foo]`, `[method: Foo]`) is no attribute.
  const target = /^\s*[A-Za-z_]\w*\s*:(?!:)/.exec(inside);
  const body = target ? inside.slice(target[0].length) : inside;
  const at = offset + (target ? target[0].length : 0);
  const out: CsAttribute[] = [];
  let cursor = 0;
  for (const part of splitTopLevel(body)) {
    const where = body.indexOf(part, cursor);
    cursor = where + part.length;
    const head = /^((?:[A-Za-z_]\w*\s*\.\s*)*[A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*(\(([\s\S]*)\))?\s*$/.exec(part);
    if (!head) continue;
    const name = head[1]!.replace(/\s+/g, '').split('.').pop()!.replace(/(.)Attribute$/, '$1');
    const positional: Array<string | undefined> = [];
    const named = new Map<string, string | undefined>();
    for (const arg of head[3] !== undefined ? splitTopLevel(head[3]) : []) {
      const assigned = /^([A-Za-z_]\w*)\s*(?:=(?![=>])|:(?!:))\s*([\s\S]*)$/.exec(arg);
      if (assigned) named.set(assigned[1]!, stringValue(assigned[2]!) ?? assigned[2]!.trim());
      else positional.push(stringValue(arg));
    }
    out.push({ name, positional, named, line: where >= 0 ? lineOf(at + where) : firstLine, length });
  }
  return out;
}

/** A stack entry for a namespace's `{`, whose members are declarations, as a class body's are. */
const NAMESPACE = -2;
/** Words `class` is followed by in a generic constraint (`where T : class where U : struct`), never a class's name. */
const NOT_A_CLASS_NAME: ReadonlySet<string> = new Set(['where', 'new', 'struct', 'class', 'unmanaged', 'notnull', 'default']);
const CLASS_HEAD = /^\s*(?:(?:public|internal|private|protected|static|sealed|abstract|partial|unsafe|new|file|readonly)\s+)*(?:record\s+)?class\s+([A-Za-z_]\w*)/;
const METHOD_HEAD = /^\s*((?:(?:public|protected|internal|private|static|virtual|override|abstract|sealed|async|new|extern|unsafe|partial|required)\s+)*)[\w<>,\s\[\]?.():]+?\s+([A-Za-z_]\w*)\s*(?:<[^<>(){};=]*(?:<[^<>(){};=]*>[^<>(){};=]*)*>\s*)?\(/;

/** A preprocessor line: `#region Actions`, `#if DEBUG`, `#endif`. */
const DIRECTIVE_LINE = /^[ \t]*#[^\n]*/gm;

/**
 * One pass over a C# source with its comments blanked: every class with its
 * attributes, base and body, and every method declared directly in a class
 * body (or at the top level) with the attributes written on it.
 */
function scanDeclarations(source: string): CsScan {
  // A preprocessor line can sit between an attribute and what it is on
  // (`#region Actions` before `[HttpGet]`, `#endif` after it) and is neither:
  // blank it, keeping every offset.
  const safe = source.replace(DIRECTIVE_LINE, (line) => ' '.repeat(line.length));
  const lineStarts = [0];
  for (let i = 0; i < safe.length; i++) if (safe[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const classes: CsClass[] = [];
  const actions: CsAction[] = [];
  /** For each open `{`: the class whose body it opens, NAMESPACE for a namespace's, or -1. */
  const stack: number[] = [];
  /** A `namespace` keyword read, waiting for its `{` (or the `;` of a file-scoped one). */
  let namespaceHead = false;
  let pending: CsAttribute[] = [];
  let pendingAt = -1;
  /** A class head read, waiting for its body's `{`. */
  let head: { name: string; base: string | null; attributes: CsAttribute[] } | null = null;
  /** The last non-space character before the current one. */
  let prev = '';
  const inClassBody = (): boolean => stack.length === 0 || stack[stack.length - 1]! >= 0 || stack[stack.length - 1] === NAMESPACE;
  for (let i = 0; i < safe.length; ) {
    const end = literalEnd(safe, i);
    if (end !== i) {
      prev = '"';
      i = end;
      continue;
    }
    const c = safe[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '[' && (prev === '' || prev === ';' || prev === '{' || prev === '}' || prev === ']') && inClassBody() && !head) {
      // An attribute section: read to its `]`.
      let depth = 0;
      let j = i;
      for (; j < safe.length; ) {
        const e = literalEnd(safe, j);
        if (e !== j) {
          j = e;
          continue;
        }
        if (safe[j] === '[') depth++;
        else if (safe[j] === ']' && --depth === 0) break;
        j++;
      }
      if (j >= safe.length) break;
      if (pending.length === 0) pendingAt = i;
      pending.push(...parseSection(safe.slice(i + 1, j), lineOf(i), lineOf, i + 1));
      prev = ']';
      i = j + 1;
      // What the attributes are on: a class, a method, or something else.
      const after = safe.slice(i, i + 600);
      const cls = CLASS_HEAD.exec(after);
      if (cls) {
        const rest = safe.slice(i + cls[0].length, i + cls[0].length + 600);
        const brace = rest.search(/[{;]/);
        const list = brace >= 0 ? rest.slice(0, brace) : rest;
        // `class X<T> : Base<T>, IFoo where T : …`: the first type of the base list.
        const base = /^\s*(?:<[^{};]*?>)?\s*(?:\([^)]*\))?\s*:\s*((?:global::)?[A-Za-z_][\w.]*)/.exec(list)?.[1]?.split(/::|\./).pop() ?? null;
        head = { name: cls[1]!, base, attributes: pending };
        pending = [];
        i += cls[0].length;
        prev = 'w';
        continue;
      }
      if (/^\s*\[/.test(after)) continue;
      const m = METHOD_HEAD.exec(after);
      if (m && /\bpublic\b/.test(m[1]!)) actions.push({ method: m[2]!, attributes: pending, at: pendingAt });
      pending = [];
      continue;
    }
    if (/[A-Za-z_]/.test(c) && !/[\w$]/.test(safe[i - 1] ?? '')) {
      const word = /^[A-Za-z_]\w*/.exec(safe.slice(i, i + 64))![0];
      if (word === 'namespace') namespaceHead = true;
      if (word === 'class' && !head) {
        const cls = CLASS_HEAD.exec(safe.slice(i, i + 200));
        if (cls && !NOT_A_CLASS_NAME.has(cls[1]!)) {
          const rest = safe.slice(i + cls[0].length, i + cls[0].length + 600);
          const brace = rest.search(/[{;]/);
          const list = brace >= 0 ? rest.slice(0, brace) : rest;
          const base = /^\s*(?:<[^{};]*?>)?\s*(?:\([^)]*\))?\s*:\s*((?:global::)?[A-Za-z_][\w.]*)/.exec(list)?.[1]?.split(/::|\./).pop() ?? null;
          head = { name: cls[1]!, base, attributes: [] };
          i += cls[0].length;
          prev = 'w';
          continue;
        }
      }
      pending = [];
      prev = 'w';
      i += word.length;
      continue;
    }
    if (c === '{') {
      if (head) {
        classes.push({ ...head, open: i, close: safe.length });
        stack.push(classes.length - 1);
        head = null;
      } else stack.push(namespaceHead ? NAMESPACE : -1);
      namespaceHead = false;
    } else if (c === '}') {
      const top = stack.pop();
      if (top !== undefined && top >= 0) classes[top]!.close = i;
    } else if (c === ';') {
      // `record class X(int A);`: no body. `namespace X;`: the file is its body.
      head = null;
      namespaceHead = false;
    }
    if (c !== ']') pending = [];
    prev = c;
    i++;
  }
  return { classes, actions };
}

/** A string attribute argument that is a template: the first positional one, or the one named `template`. */
function templateOf(a: CsAttribute): string | null | undefined {
  if (a.named.has('template')) return a.named.get('template');
  if (a.positional.length > 0) return a.positional[0];
  return null;
}

/**
 * The selectors ASP.NET Core makes of an action's attributes
 * (DefaultApplicationModelProvider.CreateSelectors): each its verbs and its
 * template (null: the controller's). Undefined for a template that is not a
 * literal, which gives no route.
 */
function selectorsOf(attributes: CsAttribute[]): Array<{ verbs: string[]; template: string | null | undefined; line: number; length: number }> {
  type Provider = { http: boolean; verbs: string[]; template: string | null | undefined; silent: boolean; line: number; length: number };
  const providers: Provider[] = [];
  for (const a of attributes) {
    const verb = VERB_ATTRIBUTES.get(a.name);
    if (verb) {
      const template = templateOf(a);
      providers.push({ http: true, verbs: [verb], template, silent: template === null && !a.named.has('Name') && !a.named.has('Order'), line: a.line, length: a.length });
    } else if (a.name === 'AcceptVerbs') {
      const verbs = a.positional.filter((v): v is string => !!v).map((v) => v.toUpperCase());
      const template = a.named.has('Route') ? a.named.get('Route') : null;
      providers.push({ http: true, verbs, template, silent: template === null && !a.named.has('Name') && !a.named.has('Order'), line: a.line, length: a.length });
    } else if (a.name === 'Route') {
      providers.push({ http: false, verbs: [], template: templateOf(a), silent: false, line: a.line, length: a.length });
    }
  }
  const routed = providers.filter((p) => !p.silent);
  const silent = providers.filter((p) => p.silent);
  const silentVerbs = [...new Set(silent.flatMap((p) => p.verbs))];
  const selectors: Array<{ verbs: string[]; template: string | null | undefined; line: number; length: number }> = [];
  for (const p of routed) {
    const verbs = p.http ? p.verbs : silentVerbs;
    selectors.push({ verbs: verbs.length > 0 ? verbs : ['ANY'], template: p.template, line: p.line, length: p.length });
  }
  // Verb attributes with no template take the controller's — unless a
  // `[Route]` took them.
  if (silent.length > 0 && routed.every((p) => p.http)) {
    selectors.push({ verbs: silentVerbs.length > 0 ? silentVerbs : ['ANY'], template: null, line: silent[0]!.line, length: silent[0]!.length });
  }
  return selectors;
}

/** Join two template parts with one `/`. */
function joinTemplate(prefix: string, sub: string): string {
  return [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

/**
 * The path an action template and a controller template make: the action's
 * alone when it starts with `/` or `~/`, else the two joined, with the
 * route tokens replaced. Always one leading `/`, no trailing one.
 */
export function aspnetRoutePath(controllerTemplate: string | null, actionTemplate: string | null, controller: string, action: string, area: string | null): string {
  const absolute = actionTemplate !== null && /^~?\//.test(actionTemplate);
  const template = absolute
    ? actionTemplate!.replace(/^~/, '')
    : joinTemplate((controllerTemplate ?? '').replace(/^~/, ''), actionTemplate ?? '');
  const replaced = template.replace(/\[(controller|action|area)\]/gi, (token, name: string) => {
    const key = name.toLowerCase();
    if (key === 'controller') return controller;
    if (key === 'action') return action;
    return area ?? token;
  });
  return '/' + replaced.replace(/^\/+|\/+$/g, '');
}

/** A controller's name as `[controller]` reads it: its class name without a `Controller` suffix. */
function controllerName(className: string): string {
  return /.Controller$/.test(className) ? className.slice(0, -'Controller'.length) : className;
}

/** The `[Route]` templates a class declares itself; undefined entries are templates that are not literals. */
function ownTemplates(cls: CsClass): Array<string | undefined> {
  return cls.attributes.filter((a) => a.name === 'Route').map((a) => templateOf(a) ?? undefined);
}

/** The class a position sits in, innermost first; null at the top level. */
function classAt(scan: CsScan, at: number): CsClass | null {
  let found: CsClass | null = null;
  for (const c of scan.classes) {
    if (c.open < at && at < c.close && (!found || c.open > found.open)) found = c;
  }
  return found;
}

/** The templates a class's routes start from: its own, or the nearest base's in the same file; null when neither declares any. */
function classTemplates(cls: CsClass, scan: CsScan): { templates: Array<string | undefined>; inheritFrom: string | null } {
  let current: CsClass | undefined = cls;
  const seen = new Set<string>();
  while (current && !seen.has(current.name)) {
    seen.add(current.name);
    const own = ownTemplates(current);
    if (own.length > 0) return { templates: own, inheritFrom: null };
    if (!current.base) return { templates: [], inheritFrom: null };
    const base: string = current.base;
    const next = scan.classes.find((c) => c.name === base);
    if (!next) return { templates: [], inheritFrom: base };
    current = next;
  }
  return { templates: [], inheritFrom: null };
}

/** The routes ASP.NET attribute routing gives the actions a C# source declares (`safe`: comments blanked). */
export function aspnetAttributeRoutes(safe: string): AspnetRoute[] {
  if (!ROUTING_ATTRIBUTE.test(safe)) return [];
  const scan = scanDeclarations(safe);
  const routes: AspnetRoute[] = [];
  for (const action of scan.actions) {
    if (action.attributes.some((a) => a.name === 'NonAction')) continue;
    const selectors = selectorsOf(action.attributes);
    if (selectors.length === 0) continue;
    const cls = classAt(scan, action.at);
    const controller = cls ? controllerName(cls.name) : '';
    const actionName = action.attributes.find((a) => a.name === 'ActionName')?.positional[0] ?? action.method.replace(/(.)Async$/, '$1');
    const area = cls?.attributes.find((a) => a.name === 'Area')?.positional[0] ?? null;
    const { templates, inheritFrom } = cls ? classTemplates(cls, scan) : { templates: [], inheritFrom: null };
    for (const selector of selectors) {
      if (selector.template === undefined) continue;
      for (const ct of templates.length > 0 ? templates : [null]) {
        if (ct === undefined) continue;
        const path = aspnetRoutePath(ct, selector.template, controller, actionName, area);
        for (const method of selector.verbs) {
          const route: AspnetRoute = { method, path, line: selector.line, length: selector.length, handler: action.method };
          if (templates.length === 0 && inheritFrom) {
            route.inherit = { base: inheritFrom, controller, action: actionName, template: selector.template };
          }
          routes.push(route);
        }
      }
    }
  }
  return routes;
}

/**
 * The `[Route]` templates the C# class `name` passes to its subclasses, in a
 * source with comments blanked: its own, or its nearest base's in that file
 * (`next` names a base declared elsewhere).
 */
export function aspnetDeclaredTemplates(safe: string, name: string): { templates: string[]; next: string | null } | null {
  const scan = scanDeclarations(safe);
  const cls = scan.classes.find((c) => c.name === name);
  if (!cls) return null;
  const { templates, inheritFrom } = classTemplates(cls, scan);
  return { templates: templates.filter((t): t is string => t !== undefined), next: inheritFrom };
}
