/**
 * Grammar Loading and Caching
 *
 * Uses web-tree-sitter (WASM) for universal cross-platform support.
 * Grammars are loaded lazily — only languages actually present in the project
 * are compiled, keeping V8 WASM memory pressure low on large codebases.
 */

import * as path from 'path';
import { Parser, Language as WasmLanguage } from 'web-tree-sitter';
import { Language } from '../types';

export type GrammarLanguage = Exclude<Language, 'svelte' | 'vue' | 'astro' | 'liquid' | 'razor' | 'yaml' | 'twig' | 'xml' | 'properties' | 'unknown'>;

/**
 * WASM filename map — maps each language to its .wasm grammar file
 * in the tree-sitter-wasms package.
 */
const WASM_GRAMMAR_FILES: Record<GrammarLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  php: 'tree-sitter-php.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  dart: 'tree-sitter-dart.wasm',
  pascal: 'tree-sitter-pascal.wasm',
  scala: 'tree-sitter-scala.wasm',
  lua: 'tree-sitter-lua.wasm',
  r: 'tree-sitter-r.wasm',
  luau: 'tree-sitter-luau.wasm',
  objc: 'tree-sitter-objc.wasm',
  cfml: 'tree-sitter-cfml.wasm',
  cfscript: 'tree-sitter-cfscript.wasm',
  cfquery: 'tree-sitter-cfquery.wasm',
  cobol: 'tree-sitter-cobol.wasm',
};

/**
 * File extension to Language mapping
 */
export const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  // ESM/CJS TypeScript module extensions — parsed as TS (no JSX). (#366)
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // SAP HANA XS Classic server-side JavaScript. (#556)
  '.xsjs': 'javascript',
  '.xsjslib': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c', // Could also be C++, defaulting to C
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  // ASP.NET Razor / Blazor markup — custom RazorExtractor (links @model/@inject/
  // component tags to their C# types; markup isn't a tree-sitter grammar).
  '.cshtml': 'razor',
  '.razor': 'razor',
  '.php': 'php',
  // Drupal-specific PHP file extensions
  '.module': 'php',
  '.install': 'php',
  '.theme': 'php',
  '.inc': 'php',
  // YAML (used for Drupal routing files; no symbol extraction, file-level tracking only)
  '.yml': 'yaml',
  '.yaml': 'yaml',
  // Twig templates (file-level tracking only, no symbol extraction)
  '.twig': 'twig',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.dart': 'dart',
  '.liquid': 'liquid',
  '.svelte': 'svelte',
  '.vue': 'vue',
  '.astro': 'astro',
  '.r': 'r',
  '.pas': 'pascal',
  '.dpr': 'pascal',
  '.dpk': 'pascal',
  '.lpr': 'pascal',
  '.dfm': 'pascal',
  '.fmx': 'pascal',
  '.scala': 'scala',
  '.sc': 'scala',
  '.lua': 'lua',
  '.luau': 'luau',
  '.m': 'objc',
  '.mm': 'objc',
  // CFML: .cfc/.cfm parse with the tag-aware `cfml` grammar (custom CfmlExtractor
  // dialect-switches to cfscript for bare-script content); .cfs is pure CFScript.
  '.cfc': 'cfml',
  '.cfm': 'cfml',
  '.cfs': 'cfscript',
  // Metal Shading Language ≈ C++14: the C++ grammar extracts its functions,
  // structs, and calls. MSL-specific `[[attribute]]` annotations are blanked
  // pre-parse for `.metal` files (see blankMetalAttributes in c-cpp.ts). (#1121)
  '.metal': 'cpp',
  // XML: file-level tracking; the MyBatis extractor matches `<mapper namespace="...">`
  // shape and emits SQL-statement nodes (other XML returns empty).
  '.xml': 'xml',
  // COBOL: programs (.cbl/.cob) and copybooks (.cpy). Vendored grammar
  // (patched yutaro-sakamoto/tree-sitter-cobol) handles fixed-format column
  // rules, EXEC CICS/SQL blocks, and standalone copybook fragments.
  '.cbl': 'cobol',
  '.cob': 'cobol',
  '.cobol': 'cobol',
  '.cpy': 'cobol',
  // Spring config: `application.properties` / `application-*.properties`. Same
  // shape as the `.yml` variants — the YAML/properties extractor emits one node
  // per leaf key, and the Spring resolver links `@Value("${k}")` references.
  '.properties': 'properties',
};

