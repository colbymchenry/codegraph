/**
 * Swift ↔ Objective-C bridging rules.
 *
 * Apple's auto-bridging mechanism exposes Swift declarations to the ObjC
 * runtime under a deterministic selector name. The full rule set:
 * https://developer.apple.com/documentation/swift/importing-swift-into-objective-c
 *
 * This module is **pure name math** — given a Swift declaration's base name
 * + parameter external labels (or the raw signature text), produce the
 * bridged ObjC selector(s); given an ObjC selector, produce the
 * candidate Swift base names. No graph/DB access here.
 *
 * Used by `frameworks/swift-objc.ts` (the framework resolver that wires
 * the rules into the resolution pipeline) and by its tests.
 *
 * ─── Bridging cheat sheet ───────────────────────────────────────────────
 *
 *   Swift declaration                             ObjC selector
 *   ─────────────────────────────────────────     ─────────────────────────
 *   func play()                                    play
 *   func play(_ song: String)                      play:
 *   func play(song: String)                        playWithSong:
 *   func play(_ song: String, by artist: String)   play:by:
 *   func play(song: String, by artist: String)     playWithSong:by:
 *   init(name: String)                             initWithName:
 *   init(name: String, age: Int)                   initWithName:age:
 *   var name: String  (getter / setter)            name  /  setName:
 *   @objc(custom:) func f(_ x: Int)                custom:        (literal override)
 *
 * The reverse direction (ObjC → Swift) collapses the bridge: a Swift call
 * site for `play(song:)` reaches us as the bare base name `play` (Swift's
 * tree-sitter call_expression strips parameter labels from the callee
 * name). So `swiftBaseNamesForObjcSelector('playWithSong:')` returns
 * `['play']` — the resolver looks up Swift methods named `play`.
 */

/**
 * Capitalize the first character of a string. Used for the "With"-prefix
 * form on the first selector keyword when the Swift declaration has an
 * explicit first-parameter label (e.g. `func play(song:)` → `playWithSong:`).
 */
function capFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Lowercase the first character. Used in reverse: `setName:` setter ↔
 * Swift property `name`.
 */
function lowerFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * Compute the auto-bridged ObjC selector for a Swift method declaration.
 *
 * @param baseName  The Swift method's base name (e.g. `play`).
 * @param externalLabels  Parameter EXTERNAL labels in declaration order;
 *                        `null` for a `_` (unlabeled) parameter.
 *                        `[]` for a no-parameter method.
 * @param explicitObjcName  If `@objc(customSel:)` was specified, the
 *                          literal selector — short-circuits the rule
 *                          and is returned as-is.
 * @returns The ObjC selector (e.g. `playWithSong:by:`), or `null` if it
 *          can't be determined.
 *
 * **Method rules:**
 * - No params → base name (no colons)
 * - Single param, `_` label → `baseName:`
 * - Single param, explicit label `L` → `baseNameWithL:`
 * - Multi-param, `_` first label → `baseName:label2:label3:`
 * - Multi-param, explicit first label `L1` → `baseNameWithL1:label2:label3:`
 *
 * Initializer rules are handled by `objcSelectorForSwiftInit`.
 */
export function objcSelectorForSwiftMethod(
  baseName: string,
  externalLabels: (string | null)[],
  explicitObjcName?: string | null
): string | null {
  if (!baseName) return null;
  if (explicitObjcName) return explicitObjcName;

  if (externalLabels.length === 0) {
    return baseName;
  }

  const [first, ...rest] = externalLabels;
  // Single param: "_" → "base:" ; "label" → "baseWithLabel:"
  // Multi-param mirrors the same first-keyword formation, then appends each
  // subsequent label as its own keyword. A `null` later label is invalid
  // ObjC (no way to express unlabeled middle params) — keep as `:` to be safe.
  const firstKeyword =
    first === null || first === undefined || first === '_' || first === ''
      ? `${baseName}:`
      : `${baseName}With${capFirst(first)}:`;

  const restKeywords = rest.map((l) => `${l ?? ''}:`).join('');
  return firstKeyword + restKeywords;
}

/**
 * Compute the bridged ObjC selector for a Swift `init(...)` declaration.
 *
 * **Init rules** (different from regular methods — Apple always uses
 * `initWith` regardless of whether the first label is `_`):
 * - `init()`                       → `init`
 * - `init(_ name: String)`         → `initWithName:`  (uses the INTERNAL
 *                                    name when external is `_`, per Apple's
 *                                    bridging conventions)
 * - `init(name: String)`           → `initWithName:`
 * - `init(name: String, age: Int)` → `initWithName:age:`
 *
 * For the `_` case we need the internal (second identifier) name —
 * passed via `internalNames`.
 */
export function objcSelectorForSwiftInit(
  externalLabels: (string | null)[],
  internalNames: string[],
  explicitObjcName?: string | null
): string | null {
  if (explicitObjcName) return explicitObjcName;

  if (externalLabels.length === 0) {
    return 'init';
  }

  const [firstExt, ...restExt] = externalLabels;
  const [firstInt] = internalNames;
  // Use the internal name when external is "_"; ObjC needs *some* keyword,
  // and Swift's auto-bridger uses the parameter's local name in this case.
  const firstLabel =
    firstExt === null || firstExt === '_' || firstExt === ''
      ? firstInt
      : firstExt;
  if (!firstLabel) return null;

  const firstKeyword = `initWith${capFirst(firstLabel)}:`;
  const restKeywords = restExt
    .map((label, idx) => {
      const internal = internalNames[idx + 1];
      const name = label && label !== '_' ? label : internal ?? '';
      return `${name}:`;
    })
    .join('');
  return firstKeyword + restKeywords;
}

