import * as path from 'path';
import type { ResolutionContext } from './types';
import { stripCommentsForRegex } from './strip-comments';

export const ZIG_BUILTIN_MODULES = new Set(['std', 'builtin', 'root']);

const MAX_BUILD_FILES = 512;
const TEST_PATH_RE = /(?:^|\/)(?:tests?|test_support)\/|test\.zig$/i;

interface ParsedFn {
  name: string;
  params: string[];
  retType: string;
  body: string;
}

interface FnTarget {
  file: string;
  fn: string;
  args: string[];
}

interface BuildRootCache {
  dirToBuildZig: Map<string, string | null>;
  parsedBuildZigs: Map<string, Map<string, string>>;
}

const buildCaches = new WeakMap<ResolutionContext, BuildRootCache>();

function getBuildCache(context: ResolutionContext): BuildRootCache {
  let cache = buildCaches.get(context);
  if (!cache) {
    cache = { dirToBuildZig: new Map(), parsedBuildZigs: new Map() };
    buildCaches.set(context, cache);
  }
  return cache;
}

function findNearestBuildZig(fromFile: string, context: ResolutionContext): string | null {
  const cache = getBuildCache(context);
  const norm = fromFile.replace(/\\/g, '/');
  const startDir = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
  if (cache.dirToBuildZig.has(startDir)) {
    return cache.dirToBuildZig.get(startDir) ?? null;
  }

  const visitedDirs: string[] = [];
  let dir = startDir;
  let found: string | null = null;
  while (true) {
    if (cache.dirToBuildZig.has(dir)) {
      found = cache.dirToBuildZig.get(dir) ?? null;
      break;
    }
    visitedDirs.push(dir);
    const candidate = dir ? `${dir}/build.zig` : 'build.zig';
    if (context.fileExists(candidate)) {
      found = candidate;
      break;
    }
    if (!dir) break;
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }

  for (const d of visitedDirs) {
    cache.dirToBuildZig.set(d, found);
  }
  return found;
}

function findMatchingDelim(src: string, openIdx: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < src.length) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < src.length && src[i] === q) i++;
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function splitTopLevelArgs(str: string): string[] {
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i]!;
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < str.length && str[i] !== q) {
        if (str[i] === '\\' && i + 1 < str.length) {
          i += 2;
          continue;
        }
        if (str[i] === '\n') break;
        i++;
      }
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      args.push(str.slice(start, i));
      start = i + 1;
    }
  }
  args.push(str.slice(start));
  return args;
}

function extractRootSourceExpr(block: string): { literal?: string; paramName?: string } | null {
  const lit =
    /\.root_source_file\s*=\s*(?:[A-Za-z_][\w.]*\.)?path\(\s*"([^"]+\.zig)"\s*\)/.exec(block) ??
    /\.source_file\s*=\s*\.\{\s*\.path\s*=\s*"([^"]+\.zig)"\s*\}/.exec(block);
  if (lit) return { literal: lit[1]! };
  const param = /\.root_source_file\s*=\s*(?:[A-Za-z_][\w.]*\.)?path\(\s*([A-Za-z_]\w*)\s*\)/.exec(block);
  if (param) return { paramName: param[1]! };
  return null;
}

function parseParamNames(paramList: string): string[] {
  return splitTopLevelArgs(paramList)
    .map((p) => {
      const m = /^\s*(?:comptime\s+)?([A-Za-z_]\w*)\s*:/.exec(p);
      return m ? m[1]! : '';
    })
    .filter((p) => p.length > 0);
}