/**
 * Whether a file is one CodeGraph can parse, based purely on its extension.
 * This is the single source of truth for "should we index this file" — derived
 * from EXTENSION_MAP so parser support and indexing selection never drift.
 *
 * `overrides` is the project's validated custom extension → language map (from
 * `codegraph.json`); when present its extensions count as indexable in addition
 * to the built-ins. Omitting it is byte-identical to the zero-config behavior.
 */
export function isSourceFile(filePath: string, overrides?: Record<string, Language>): boolean {
  if (isPlayRoutesFile(filePath)) return true; // Play `conf/routes` is extensionless
  if (isShopifyLiquidJson(filePath)) return true; // Shopify OS 2.0 JSON templates / section groups
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = filePath.slice(dot).toLowerCase();
  return ext in EXTENSION_MAP || (!!overrides && ext in overrides);
}

/**
 * Shopify OS 2.0 JSON template (`templates/*.json`) or section group
 * (`sections/*.json`) — these reference sections by `"type"`, so the Liquid
 * extractor links them. (config/ + locales/ JSON have no section refs.)
 */
export function isShopifyLiquidJson(filePath: string): boolean {
  // Allow nested template dirs (`templates/customers/login.json`), not just
  // top-level (`templates/product.json`).
  return /(^|\/)(templates|sections)\/.+\.json$/i.test(filePath);
}

/**
 * Play Framework routes file: the extensionless `conf/routes` (and included
 * `conf/*.routes`). No grammar — route extraction is done by the Play framework
 * resolver, so it's processed through the no-grammar (`yaml`-style) path.
 */
export function isPlayRoutesFile(filePath: string): boolean {
  return (
    filePath === 'conf/routes' ||
    filePath.endsWith('/conf/routes') ||
    filePath.endsWith('.routes')
  );
}

/**
 * Caches for loaded grammars and parsers
 */
const parserCache = new Map<Language, Parser>();
const languageCache = new Map<Language, WasmLanguage>();
const unavailableGrammarErrors = new Map<Language, string>();

let parserInitialized = false;

/**
 * Initialize the tree-sitter WASM runtime. Must be called before loading grammars.
 * Does NOT load any grammar WASM files — use loadGrammarsForLanguages() for that.
 * Idempotent — safe to call multiple times.
 */
export async function initGrammars(): Promise<void> {
  if (parserInitialized) return;

  await Parser.init();

  parserInitialized = true;
}

/**
 * Load grammar WASM files for specific languages only.
 * Skips languages that are already loaded or have no WASM grammar.
 * Must be called after initGrammars().
 */
