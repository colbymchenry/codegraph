/**
 * Grammar Loading and Caching
 *
 * Uses web-tree-sitter (WASM) for universal cross-platform support.
 * All grammars are pre-loaded asynchronously via initGrammars(), then
 * getParser() returns synchronously from cache.
 */

import * as path from 'path';
import { Parser, Language as WasmLanguage } from 'web-tree-sitter';
import { Language } from '../types';

type GrammarLanguage = Exclude<Language, 'svelte' | 'liquid' | 'unknown'>;

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
  mql5: 'tree-sitter-mql5.wasm'
};

/**
 * File extension to Language mapping
 */
export const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
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
  '.php': 'php',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.dart': 'dart',
  '.liquid': 'liquid',
  '.svelte': 'svelte',
  '.pas': 'pascal',
  '.dpr': 'pascal',
  '.dpk': 'pascal',
  '.lpr': 'pascal',
  '.dfm': 'pascal',
  '.fmx': 'pascal',
  '.mq5': 'mql5',
  '.mqh': 'mql5',
  '.mql5': 'mql5',
};

/**
 * Caches for loaded grammars and parsers
 */
const parserCache = new Map<Language, Parser>();
const languageCache = new Map<Language, WasmLanguage>();
const unavailableGrammarErrors = new Map<Language, string>();

let grammarsInitialized = false;

/**
 * Initialize all WASM grammars. Must be called before any parsing.
 * Idempotent — safe to call multiple times.
 */
export async function initGrammars(): Promise<void> {
  if (grammarsInitialized) return;

  await Parser.init();

  // Load grammars sequentially to avoid web-tree-sitter WASM race condition on Node 20+
  // See: https://github.com/tree-sitter/tree-sitter/issues/2338
  const entries = Object.entries(WASM_GRAMMAR_FILES) as [GrammarLanguage, string][];
  for (const [lang, wasmFile] of entries) {
    try {
      // Pascal & MQL5 ships its own WASM (not in tree-sitter-wasms)
      const wasmPath = (lang === 'pascal' || lang === 'mql5')
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

  grammarsInitialized = true;
}

/**
 * Check if grammars have been initialized
 */
export function isGrammarsInitialized(): boolean {
  return grammarsInitialized;
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
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): Language {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_MAP[ext] || 'unknown';
}

/**
 * Check if a language is supported by currently available parsers.
 */
export function isLanguageSupported(language: Language): boolean {
  if (language === 'svelte') return true; // custom extractor (script block delegation)
  if (language === 'liquid') return true; // custom regex extractor
  if (language === 'unknown') return false;
  return languageCache.has(language);
}

/**
 * Get all currently supported languages.
 */
export function getSupportedLanguages(): Language[] {
  const available = (Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[])
    .filter((language) => languageCache.has(language));
  return [...available, 'svelte', 'liquid'];
}

/**
 * Clear parser/grammar caches (useful for testing)
 */
export function clearParserCache(): void {
  parserCache.clear();
  // Note: languageCache is NOT cleared — WASM languages persist.
  // To fully re-init, set grammarsInitialized = false and call initGrammars() again.
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
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    php: 'PHP',
    ruby: 'Ruby',
    swift: 'Swift',
    kotlin: 'Kotlin',
    dart: 'Dart',
    svelte: 'Svelte',
    liquid: 'Liquid',
    pascal: 'Pascal / Delphi',
    mql5: 'mql5',
    unknown: 'Unknown',
  };
  return names[language] || language;
}
