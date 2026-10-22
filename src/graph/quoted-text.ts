import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type CodeGraph from '../index';
import type { Language } from '../types';

export function quotedPhrases(query: string): { phrases: string[]; truncated: boolean; remainder: string } {
  const phrases: string[] = [];
  let count = 0;
  const remainder = query.replace(/"((?:\\.|[^"\\])*)"|(?<!\w)'((?:\\.|[^'\\])*)'|\u201c([^\u201d]*)\u201d|\u2018([^\u2019]*)\u2019/g, (span, double: string | undefined, single: string | undefined, smartDouble: string | undefined, smartSingle: string | undefined) => {
    let value = double ?? single ?? smartDouble ?? smartSingle ?? '';
    if (double !== undefined) { try { value = JSON.parse(span); } catch { return span; } }
    if (value.length < 2 || value.length > 160 || !/[\p{L}\p{N}]/u.test(value) || value.includes('\n') || value.includes('\r')) return span;
    if (!phrases.includes(value)) { count++; if (phrases.length < 8) phrases.push(value); }
    return ' ';
  });
  return { phrases, truncated: count > 8, remainder };
}

export interface QuotedTextOptions {
  directory?: string;
  languages?: Language[];
  maxFiles?: number;
  maxItems?: number;
  maxMatchingFiles?: number;
}
export interface QuotedTextMatch {
  phrase: string;
  filePath: string;
  line: number;
  column: number;
  source: string;
  sourceStartColumn: number;
}
export interface QuotedTextReport {
  phrases: string[];
  items: QuotedTextMatch[];
  total: number;
  eligibleFiles: number;
  scannedFiles: number;
  skippedFiles: string[];
  truncated: boolean;
}

export async function queryQuotedText(graph: CodeGraph, query: string, options: QuotedTextOptions = {}): Promise<QuotedTextReport> {
  const parsed = quotedPhrases(query);
  const maxFiles = options.maxFiles ?? 200;
  const maxItems = options.maxItems ?? 40;
  const maxMatchingFiles = options.maxMatchingFiles ?? 20;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 2000 || !Number.isInteger(maxItems) || maxItems < 0 || maxItems > 2000 || !Number.isInteger(maxMatchingFiles) || maxMatchingFiles < 1 || maxMatchingFiles > 2000) {
    throw new Error('maxFiles and maxMatchingFiles must be 1-2000; maxItems must be 0-2000.');
  }
  const directory = (options.directory ?? '').replaceAll('\\', '/').replace(/\/$/, '');
  const files = parsed.phrases.length ? graph.getFiles().filter(file => (!directory || file.path.startsWith(directory + '/'))
    && (!options.languages?.length || options.languages.includes(file.language))).sort((a, b) => a.path.localeCompare(b.path)) : [];
  const items: QuotedTextMatch[] = [];
  const shownFiles = new Set<string>();
  const skippedFiles: string[] = [];
  let total = 0; let scannedFiles = 0;
  const buffer = Buffer.alloc(256 * 1024 + 1);
  for (const file of files.slice(0, maxFiles)) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(path.join(graph.getProjectRoot(), file.path), 'r');
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 256 * 1024) { skippedFiles.push(file.path); continue; }
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
      scannedFiles++;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        for (const phrase of parsed.phrases) {
          let offset = 0; let column: number;
          while ((column = line.indexOf(phrase, offset)) !== -1) {
            total++; offset = column + Math.max(1, phrase.length);
            if (items.length >= maxItems || (!shownFiles.has(file.path) && shownFiles.size >= maxMatchingFiles)) continue;
            shownFiles.add(file.path);
            const start = Math.max(0, column - 80);
            items.push({ phrase, filePath: file.path, line: index + 1, column, source: line.slice(start, start + 400), sourceStartColumn: start });
          }
        }
      }
    } catch { skippedFiles.push(file.path); }
    finally { await handle?.close(); }
  }
  return { phrases: parsed.phrases, items, total, eligibleFiles: files.length, scannedFiles, skippedFiles, truncated: parsed.truncated || files.length > maxFiles || items.length < total };
}

export function renderQuotedText(report: QuotedTextReport, maxChars: number): string {
  let output = '**Quoted Text Evidence**\nText matches in current indexed source files; not call or runtime proof.\n';
  let shown = 0;
  for (const item of report.items) {
    const row = '\n' + JSON.stringify(item.phrase) + ' at ' + item.filePath + ':' + item.line + ':' + item.column + ' (snippet starts at column ' + item.sourceStartColumn + ')\n    ' + item.line + '\t' + item.source + '\n';
    if (output.length + row.length + 300 > maxChars) break;
    output += row; shown++;
  }
  output += '\nMatches in scanned subset: ' + report.total + '; shown: ' + shown + '; files scanned: ' + report.scannedFiles + '/' + report.eligibleFiles + '; skipped: ' + report.skippedFiles.length + '; truncated: ' + (report.truncated || shown < report.items.length) + '.\n';
  if (report.total === 0) output += 'No exact text match in the scanned subset.\n';
  return output;
}
