/**
 * The SwiftPM module a Swift file belongs to, from its path alone.
 *
 * A file's module directory is the path segment after the last `Sources` or
 * `Tests` directory, when a further directory follows it (SwiftPM's layout:
 * `Sources/<Target>/…`, `Tests/<Target>/…`). Any other layout (an Xcode
 * project, a file directly under `Sources/`) has no derivable module.
 *
 * - `swiftModule` gives that directory as `id` and the name Swift code must
 *   `import` it by (`swiftModuleName`, SwiftPM's c99name rule) as `name`.
 * - `swiftModuleIdentity` gives the path up to and including the module
 *   directory, so `Packages/P/Sources/Core` and `Packages/Q/Sources/Core` are
 *   two modules; swift-type-visibility.ts's static-call gate compares modules
 *   by it.
 *
 * Known limitation: Package.swift is not read, so a target whose `path:`
 * gives it a name different from its directory is still named by the
 * directory.
 *
 * Index facts only: nothing here reads a file.
 */

/** A file's module: `id` decides sameness, `name` is what an import must name. */
export interface ModuleOf {
  id: string;
  name: string;
}

/** The directory segments of a path (`/` or `\` separated), without the file name. */
function dirSegments(filePath: string): string[] {
  const segments = filePath.split(/[\\/]/).filter((s) => s.length > 0);
  segments.pop(); // the file name
  return segments;
}

/**
 * The index in `dirs` of a SwiftPM module directory: the segment after the
 * last `Sources` or `Tests`, or -1 when no directory follows that segment (or
 * there is none).
 */
function moduleDirIndex(dirs: readonly string[]): number {
  let at = -1;
  for (let i = 0; i < dirs.length; i++) if (dirs[i] === 'Sources' || dirs[i] === 'Tests') at = i;
  return at < 0 || at + 1 >= dirs.length ? -1 : at + 1;
}

/**
 * The Unicode scalars SwiftPM keeps in a c99name, as inclusive [first, last] code-point
 * ranges: ASCII letters, digits and `_`, then C99 Annex D's extended-identifier ranges.
 * Copied range for range, in source order, from `spm_mangledToC99ExtendedIdentifier` in
 * swift-tools-support-core Sources/TSCUtility/StringMangling.swift at commit
 * c574915fe88e942e4c4c93376f022daa2ecf05f9. The table is not a Unicode property: it allows
 * U+2160-U+2182 (Roman numerals) and precomposed U+00EF, but not U+00BD (½) or the
 * combining diaeresis U+0308. Edit it only by re-copying that source.
 */
