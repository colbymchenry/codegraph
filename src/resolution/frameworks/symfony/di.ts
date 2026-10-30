export function isContainerFilePath(filePath: string, content: string): boolean {
  // The kernel's build dir (`var/cache/<env>/Container…/`), not any `Cache/` source folder.
  const containerPathPattern = /(?:^|[\\/])(?:var[\\/]cache|\.symfony)[\\/].*(?:Container|App_Kernel).*\.php$/;
  if (!containerPathPattern.test(filePath)) return false;
  if (content.includes('Container') || content.includes('App_Kernel')) return true;
  return /class\s+\w+Container\s+extends\s/.test(content.slice(0, 500));
}