function parseFunctions(src: string): ParsedFn[] {
  const fns: ParsedFn[] = [];
  const fnRe = /\b(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(src)) !== null) {
    const name = m[1]!;
    const parenOpen = m.index + m[0].length - 1;
    const parenEnd = findMatchingDelim(src, parenOpen, '(', ')');
    if (parenEnd < 0) continue;

    let idx = parenEnd + 1;
    let braceIdx = -1;
    while (idx < src.length) {
      const ch = src[idx]!;
      if (ch === ';') break;
      if (ch === '{') {
        const before = src.slice(Math.max(parenEnd + 1, idx - 32), idx);
        if (/\b(?:struct|enum|union)\s*(?:\([^)]*\)\s*)?$/.test(before)) {
          const close = findMatchingDelim(src, idx, '{', '}');
          if (close < 0) break;
          idx = close + 1;
          continue;
        }
        braceIdx = idx;
        break;
      }
      idx++;
    }
    if (braceIdx < 0) continue;
    const bodyEnd = findMatchingDelim(src, braceIdx, '{', '}');
    if (bodyEnd < 0) continue;
    fns.push({
      name,
      params: parseParamNames(src.slice(parenOpen + 1, parenEnd)),
      retType: src.slice(parenEnd + 1, braceIdx),
      body: src.slice(braceIdx + 1, bodyEnd),
    });
  }
  return fns;
}