const C99_ALLOWED_RANGES: readonly (readonly [number, number])[] = [
  // A-Z, a-z, 0-9, _
  [0x0041, 0x005a], [0x0061, 0x007a], [0x0030, 0x0039], [0x005f, 0x005f],
  // Latin (1)
  [0x00aa, 0x00aa],
  // Special characters (1)
  [0x00b5, 0x00b5], [0x00b7, 0x00b7],
  // Latin (2)
  [0x00ba, 0x00ba], [0x00c0, 0x00d6], [0x00d8, 0x00f6],
  [0x00f8, 0x01f5], [0x01fa, 0x0217], [0x0250, 0x02a8],
  // Special characters (2)
  [0x02b0, 0x02b8], [0x02bb, 0x02bb], [0x02bd, 0x02c1],
  [0x02d0, 0x02d1], [0x02e0, 0x02e4], [0x037a, 0x037a],
  // Greek (1)
  [0x0386, 0x0386], [0x0388, 0x038a], [0x038c, 0x038c],
  [0x038e, 0x03a1], [0x03a3, 0x03ce], [0x03d0, 0x03d6],
  [0x03da, 0x03da], [0x03dc, 0x03dc], [0x03de, 0x03de],
  [0x03e0, 0x03e0], [0x03e2, 0x03f3],
  // Cyrillic
  [0x0401, 0x040c], [0x040e, 0x044f], [0x0451, 0x045c],
  [0x045e, 0x0481], [0x0490, 0x04c4], [0x04c7, 0x04c8],
  [0x04cb, 0x04cc], [0x04d0, 0x04eb], [0x04ee, 0x04f5],
  [0x04f8, 0x04f9],
  // Armenian (1)
  [0x0531, 0x0556],
  // Special characters (3)
  [0x0559, 0x0559],
  // Armenian (2)
  [0x0561, 0x0587],
  // Hebrew
  [0x05b0, 0x05b9], [0x05bb, 0x05bd], [0x05bf, 0x05bf],
  [0x05c1, 0x05c2], [0x05d0, 0x05ea], [0x05f0, 0x05f2],
  // Arabic (1)
  [0x0621, 0x063a], [0x0640, 0x0652],
  // Digits (1)
  [0x0660, 0x0669],
  // Arabic (2)
  [0x0670, 0x06b7], [0x06ba, 0x06be], [0x06c0, 0x06ce],
  [0x06d0, 0x06dc], [0x06e5, 0x06e8], [0x06ea, 0x06ed],
  // Digits (2)
  [0x06f0, 0x06f9],
  // Devanagari and special character 0x093D
  [0x0901, 0x0903], [0x0905, 0x0939], [0x093d, 0x094d],
  [0x0950, 0x0952], [0x0958, 0x0963],
  // Digits (3)
  [0x0966, 0x096f],
  // Bengali (1)
  [0x0981, 0x0983], [0x0985, 0x098c], [0x098f, 0x0990],
  [0x0993, 0x09a8], [0x09aa, 0x09b0], [0x09b2, 0x09b2],
  [0x09b6, 0x09b9], [0x09be, 0x09c4], [0x09c7, 0x09c8],
  [0x09cb, 0x09cd], [0x09dc, 0x09dd], [0x09df, 0x09e3],
  // Digits (4)
  [0x09e6, 0x09ef],
  // Bengali (2)
  [0x09f0, 0x09f1],
  // Gurmukhi (1)
  [0x0a02, 0x0a02], [0x0a05, 0x0a0a], [0x0a0f, 0x0a10],
  [0x0a13, 0x0a28], [0x0a2a, 0x0a30], [0x0a32, 0x0a33],
  [0x0a35, 0x0a36], [0x0a38, 0x0a39], [0x0a3e, 0x0a42],
  [0x0a47, 0x0a48], [0x0a4b, 0x0a4d], [0x0a59, 0x0a5c],
  [0x0a5e, 0x0a5e],
  // Digits (5)
  [0x0a66, 0x0a6f],
  // Gurmukhi (2)
  [0x0a74, 0x0a74],
  // Gujarati
  [0x0a81, 0x0a83], [0x0a85, 0x0a8b], [0x0a8d, 0x0a8d],
  [0x0a8f, 0x0a91], [0x0a93, 0x0aa8], [0x0aaa, 0x0ab0],
  [0x0ab2, 0x0ab3], [0x0ab5, 0x0ab9], [0x0abd, 0x0ac5],
  [0x0ac7, 0x0ac9], [0x0acb, 0x0acd], [0x0ad0, 0x0ad0],
  [0x0ae0, 0x0ae0],
  // Digits (6)
  [0x0ae6, 0x0aef],
  // Oriya and special character 0x0B3D
  [0x0b01, 0x0b03], [0x0b05, 0x0b0c], [0x0b0f, 0x0b10],
  [0x0b13, 0x0b28], [0x0b2a, 0x0b30], [0x0b32, 0x0b33],
  [0x0b36, 0x0b39], [0x0b3d, 0x0b43], [0x0b47, 0x0b48],
  [0x0b4b, 0x0b4d], [0x0b5c, 0x0b5d], [0x0b5f, 0x0b61],
  // Digits (7)
  [0x0b66, 0x0b6f],
  // Tamil
  [0x0b82, 0x0b83], [0x0b85, 0x0b8a], [0x0b8e, 0x0b90],
  [0x0b92, 0x0b95], [0x0b99, 0x0b9a], [0x0b9c, 0x0b9c],
  [0x0b9e, 0x0b9f], [0x0ba3, 0x0ba4], [0x0ba8, 0x0baa],
  [0x0bae, 0x0bb5], [0x0bb7, 0x0bb9], [0x0bbe, 0x0bc2],
  [0x0bc6, 0x0bc8], [0x0bca, 0x0bcd],
  // Digits (8)
  [0x0be7, 0x0bef],
  // Telugu
  [0x0c01, 0x0c03], [0x0c05, 0x0c0c], [0x0c0e, 0x0c10],
  [0x0c12, 0x0c28], [0x0c2a, 0x0c33], [0x0c35, 0x0c39],
  [0x0c3e, 0x0c44], [0x0c46, 0x0c48], [0x0c4a, 0x0c4d],
  [0x0c60, 0x0c61],
  // Digits (9)
  [0x0c66, 0x0c6f],
  // Kannada
  [0x0c82, 0x0c83], [0x0c85, 0x0c8c], [0x0c8e, 0x0c90],
  [0x0c92, 0x0ca8], [0x0caa, 0x0cb3], [0x0cb5, 0x0cb9],
  [0x0cbe, 0x0cc4], [0x0cc6, 0x0cc8], [0x0cca, 0x0ccd],
  [0x0cde, 0x0cde], [0x0ce0, 0x0ce1],
  // Digits (10)
  [0x0ce6, 0x0cef],
  // Malayalam
  [0x0d02, 0x0d03], [0x0d05, 0x0d0c], [0x0d0e, 0x0d10],
  [0x0d12, 0x0d28], [0x0d2a, 0x0d39], [0x0d3e, 0x0d43],
  [0x0d46, 0x0d48], [0x0d4a, 0x0d4d], [0x0d60, 0x0d61],
  // Digits (11)
  [0x0d66, 0x0d6f],
  // Thai, including digits 0x0E50-0x0E59
  [0x0e01, 0x0e3a], [0x0e40, 0x0e5b],
  // Lao (1)
  [0x0e81, 0x0e82], [0x0e84, 0x0e84], [0x0e87, 0x0e88],
  [0x0e8a, 0x0e8a], [0x0e8d, 0x0e8d], [0x0e94, 0x0e97],
  [0x0e99, 0x0e9f], [0x0ea1, 0x0ea3], [0x0ea5, 0x0ea5],
  [0x0ea7, 0x0ea7], [0x0eaa, 0x0eab], [0x0ead, 0x0eae],
  [0x0eb0, 0x0eb9], [0x0ebb, 0x0ebd], [0x0ec0, 0x0ec4],
  [0x0ec6, 0x0ec6], [0x0ec8, 0x0ecd],
  // Digits (12)
  [0x0ed0, 0x0ed9],
  // Lao (2)
  [0x0edc, 0x0edd],
  // Tibetan (1)
  [0x0f00, 0x0f00], [0x0f18, 0x0f19],
  // Digits (13)
  [0x0f20, 0x0f33],
  // Tibetan (2)
  [0x0f35, 0x0f35], [0x0f37, 0x0f37], [0x0f39, 0x0f39],
  [0x0f3e, 0x0f47], [0x0f49, 0x0f69], [0x0f71, 0x0f84],
  [0x0f86, 0x0f8b], [0x0f90, 0x0f95], [0x0f97, 0x0f97],
  [0x0f99, 0x0fad], [0x0fb1, 0x0fb7], [0x0fb9, 0x0fb9],
  // Georgian
  [0x10a0, 0x10c5], [0x10d0, 0x10f6],
  // Latin (3)
  [0x1e00, 0x1e9b], [0x1ea0, 0x1ef9],
  // Greek (2)
  [0x1f00, 0x1f15], [0x1f18, 0x1f1d], [0x1f20, 0x1f45],
  [0x1f48, 0x1f4d], [0x1f50, 0x1f57], [0x1f59, 0x1f59],
  [0x1f5b, 0x1f5b], [0x1f5d, 0x1f5d], [0x1f5f, 0x1f7d],
  [0x1f80, 0x1fb4], [0x1fb6, 0x1fbc],
  // Special characters (4)
  [0x1fbe, 0x1fbe],
  // Greek (3)
  [0x1fc2, 0x1fc4], [0x1fc6, 0x1fcc], [0x1fd0, 0x1fd3],
  [0x1fd6, 0x1fdb], [0x1fe0, 0x1fec], [0x1ff2, 0x1ff4],
  [0x1ff6, 0x1ffc],
  // Special characters (5)
  [0x203f, 0x2040],
  // Latin (4)
  [0x207f, 0x207f],
  // Special characters (6), including Roman numerals 0x2160-0x2182
  [0x2102, 0x2102], [0x2107, 0x2107], [0x210a, 0x2113],
  [0x2115, 0x2115], [0x2118, 0x211d], [0x2124, 0x2124],
  [0x2126, 0x2126], [0x2128, 0x2128], [0x212a, 0x2131],
  [0x2133, 0x2138], [0x2160, 0x2182], [0x3005, 0x3007],
  [0x3021, 0x3029],
  // Hiragana
  [0x3041, 0x3093], [0x309b, 0x309c],
  // Katakana
  [0x30a1, 0x30f6], [0x30fb, 0x30fc],
  // Bopomofo
  [0x3105, 0x312c],
  // CJK Unified Ideographs
  [0x4e00, 0x9fa5],
  // Hangul
  [0xac00, 0xd7a3],
];

