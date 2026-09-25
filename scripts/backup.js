#!/usr/bin/env node
// バックアップをファイルに書き出す（cron などでの定期実行向け。サーバー稼働中でも実行可能）
//   npm run backup                         → <DATA_DIR>/backups/manual-<日時>.json
//   npm run backup -- --out ./backup.json  → 指定したファイルへ
//   npm run backup -- --no-snapshots       → 認証時の顔画像を含めない
//   npm run backup -- --keep 7             → manual-*.json を新しい 7 件だけ残す
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pruneBackups, writeBackupFile } from '../src/backup.js';
import { Store } from '../src/store.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'no-snapshots': { type: 'boolean', default: false },
    keep: { type: 'string' },
  },
});

const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
const store = await new Store(dataDir).init();
const includeSnapshots = !values['no-snapshots'];

let file;
if (values.out) {
  file = path.resolve(values.out);
  const data = await store.exportData({ includeSnapshots });
  await fs.writeFile(file, JSON.stringify(data));
} else {
  const dir = path.resolve(process.env.BACKUP_DIR ?? path.join(dataDir, 'backups'));
  file = await writeBackupFile(store, dir, 'manual', { includeSnapshots });
  if (values.keep) await pruneBackups(dir, 'manual', Number(values.keep));
}
console.log(`バックアップを書き出しました: ${file}`);
