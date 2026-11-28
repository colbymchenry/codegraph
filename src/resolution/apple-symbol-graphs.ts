import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import type { AppleExternalTypesConfig } from '../project-config';
import { logWarn } from '../errors';

export interface ExternalClass {
  usr: string;
  module: string;
  name: string;
  objc?: string;
  parent?: string;
  parentFallback?: string;
}
export interface ExternalModule {
  module: string;
  classes: ExternalClass[];
}
const parsed = new Map<string, { stamp: string; value: ExternalModule }>();
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 只消费公开的类声明与继承关系，不保存 SDK 文档、源码位置或方法。 */
export function readSymbolGraph(file: string): ExternalModule {
  const stat = fs.statSync(file);
  const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  const cached = parsed.get(file);
  if (cached?.stamp === stamp) return cached.value;
  const graph: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!object(graph) || !object(graph.module) || typeof graph.module.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(graph.module.name) ||
      !Array.isArray(graph.symbols) || !Array.isArray(graph.relationships)) throw new Error('Invalid Symbol Graph');
  const classes = new Map<string, ExternalClass>();
  for (const symbol of graph.symbols) {
    if (!object(symbol) || !object(symbol.kind) || !['swift.class', 'objective-c.class'].includes(String(symbol.kind.identifier)) ||
        !object(symbol.identifier) || typeof symbol.identifier.precise !== 'string' ||
        !Array.isArray(symbol.pathComponents) || symbol.pathComponents.length !== 1 ||
        typeof symbol.pathComponents[0] !== 'string') continue;
    const usr = symbol.identifier.precise;
    classes.set(usr, { usr, module: graph.module.name, name: symbol.pathComponents[0],
      objc: /^c:objc\(cs\)([^(@]+)$/.exec(usr)?.[1] });
  }
  for (const relation of graph.relationships) {
    if (!object(relation) || relation.kind !== 'inheritsFrom' || typeof relation.source !== 'string' ||
        typeof relation.target !== 'string') continue;
    const source = classes.get(relation.source);
    if (source) {
      source.parent = relation.target;
      source.parentFallback = typeof relation.targetFallback === 'string' ? relation.targetFallback : undefined;
    }
  }
  const value = { module: graph.module.name, classes: [...classes.values()] };
  // 长驻进程只缓存压缩后的类型信息，并限制模块数量。
  if (parsed.size >= 64) parsed.delete(parsed.keys().next().value!);
  parsed.set(file, { stamp, value });
  return value;
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/xcrun', args,
      { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.trim());
      });
  });
}

/** 固定 SDK、工具链、target 和模块组成缓存键；失败的提取不进入缓存。 */
async function extractModules(config: { sdk: string; target: string }, modules: string[]): Promise<string[]> {
  if (process.platform !== 'darwin') throw new Error('SDK extraction requires macOS/Xcode; use symbolGraphs on other platforms');
  const [sdk, sdkVersion, compiler, extractor] = await Promise.all([
    run(['--sdk', config.sdk, '--show-sdk-path']), run(['--sdk', config.sdk, '--show-sdk-version']),
    run(['swiftc', '--version']), run(['--find', 'swift-symbolgraph-extract']),
  ]);
  const cacheRoot = path.join(os.tmpdir(), 'codegraph-apple-symbolgraphs');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const files: string[] = [];
  for (const module of modules) {
    const key = createHash('sha256').update(JSON.stringify([sdk, sdkVersion, compiler, extractor, config.target, module])).digest('hex');
    const destination = path.join(cacheRoot, key);
    const file = path.join(destination, `${module}.symbols.json`);
    if (fs.existsSync(file)) {
      try { readSymbolGraph(file); files.push(file); continue; }
      catch (error) {
        logWarn('Rebuilding invalid Apple Symbol Graph cache', { error: error instanceof Error ? error.message : String(error) });
        fs.rmSync(destination, { recursive: true, force: true });
      }
    }
    const temporary = fs.mkdtempSync(path.join(cacheRoot, `${key}-`));
    try {
      await run(['--sdk', config.sdk, 'swift-symbolgraph-extract', '-module-name', module,
        '-sdk', sdk, '-target', config.target, '-output-dir', temporary]);
      readSymbolGraph(path.join(temporary, `${module}.symbols.json`));
      // 同时索引的进程可能已完成同一个缓存项；只采用完整结果。
      try { fs.renameSync(temporary, destination); }
      catch (error) {
        if (!fs.existsSync(file)) throw error;
        readSymbolGraph(file);
      }
      files.push(file);
    } catch (error) {
      logWarn(`Apple Symbol Graph extraction failed for ${module}; keeping its external references unresolved`, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return files;
}

export async function loadAppleSymbolGraphs(config: AppleExternalTypesConfig, root: string, modules: string[]): Promise<ExternalModule[]> {
  let files: string[];
  try {
    files = 'symbolGraphs' in config ? config.symbolGraphs.map(file => path.resolve(root, file)) :
      modules.length ? await extractModules(config, modules.filter(module => /^[A-Za-z_][A-Za-z0-9_]*$/.test(module))) : [];
  } catch (error) {
    logWarn('Apple Symbol Graph loading unavailable; keeping external references unresolved', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const result: ExternalModule[] = [];
  for (const file of files) {
    try { result.push(readSymbolGraph(file)); }
    catch (error) {
      logWarn('Ignoring unreadable Apple Symbol Graph', { file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
