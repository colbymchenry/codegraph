/**
 * `when` on a wire edge — the branch conditions its call site sits under,
 * read from the source at request time (see `src/graph/branch-guards.ts`).
 *
 * The viewer groups a symbol's edges into relations; this annotates the edges
 * of a set of relations in one pass, parsing each file once. Files that
 * drifted since the index sync are skipped: the recorded line no longer
 * reliably points at the call, and a label at the wrong line is worse than
 * none. The pass is bounded so a hub with hundreds of callers cannot turn one
 * Symbol view into a parse of the repository.
 */

import * as fs from 'fs';
import type CodeGraph from '../../index';
import type { Language } from '../../types';
import {
  callArgumentsForFile,
  callSitesForFile,
  decoratorsForFile,
  guardLabel,
  guardsForFile,
  loopsForFile,
  memberTypesForFile,
  siteKey,
  supportsBranchGuards,
  triggersForFile,
  type BranchGuard,
  type CallSiteText,
  type DefinitionDecorators,
  type SiteLoop,
  type SiteTrigger,
} from '../../graph/branch-guards';
import { resolveProjectFile } from '../security';
import { findIndexedFile, hasDriftedOnDisk } from './source';
import type { WireEdge } from './wire';

/** Distinct files parsed per request, and sites labelled per request. */
const MAX_FILES = 24;
const MAX_SITES = 400;

/**
 * Wall-clock allowance for the whole pass. The Symbol view answers in under
 * 100 ms; batches are taken in order (the focal file first), and once the
 * budget is spent the remaining rails simply carry no `when`. The parsed
 * trees are cached, so the next view of the same neighbourhood is cheaper.
 */
const BUDGET_MS = 40;

export interface WhenBatch {
  /** POSIX project-relative path of the file the call sites are in. */
  file: string;
  edges: WireEdge[];
}

export async function annotateWhen(cg: CodeGraph, projectRoot: string, batches: readonly WhenBatch[]): Promise<void> {
  const byFile = new Map<string, WireEdge[]>();
  for (const batch of batches) {
    const bucket = byFile.get(batch.file);
    if (bucket) bucket.push(...batch.edges);
    else byFile.set(batch.file, [...batch.edges]);
  }
  let files = 0;
  let sites = 0;
  const started = Date.now();
  for (const [file, edges] of byFile) {
    if (files >= MAX_FILES || sites >= MAX_SITES) return;
    if (files > 0 && Date.now() - started > BUDGET_MS) return;
    const found = findIndexedFile(cg, file);
    if (!found || !supportsBranchGuards(found.record.language)) continue;
    if (hasDriftedOnDisk(projectRoot, found.storedPath, found.record)) continue;
    let abs: string;
    try {
      abs = resolveProjectFile(projectRoot, found.storedPath);
    } catch {
      continue;
    }
    const withLine = edges.filter((e) => typeof e.line === 'number' && e.line > 0);
    if (withLine.length === 0) continue;
    files++;
    sites += withLine.length;
    const guards = await guardsForFile(
      abs,
      found.record.language as Language,
      withLine.map((e) => ({ line: e.line!, column: typeof e.col === 'number' ? e.col : null }))
    );
    for (const edge of withLine) {
      const g = guards.get(siteKey({ line: edge.line!, column: typeof edge.col === 'number' ? edge.col : null }));
      const label = g ? guardLabel(g) : '';
      if (label) edge.when = label;
    }
  }
}

/**
 * A per-request reader of the conditions ONE call site sits under, for the
 * endpoints that walk chains rather than annotate rails (the Screens view's
 * transitions, the Steps view's links). Files are resolved once, drifted
 * files yield no label, and the count of sites labelled is bounded so a wide
 * walk cannot turn one request into a parse of the repository.
 */
