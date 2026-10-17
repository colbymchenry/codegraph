import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getDatabasePath } from '../../db';

/** 包含数据库及 WAL 身份，索引被替换或原地提交都会使游标失效。 */
export function workbenchRevision(root: string): string {
  const db = getDatabasePath(root);
  const marks = [db, `${db}-wal`].map(file => {
    try {
      const s = fs.statSync(file, { bigint: true });
      // 只读连接也会创建空 WAL；它与不存在的 WAL 代表相同已提交数据。
      if (file.endsWith('-wal') && s.size === 0n) return null;
      return [s.ino, s.size, s.mtimeNs].map(String);
    }
    catch { return null; }
  });
  return createHash('sha256').update(root).update(JSON.stringify(marks)).digest('hex').slice(0, 24);
}