export async function loadGrammarsForLanguages(languages: Language[]): Promise<void> {
  if (!parserInitialized) {
    await initGrammars();
  }

  // SFC languages (svelte/vue/astro) have no grammar of their own — their
  // extractors delegate <script>/frontmatter content to the TS/JS extractor,
  // so those grammars must be loaded even when no plain .ts/.js file is in
  // the index set (e.g. a pure-.astro content site).
  if (languages.some((l) => l === 'svelte' || l === 'vue' || l === 'astro')) {
    languages = [...languages, 'typescript', 'javascript'];
  }

  // CFML (.cfc/.cfm) delegates bare-script content, <cfscript> tag bodies, and
  // <cfquery> SQL bodies to the cfscript/cfquery grammars (see injections.scm in
  // tree-sitter-cfml) — load both even when no standalone .cfs file is in the
  // index set.
  if (languages.some((l) => l === 'cfml')) {
    languages = [...languages, 'cfscript', 'cfquery'];
  }

  // Deduplicate and filter to languages that have WASM grammars and aren't already loaded
  const toLoad = [...new Set(languages)].filter(
    (lang): lang is GrammarLanguage =>
      lang in WASM_GRAMMAR_FILES &&
      !languageCache.has(lang) &&
      !unavailableGrammarErrors.has(lang)
  );

  // Load grammars sequentially to avoid web-tree-sitter WASM race condition on Node 20+
  // See: https://github.com/tree-sitter/tree-sitter/issues/2338
  for (const lang of toLoad) {
    const wasmFile = WASM_GRAMMAR_FILES[lang];
    try {
      // Some grammars ship their own WASMs (not in tree-sitter-wasms, or the
      // tree-sitter-wasms build is too old). Lua: tree-sitter-wasms ships an
      // ABI-13 build that corrupts the shared WASM heap under web-tree-sitter
      // 0.25 (drops nested calls/imports on every file after the first); we
      // vendor the upstream ABI-15 wasm instead. C#: the tree-sitter-wasms
      // build (ABI 13) has no primary-constructor support and parses
      // `class Foo(...)` as an ERROR that swallows the whole class (#237); we
      // vendor the upstream ABI-15 tree-sitter-c-sharp 0.23.5 wasm, which parses
      // primary constructors natively.
      const wasmPath = (lang === 'pascal' || lang === 'scala' || lang === 'lua' || lang === 'luau' || lang === 'csharp' || lang === 'r' || lang === 'cfml' || lang === 'cfscript' || lang === 'cfquery' || lang === 'cobol')
        ? path.join(__dirname, 'wasm', wasmFile)
        : require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
      const language = await WasmLanguage.load(wasmPath);
      languageCache.set(lang, language);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodeGraph] Failed to load ${lang} grammar — parsing will be unavailable: ${message}`);
      unavailableGrammarErrors.set(lang, message);
    }
  }
}

/**
 * Load ALL grammar WASM files. Convenience function for tests and
 * backward compatibility. Prefer loadGrammarsForLanguages() in production.
 */
export async function loadAllGrammars(): Promise<void> {
  const allLanguages = Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[];
  await loadGrammarsForLanguages(allLanguages);
}

/**
 * Check if grammars have been initialized
 */
export function isGrammarsInitialized(): boolean {
  return parserInitialized;
}

/**
 * Get a parser for the specified language.
 * Returns synchronously from pre-loaded cache.
 */
export function getParser(language: Language): Parser | null {
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  const lang = languageCache.get(language);
  if (!lang) {
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(language, parser);
  return parser;
}

/**
 * Detect language from file extension.
 *
 * `overrides` is the project's validated custom extension → language map (from
 * `codegraph.json`); when present its mappings take precedence over the built-in
 * `EXTENSION_MAP`. Omitting it is byte-identical to the zero-config behavior.
 */
export function detectLanguage(filePath: string, source?: string, overrides?: Record<string, Language>): Language {
  // Play `conf/routes` has no grammar — route through the no-symbol path; the
  // Play framework resolver extracts route nodes from it.
  if (isPlayRoutesFile(filePath)) return 'yaml';
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  // Shopify OS 2.0 JSON templates / section groups → the Liquid extractor (it
  // links each section `"type"` to its `sections/<type>.liquid`).
  if (isShopifyLiquidJson(filePath)) return 'liquid';
  const lang = (overrides && overrides[ext]) || EXTENSION_MAP[ext] || 'unknown';

  // .h files could be C, C++, or Objective-C — check source content
  if (lang === 'c' && ext === '.h' && source) {
    if (looksLikeCpp(source)) return 'cpp';
    if (looksLikeObjc(source)) return 'objc';
  }

  return lang;
}

/**
 * Heuristic: does a .h file contain C++ constructs?
 * Checks the first ~8KB for patterns that are unique to C++ and never valid C.
 */
function looksLikeCpp(source: string): boolean {
  const sample = source.substring(0, 8192);
  return /\bnamespace\b|\bclass\s+\w+\s*[:{]|\btemplate\s*<|\b(?:public|private|protected)\s*:|\bvirtual\b|\busing\s+(?:namespace\b|\w+\s*=)/.test(sample);
}

/**
 * Heuristic: does a .h file contain Objective-C constructs?
 */
function looksLikeObjc(source: string): boolean {
  const sample = source.substring(0, 8192);
  return /@(?:interface|implementation|protocol|synthesize)\b/.test(sample);
}

/**
 * Check if a language is supported (has a grammar defined).
 * Returns true if the grammar exists, even if not yet loaded.
 */
export function isLanguageSupported(language: Language): boolean {
  if (language === 'svelte') return true; // custom extractor (script block delegation)
  if (language === 'vue') return true; // custom extractor (script block delegation)
  if (language === 'astro') return true; // custom extractor (frontmatter/script block delegation)
  if (language === 'liquid') return true; // custom regex extractor
  if (language === 'razor') return true; // custom RazorExtractor (.cshtml/.razor markup)
  if (language === 'yaml') return true; // file-level tracking only; Drupal routing extraction via framework resolver
  if (language === 'twig') return true; // file-level tracking only
  if (language === 'xml') return true; // MyBatis mapper extractor
  if (language === 'properties') return true; // Spring config keys
  if (language === 'unknown') return false;
  return language in WASM_GRAMMAR_FILES;
}

/**
 * Check if a grammar has been loaded and is ready for parsing.
 */
export function isGrammarLoaded(language: Language): boolean {
  if (language === 'svelte' || language === 'vue' || language === 'astro' || language === 'liquid' || language === 'razor') return true;
  if (language === 'yaml' || language === 'twig') return true; // no WASM grammar needed
  if (language === 'xml' || language === 'properties') return true; // no WASM grammar needed
  return languageCache.has(language);
}

/**
 * Languages tracked at the file-record level only: parsing emits zero symbol
 * nodes, but the file is still stored (and framework resolvers may add per-file
 * references later, e.g. Drupal routing yml, Spring `@Value` against
 * application.properties). This is the canonical set behind the no-symbol
 * branch in `tree-sitter.ts`; `xml` is intentionally excluded because its
 * MyBatis extractor emits a file node. Callers use this to count such files as
 * indexed rather than skipped, so it must stay in sync with that branch.
 */
export function isFileLevelOnlyLanguage(language: Language): boolean {
  return language === 'yaml' || language === 'twig' || language === 'properties';
}

/**
 * Get all supported languages (those with grammar definitions).
 */
export function getSupportedLanguages(): Language[] {
  return [...(Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[]), 'svelte', 'vue', 'astro', 'liquid'];
}

/**
 * Reset the cached parser for a language to reclaim WASM heap memory.
 * The tree-sitter WASM runtime accumulates fragmented memory over thousands
 * of parses. Deleting and recreating the Parser instance forces the WASM
 * heap to reset, preventing "memory access out of bounds" crashes in
 * large repos.
 */
export function resetParser(language: Language): void {
  const old = parserCache.get(language);
  if (old) {
    old.delete();
    parserCache.delete(language);
  }
}

/**
 * Clear parser/grammar caches (useful for testing)
 */
export function clearParserCache(): void {
  for (const parser of parserCache.values()) {
    parser.delete();
  }
  parserCache.clear();
  // Note: languageCache is NOT cleared — WASM languages persist.
  // To fully re-init, set parserInitialized = false and call initGrammars() again.
  unavailableGrammarErrors.clear();
}

/**
 * Report grammars that failed to load.
 */
export function getUnavailableGrammarErrors(): Partial<Record<Language, string>> {
  const out: Partial<Record<Language, string>> = {};
  for (const [language, message] of unavailableGrammarErrors.entries()) {
    out[language] = message;
  }
  return out;
}

/**
 * Get language display name
 */
export function getLanguageDisplayName(language: Language): string {
  const names: Record<Language, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    tsx: 'TypeScript (TSX)',
    jsx: 'JavaScript (JSX)',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
    r: 'R',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    razor: 'Razor/Blazor',
    php: 'PHP',
    ruby: 'Ruby',
    swift: 'Swift',
    kotlin: 'Kotlin',
    dart: 'Dart',
    svelte: 'Svelte',
    vue: 'Vue',
    astro: 'Astro',
    liquid: 'Liquid',
    pascal: 'Pascal / Delphi',
    scala: 'Scala',
    lua: 'Lua',
    luau: 'Luau',
    objc: 'Objective-C',
    yaml: 'YAML',
    twig: 'Twig',
    xml: 'XML',
    properties: 'Java properties',
    cfml: 'CFML',
    cfscript: 'CFScript',
    cfquery: 'CFQuery (SQL)',
    cobol: 'COBOL',
    unknown: 'Unknown',
  };
  return names[language] || language;
}
