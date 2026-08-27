import * as fs from 'fs';
import * as path from 'path';

const SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env(?:\s+-S)?\s+|(?:\/\S+\/)*)(?:ba|z|k|da)?sh(?:\s|$)/i;

const SHEBANG_SCAN_BYTES = 256;

export function looksLikeShellScript(source: string): boolean {
  const firstLine = source.slice(0, SHEBANG_SCAN_BYTES).split(/\r?\n/, 1)[0] ?? '';
  return SHELL_SHEBANG.test(firstLine);
}

export function looksLikeShellScriptFile(filePath: string, rootDir: string): boolean {
  try {
    return looksLikeShellScript(fsReadPrefix(path.join(rootDir, filePath)));
  } catch {
    return false;
  }
}

function fsReadPrefix(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(SHEBANG_SCAN_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, SHEBANG_SCAN_BYTES, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}
