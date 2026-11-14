import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function sqliteStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS economy (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)');
  let queue = Promise.resolve();
  return {
    async read() {
      const row = db.prepare('SELECT revision,value FROM economy WHERE id=1').get();
      return row ? { revision: row.revision, value: JSON.parse(row.value) } : { revision: 0, value: null };
    },
    async write(value, revision) {
      const result = revision === 0
        ? db.prepare('INSERT OR IGNORE INTO economy VALUES(1,1,?)').run(JSON.stringify(value))
        : db.prepare('UPDATE economy SET revision=revision+1,value=? WHERE id=1 AND revision=?').run(JSON.stringify(value), revision);
      if (result.changes !== 1) throw new Error('Market revision conflict; read the latest checkpoint before retrying');
      return revision + 1;
    },
    lock(action) { const next = queue.then(action); queue = next.catch(() => {}); return next; },
    close() { db.close(); },
  };
}
