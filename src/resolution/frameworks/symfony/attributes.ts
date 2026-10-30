function normalizeMethod(method: string): string {
  const trimmed = method.trim();
  if (!trimmed) return '';
  const dequoted = trimmed.replace(/^['"]|['"]$/g, '');
  if (dequoted.includes('::')) {
    const constName = dequoted.split('::').pop()!;
    return constName.replace(/^METHOD_/, '');
  }
  return dequoted.toUpperCase();
}

export function extractMethods(args: string): string[] {
  const methodsMatch = args.match(/methods:\s*\[([^\]]*)\]/);
  if (methodsMatch) {
    return methodsMatch[1]!.split(',').map(normalizeMethod).filter(Boolean);
  }
  return [];
}

export function extractName(args: string): string | null {
  const nameMatch = args.match(/\bname:\s*['"]([^'"]+)['"]/);
  return nameMatch ? nameMatch[1]! : null;
}

export function extractPath(args: string): string | null {
  const named = args.match(/\bpath:\s*['"]([^'"]*)['"]/);
  if (named) return named[1]!;
  const pos = args.match(/^['"]([^'"]*)['"]/);
  return pos ? pos[1]! : null;
}

/** The `[...]` array a named argument holds, nested brackets balanced. */
function extractDictPhpStyle(pattern: string, args: string): Record<string, string> | undefined {
  const head = new RegExp(`\\b${pattern}:\\s*\\[`).exec(args);
  if (!head) return undefined;
  const start = head.index + head[0].length;
  let depth = 1;
  let end = start;
  for (; end < args.length && depth > 0; end++) {
    if (args[end] === '[') depth++;
    else if (args[end] === ']') depth--;
  }
  return parsePhpArrayPairs(args.slice(start, end - 1));
}

/** `'key' => 'value'` and `'key' => 1` pairs of a PHP array literal. */
function parsePhpArrayPairs(inner: string): Record<string, string> | undefined {
  const pairs: Record<string, string> = {};
  const pairRe = /['"](\w[\w-]*)['"]\s*=>\s*(?:['"]([^'"]*)['"]|([\w.-]+))/g;
  let m;
  while ((m = pairRe.exec(inner)) !== null) {
    pairs[m[1]!] = (m[2] ?? m[3]!).trim();
  }
  return Object.keys(pairs).length > 0 ? pairs : undefined;
}

export function extractDefaults(args: string): Record<string, string> | undefined {
  return extractDictPhpStyle('defaults', args);
}

export function extractRequirements(args: string): Record<string, string> | undefined {
  return extractDictPhpStyle('requirements', args);
}

export function extractHost(args: string): string | undefined {
  const match = args.match(/\bhost:\s*['"]([^'"]+)['"]/);
  return match ? match[1]! : undefined;
}

export function extractSchemes(args: string): string[] | undefined {
  const match = args.match(/\bschemes:\s*\[([^\]]*)\]/);
  if (match) {
    const schemes = match[1]!.split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    return schemes.length > 0 ? schemes : undefined;
  }
  return undefined;
}
