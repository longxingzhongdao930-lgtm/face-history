import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKUP_FORMAT, BACKUP_VERSION, BackupError, parseBackup } from '../public/shared/backup-format.js';

export { BACKUP_FORMAT, BACKUP_VERSION, BackupError, parseBackup };

// ---------------------------------------------------------------- ファイル保存

const timestampForFile = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-').replace('Z', '');

/** バックアップをファイルに書き出す。@returns 書き出したファイルのパス */
export async function writeBackupFile(store, dir, prefix, { includeSnapshots = true } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const data = await store.exportData({ includeSnapshots });
  const file = path.join(dir, `${prefix}-${timestampForFile()}.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
  return file;
}

/** 同じ接頭辞のバックアップを新しい順に keep 件だけ残す */
export async function pruneBackups(dir, prefix, keep) {
  const files = (await fs.readdir(dir).catch(() => []))
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.json'))
    .sort()
    .reverse();
  const removed = files.slice(keep);
  await Promise.all(removed.map((f) => fs.rm(path.join(dir, f), { force: true })));
  return removed;
}

/**
 * 定期バックアップ。intervalMs ごとに <dir>/auto-*.json を書き出し、keep 件を残す。
 * @returns {() => void} 停止関数
 */
export function scheduleBackups(store, dir, { intervalMs, keep = 7, includeSnapshots = true, log = console }) {
  const run = async () => {
    try {
      const file = await writeBackupFile(store, dir, 'auto', { includeSnapshots });
      await pruneBackups(dir, 'auto', keep);
      log.log(`backup: ${file}`);
    } catch (err) {
      log.error('backup failed:', err);
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export const backupFileName = (date = new Date()) => `face-history-backup-${timestampForFile(date)}.json`;