/**
 * Compute the bridged ObjC getter + setter for a Swift `@objc` property.
 *
 * - `var name: String`        → getter `name`, setter `setName:`
 * - `var isReady: Bool`       → getter `isReady`, setter `setIsReady:`
 *   (no special `is` handling — Swift's `isReady` stays as `isReady` in ObjC;
 *   `@objc(name:)` overrides if a Cocoa-style getter `isReady` / setter
 *   `setReady:` pairing is needed — that's the responsibility of the
 *   declaration's `@objc(customGetter)` annotation, which we surface via
 *   `explicitObjcName`.)
 */
export function objcAccessorsForSwiftProperty(
  swiftName: string,
  explicitObjcName?: string | null
): { getter: string; setter: string } | null {
  if (!swiftName) return null;
  // The override syntax `@objc(customGetterName)` re-points the GETTER only;
  // the setter still follows the `setX:` rule but is keyed off the override.
  // (`@objc(getX:setY:)` is not currently supported — that's a rarer
  // shape; can extend later if a real codebase needs it.)
  const getter = explicitObjcName ?? swiftName;
  return {
    getter,
    setter: `set${capFirst(getter)}:`,
  };
}

/**
 * Reverse: from an ObjC selector, return the candidate Swift base names
 * the resolver should try when looking for the bridged Swift declaration.
 *
 * Examples:
 *   `play`                 → ['play']
 *   `play:`                → ['play']
 *   `playWithSong:`        → ['play', 'playWithSong']
 *   `play:by:`             → ['play']
 *   `playWithSong:by:`     → ['play', 'playWithSong']
 *   `initWithName:`        → ['init']                      (init is its own base name)
 *   `initWithName:age:`    → ['init']
 *   `setName:`             → ['name', 'setName']           (could be a setter OR a regular func)
 *   `tableView:didSel…:`   → ['tableView']
 *
 * Returns multiple candidates because the bare base name is ambiguous —
 * `playWithSong:` could correspond to either `func play(song:)` or
 * `func playWithSong(_ x:)` (a Swift method literally named that with a
 * `_` first label). The resolver tries each.
 */
export function swiftBaseNamesForObjcSelector(selector: string): string[] {
  if (!selector) return [];

  // Strip trailing colons and split into keywords.
  const keywords = selector.replace(/:+$/g, '').split(':');
  const firstKeyword = keywords[0];
  if (!firstKeyword) return [];

  const candidates: Set<string> = new Set();

  // Always a candidate: the raw first keyword. Covers
  //   `play:`           → `play`
  //   `play:by:`        → `play`
  //   `playWithSong:`   → `playWithSong` (a literal Swift name)
  //   `tableView:...:`  → `tableView`
  candidates.add(firstKeyword);

  // `initWith<X>:` and `initWith<X>:<more>:` always reduce to `init`.
  if (firstKeyword.startsWith('initWith')) {
    candidates.add('init');
  }

  // Preposition-prefix patterns: `<base>(With|For|By|In|On|At|From|To|Of|As)<Cap>:`
  // covers both Swift's @objc EXPORT rule (always "With") and Cocoa's
  // IMPORTED selectors which use other prepositions natively (e.g.
  // `objectForKey:`, `stringWithFormat:`, `compareTo:`,
  // `imageNamed:inBundle:`). Strip to recover the Swift base name a caller
  // would use (e.g. `object`, `string`, `compare`, `image`).
  const prepositionMatch = firstKeyword.match(
    /^([a-z][a-zA-Z0-9]*?)(?:With|For|By|In|On|At|From|To|Of|As)[A-Z]/
  );
  if (prepositionMatch && prepositionMatch[1]) {
    candidates.add(prepositionMatch[1]);
  }

  // `setX:` could be a property setter — the Swift property is `x` (lowercase).
  // Only fires for the obvious shape: `set` + capital letter + ':' (one param).
  if (
    keywords.length === 1 &&
    /^set[A-Z]/.test(firstKeyword) &&
    selector.endsWith(':')
  ) {
    const propName = lowerFirst(firstKeyword.slice(3));
    if (propName) candidates.add(propName);
  }

  return Array.from(candidates);
}

/**
 * Detect whether a Swift method `@objc` declaration uses the `@objc(custom:)`
 * override form, returning the literal selector when present.
 *
 * Regex-based scan over the small chunk of source preceding the declaration —
 * tree-sitter would be more precise but this is only consulted as a fallback
 * when the structured AST isn't available (e.g. resolver-time lookups
 * via `context.readFile`).
 *
 * Returns `null` when the declaration is plain `@objc` (no override) or has
 * no `@objc` attribute at all.
 */
export function detectExplicitObjcName(sourceSlice: string): string | null {
  // `@objc(customName:)` or `@objc(custom:name:)` — the parens contents are
  // the literal ObjC selector. Whitespace permitted.
  const m = sourceSlice.match(/@objc\s*\(\s*([^)\s]+)\s*\)/);
  return m && m[1] ? m[1] : null;
}

/**
 * Detect whether a Swift declaration is `@objc`-exposed by scanning the
 * source slice that precedes it. Returns true for explicit `@objc`,
 * `@objc(custom:)`, or membership in a `@objcMembers` class (caller's
 * responsibility to pass class-level context if relevant).
 *
 * `@nonobjc` returns false even if `@objc` also appears (per Swift's rule
 * that `@nonobjc` opts out of class-level `@objcMembers`).
 */
export function isObjcExposed(sourceSlice: string): boolean {
  if (/@nonobjc\b/.test(sourceSlice)) return false;
  return /@objc\b/.test(sourceSlice);
}
