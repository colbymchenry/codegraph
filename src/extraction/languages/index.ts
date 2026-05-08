/**
 * Per-language extraction configurations.
 *
 * Each file exports a LanguageExtractor config object.
 * This barrel builds the EXTRACTORS map consumed by TreeSitterExtractor.
 */

import { Language } from '../../types';
import type { LanguageExtractor } from '../tree-sitter-types';

import { typescriptExtractor } from './typescript';
import { javascriptExtractor } from './javascript';
import { pythonExtractor } from './python';
import { goExtractor } from './go';
import { rustExtractor } from './rust';
import { javaExtractor } from './java';
import { cExtractor, cppExtractor } from './c-cpp';
import { csharpExtractor } from './csharp';
import { phpExtractor } from './php';
import { rubyExtractor } from './ruby';
import { swiftExtractor } from './swift';
import { kotlinExtractor } from './kotlin';
import { dartExtractor } from './dart';
import { pascalExtractor } from './pascal';

export const EXTRACTORS: Partial<Record<Language, LanguageExtractor>> = {
  typescript: typescriptExtractor,
  tsx: typescriptExtractor,
  javascript: javascriptExtractor,
  jsx: javascriptExtractor,
  python: pythonExtractor,
  go: goExtractor,
  rust: rustExtractor,
  java: javaExtractor,
  c: cExtractor,
  cpp: cppExtractor,
  csharp: csharpExtractor,
  php: phpExtractor,
  ruby: rubyExtractor,
  swift: swiftExtractor,
  kotlin: kotlinExtractor,
  dart: dartExtractor,
  pascal: pascalExtractor,
};
