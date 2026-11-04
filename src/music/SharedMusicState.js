import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export class SharedMusicState {
  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.instance = randomUUID();
    try {
      this.db.exec(`
        PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS playlists (
          user_id TEXT PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cache_entries (
          bucket TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          expires INTEGER NOT NULL, tags TEXT NOT NULL, played INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(bucket, key)
        );
        CREATE TABLE IF NOT EXISTS cache_protection (
          instance TEXT PRIMARY KEY, keys TEXT NOT NULL, expires INTEGER NOT NULL
        );
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cache(bucket, ttlMs, limit = 250) {
    return new SharedCache(this, bucket, ttlMs, limit);
  }

  protect(keys) {
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare('DELETE FROM cache_protection WHERE expires<=?').run(now);
      this.db.prepare(`
        INSERT INTO cache_protection VALUES (?, ?, ?)
        ON CONFLICT(instance) DO UPDATE SET keys=excluded.keys, expires=excluded.expires
      `).run(this.instance, JSON.stringify([...keys]), now + 90_000);
    });
  }

  close() {
    try { this.db.prepare('DELETE FROM cache_protection WHERE instance=?').run(this.instance); }
    finally { this.db.close(); }
  }
}

class SharedCache {
  constructor(state, bucket, ttlMs, limit) {
    Object.assign(this, { state, db: state.db, bucket, ttlMs, limit });
  }

  get(key) {
    const row = this.db.prepare('SELECT value FROM cache_entries WHERE bucket=? AND key=? AND expires>?')
      .get(this.bucket, key, Date.now());
    return row && JSON.parse(row.value);
  }

  set(key, value, trackKeys = []) {
    const now = Date.now();
    this.state.transaction(() => {
      this.db.prepare('DELETE FROM cache_entries WHERE expires<=?').run(now);
      this.db.prepare(`
        INSERT INTO cache_entries (bucket,key,value,expires,tags) VALUES (?,?,?,?,?)
        ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value, expires=excluded.expires,
          tags=excluded.tags, played=0
      `).run(this.bucket, key, JSON.stringify(value), now + this.ttlMs, JSON.stringify([...new Set(trackKeys)]));
      this.db.prepare(`
        DELETE FROM cache_entries WHERE bucket=? AND key IN (
          SELECT key FROM cache_entries WHERE bucket=? ORDER BY expires DESC LIMIT -1 OFFSET ?
        )
      `).run(this.bucket, this.bucket, this.limit);
    });
    return value;
  }

  delete(key) {
    return this.db.prepare('DELETE FROM cache_entries WHERE bucket=? AND key=?').run(this.bucket, key).changes > 0;
  }

  tag(key, trackKeys) {
    if (!trackKeys.length) return;
    this.db.prepare(`
      UPDATE cache_entries SET tags=(
        SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(cache_entries.tags) UNION SELECT value FROM json_each(?)
        )
      ) WHERE bucket=? AND key=?
    `).run(JSON.stringify(trackKeys), this.bucket, key);
  }

  markPlayed(trackKeys) {
    this.db.prepare(`
      UPDATE cache_entries SET played=1 WHERE bucket=? AND EXISTS (
        SELECT 1 FROM json_each(tags) WHERE value IN (SELECT value FROM json_each(?))
      )
    `).run(this.bucket, JSON.stringify(trackKeys));
  }

  clearPlayed(protectedKeys) {
    return this.db.prepare(`
      DELETE FROM cache_entries WHERE bucket=? AND played=1 AND NOT EXISTS (
        SELECT 1 FROM json_each(tags) WHERE value IN (
          SELECT value FROM json_each(?)
          UNION SELECT tag.value FROM cache_protection AS active, json_each(active.keys) AS tag
          WHERE active.expires>?
        )
      )
    `).run(this.bucket, JSON.stringify([...protectedKeys]), Date.now()).changes;
  }
}
