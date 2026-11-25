/**
 * The MSBuild projects of a .NET repository, as far as C# and Razor names of
 * F# declarations depend on them: which project a C# or Razor file belongs
 * to and what that project brings into every file (`<Using>`, the root
 * namespace), which F# projects compile an F# file, and which projects a
 * project references. A C# compilation sees the declarations of the
 * assemblies it references, directly or through a referenced project, and no
 * others.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fsprojCompileItems, msbuildProjectReferences, msbuildRootNamespace, msbuildUsings, type MsbuildUsing } from './msbuild';
import type { ResolutionContext } from './types';

/** What an MSBuild project says about the names its C# and Razor files can write. */
export interface DotnetProject {
  /** The nearest `.csproj` at or above a file, project-relative; null with none. */
  file: string | null;
  /** The folder of `file`, project-relative (`''` for the repository root); null with none. */
  dir: string | null;
  /** The namespace a file at the project's top is in when it names none. */
  rootNamespace: string;
  /** The `<Using>` items of the project and of the `.props` files above it. */
  usings: MsbuildUsing[];
}

interface ProjectIndex {
  /** By folder, project-relative. */
  projects: Map<string, DotnetProject>;
  /** The `.fsproj` files whose compile items list each F# file. */
  compiledBy: Map<string, Set<string>> | null;
  /** Each project file and those it references, directly or through another. */
  referenced: Map<string, ReadonlySet<string>>;
  /** Each project file's text. */
  texts: Map<string, string>;
}

const INDEXES = new WeakMap<ResolutionContext, ProjectIndex>();

function indexOf(context: ResolutionContext): ProjectIndex {
  let index = INDEXES.get(context);
  if (!index) INDEXES.set(context, (index = { projects: new Map(), compiledBy: null, referenced: new Map(), texts: new Map() }));
  return index;
}

/** Forget what was read from project files; called when the resolver drops its caches. */
export function clearDotnetProjects(context: ResolutionContext): void {
  INDEXES.delete(context);
}

function listDir(root: string, dir: string): string[] {
  try {
    return fs.readdirSync(path.join(root, dir));
  } catch {
    return [];
  }
}

function projectText(file: string, context: ResolutionContext): string {
  const index = indexOf(context);
  let text = index.texts.get(file);
  if (text === undefined) {
    try {
      text = fs.readFileSync(path.join(context.getProjectRoot(), file), 'utf8');
    } catch {
      text = '';
    }
    index.texts.set(file, text);
  }
  return text;
}

