import * as path from 'node:path';
import { loadHdlProfile, isReservedHdlPath, type ActiveHdlProfile } from '../hdl/profile';

/** Watch inputs to a selected HDL profile, including files outside the ordinary source filter.
 * Retain the last valid scope after a transient deletion/invalid config so a repair is observable. */
export class HdlWatchScope {
  private profile: ActiveHdlProfile | null = null;
  private files = new Set<string>();
  private filelists = new Set<string>();
  private includeDirs: string[] = [];
  private sourceDirs = new Set<string>();
  private identity = '';
  constructor(private readonly root: string, private readonly getDependencies?: () => string[]) {}
  refresh(): boolean {
    const loaded = loadHdlProfile(this.root);
    if (loaded.status === 'active') this.profile = loaded.profile;
    else if (loaded.status === 'none') this.profile = null;
    const profile = this.profile;
    const files = new Set(profile?.files ?? []);
    this.filelists = new Set(profile?.dependencies.map(d => d.path) ?? []);
    for (const file of this.filelists) files.add(file);
    const dependencies = profile ? this.getDependencies?.() : [];
    if (Array.isArray(dependencies)) for (const file of dependencies) {
      if (typeof file !== 'string') continue;
      const rel = path.relative(this.root, path.resolve(this.root, file)).split(path.sep).join('/');
      if (rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel) && !isReservedHdlPath(rel)) files.add(rel);
    }
    this.files = files;
    this.includeDirs = profile?.includeDirs ?? [];
    this.sourceDirs = new Set(profile?.files.map(file => path.posix.dirname(file)) ?? []);
    const identity = JSON.stringify([[...files].sort(), [...this.filelists].sort(), this.includeDirs, [...this.sourceDirs].sort()]);
    const changed = identity !== this.identity;
    this.identity = identity;
    return changed;
  }
  isFilelist(rel: string): boolean { return this.filelists.has(rel); }
  matchesFile(rel: string): boolean {
    if (isReservedHdlPath(rel)) return false;
    return this.files.has(rel) || this.sourceDirs.has(path.posix.dirname(rel))
      || this.includeDirs.some(dir => dir === '.' || rel.startsWith(`${dir}/`));
  }
  matchesDirectory(rel: string): boolean {
    if (!this.profile || isReservedHdlPath(rel)) return false;
    return [...this.files].some(file => file.startsWith(`${rel}/`))
      || this.includeDirs.some(dir => dir === '.' || dir === rel || dir.startsWith(`${rel}/`) || rel.startsWith(`${dir}/`));
  }
}
