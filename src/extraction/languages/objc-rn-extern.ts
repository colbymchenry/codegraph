/**
 * React Native's `.m` shim for a module written in Swift, made readable.
 *
 * A Swift class reaches JavaScript through a few lines of Objective-C that
 * are all macros:
 *
 *   @interface RCT_EXTERN_MODULE(CaptureView, RCTEventEmitter)
 *   RCT_EXTERN_METHOD(start:(NSString *)name resolver:(RCTPromiseResolveBlock)resolve)
 *   RCT_EXPORT_VIEW_PROPERTY(isActive, BOOL);
 *   + (BOOL)requiresMainQueueSetup { return NO; }
 *   @end
 *
 * `RCT_EXTERN_MODULE(Name, Super)` expands to an interface for `Name`, closed
 * at once, and then `@implementation Name (RCTExternModule)`: what follows,
 * up to `@end`, is the body of an implementation. That is why a method there
 * has a body. The grammar sees none of that. It reads an interface named
 * `RCT_EXTERN_MODULE` and then lines it cannot parse, and recovers from them:
 * the class was named for the macro, a method written after the macros came
 * out as a function on the first macro's line or not at all, and nothing in
 * its body was read. The recovery also takes the square of the lines it
 * recovers from, inside the parser: two thousand `RCT_EXTERN_METHOD` lines
 * took half a second, sixteen thousand took seven, and thirty-two thousand
 * ran out the parse budget and left the file with nothing.
 *
 * So the parser is given what the macros mean, at the same length, every
 * line and column where it was:
 *
 *   @implementation              CaptureView
 *
 *
 *   + (BOOL)requiresMainQueueSetup { return NO; }
 *   @end
 *
 * - The head becomes `@implementation` and the native class's name, which is
 *   the second argument of `RCT_EXTERN_REMAP_MODULE(jsName, Name, Super)`.
 *   The name stays where it is written.
 * - Each of React Native's macros in the body that has no body of its own
 *   (`RCT_EXTERN_METHOD(…)`, `RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(…)`,
 *   `RCT_EXPORT_VIEW_PROPERTY(…)`, with the `;` some files end it with) is
 *   blanked. They declare nothing the tree could show: the Swift method a
 *   macro exposes is found from the file's text by the React Native bridge
 *   (resolution/frameworks/react-native.ts), which reads the file as written.
 * - A macro followed by `{` (`RCT_CUSTOM_VIEW_PROPERTY(…) { … }`) is left as
 *   in any other implementation, and so is everything else: a method, and
 *   whatever its body calls, a macro of React Native's included.
 *
 * Comments and strings are stepped over, so a head or a macro that is only
 * mentioned is not one. A shim that does not close (`@end`), or whose head
 * does not name a class, is left as written.
 */

const SLASH = 47;
const STAR = 42;
const QUOTE = 34;
const APOSTROPHE = 39;
const BACKSLASH = 92;
const NEWLINE = 10;
const OPEN = 40;
const CLOSE = 41;
const AT = 64;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;

