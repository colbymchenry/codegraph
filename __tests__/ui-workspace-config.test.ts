import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWorkspaceConfig } from '../src/ui-server/workspace/config';
import { getDatabasePath } from '../src/db';

describe('工作区离线目录及索引目录配置', () => {
  it('缺失项目目录不阻断其他项目，已有祖先符号链接仍规范化', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-config-missing-'));
    try {
      fs.mkdirSync(path.join(dir, 'repo'));
      fs.symlinkSync(path.join(dir, 'repo'), path.join(dir, 'alias'));
      const file = path.join(dir, 'workspace.json');
      fs.writeFileSync(file, JSON.stringify({ name: '本地', projects: [{ id: 'live', name: '存在', path: './repo' }, { id: 'offline', name: '离线', path: './alias/missing/project' }] }));
      const config = loadWorkspaceConfig(file);
      expect(config.projects[1]!.path).toBe(path.join(fs.realpathSync(path.join(dir, 'repo')), 'missing/project'));
      expect(config.projects).toHaveLength(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([undefined, '.codegraph-custom'])('索引目录归一到项目根并拒绝与根目录重复挂载（目录覆盖=%s）', override => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-config-index-'));
    vi.stubEnv('CODEGRAPH_DIR', override);
    try {
      const root = path.join(dir, 'repo'); fs.mkdirSync(root);
      const db = getDatabasePath(root); fs.mkdirSync(path.dirname(db)); fs.writeFileSync(db, '仅用于配置路径验证');
      const file = path.join(dir, 'workspace.json');
      const indexed = { id: 'index', name: '索引', path: path.dirname(db) };
      fs.writeFileSync(file, JSON.stringify({ name: '本地', projects: [indexed] }));
      expect(loadWorkspaceConfig(file).projects[0]!.path).toBe(fs.realpathSync(root));
      fs.writeFileSync(file, JSON.stringify({ name: '本地', projects: [{ id: 'root', name: '项目', path: root }, indexed] }));
      expect(() => loadWorkspaceConfig(file)).toThrow(/真实目录/);
    } finally { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('同名普通目录没有实际索引时不误认为项目索引', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-config-ordinary-'));
    try {
      const ordinary = path.dirname(getDatabasePath(dir)); fs.mkdirSync(ordinary);
      const file = path.join(dir, 'workspace.json');
      fs.writeFileSync(file, JSON.stringify({ name: '普通目录', projects: [{ id: 'one', name: '项目', path: ordinary }] }));
      expect(loadWorkspaceConfig(file).projects[0]!.path).toBe(fs.realpathSync(ordinary));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

it('非缺失路径错误不当作离线项目忽略', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-config-not-directory-'));
  try {
    fs.writeFileSync(path.join(dir, 'file'), '不是目录');
    const config = path.join(dir, 'workspace.json');
    fs.writeFileSync(config, JSON.stringify({ name: '错误配置', projects: [{ id: 'one', name: '项目', path: './file/child' }] }));
    expect(() => loadWorkspaceConfig(config)).toThrow();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
