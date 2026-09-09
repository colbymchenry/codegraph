export function isContainerFilePath(filePath: string, content: string): boolean {
  const containerPathPattern = /(?:var[\\/]cache[\\/]|\.symfony[\\/]|cache[\\/]).*(?:Container|App_Kernel).*\.php$/i;
  if (!containerPathPattern.test(filePath)) return false;
  if (content.includes('Container') || content.includes('App_Kernel')) return true;
  return /class\s+\w+Container\s+extends\s/.test(content.slice(0, 500));
}