/** `@interface RCT_EXTERN_MODULE(` or `@interface RCT_EXTERN_REMAP_MODULE(`, from where it is tried; 1 is set for the remap form. */
const SHIM_HEAD = /@interface[ \t]+RCT_EXTERN_(REMAP_)?MODULE\s*\(/y;

/** One of React Native's macros: `RCT_EXTERN_METHOD`, `_RCT_EXTERN_REMAP_METHOD`, `RCT_EXPORT_VIEW_PROPERTY`. */
const RN_MACRO = /^_?RCT_[A-Z0-9_]+$/;

const isNameCode = (c: number): boolean =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;

/**
 * Where the comment, string or character literal that starts at `at` ends
 * (the index after it), or `at` when none starts there. A literal ends with
 * its line when it is not closed on it.
 */
function skipCommentOrLiteral(source: string, at: number): number {
  const c = source.charCodeAt(at);
  if (c === SLASH) {
    const next = source.charCodeAt(at + 1);
    if (next === SLASH) {
      const end = source.indexOf('\n', at);
      return end < 0 ? source.length : end;
    }
    if (next === STAR) {
      const end = source.indexOf('*/', at + 2);
      return end < 0 ? source.length : end + 2;
    }
    return at;
  }
  if (c === QUOTE || c === APOSTROPHE) {
    for (let i = at + 1; i < source.length; i++) {
      const d = source.charCodeAt(i);
      if (d === BACKSLASH) i++;
      else if (d === c) return i + 1;
      else if (d === NEWLINE) return i;
    }
    return source.length;
  }
  return at;
}

/** The index of the `)` that closes the `(` at `open`, or -1. */
function closingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; ) {
    const past = skipCommentOrLiteral(source, i);
    if (past > i) {
      i = past;
      continue;
    }
    const c = source.charCodeAt(i);
    if (c === OPEN) depth++;
    else if (c === CLOSE && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** `text` with everything but its line ends blanked. */
const blanked = (text: string): string => text.replace(/[^\n\r]/g, ' ');

/**
 * Where the native class's name is written among a shim head's arguments,
 * `source[from, to)`: the first of `RCT_EXTERN_MODULE(Name, Super)`, the
 * second of `RCT_EXTERN_REMAP_MODULE(jsName, Name, Super)`. Null when what
 * is there is not a name.
 */
function classNameSpan(source: string, from: number, to: number, remap: boolean): [number, number] | null {
  let start = from;
  if (remap) {
    const comma = source.indexOf(',', from);
    if (comma < 0 || comma >= to) return null;
    start = comma + 1;
  }
  while (start < to && /\s/.test(source[start]!)) start++;
  let end = start;
  while (end < to && isNameCode(source.charCodeAt(end))) end++;
  if (end === start || (source.charCodeAt(start) >= 48 && source.charCodeAt(start) <= 57)) return null;
  // Then the next argument, or the head's end.
  let after = end;
  while (after < to && /\s/.test(source[after]!)) after++;
  return after === to || source[after] === ',' ? [start, end] : null;
}

/**
 * The spans to blank in a shim's body, which starts at `from`: each bodiless
 * macro of React Native's that stands among the body's declarations. One
 * written inside a method's braces is part of that method's code and stays.
 * Returns where the body's `@end` is, or -1 when it has none or a macro's
 * parentheses do not close.
 */
function scanShimBody(source: string, from: number, spans: Array<[number, number]>): number {
  let braces = 0;
  for (let i = from; i < source.length; ) {
    const past = skipCommentOrLiteral(source, i);
    if (past > i) {
      i = past;
      continue;
    }
    const c = source.charCodeAt(i);
    if (c === AT) {
      if (source.startsWith('@end', i) && !isNameCode(source.charCodeAt(i + 4))) return i;
      i++;
      continue;
    }
    if (c === OPEN_BRACE || c === CLOSE_BRACE) {
      braces = c === OPEN_BRACE ? braces + 1 : Math.max(0, braces - 1);
      i++;
      continue;
    }
    if (!isNameCode(c)) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < source.length && isNameCode(source.charCodeAt(end))) end++;
    if (braces > 0 || (source.charCodeAt(i) !== 95 && source.charCodeAt(i) !== 82)) {
      // Inside a method, or not `_…` or `R…`: no macro of React Native's to blank.
      i = end;
      continue;
    }
    let open = end;
    while (source[open] === ' ' || source[open] === '\t') open++;
    if (source.charCodeAt(open) !== OPEN || !RN_MACRO.test(source.slice(i, end))) {
      i = end;
      continue;
    }
    const close = closingParen(source, open);
    if (close < 0) return -1;
    // What follows the invocation: a body (leave the macro), a `;` (its own), or the next thing.
    let after = close + 1;
    while (after < source.length && /\s/.test(source[after]!)) after++;
    if (source[after] === '{') {
      i = close + 1;
      continue;
    }
    let stop = close + 1;
    while (source[stop] === ' ' || source[stop] === '\t') stop++;
    stop = source[stop] === ';' ? stop + 1 : close + 1;
    spans.push([i, stop]);
    i = stop;
  }
  return -1;
}

/**
 * `source` with each React Native extern shim rewritten as the
 * implementation its macros expand to (see the file comment). The same
 * length, with every line end where it was; `source` itself when it holds no
 * shim.
 */
export function rewriteRctExternShims(source: string): string {
  if (!source.includes('RCT_EXTERN_')) return source;
  const parts: string[] = [];
  let done = 0;
  for (let i = 0; i < source.length; ) {
    const past = skipCommentOrLiteral(source, i);
    if (past > i) {
      i = past;
      continue;
    }
    if (source.charCodeAt(i) !== AT) {
      i++;
      continue;
    }
    SHIM_HEAD.lastIndex = i;
    const head = SHIM_HEAD.exec(source);
    if (!head) {
      i++;
      continue;
    }
    const open = i + head[0].length - 1;
    const close = closingParen(source, open);
    const name = close < 0 ? null : classNameSpan(source, open + 1, close, head[1] !== undefined);
    const spans: Array<[number, number]> = [];
    const end = name ? scanShimBody(source, close + 1, spans) : -1;
    if (!name || end < 0) {
      i += head[0].length;
      continue;
    }
    // `@implementation` is shorter than the least a head has before its name.
    parts.push(
      source.slice(done, i),
      '@implementation',
      blanked(source.slice(i + '@implementation'.length, name[0])),
      source.slice(name[0], name[1]),
      blanked(source.slice(name[1], close + 1))
    );
    done = close + 1;
    for (const [from, to] of spans) {
      parts.push(source.slice(done, from), blanked(source.slice(from, to)));
      done = to;
    }
    i = end + '@end'.length;
  }
  if (parts.length === 0) return source;
  parts.push(source.slice(done));
  return parts.join('');
}