/**
 * The digits that may not start a c99name, as inclusive code-point ranges: ASCII 0-9 and
 * the Annex D digit ranges. Same source and commit as C99_ALLOWED_RANGES (its "Apply further
 * restrictions to the prefix" step); every range here is also in C99_ALLOWED_RANGES.
 */
const C99_NON_INITIAL_DIGIT_RANGES: readonly (readonly [number, number])[] = [
  [0x0030, 0x0039],
  [0x0660, 0x0669], [0x06f0, 0x06f9], [0x0966, 0x096f],
  [0x09e6, 0x09ef], [0x0a66, 0x0a6f], [0x0ae6, 0x0aef],
  [0x0b66, 0x0b6f], [0x0be7, 0x0bef], [0x0c66, 0x0c6f],
  [0x0ce6, 0x0cef], [0x0d66, 0x0d6f], [0x0e50, 0x0e59],
  [0x0ed0, 0x0ed9], [0x0f20, 0x0f33],
];

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([first, last]) => codePoint >= first && codePoint <= last);
}

/**
 * The name Swift code must `import` for a SwiftPM target in `directory`: SwiftPM's c99name,
 * computed as `spm_mangledToC99ExtendedIdentifier` does (StringMangling.swift, commit above
 * C99_ALLOWED_RANGES). Two steps over the Unicode scalars (code points, not UTF-16 units):
 * every scalar outside C99_ALLOWED_RANGES becomes `_`; then, if the first scalar is in
 * C99_NON_INITIAL_DIGIT_RANGES, it is replaced by `_` (not prefixed, so '1abc' -> '_abc',
 * as Swift 6.4 `swift package describe --type json` also reports). Only the first scalar is
 * examined. No normalization is applied, so a precomposed 'ï' (U+00EF) is kept but 'i'
 * followed by a combining diaeresis (U+0308) becomes 'i_'. 'mcp-benchmarker' ->
 * 'mcp_benchmarker', 'a.b c' -> 'a_b_c', 'naïve+x' -> 'naïve_x', 'Util' -> 'Util',
 * 'a½b' -> 'a_b', 'aⅣb' -> 'aⅣb'.
 */