function joinRelative(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function parentDir(dir: string): string {
  return dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
}

/** The folder of a project-relative file. */
function dirOf(file: string): string {
  return file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
}

/** The project the files of folder `dir` (project-relative) belong to. */
export function dotnetProjectOf(dir: string, context: ResolutionContext): DotnetProject {
  const projects = indexOf(context).projects;
  const key = dir === '.' ? '' : dir;
  const cached = projects.get(key);
  if (cached) return cached;
  const root = context.getProjectRoot();
  const parent = key === '' ? null : dotnetProjectOf(parentDir(key), context);
  const entries = listDir(root, key).sort();
  const usings = [...(parent?.usings ?? [])];
  for (const entry of entries) if (/\.props$/i.test(entry)) usings.push(...msbuildUsings(projectText(joinRelative(key, entry), context)));
  const csproj = entries.find((e) => /\.csproj$/i.test(e));
  let project: DotnetProject;
  if (csproj !== undefined) {
    const file = joinRelative(key, csproj);
    const xml = projectText(file, context);
    usings.push(...msbuildUsings(xml));
    const rootNamespace = msbuildRootNamespace(xml) ?? csproj.replace(/\.csproj$/i, '').replace(/[^\w.]/g, '_');
    project = { file, dir: key, rootNamespace, usings };
  } else {
    project = { file: parent?.file ?? null, dir: parent?.dir ?? null, rootNamespace: parent?.rootNamespace ?? '', usings };
  }
  projects.set(key, project);
  return project;
}

/** The namespace Razor gives a component in folder `dir` that no `@namespace` names: the project's root namespace, then the folders below the project. */
export function razorRootNamespace(dir: string, context: ResolutionContext): string {
  const project = dotnetProjectOf(dir, context);
  if (project.dir === null) return '';
  const below = dir === project.dir ? '' : dir.slice(project.dir === '' ? 0 : project.dir.length + 1);
  const folders = below === '' ? [] : below.split('/').map((f) => f.replace(/[^\w]/g, '_'));
  return [project.rootNamespace, ...folders].filter((p) => p !== '').join('.');
}

/** The `.fsproj` files in the folders at and above each F# file, and the F# files each compiles. */
function compiledBy(context: ResolutionContext): Map<string, Set<string>> {
  const index = indexOf(context);
  if (index.compiledBy) return index.compiledBy;
  const byFile = new Map<string, Set<string>>();
  const root = context.getProjectRoot();
  const seenDirs = new Set<string>();
  for (const file of context.getFilePathsOfLanguage?.('fsharp') ?? []) {
    for (let dir = dirOf(file); !seenDirs.has(dir); dir = parentDir(dir)) {
      seenDirs.add(dir);
      for (const entry of listDir(root, dir)) {
        if (!/\.fsproj$/i.test(entry)) continue;
        const project = joinRelative(dir, entry);
        for (const item of fsprojCompileItems(projectText(project, context))) {
          const listed = path.posix.normalize(joinRelative(dir, item));
          let owners = byFile.get(listed);
          if (!owners) byFile.set(listed, (owners = new Set()));
          owners.add(project);
        }
      }
      if (dir === '') break;
    }
  }
  index.compiledBy = byFile;
  return byFile;
}

/** Project file `project` and every project it references, directly or through a referenced one. */
function referencedFrom(project: string, context: ResolutionContext): ReadonlySet<string> {
  const index = indexOf(context);
  const cached = index.referenced.get(project);
  if (cached) return cached;
  const seen = new Set<string>();
  const pending = [project];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const reference of msbuildProjectReferences(projectText(next, context))) {
      pending.push(path.posix.normalize(joinRelative(dirOf(next), reference)));
    }
  }
  index.referenced.set(project, seen);
  return seen;
}

/**
 * Whether the C# or Razor code of file `from` can see what F# file `fsharpFile`
 * declares: its project references a project that compiles the file. Where
 * the code is in no project, or no project compiles the F# file, nothing says
 * which assemblies meet, and it can.
 */
export function isFsharpFileVisibleFrom(fsharpFile: string, from: string, context: ResolutionContext): boolean {
  const project = dotnetProjectOf(dirOf(from), context).file;
  if (project === null) return true;
  const owners = compiledBy(context).get(fsharpFile);
  if (!owners || owners.size === 0) return true;
  const seen = referencedFrom(project, context);
  for (const owner of owners) if (seen.has(owner)) return true;
  return false;
}

/**
 * The project files that decide what C# and Razor code sees of F#,
 * project-relative: the `.csproj` and `.props` files in the folders at and
 * above each C# and Razor file. The `.fsproj` files are F#'s own
 * (`fsharpConfigFiles`).
 */
export function dotnetProjectFiles(context: ResolutionContext): string[] {
  const root = context.getProjectRoot();
  const out = new Set<string>();
  const seenDirs = new Set<string>();
  const files = [...(context.getFilePathsOfLanguage?.('csharp') ?? []), ...(context.getFilePathsOfLanguage?.('razor') ?? [])];
  for (const file of files) {
    for (let dir = dirOf(file); !seenDirs.has(dir); dir = parentDir(dir)) {
      seenDirs.add(dir);
      for (const entry of listDir(root, dir)) if (/\.(csproj|props)$/i.test(entry)) out.add(joinRelative(dir, entry));
      if (dir === '') break;
    }
  }
  return [...out];
}
