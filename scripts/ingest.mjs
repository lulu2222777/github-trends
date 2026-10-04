/**
 * 存储脚本 —— 闭环第 ② 步
 *
 * 把采集结果落进 SQLite 快照表。核心思想：
 *   只存「当前值」永远算不出趋势，必须每天留一行快照。
 *
 * 用法：
 *   node scripts/ingest.mjs                # 用今天的日期入库（同一天重复跑会覆盖，不会重复计数）
 *   node scripts/ingest.mjs --date=2026-10-04
 *
 * 表结构：
 *   repos      仓库静态信息（只写一次，后续更新 last_seen）
 *   snapshots  时序快照 (repo_id, captured_at) 主键 —— 这是整套系统的地基
 *   runs       每次采集的运行日志
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { OUTPUT_JSON, DB_FILE } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id            INTEGER PRIMARY KEY,
  full_name     TEXT NOT NULL,
  owner         TEXT,
  owner_avatar  TEXT,
  name          TEXT,
  description   TEXT,
  url           TEXT,
  homepage      TEXT,
  language      TEXT,
  license       TEXT,
  topics        TEXT,
  created_at    TEXT,
  archived      INTEGER DEFAULT 0,
  is_fork       INTEGER DEFAULT 0,
  size_kb       INTEGER DEFAULT 0,
  noise         INTEGER DEFAULT 0,
  noise_hits    TEXT,
  first_seen    TEXT,
  last_seen     TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  repo_id      INTEGER NOT NULL,
  captured_at  TEXT    NOT NULL,
  stars        INTEGER NOT NULL,
  forks        INTEGER DEFAULT 0,
  watchers     INTEGER DEFAULT 0,
  open_issues  INTEGER DEFAULT 0,
  pushed_at    TEXT,
  PRIMARY KEY (repo_id, captured_at)
);

CREATE INDEX IF NOT EXISTS idx_snap_date ON snapshots (captured_at);
CREATE INDEX IF NOT EXISTS idx_snap_repo ON snapshots (repo_id, captured_at);

CREATE TABLE IF NOT EXISTS repo_directions (
  repo_id    INTEGER NOT NULL,
  direction  TEXT    NOT NULL,
  PRIMARY KEY (repo_id, direction)
);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at       TEXT,
  captured_at  TEXT,
  query_count  INTEGER,
  repo_count   INTEGER,
  new_repos    INTEGER,
  authenticated INTEGER
);
`;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** WAL 模式下数据可能还在 -wal 文件里，统计时要一起算 */
function dbSizeKb(dbPath) {
  let bytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      bytes += fs.statSync(dbPath + suffix).size;
    } catch { /* 文件不存在则跳过 */ }
  }
  return bytes / 1024;
}