function parseZigBuildGraph(buildZigPath: string, context: ResolutionContext): Map<string, string> {
  const buildRootDir = buildZigPath.includes('/') ? buildZigPath.slice(0, buildZigPath.lastIndexOf('/')) : '';
  const toProjectRel = (relFromBuildRoot: string): string | null => {
    const norm = path.posix.normalize(relFromBuildRoot.replace(/\\/g, '/'));
    if (norm.startsWith('..') || !norm.endsWith('.zig')) return null;
    const full = buildRootDir ? path.posix.normalize(`${buildRootDir}/${norm}`) : norm;
    if (full.startsWith('..')) return null;
    return context.fileExists(full) ? full : null;
  };

  const visited = new Map<string, string>();
  const queue: string[] = [buildZigPath];
  while (queue.length > 0 && visited.size < MAX_BUILD_FILES) {
    const filePath = queue.shift()!;
    if (visited.has(filePath)) continue;
    const raw = context.readFile(filePath);
    if (!raw) continue;
    const cleaned = stripCommentsForRegex(raw, 'zig');
    visited.set(filePath, cleaned);

    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const impRe = /@import\(\s*"([^"]+\.zig)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = impRe.exec(cleaned)) !== null) {
      const target = path.posix.normalize(dir ? `${dir}/${m[1]!}` : m[1]!);
      if (!target.startsWith('..') && !visited.has(target) && context.fileExists(target)) {
        queue.push(target);
      }
    }
  }

  const fileImports = new Map<string, Map<string, string>>();
  const fileFnImports = new Map<string, Map<string, { file: string; fn: string }>>();
  const fileFns = new Map<string, ParsedFn[]>();

  for (const [filePath, src] of visited) {
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
    const imps = new Map<string, string>();
    const fnImps = new Map<string, { file: string; fn: string }>();
    const impRe =
      /(?:^|[;{}])\s*(?:pub\s+)?const\s+([A-Za-z_]\w*)\s*=\s*@import\(\s*"([^"]+\.zig)"\s*\)(?:\.([A-Za-z_]\w*))?\s*(?=;)/gm;
    let m: RegExpExecArray | null;
    while ((m = impRe.exec(src)) !== null) {
      const target = path.posix.normalize(dir ? `${dir}/${m[2]!}` : m[2]!);
      if (m[3]) fnImps.set(m[1]!, { file: target, fn: m[3]! });
      else imps.set(m[1]!, target);
    }
    fileImports.set(filePath, imps);
    fileFnImports.set(filePath, fnImps);
    fileFns.set(filePath, parseFunctions(src));
  }

  const parseCallExpr = (filePath: string, expr: string): FnTarget | null => {
    const trimmed = expr.trim();
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';

    let targetFile: string | null = null;
    let targetFn: string | null = null;
    let openP = -1;

    let m = /^@import\(\s*"([^"]+\.zig)"\s*\)\.([A-Za-z_]\w*)\s*\(/.exec(trimmed);
    if (m) {
      targetFile = path.posix.normalize(dir ? `${dir}/${m[1]!}` : m[1]!);
      targetFn = m[2]!;
      openP = m[0].length - 1;
    } else if ((m = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/.exec(trimmed)) !== null) {
      targetFile = fileImports.get(filePath)?.get(m[1]!) ?? filePath;
      targetFn = m[2]!;
      openP = m[0].length - 1;
    } else if ((m = /^([A-Za-z_]\w*)\s*\(/.exec(trimmed)) !== null) {
      const fi = fileFnImports.get(filePath)?.get(m[1]!);
      targetFile = fi ? fi.file : filePath;
      targetFn = fi ? fi.fn : m[1]!;
      openP = m[0].length - 1;
    }

    if (!targetFile || !targetFn || openP < 0) return null;
    const closeP = findMatchingDelim(trimmed, openP, '(', ')');
    if (closeP < 0) return null;
    return {
      file: targetFile,
      fn: targetFn,
      args: splitTopLevelArgs(trimmed.slice(openP + 1, closeP)),
    };
  };

  const fnLocals = new Map<string, Map<string, string>>();
  const fnReturnPath = new Map<string, string>();
  const fnReturnParamIdx = new Map<string, number>();
  const fnDelegates = new Map<string, FnTarget>();
  const fnStructReturn = new Map<string, Map<string, string>>();
  const fileVarPaths = new Map<string, Map<string, Set<string>>>();

  const recordFileVar = (filePath: string, varName: string, modPath: string) => {
    let fv = fileVarPaths.get(filePath);
    if (!fv) {
      fv = new Map();
      fileVarPaths.set(filePath, fv);
    }
    let set = fv.get(varName);
    if (!set) {
      set = new Set();
      fv.set(varName, set);
    }
    set.add(modPath);
  };

  for (const [filePath, fns] of fileFns) {
    for (const fn of fns) {
      const key = `${filePath}::${fn.name}`;
      const locals = new Map<string, string>();
      const localParamIdx = new Map<string, number>();
      fnLocals.set(key, locals);

      const bindRe =
        /\bconst\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:[A-Za-z_][\w.]*\.)?(createModule|addModule)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = bindRe.exec(fn.body)) !== null) {
        const varName = m[1]!;
        const openP = m.index + m[0].length - 1;
        const closeP = findMatchingDelim(fn.body, openP, '(', ')');
        if (closeP < 0) continue;
        const expr = extractRootSourceExpr(fn.body.slice(openP, closeP + 1));
        if (expr?.literal) {
          locals.set(varName, expr.literal);
          recordFileVar(filePath, varName, expr.literal);
        } else if (expr?.paramName) {
          const idx = fn.params.indexOf(expr.paramName);
          if (idx >= 0) localParamIdx.set(varName, idx);
        }
      }

      if (fn.retType.includes('Module') && !fn.retType.includes('struct')) {
        const retCreate = /\breturn\s+(?:[A-Za-z_][\w.]*\.)?createModule\s*\(/.exec(fn.body);
        if (retCreate) {
          const openP = retCreate.index + retCreate[0].length - 1;
          const closeP = findMatchingDelim(fn.body, openP, '(', ')');
          if (closeP >= 0) {
            const expr = extractRootSourceExpr(fn.body.slice(openP, closeP + 1));
            if (expr?.literal) {
              fnReturnPath.set(key, expr.literal);
            } else if (expr?.paramName) {
              const idx = fn.params.indexOf(expr.paramName);
              if (idx >= 0) fnReturnParamIdx.set(key, idx);
            }
          }
          continue;
        }

        const retVar = /\breturn\s+([A-Za-z_]\w*)\s*;/.exec(fn.body);
        if (retVar) {
          if (locals.has(retVar[1]!)) {
            fnReturnPath.set(key, locals.get(retVar[1]!)!);
            continue;
          }
          if (localParamIdx.has(retVar[1]!)) {
            fnReturnParamIdx.set(key, localParamIdx.get(retVar[1]!)!);
            continue;
          }
        }

        const retCallMatch = /\breturn\s+([^;]+);/.exec(fn.body);
        if (retCallMatch) {
          const callTarget = parseCallExpr(filePath, retCallMatch[1]!);
          if (callTarget) {
            fnDelegates.set(key, callTarget);
            continue;
          }
        }

        let createCount = 0;
        let singlePath: string | null = null;
        const anyCreateRe = /\bcreateModule\s*\(/g;
        while ((m = anyCreateRe.exec(fn.body)) !== null) {
          createCount++;
          const openP = m.index + m[0].length - 1;
          const closeP = findMatchingDelim(fn.body, openP, '(', ')');
          if (closeP < 0) continue;
          const expr = extractRootSourceExpr(fn.body.slice(openP, closeP + 1));
          if (expr?.literal) singlePath = expr.literal;
        }
        if (createCount === 1 && singlePath) {
          fnReturnPath.set(key, singlePath);
        }
      }
    }
  }

  const resolveCallToPath = (callTarget: FnTarget): string | null => {
    const targetKey = `${callTarget.file}::${callTarget.fn}`;
    const direct = fnReturnPath.get(targetKey);
    if (direct) return direct;
    const paramIdx = fnReturnParamIdx.get(targetKey);
    if (paramIdx !== undefined) {
      const arg = callTarget.args[paramIdx];
      const strMatch = arg ? /^\s*"([^"]+\.zig)"\s*$/.exec(arg) : null;
      if (strMatch) return strMatch[1]!;
    }
    return null;
  };

  for (let pass = 0; pass < 4; pass++) {
    for (const [key, callTarget] of fnDelegates) {
      if (fnReturnPath.has(key)) continue;
      const resolved = resolveCallToPath(callTarget);
      if (resolved) fnReturnPath.set(key, resolved);
    }
  }

  for (const [filePath, fns] of fileFns) {
    for (const fn of fns) {
      const key = `${filePath}::${fn.name}`;
      const locals = fnLocals.get(key)!;
      const bindRe = /\bconst\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*([^;]+);/g;
      let m: RegExpExecArray | null;
      while ((m = bindRe.exec(fn.body)) !== null) {
        const varName = m[1]!;
        if (locals.has(varName)) continue;
        const callTarget = parseCallExpr(filePath, m[2]!);
        const resolved = callTarget ? resolveCallToPath(callTarget) : null;
        if (resolved) {
          locals.set(varName, resolved);
          recordFileVar(filePath, varName, resolved);
        }
      }

      if (fn.retType.includes('struct')) {
        const retStruct = /\breturn\s+\.\{/.exec(fn.body);
        if (retStruct) {
          const openB = retStruct.index + retStruct[0].length - 1;
          const closeB = findMatchingDelim(fn.body, openB, '{', '}');
          if (closeB >= 0) {
            const fields = new Map<string, string>();
            const inner = fn.body.slice(openB + 1, closeB);
            const fieldRe = /\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)(?:\s*,|\s*$)/g;
            let fm: RegExpExecArray | null;
            while ((fm = fieldRe.exec(inner)) !== null) {
              const p = locals.get(fm[2]!);
              if (p) fields.set(fm[1]!, p);
            }
            if (fields.size > 0) fnStructReturn.set(key, fields);
          }
        }
      }
    }
  }

  const fnLocalStructs = new Map<string, Map<string, Map<string, string>>>();
  for (const [filePath, fns] of fileFns) {
    for (const fn of fns) {
      const key = `${filePath}::${fn.name}`;
      const structs = new Map<string, Map<string, string>>();
      fnLocalStructs.set(key, structs);
      const bindRe = /\bconst\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*([^;]+);/g;
      let m: RegExpExecArray | null;
      while ((m = bindRe.exec(fn.body)) !== null) {
        const callTarget = parseCallExpr(filePath, m[2]!);
        if (!callTarget) continue;
        const sr = fnStructReturn.get(`${callTarget.file}::${callTarget.fn}`);
        if (sr) structs.set(m[1]!, sr);
      }
    }
  }

  const fnByKey = new Map<string, ParsedFn>();
  for (const [filePath, fns] of fileFns) {
    for (const fn of fns) fnByKey.set(`${filePath}::${fn.name}`, fn);
  }

  const fnParamPaths = new Map<string, Map<string, Set<string>>>();

  const resolveExpr = (filePath: string, fnKey: string, expr: string): string | null => {
    const trimmed = expr.trim();
    const cmIdx = trimmed.indexOf('createModule(');
    if (cmIdx >= 0) {
      const res = extractRootSourceExpr(trimmed.slice(cmIdx));
      if (res?.literal) return res.literal;
    }
    const callTarget = parseCallExpr(filePath, trimmed);
    if (callTarget) {
      const p = resolveCallToPath(callTarget);
      if (p) return p;
    }
    if (/^[A-Za-z_]\w*$/.test(trimmed)) {
      const local = fnLocals.get(fnKey)?.get(trimmed);
      if (local) return local;
      const paramSet = fnParamPaths.get(fnKey)?.get(trimmed);
      if (paramSet && paramSet.size === 1) return [...paramSet][0]!;
      const fv = fileVarPaths.get(filePath)?.get(trimmed);
      if (fv && fv.size === 1) return [...fv][0]!;
    }
    const fieldMatch = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(trimmed);
    if (fieldMatch) {
      const sr = fnLocalStructs.get(fnKey)?.get(fieldMatch[1]!);
      if (sr?.has(fieldMatch[2]!)) return sr.get(fieldMatch[2]!)!;
      const fv = fileVarPaths.get(filePath)?.get(fieldMatch[2]!);
      if (fv && fv.size === 1) return [...fv][0]!;
    }
    return null;
  };

  // Propagate module-typed call arguments into helper function parameters (2 passes for nested helpers)
  const callSiteRe = /(?:@import\(\s*"([^"]+\.zig)"\s*\)\.|([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\(/g;
  for (let pass = 0; pass < 2; pass++) {
    for (const [filePath, fns] of fileFns) {
      const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
      for (const fn of fns) {
        const callerKey = `${filePath}::${fn.name}`;
        callSiteRe.lastIndex = 0;
        let cm: RegExpExecArray | null;
        while ((cm = callSiteRe.exec(fn.body)) !== null) {
          const targetFile = cm[1]
            ? path.posix.normalize(dir ? `${dir}/${cm[1]}` : cm[1])
            : cm[2]
              ? (fileImports.get(filePath)?.get(cm[2]) ?? filePath)
              : (fileFnImports.get(filePath)?.get(cm[3]!)?.file ?? filePath);
          const targetFnName =
            !cm[1] && !cm[2] && fileFnImports.get(filePath)?.has(cm[3]!)
              ? fileFnImports.get(filePath)!.get(cm[3]!)!.fn
              : cm[3]!;
          const targetKey = `${targetFile}::${targetFnName}`;
          const targetFn = fnByKey.get(targetKey);
          if (!targetFn || targetFn.params.length === 0) continue;

          const openP = cm.index + cm[0].length - 1;
          const closeP = findMatchingDelim(fn.body, openP, '(', ')');
          if (closeP < 0) continue;
          const args = splitTopLevelArgs(fn.body.slice(openP + 1, closeP));
          let paramMap = fnParamPaths.get(targetKey);
          if (!paramMap) {
            paramMap = new Map();
            fnParamPaths.set(targetKey, paramMap);
          }
          const count = Math.min(args.length, targetFn.params.length);
          for (let i = 0; i < count; i++) {
            const p = resolveExpr(filePath, callerKey, args[i]!);
            if (!p) continue;
            const pname = targetFn.params[i]!;
            let set = paramMap.get(pname);
            if (!set) {
              set = new Set();
              paramMap.set(pname, set);
            }
            set.add(p);
          }
        }
      }
    }
  }

  const addModulePaths = new Map<string, Set<string>>();
  const importCounts = new Map<string, Map<string, number>>();

  const recordBinding = (name: string, rawPath: string | null, isAddModule: boolean) => {
    if (!name || !rawPath || ZIG_BUILTIN_MODULES.has(name)) return;
    const projectRel = toProjectRel(rawPath);
    if (!projectRel) return;
    if (isAddModule) {
      let set = addModulePaths.get(name);
      if (!set) {
        set = new Set();
        addModulePaths.set(name, set);
      }
      set.add(projectRel);
    }
    let counts = importCounts.get(name);
    if (!counts) {
      counts = new Map();
      importCounts.set(name, counts);
    }
    counts.set(projectRel, (counts.get(projectRel) ?? 0) + 1);
  };

  for (const [filePath, fns] of fileFns) {
    for (const fn of fns) {
      const fnKey = `${filePath}::${fn.name}`;
      const body = fn.body;
      let m: RegExpExecArray | null;

      const addModRe = /\.addModule\s*\(/g;
      while ((m = addModRe.exec(body)) !== null) {
        const openP = m.index + m[0].length - 1;
        const closeP = findMatchingDelim(body, openP, '(', ')');
        if (closeP < 0) continue;
        const args = splitTopLevelArgs(body.slice(openP + 1, closeP));
        const nm = /^\s*"([^"]+)"\s*$/.exec(args[0] ?? '');
        if (nm && args[1]) {
          const expr = extractRootSourceExpr(args[1]);
          if (expr?.literal) recordBinding(nm[1]!, expr.literal, true);
        }
      }

      const addImpRe = /\.addImport\s*\(/g;
      while ((m = addImpRe.exec(body)) !== null) {
        const openP = m.index + m[0].length - 1;
        const closeP = findMatchingDelim(body, openP, '(', ')');
        if (closeP < 0) continue;
        const args = splitTopLevelArgs(body.slice(openP + 1, closeP));
        const nm = /^\s*"([^"]+)"\s*$/.exec(args[0] ?? '');
        if (nm && args[1]) {
          recordBinding(nm[1]!, resolveExpr(filePath, fnKey, args[1]), false);
        }
      }

      const entryRe = /\.\{\s*\.name\s*=\s*"([^"]+)"\s*,\s*\.module\s*=/g;
      while ((m = entryRe.exec(body)) !== null) {
        const openB = m.index + 1;
        const closeB = findMatchingDelim(body, openB, '{', '}');
        if (closeB < 0) continue;
        const exprStr = body.slice(m.index + m[0].length, closeB);
        recordBinding(m[1]!, resolveExpr(filePath, fnKey, exprStr), false);
      }
    }
  }

  const resolved = new Map<string, string>();
  const allNames = new Set<string>([...addModulePaths.keys(), ...importCounts.keys()]);

  for (const name of allNames) {
    const direct = addModulePaths.get(name);
    if (direct && direct.size === 1) {
      resolved.set(name, [...direct][0]!);
      continue;
    }

    const counts = importCounts.get(name);
    if (!counts || counts.size === 0) continue;
    if (counts.size === 1) {
      resolved.set(name, [...counts.keys()][0]!);
      continue;
    }

    const entries = [...counts.entries()];
    const nonTest = entries.filter(([p]) => !TEST_PATH_RE.test(p));
    const pool = nonTest.length > 0 ? nonTest : entries;
    if (pool.length === 1) {
      resolved.set(name, pool[0]![0]);
      continue;
    }

    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const canonicalRe = new RegExp(`(?:^|/)${escaped}(?:/root)?\\.zig$`);
    const canonical = pool.filter(([p]) => canonicalRe.test(p));
    if (canonical.length === 1) {
      resolved.set(name, canonical[0]![0]);
      continue;
    }

    pool.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (pool[0]![1] >= 3 && pool[0]![1] >= 3 * pool[1]![1]) {
      resolved.set(name, pool[0]![0]);
    }
  }

  return resolved;
}

/**
 * Resolve a Zig `build.zig`-declared named module (`@import("engine_api")`)
 * to its project-relative `.zig` root file. Returns null for built-ins
 * (`std`, `builtin`, `root`), unknown/external dependencies, or ambiguous
 * multi-backend modules.
 */
export function resolveZigBuildModule(
  moduleName: string,
  fromFile: string,
  context: ResolutionContext
): string | null {
  if (!moduleName || ZIG_BUILTIN_MODULES.has(moduleName)) return null;
  if (moduleName.startsWith('.') || moduleName.endsWith('.zig') || moduleName.includes('/')) {
    return null;
  }

  const buildZigPath = findNearestBuildZig(fromFile, context);
  if (!buildZigPath) return null;

  const cache = getBuildCache(context);
  let moduleMap = cache.parsedBuildZigs.get(buildZigPath);
  if (!moduleMap) {
    moduleMap = parseZigBuildGraph(buildZigPath, context);
    cache.parsedBuildZigs.set(buildZigPath, moduleMap);
  }
  return moduleMap.get(moduleName) ?? null;
}