export interface SiteReader {
  /** The conditions the site runs under, joined; '' when unconditional or unreadable. */
  when(caller: { filePath: string; language: Language }, site: { line?: number; column?: number }): Promise<string>;
  /**
   * The same conditions, outermost first, unjoined — each with the branching
   * construct it belongs to, so two sites can be told to be the two arms of
   * ONE `if` rather than two conditions that happen to read as opposites.
   * What {@link SiteReader.when} joins; empty when unconditional or unreadable.
   */
  guards(caller: { filePath: string; language: Language }, site: { line?: number; column?: number }): Promise<BranchGuard[]>;
  /** The loops the site is written inside, outermost first — a run of calls that happens once per item. */
  loops(caller: { filePath: string; language: Language }, site: { line?: number; column?: number }): Promise<SiteLoop[]>;
  /** What the site passes, abbreviated (`'userEmail', values.email`); null when unreadable. '' for an empty list. */
  args(caller: { filePath: string; language: Language }, site: { line?: number; column?: number }): Promise<string | null>;
  /** What fires the site — the JSX prop, `on*` option or runs-later call it is written under; null when nothing binds it. */
  trigger(caller: { filePath: string; language: Language }, site: { line?: number; column?: number }): Promise<SiteTrigger | null>;
  /** The call as written (the whole member chain) and what it passes; null when unreadable. `callee` names the call when a position is shared. */
  callSite(caller: { filePath: string; language: Language }, site: { line?: number; column?: number; callee?: string }): Promise<CallSiteText | null>;
  /** The decorators / annotations / attributes on a definition, and on its class; null when unreadable. */
  decorators(definition: { filePath: string; language: Language; startLine: number }): Promise<DefinitionDecorators | null>;
  /** The declared types of the members of the class a definition belongs to, by member name; empty when unreadable. */
  memberTypes(definition: { filePath: string; language: Language; startLine: number }): Promise<Map<string, string>>;
  /**
   * The `'use server'` / `'use client'` directive a JS-family file opens with,
   * and whether the definition itself opens with `'use server'` (a server
   * action declared inline). Nothing for other languages or unreadable files.
   */
  directive(definition: { filePath: string; language: Language; startLine: number }): Promise<{ file: 'server' | 'client' | null; own: boolean }>;
}

