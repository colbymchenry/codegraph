/**
 * scip-typescript (https://github.com/sourcegraph/scip-typescript) for TS/JS.
 * Without a tsconfig.json it infers one (plain-JS projects); pnpm / yarn
 * workspaces are indexed per package.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IndexerSpec } from './index';

const has = (root: string, f: string) => fs.existsSync(path.join(root, f));

function hasWorkspaces(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { workspaces?: unknown };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

export const typescriptIndexer: IndexerSpec = {
  lang: 'typescript',
  tool: 'scip-typescript',
  codegraphLanguages: ['typescript', 'javascript', 'tsx', 'jsx'],
  detect: root => has(root, 'tsconfig.json') || has(root, 'jsconfig.json') || has(root, 'package.json'),
  cmd: 'scip-typescript',
  invocation(root, outFile) {
    const args = ['index', '--output', outFile];
    if (has(root, 'pnpm-workspace.yaml')) args.push('--pnpm-workspaces');
    else if (has(root, 'yarn.lock') && hasWorkspaces(root)) args.push('--yarn-workspaces');
    else if (!has(root, 'tsconfig.json')) args.push('--infer-tsconfig');
    return { args };
  },
};
