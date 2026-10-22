import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type CodeGraph from '../index';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import { extractFieldContracts, type FieldContract } from './field-contracts';

export interface SerializationAliasOptions {
  externalName?: string;
  filePath?: string;
  maxFiles?: number;
  maxItems?: number;
}

export interface SerializationAliasReport {
  items: FieldContract[];
  total: number;
  scannedFiles: number;
  eligibleFiles: number;
  skippedFiles: string[];
  truncated: boolean;
}

export async function serializationAliases(graph: CodeGraph, options: SerializationAliasOptions = {}): Promise<SerializationAliasReport> {
  const maxFiles = options.maxFiles ?? 200;
  const maxItems = options.maxItems ?? 100;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 2000 || !Number.isInteger(maxItems) || maxItems < 0 || maxItems > 2000) {
    throw new Error('maxFiles must be 1-2000 and maxItems must be 0-2000.');
  }
  const files = graph.getFiles().filter(file => (file.language === 'rust' || file.language === 'go')
    && (!options.filePath || file.path === options.filePath)).sort((a, b) => a.path.localeCompare(b.path));
  await loadGrammarsForLanguages([...new Set(files.map(file => file.language!))]);
  const items: FieldContract[] = [];
  const skippedFiles: string[] = [];
  let scannedFiles = 0;
  let total = 0;
  for (const file of files.slice(0, maxFiles)) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(path.join(graph.getProjectRoot(), file.path), 'r');
      const buffer = Buffer.alloc(256 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 256 * 1024) { skippedFiles.push(file.path); continue; }
      const source = buffer.subarray(0, bytesRead).toString('utf8');
      const extracted = graph.extractFromSource(file.path, source);
      const contracts = extractFieldContracts(file.path, source, file.language!, extracted.nodes);
      if (!contracts || extracted.errors.some(error => error.severity === 'error')) { skippedFiles.push(file.path); continue; }
      scannedFiles++;
      for (const contract of contracts.contracts) {
        if (options.externalName !== undefined && contract.externalName !== options.externalName) continue;
        total++;
        if (items.length < maxItems) items.push(contract);
      }
    } catch { skippedFiles.push(file.path); }
    finally { await handle?.close(); }
  }
  return { items, total, scannedFiles, eligibleFiles: files.length, skippedFiles, truncated: files.length > maxFiles || total > items.length };
}
