import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadHdlProfile, type ActiveHdlProfile } from './profile';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { preprocessVerilog, type HdlPreprocessDiagnostic } from './preprocess';
import { detectLanguage } from '../extraction/grammars';
import { loadExtensionOverrides } from '../project-config';

export interface HdlDependency { path: string; sha256: string | null }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function inside(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('HDL path escapes project root');
  return relative.split(path.sep).join('/');
}

/** Immutable per-operation conditional source view. Original bytes remain file hashes/snippets. */
export class HdlIndexContext {
  readonly profile: ActiveHdlProfile | null;
  readonly diagnostics: HdlPreprocessDiagnostic[] = [];
  readonly dependencies: HdlDependency[];
  readonly fingerprint: string;
  readonly sources = new Map<string, { original: string; selected: string; stats: fs.Stats }>();
  readonly unitDiagnostics = new Map<string, HdlPreprocessDiagnostic[]>();
  private readonly root: string;
  private readonly overrides: ReturnType<typeof loadExtensionOverrides>;

  constructor(root: string, previouslyProfiled: boolean) {
    this.root = path.resolve(root);
    this.overrides = loadExtensionOverrides(root);
    const loaded = loadHdlProfile(root);
    if (loaded.status === 'invalid-profile' || (loaded.status === 'invalid-config' && previouslyProfiled)) {
      throw new Error(`Invalid HDL profile: ${loaded.diagnostics.join('; ')}`);
    }
    this.profile = loaded.profile;
    if (!this.profile) { this.dependencies = []; this.fingerprint = 'raw'; return; }
    this.root = fs.realpathSync(root);
    const dependency = new Map<string, string | null>();
    const bytes = new Map<string, string>();
    const snapshots = new Map<string, fs.Stats>();
    let total = 0;
    const read = (relative: string): string | null => {
      const lexical = path.resolve(this.root, relative);
      const normalized = inside(this.root, lexical);
      if (normalized.split('/').some(p => ['.git', '.jj', '.codegraph'].includes(p) || p.startsWith('.codegraph-'))) throw new Error('HDL profile cannot read VCS/index storage');
      if (bytes.has(normalized)) return bytes.get(normalized)!;
      try {
        inside(this.root, fs.realpathSync(lexical));
        const stat = fs.statSync(lexical);
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`HDL input is not a regular file of at most 1 MiB: ${normalized}`);
        const text = fs.readFileSync(lexical, 'utf8');
        const after = fs.statSync(lexical);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) {
          throw new Error(`HDL input changed while preparing snapshot; retry: ${normalized}`);
        }
        snapshots.set(normalized, after);
        total += Buffer.byteLength(text);
        if (total > 64 * 1024 * 1024) throw new Error('HDL profile source/dependency snapshot exceeds 64 MiB');
        bytes.set(normalized, text);
        return text;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    for (const file of this.profile.files) {
      if (detectLanguage(file, undefined, this.overrides) !== 'verilog') throw new Error(`HDL profile lists a non-HDL source: ${file}`);
      const source = read(file);
      if (source === null) throw new Error(`HDL source missing: ${file}`);
      const result = preprocessVerilog(source, { filePath: file, defines: this.profile.defines, includeDirs: this.profile.includeDirs,
        readInclude: (request, from, dirs) => {
          if (path.isAbsolute(request) || /^[A-Za-z]:[\\/]/.test(request)) throw new Error('Absolute HDL include paths are outside the supported project-relative profile');
          const candidates = [path.posix.join(path.posix.dirname(from), request), ...dirs.map(dir => path.posix.join(dir, request))];
          for (const candidate of [...new Set(candidates)]) {
            const relative = inside(this.root, path.resolve(this.root, candidate));
            const text = read(relative);
            dependency.set(relative, text === null ? null : hash(text));
            if (text !== null) return { filePath: relative, source: text };
          }
          return null;
        } });
      if (result.source.length !== source.length) throw new Error('HDL conditional selection changed source offsets');
      this.sources.set(file, { original: source, selected: result.source, stats: snapshots.get(file)! });
      const diagnostics = result.diagnostics.slice(0, 32);
      if (result.diagnostics.length > diagnostics.length) diagnostics.push({ filePath: file, line: 1,
        code: 'diagnostic-limit', message: `${result.diagnostics.length - diagnostics.length} additional preprocessing diagnostics omitted for this unit.` });
      this.unitDiagnostics.set(file, diagnostics);
      this.diagnostics.push(...diagnostics.slice(0, Math.max(0, 200 - this.diagnostics.length)));
    }
    this.dependencies = [...dependency].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 }));
    this.fingerprint = hash(JSON.stringify([EXTRACTION_VERSION, this.profile.fingerprint, this.dependencies]));
  }

  isHdl(file: string): boolean { return detectLanguage(file, undefined, this.overrides) === 'verilog'; }
  accepts(file: string): boolean { return !this.profile || !this.isHdl(file) || this.sources.has(file); }
  files(scanned: string[]): string[] {
    return this.profile ? [...scanned.filter(file => !this.isHdl(file)), ...this.profile.files] : scanned;
  }
  source(file: string, original: string): string {
    if (!this.profile || !this.isHdl(file)) return original;
    const cached = this.sources.get(file);
    if (!cached) throw new Error(`HDL source is outside active profile: ${file}`);
    if (cached.original !== original) throw new Error(`HDL source changed during profile preparation; retry indexing: ${file}`);
    return cached.selected;
  }
  context(): string {
    return JSON.stringify(this.profile ? { mode: 'profile', configurationFingerprint: this.profile.fingerprint,
      files: this.profile.files, includeDirs: this.profile.includeDirs, defines: this.profile.defines,
      topModules: this.profile.topModules, languageMode: this.profile.languageMode,
      dependencies: this.dependencies, unitDiagnostics: Object.fromEntries(this.unitDiagnostics), diagnostics: this.diagnostics.slice(0, 200),
      diagnosticCount: this.diagnostics.length, incomplete: this.diagnostics.length > 0,
    } : { mode: 'raw' });
  }
}

/** Include changes can invalidate a profile even when codegraph.json is unchanged. */
export function hdlDependenciesChanged(root: string, context: string | null): boolean {
  let value: unknown;
  try { value = context ? JSON.parse(context) : null; } catch { return true; }
  if (!value || typeof value !== 'object' || !('dependencies' in value) || !Array.isArray(value.dependencies)) return false;
  const canonicalRoot = fs.realpathSync(root);
  return value.dependencies.some((entry: HdlDependency) => {
    if (!entry || typeof entry.path !== 'string') return true;
    try {
      const full = path.resolve(canonicalRoot, entry.path);
      inside(canonicalRoot, full); inside(canonicalRoot, fs.realpathSync(full));
      const stat = fs.statSync(full);
      return !stat.isFile() || stat.size > 1024 * 1024 || hash(fs.readFileSync(full, 'utf8')) !== entry.sha256;
    } catch { return entry.sha256 !== null; }
  });
}
