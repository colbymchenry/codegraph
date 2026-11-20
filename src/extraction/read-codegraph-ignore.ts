/**
 * Reads `.codegraphignore` from `rootDir`: the same .gitignore syntax, read from whichever
 * directory buildDefaultIgnore reads `.gitignore` from (the project root, or an embedded repo's root),
 * so a project can exclude paths from the index without touching its git rules.
 * Parsing is the caller's reader; this file only finds the file.
 */
import * as fs from 'fs';
import * as path from 'path';

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The parsed rules of `<rootDir>/.codegraphignore`, or '' when there is no such file. */
export function readCodegraphIgnore(
  rootDir: string,
  parse: (file: string) => string,
  isFile: (p: string) => boolean = defaultIsFile
): string {
  const file = path.join(rootDir, '.codegraphignore');
  return isFile(file) ? parse(file) : '';
}