function main() {
  const dateArg = process.argv.find((a) => a.startsWith('--date='));
  const capturedAt = dateArg ? dateArg.split('=')[1] : todayUtc();

  const jsonPath = path.join(ROOT, OUTPUT_JSON);
  if (!fs.existsSync(jsonPath)) {
    console.error(`✗ 找不到 ${OUTPUT_JSON}，请先运行 npm run collect`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const repos = payload.repos ?? [];

  const dbPath = path.join(ROOT, DB_FILE);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const upsertRepo = db.prepare(`
    INSERT INTO repos (id, full_name, owner, owner_avatar, name, description, url, homepage,
                       language, license, topics, created_at, archived, is_fork, size_kb,
                       noise, noise_hits, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      full_name    = excluded.full_name,
      owner        = excluded.owner,
      owner_avatar = excluded.owner_avatar,
      description  = excluded.description,
      homepage     = excluded.homepage,
      language     = excluded.language,
      license      = excluded.license,
      topics       = excluded.topics,
      archived     = excluded.archived,
      size_kb      = excluded.size_kb,
      noise        = excluded.noise,
      noise_hits   = excluded.noise_hits,
      last_seen    = excluded.last_seen
  `);

  const insertSnapshot = db.prepare(`
    INSERT INTO snapshots (repo_id, captured_at, stars, forks, watchers, open_issues, pushed_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(repo_id, captured_at) DO UPDATE SET
      stars       = excluded.stars,
      forks       = excluded.forks,
      watchers    = excluded.watchers,
      open_issues = excluded.open_issues,
      pushed_at   = excluded.pushed_at
  `);

  const existsRepo = db.prepare('SELECT id FROM repos WHERE id = ?');
  const insertDirection = db.prepare(`
    INSERT INTO repo_directions (repo_id, direction) VALUES (?,?)
    ON CONFLICT(repo_id, direction) DO NOTHING
  `);

  let newRepos = 0;
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (const r of repos) {
      const isNew = !existsRepo.get(r.id);
      if (isNew) newRepos += 1;

      upsertRepo.run(
        r.id, r.fullName, r.owner, r.ownerAvatar, r.name, r.description ?? '', r.url,
        r.homepage, r.language, r.license, JSON.stringify(r.topics ?? []),
        r.createdAt, r.archived ? 1 : 0, r.isFork ? 1 : 0, r.sizeKb ?? 0,
        r.noise ? 1 : 0, JSON.stringify(r.noiseHits ?? []),
        now, now,
      );

      insertSnapshot.run(
        r.id, capturedAt, r.stars ?? 0, r.forks ?? 0,
        r.watchers ?? 0, r.openIssues ?? 0, r.pushedAt,
      );

      for (const d of r.matchedDirections ?? []) {
        insertDirection.run(r.id, d);
      }
    }

    db.prepare(`
      INSERT INTO runs (run_at, captured_at, query_count, repo_count, new_repos, authenticated)
      VALUES (?,?,?,?,?,?)
    `).run(now, capturedAt, payload.queryCount ?? 0, repos.length, newRepos, payload.authenticated ? 1 : 0);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // ── 摘要 ────────────────────────────────────────────────────────────
  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM repos)      AS repos,
           (SELECT COUNT(*) FROM snapshots)  AS snaps,
           (SELECT COUNT(DISTINCT captured_at) FROM snapshots) AS days
  `).get();

  console.log('━'.repeat(64));
  console.log('入库完成');
  console.log('━'.repeat(64));
  console.log(`快照日期   : ${capturedAt}`);
  console.log(`本次记录   : ${repos.length} 个仓库（新发现 ${newRepos} 个）`);
  console.log(`库内总量   : ${totals.repos} 个仓库 / ${totals.snaps} 条快照 / ${totals.days} 个日期`);
  console.log(`数据库文件 : ${DB_FILE}  (${dbSizeKb(dbPath).toFixed(1)} KB)`);

  const growth = db.prepare(`
    WITH pair AS (
      SELECT repo_id, MIN(captured_at) AS first_at, MAX(captured_at) AS last_at
      FROM snapshots GROUP BY repo_id HAVING COUNT(*) > 1
    )
    SELECT r.full_name, f.stars AS s0, l.stars AS s1, (l.stars - f.stars) AS delta,
           pair.first_at, pair.last_at
    FROM pair
    JOIN repos r      ON r.id = pair.repo_id
    JOIN snapshots f  ON f.repo_id = pair.repo_id AND f.captured_at = pair.first_at
    JOIN snapshots l  ON l.repo_id = pair.repo_id AND l.captured_at = pair.last_at
    ORDER BY delta DESC LIMIT 10
  `).all();

  console.log('');
  if (growth.length === 0) {
    console.log('▸ 增量对比：暂无可对比数据（同一仓库需要至少两天的快照）');
    console.log(`  → 明天再跑一次 ${'`npm run collect && npm run store`'}，这里就会出现真实的每日增量。`);
  } else {
    console.log('▸ 期间 star 增量 Top 10');
    growth.forEach((g, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${g.full_name.padEnd(38)} +${String(g.delta).padStart(6)}  (${g.s0} → ${g.s1}, ${g.first_at}→${g.last_at})`);
    });
  }
  console.log('━'.repeat(64));

  db.close();
}

main();
