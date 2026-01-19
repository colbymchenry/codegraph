/**
 * Grammar Loading and Caching
 *
 * Manages tree-sitter language grammars.
 */

import Parser from 'tree-sitter';
import { Language } from '../types';

// Grammar module imports
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TypeScript = require('tree-sitter-typescript').typescript;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TSX = require('tree-sitter-typescript').tsx;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const JavaScript = require('tree-sitter-javascript');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Python = require('tree-sitter-python');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Go = require('tree-sitter-go');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Rust = require('tree-sitter-rust');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Java = require('tree-sitter-java');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const C = require('tree-sitter-c');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Cpp = require('tree-sitter-cpp');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CSharp = require('tree-sitter-c-sharp');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PHP = require('tree-sitter-php').php;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Ruby = require('tree-sitter-ruby');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Swift = require('tree-sitter-swift');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Kotlin = require('tree-sitter-kotlin');
// Note: tree-sitter-liquid has ABI compatibility issues with tree-sitter 0.22+
// Liquid extraction is handled separately via regex in tree-sitter.ts

/**
 * Mapping of Language to tree-sitter grammar
 */
const GRAMMAR_MAP: Record<string, unknown> = {
  typescript: TypeScript,
  tsx: TSX,
  javascript: JavaScript,
  jsx: JavaScript, // JSX uses the JavaScript grammar
  python: Python,
  go: Go,
  rust: Rust,
  java: Java,
  c: C,
  cpp: Cpp,
  csharp: CSharp,
  php: PHP,
  ruby: Ruby,
  swift: Swift,
  kotlin: Kotlin,
  // liquid: uses custom regex-based extraction, not tree-sitter
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
  '.liquid': 'liquid',
};

/**
 * Cache for initialized parsers
 */
const parserCache = new Map<Language, Parser>();

/**
 * Get a parser for the specified language
 */
export function getParser(language: Language): Parser | null {
  // Check cache first
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  // Get grammar for language
  const grammar = GRAMMAR_MAP[language];
  if (!grammar) {
    return null;
  }

  // Create and cache parser
  const parser = new Parser();
  parser.setLanguage(grammar as Parameters<typeof parser.setLanguage>[0]);
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
 * Check if a language is supported
 */
export function isLanguageSupported(language: Language): boolean {
  // Liquid uses custom regex-based extraction, not tree-sitter
  if (language === 'liquid') return true;
  return language !== 'unknown' && language in GRAMMAR_MAP;
}

/**
 * Get all supported languages
 */
export function getSupportedLanguages(): Language[] {
  const languages = Object.keys(GRAMMAR_MAP) as Language[];
  // Add Liquid which uses custom extraction
  languages.push('liquid');
  return languages;
}

/**
 * Clear the parser cache (useful for testing)
 */
export function clearParserCache(): void {
  parserCache.clear();
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
    liquid: 'Liquid',
    unknown: 'Unknown',
  };
  return names[language] || language;
}