const JS_FAMILY: ReadonlySet<string> = new Set(['javascript', 'typescript', 'tsx', 'jsx']);
/** A file read for its directives, at most. */
const MAX_DIRECTIVE_FILE = 512 * 1024;
const FILE_DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use (server|client)\1/;
const OWN_DIRECTIVE = /^\s*(['"])use server\1\s*;?\s*$/m;

/**
 * Both readings of one call site — WHEN it runs and WITH WHAT — for the
 * endpoints that walk chains (Screens, Steps). One file resolution and one
 * parsed tree serve both; drifted files yield nothing; one site budget bounds
 * the whole pass.
 */
export function createSiteReader(cg: CodeGraph, projectRoot: string, maxSites = 600): SiteReader {
  const files = new Map<string, { abs: string; language: Language } | null>();
  const texts = new Map<string, string | null>();
  let sites = 0;
  const resolve = (caller: { filePath: string; language: Language }): { abs: string; language: Language } | null => {
    const posix = caller.filePath.replace(/\\/g, '/');
    let file = files.get(posix);
    if (file === undefined) {
      file = null;
      const found = findIndexedFile(cg, posix);
      if (found && !hasDriftedOnDisk(projectRoot, found.storedPath, found.record)) {
        try {
          file = { abs: resolveProjectFile(projectRoot, found.storedPath), language: found.record.language as Language };
        } catch {
          file = null;
        }
      }
      files.set(posix, file);
    }
    return file;
  };
  // Named rather than a method, because `createWhenReader` hands `when` out
  // detached: it must not depend on `this`.
  const guards = async (
    caller: { filePath: string; language: Language },
    site: { line?: number; column?: number }
  ): Promise<BranchGuard[]> => {
    if (!site.line || sites >= maxSites || !supportsBranchGuards(caller.language)) return [];
    const file = resolve(caller);
    if (!file) return [];
    sites++;
    const key = { line: site.line, column: typeof site.column === 'number' ? site.column : null };
    return (await guardsForFile(file.abs, file.language, [key])).get(siteKey(key)) ?? [];
  };
  return {
    guards,
    async when(caller, site) {
      return guardLabel(await guards(caller, site));
    },
    async loops(caller, site) {
      // Not counted against the budget: the tree is parsed for the site's
      // guards anyway, and this is a second climb up the same nodes.
      if (!site.line || !supportsBranchGuards(caller.language)) return [];
      const file = resolve(caller);
      if (!file) return [];
      const key = { line: site.line, column: typeof site.column === 'number' ? site.column : null };
      return (await loopsForFile(file.abs, file.language, [key])).get(siteKey(key)) ?? [];
    },
    async args(caller, site) {
      if (!site.line || sites >= maxSites || !supportsBranchGuards(caller.language)) return null;
      const file = resolve(caller);
      if (!file) return null;
      sites++;
      const key = { line: site.line, column: typeof site.column === 'number' ? site.column : null };
      return (await callArgumentsForFile(file.abs, file.language, [key])).get(siteKey(key)) ?? null;
    },
    async trigger(caller, site) {
      // Not counted against the budget: the tree is already parsed for the
      // site's guards, and a trigger lookup is a walk up from one node.
      if (!site.line || !supportsBranchGuards(caller.language)) return null;
      const file = resolve(caller);
      if (!file) return null;
      const key = { line: site.line, column: typeof site.column === 'number' ? site.column : null };
      return (await triggersForFile(file.abs, file.language, [key])).get(siteKey(key)) ?? null;
    },
    async callSite(caller, site) {
      if (!site.line || sites >= maxSites || !supportsBranchGuards(caller.language)) return null;
      const file = resolve(caller);
      if (!file) return null;
      sites++;
      const key = { line: site.line, column: typeof site.column === 'number' ? site.column : null, ...(site.callee ? { callee: site.callee } : {}) };
      return (await callSitesForFile(file.abs, file.language, [key])).get(siteKey(key)) ?? null;
    },
    async decorators(definition) {
      // Not counted: one lookup per step, on a tree the walk has parsed anyway.
      if (!definition.startLine || !supportsBranchGuards(definition.language)) return null;
      const file = resolve(definition);
      if (!file) return null;
      return (await decoratorsForFile(file.abs, file.language, [definition.startLine])).get(definition.startLine) ?? null;
    },
    async memberTypes(definition) {
      if (!definition.startLine || !supportsBranchGuards(definition.language)) return new Map();
      const file = resolve(definition);
      if (!file) return new Map();
      return memberTypesForFile(file.abs, file.language, definition.startLine);
    },
    async directive(definition) {
      // Not counted: a text read, cached per file, no tree.
      const none = { file: null, own: false } as const;
      if (!JS_FAMILY.has(definition.language)) return none;
      const file = resolve(definition);
      if (!file) return none;
      let text = texts.get(file.abs);
      if (text === undefined) {
        try {
          text = fs.statSync(file.abs).size <= MAX_DIRECTIVE_FILE ? fs.readFileSync(file.abs, 'utf8') : null;
        } catch {
          text = null;
        }
        texts.set(file.abs, text);
      }
      if (text === null) return none;
      const head = FILE_DIRECTIVE.exec(text);
      const fileDirective = head ? (head[2] as 'server' | 'client') : null;
      let own = false;
      if (definition.startLine > 0) {
        const lines = text.split('\n');
        own = OWN_DIRECTIVE.test(lines.slice(definition.startLine - 1, definition.startLine + 3).join('\n'));
      }
      return { file: fileDirective, own };
    },
  };
}

/** The `when` half of {@link createSiteReader}, for callers that read nothing else. */
export function createWhenReader(
  cg: CodeGraph,
  projectRoot: string,
  maxSites = 600
): (caller: { filePath: string; language: Language }, site: { line?: number; column?: number }) => Promise<string> {
  return createSiteReader(cg, projectRoot, maxSites).when;
}
