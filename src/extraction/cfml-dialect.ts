/**
 * Which of CFML's two dialects a file is written in.
 *
 * Its own module, dependency-free, because two readers need the same answer:
 * the extractor (which hands a bare-script file to the cfscript grammar) and
 * the viewer's syntax classifier (which has to read the file with that same
 * grammar, or it highlights nothing) — and the classifier runs in a worker
 * that must not load the whole extraction pipeline to find out.
 */

/**
 * Sniff whether CFML source is bare-script (`component { ... }`, modern style)
 * vs tag-based (`<cfcomponent>`, `<cfif>`, HTML). Skips a leading UTF-8 BOM
 * (endemic in CFML's Windows-editor history — 17% of ColdBox's files carry
 * one; both grammars parse fine with it once routed correctly), whitespace,
 * and `//`/`/* *\/` comments to find the first real token; tag-based files
 * start with `<`, script-based files don't.
 */
export function isBareScriptCfml(source: string): boolean {
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF') {
      i++;
    } else if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? len : nl + 1;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
    } else {
      return ch !== '<';
    }
  }
  return true; // empty/whitespace-only file — treat as script (no-op extraction either way)
}
