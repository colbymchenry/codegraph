import * as fs from 'fs';
import * as path from 'path';
import { validateProjectPath } from '../../utils';
import { codeGraphDirName } from '../../directory';
import { getDatabasePath } from '../../db';

export interface WorkspaceProject { id: string; name: string; path: string }
export interface WorkspaceConfig { name: string; projects: WorkspaceProject[] }

/** 允许离线目录；已有祖先仍解析符号链接，其他文件系统错误保持可见。 */
function resolveOfflinePath(absolute: string): string {
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if (fs.lstatSync(absolute).isSymbolicLink()) return resolveOfflinePath(path.resolve(path.dirname(absolute), fs.readlinkSync(absolute)));
    } catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
    return path.join(resolveOfflinePath(path.dirname(absolute)), path.basename(absolute));
  }
}

function statIfPresent(filename: string): fs.Stats | null {
  try { return fs.statSync(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** 路径相对于配置文件，可指项目根或包含实际数据库的当前索引目录。 */
export function loadWorkspaceConfig(filename: string): WorkspaceConfig {
  const config = JSON.parse(fs.readFileSync(filename, 'utf8')) as WorkspaceConfig;
  if (!config || typeof config.name !== 'string' || !config.name.trim() || !Array.isArray(config.projects) || !config.projects.length) {
    throw new Error('工作区需要名称和至少一个项目。');
  }
  const ids = new Set<string>();
  const roots = new Set<string>();
  const projects = config.projects.map(project => {
    if (!project || typeof project.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(project.id) || ids.has(project.id)) throw new Error('项目编号必须唯一，只能包含字母、数字、下划线和连字符。');
    ids.add(project.id);
    if (typeof project.name !== 'string' || !project.name.trim() || typeof project.path !== 'string' || !project.path.trim()) throw new Error('每个项目必须提供名称和路径。');
    let root = resolveOfflinePath(path.resolve(path.dirname(path.resolve(filename)), project.path));
    const directory = statIfPresent(root);
    if (directory && !directory.isDirectory()) throw new Error(`项目路径不是目录：${root}`);
    const parent = path.dirname(root);
    if (path.basename(root) === codeGraphDirName() && path.dirname(getDatabasePath(parent)) === root && statIfPresent(getDatabasePath(parent))?.isFile()) root = parent;
    if (roots.has(root)) throw new Error(`项目真实目录不能重复挂载：${root}`);
    roots.add(root);
    const error = validateProjectPath(root);
    // statIfPresent 已确认只有 ENOENT；仍保留校验器对敏感路径的拒绝。
    const offline = statIfPresent(root) === null;
    if (error && !(offline && error === `Path does not exist or is not accessible: ${root}`)) throw new Error(error);
    return { id: project.id, name: project.name, path: root };
  });
  return { name: config.name, projects };
}
