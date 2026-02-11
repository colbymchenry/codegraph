/**
 * Grammar Loading and Caching
 *
 * Uses lazy per-language loading so one missing native grammar does not
 * break extraction for all other languages.
 */

import Parser from 'tree-sitter';
import { Language } from '../types';

type GrammarLoader = () => unknown;
type GrammarLanguage = Exclude<Language, 'svelte' | 'liquid' | 'unknown'>;

/**
 * Lazy grammar loaders — each language's native binding is only loaded
 * on first use, so a failure in one grammar doesn't affect others.
 */
const grammarLoaders: Record<GrammarLanguage, GrammarLoader> = {
  typescript: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-typescript').typescript;
  },
  tsx: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-typescript').tsx;
  },
  javascript: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-javascript');
  },
  jsx: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-javascript');
  },
  python: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-python');
  },
  go: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-go');
  },
  rust: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-rust');
  },
  java: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-java');
  },
  c: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-c');
  },
  cpp: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-cpp');
  },
  csharp: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-c-sharp');
  },
  php: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-php').php;
  },
  ruby: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-ruby');
  },
  swift: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-swift');
  },
  kotlin: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('tree-sitter-kotlin');
  },
  dart: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@sengac/tree-sitter-dart');
  },
  // Note: tree-sitter-liquid has ABI compatibility issues with tree-sitter 0.22+
  // Liquid extraction is handled separately via regex in tree-sitter.ts
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
};

/**
 * Caches for loaded grammars and parsers
 */
const parserCache = new Map<Language, Parser>();
const grammarCache = new Map<Language, unknown | null>();
const unavailableGrammarErrors = new Map<Language, string>();

/**
 * Load a grammar on demand, caching the result.
 * Returns null if the grammar is not available on this platform.
 */
function loadGrammar(language: Language): unknown | null {
  if (grammarCache.has(language)) {
    return grammarCache.get(language) ?? null;
  }

  const loader = grammarLoaders[language as GrammarLanguage];
  if (!loader) {
    grammarCache.set(language, null);
    return null;
  }

  try {
    const grammar = loader();
    if (!grammar) {
      throw new Error(`Grammar loader returned empty value for ${language}`);
    }
    grammarCache.set(language, grammar);
    return grammar;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[CodeGraph] Failed to load ${language} grammar — parsing will be unavailable: ${message}`);
    unavailableGrammarErrors.set(language, message);
    grammarCache.set(language, null);
    return null;
  }
}

/**
 * Get a parser for the specified language
 */
export function getParser(language: Language): Parser | null {
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  const grammar = loadGrammar(language);
  if (!grammar) {
    return null;
  }

  try {
    const parser = new Parser();
    parser.setLanguage(grammar as Parameters<typeof parser.setLanguage>[0]);
    parserCache.set(language, parser);
    return parser;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[CodeGraph] Failed to initialize ${language} parser — ABI incompatible: ${message}`);
    unavailableGrammarErrors.set(language, message);
    grammarCache.set(language, null);
    return null;
  }
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
  return getParser(language) !== null;
}

/**
 * Get all currently supported languages.
 */
export function getSupportedLanguages(): Language[] {
  const available = (Object.keys(grammarLoaders) as GrammarLanguage[])
    .filter((language) => getParser(language) !== null);
  return [...available, 'svelte', 'liquid'];
}

/**
 * Clear parser/grammar caches (useful for testing)
 */
export function clearParserCache(): void {
  parserCache.clear();
  grammarCache.clear();
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
    unknown: 'Unknown',
  };
  return names[language] || language;
}