export function swiftModuleName(directory: string): string {
  const scalars = Array.from(directory, (ch) => (inRanges(ch.codePointAt(0)!, C99_ALLOWED_RANGES) ? ch : '_'));
  if (scalars.length > 0 && inRanges(scalars[0]!.codePointAt(0)!, C99_NON_INITIAL_DIGIT_RANGES)) scalars[0] = '_';
  return scalars.join('');
}

/**
 * SwiftPM module: the directory after the last `Sources`/`Tests` directory, if one follows.
 * The directory is the id (it decides sameness); the name is its c99name (`swiftModuleName`).
 * Null when the path has no such directory.
 */
export function swiftModule(filePath: string): ModuleOf | null {
  const dirs = dirSegments(filePath);
  const at = moduleDirIndex(dirs);
  if (at < 0) return null;
  const dir = dirs[at]!;
  return { id: dir, name: swiftModuleName(dir) };
}

/**
 * A SwiftPM module's identity for sameness: the path's directories up to and
 * including the module directory (the one `swiftModule` names), joined by
 * `/`. `Packages/P/Sources/Core/A.swift` is `Packages/P/Sources/Core`, so two
 * packages' `Core` targets differ. Null when `swiftModule` is null.
 */
export function swiftModuleIdentity(filePath: string): string | null {
  const dirs = dirSegments(filePath);
  const at = moduleDirIndex(dirs);
  return at < 0 ? null : dirs.slice(0, at + 1).join('/');
}
