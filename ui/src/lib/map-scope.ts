export function moduleTarget(module: { id: string; facade: boolean }): { kind: 'file' | 'directory' | 'root-files'; path: string } {
  if (module.facade) return { kind: 'file', path: module.id };
  if (module.id === '(root files)' || module.id.endsWith('/(root files)')) return { kind: 'root-files', path: module.id.replace(/(?:\/)?\(root files\)$/, '') };
  return { kind: 'directory', path: module.id };
}
