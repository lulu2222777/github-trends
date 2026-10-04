/**
 * 评分与排名 —— 闭环第 ③ 步
 *
 * 核心：不按 star 存量排，按「增速 × 质量」排。
 *
 *   score = 0.42×日均增量 + 0.23×相对涨幅 + 0.20×质量分 + 0.15×新鲜度
 *           （各项先做分位数归一化，避免 star 长尾分布把头部项目碾压）
 *   命中「awesome/教程」类噪音特征的，乘以 0.3 惩罚并在默认输出中剔除。
 *
 * 两种运行模式：
 *   growth    已有 ≥2 天快照 → 用真实的每日增量（目标形态）
 *   bootstrap 只有 1 天快照 → 退化为「star 总数 / 项目年龄」的历史平均速度，
 *             先让榜单能跑起来，等积累了真实增量自动切换。
 *
 * 用法：
 *   node scripts/score.mjs                  # 全部方向
 *   node scripts/score.mjs --only=all,ai
 *   node scripts/score.mjs --include-noise  # 不过滤噪音仓库（用于检查过滤效果）
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DIRECTIONS, DB_FILE } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = 'data/ranking.json';
const PER_DIRECTION = 60;

const WEIGHTS = { velocity: 0.42, relative: 0.23, quality: 0.20, freshness: 0.15 };
const NOISE_PENALTY = 0.3;

const DAY_MS = 86400_000;

/** 分位数归一化：把任意分布压到 0..1，天然抗长尾。相同值取平均位次。 */
function percentileRanker(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (v) => {
    if (n === 0) return 0.5;
    if (n === 1) return 0.5;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    while (end < n && sorted[end] === v) end += 1;
    return ((lo + end) / 2) / n;
  };
}

/** 质量分原始值：0..0.9，衡量「这是个正经在维护的项目」而非空壳 */
function qualityRaw(repo, snap, now) {
  let q = 0;
  if (repo.license) q += 0.15;
  if ((repo.description ?? '').trim().length >= 20) q += 0.10;

  let topics = [];
  try { topics = JSON.parse(repo.topics || '[]'); } catch { topics = []; }
  if (topics.length >= 3) q += 0.10;
  if (repo.homepage) q += 0.05;

  if (snap.stars > 0) {
    q += Math.min((snap.forks / snap.stars) / 0.15, 1) * 0.10;
  }
  if (snap.open_issues > 0) q += 0.05;
  if ((repo.size_kb ?? 0) >= 100) q += 0.10;

  if (snap.pushed_at) {
    const pushAge = (now - new Date(snap.pushed_at).getTime()) / DAY_MS;
    if (pushAge <= 30) q += 0.20;
    if (pushAge <= 7) q += 0.05;
  }
  if (repo.archived) q -= 0.50;
  return Math.max(0, Math.min(1, q));
}

function parseArgs() {
  const only = process.argv.find((a) => a.startsWith('--only='));
  return {
    onlyIds: only ? new Set(only.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean)) : null,
    includeNoise: process.argv.includes('--include-noise'),
  };
}

function main() {
  const { onlyIds, includeNoise } = parseArgs();

  const dbPath = path.join(ROOT, DB_FILE);
  if (!fs.existsSync(dbPath)) {
    console.error('✗ 找不到数据库，请先运行 npm run collect && npm run store');
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath);
  const now = Date.now();

  const repoRows = db.prepare('SELECT * FROM repos').all();
  const snapRows = db.prepare('SELECT * FROM snapshots ORDER BY repo_id, captured_at').all();
  const dirRows = db.prepare('SELECT * FROM repo_directions').all();

  const dates = [...new Set(snapRows.map((s) => s.captured_at))].sort();
  const latestDate = dates[dates.length - 1];
  const dataDays = dates.length;
  const mode = dataDays >= 2 ? 'growth' : 'bootstrap';

  // 按仓库聚合成时间序列
  const series = new Map();
  for (const s of snapRows) {
    if (!series.has(s.repo_id)) series.set(s.repo_id, []);
    series.get(s.repo_id).push(s);
  }

  const dirOf = new Map();
  for (const d of dirRows) {
    if (!dirOf.has(d.repo_id)) dirOf.set(d.repo_id, []);
    dirOf.get(d.repo_id).push(d.direction);
  }

  const excluded = { archived: 0, fork: 0, lowStars: 0, noise: 0, noSeries: 0 };

  // ── 计算每个仓库的原始指标 ────────────────────────────────────────
  const enriched = [];
  for (const repo of repoRows) {
    const snaps = series.get(repo.id);
    if (!snaps || snaps.length === 0) { excluded.noSeries += 1; continue; }
    if (repo.archived) { excluded.archived += 1; continue; }
    if (repo.is_fork) { excluded.fork += 1; continue; }

    const latest = snaps[snaps.length - 1];
    if (latest.stars < 100) { excluded.lowStars += 1; continue; }
    if (repo.noise && !includeNoise) excluded.noise += 1;

    const first = snaps[0];
    const spanDays = (new Date(latest.captured_at) - new Date(first.captured_at)) / DAY_MS;
    const ageDays = Math.max((now - new Date(repo.created_at).getTime()) / DAY_MS, 1);

    let delta = 0;
    let velocity = 0;
    let relativeGrowth = 0;

    if (spanDays >= 1) {
      delta = latest.stars - first.stars;
      velocity = delta / spanDays;
      relativeGrowth = first.stars > 0 ? delta / first.stars : 0;
    } else {
      // bootstrap：没有历史增量，退化为历史平均速度
      velocity = latest.stars / ageDays;
      relativeGrowth = 0;
    }

    enriched.push({
      repo,
      snap: latest,
      matchedDirections: dirOf.get(repo.id) ?? [],
      stars: latest.stars,
      forks: latest.forks,
      openIssues: latest.open_issues,
      ageDays,
      spanDays,
      delta,
      velocity,
      relativeGrowth,
      quality: qualityRaw(repo, latest, now),
      freshness: 1 / (1 + ageDays / 180),
      history: snaps.map((s) => ({ date: s.captured_at, stars: s.stars })),
    });
  }

  // ── 分位数归一化（在每个方向的候选集内做）────────────────────────
  /** 把内部结构序列化成前端可用的条目 */
function serialize(e, rank, components = null, score = 0, isNoise = false) {
  return {
    rank,
    id: e.repo.id,
    fullName: e.repo.full_name,
    owner: e.repo.owner,
    ownerAvatar: e.repo.owner_avatar,
    name: e.repo.name,
    description: e.repo.description ?? '',
    url: e.repo.url,
    homepage: e.repo.homepage,
    language: e.repo.language,
    license: e.repo.license,
    topics: (() => { try { return JSON.parse(e.repo.topics || '[]'); } catch { return []; } })(),
    stars: e.stars,
    forks: e.forks,
    openIssues: e.openIssues,
    createdAt: e.repo.created_at,
    pushedAt: e.snap.pushed_at,
    ageDays: Number(e.ageDays.toFixed(1)),
    delta: e.delta,
    spanDays: e.spanDays,
    velocity: Number(e.velocity.toFixed(2)),
    relativeGrowth: Number((e.relativeGrowth * 100).toFixed(2)),
    quality: Number(e.quality.toFixed(3)),
    noise: isNoise,
    components,
    score: Number(score.toFixed(4)),
    history: e.history,
  };
}

function buildDirection(dir) {
    const pool = dir.id === 'all'
      ? enriched
      : enriched.filter((e) => e.matchedDirections.includes(dir.id));

    if (pool.length === 0) return { ...dir, total: 0, top: [] };

    const pVel = percentileRanker(pool.map((e) => e.velocity));
    const pRel = percentileRanker(pool.map((e) => e.relativeGrowth));
    const pQua = percentileRanker(pool.map((e) => e.quality));
    const pFre = percentileRanker(pool.map((e) => e.freshness));

    const scored = pool.map((e) => {
      const c = {
        velocity: pVel(e.velocity),
        relative: pRel(e.relativeGrowth),
        quality: pQua(e.quality),
        freshness: pFre(e.freshness),
      };
      let score = WEIGHTS.velocity * c.velocity
        + WEIGHTS.relative * c.relative
        + WEIGHTS.quality * c.quality
        + WEIGHTS.freshness * c.freshness;
      const isNoise = Boolean(e.repo.noise);
      if (isNoise) score *= NOISE_PENALTY;

      return { e, c, isNoise, score };
    });

    const visible = scored
      .filter((s) => includeNoise || !s.isNoise)
      .sort((a, b) => b.score - a.score)
      .slice(0, PER_DIRECTION);

    return {
      id: dir.id,
      name: dir.name,
      total: pool.length,
      hidden: scored.filter((s) => s.isNoise).length,
      top: visible.map((s, i) => serialize(s.e, i + 1, {
        velocity: Number(s.c.velocity.toFixed(3)),
        relative: Number(s.c.relative.toFixed(3)),
        quality: Number(s.c.quality.toFixed(3)),
        freshness: Number(s.c.freshness.toFixed(3)),
      }, s.score, s.isNoise)),
    };
  }

  const dirs = DIRECTIONS.filter((d) => !onlyIds || onlyIds.has(d.id)).map(buildDirection);

  // 「按 star 总数排」的对照组 —— 故意保留噪音仓库，用来直观对比「存量」与「增速」的差别
  const classic = [...enriched]
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 25)
    .map((e, i) => serialize(e, i + 1, null, 0, Boolean(e.repo.noise)));

  const payload = {
    generatedAt: new Date().toISOString(),
    asOf: latestDate,
    mode,
    dataDays,
    dates,
    weights: WEIGHTS,
    noisePenalty: NOISE_PENALTY,
    excluded,
    classic,
    directions: dirs,
  };

  const outPath = path.join(ROOT, OUTPUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  // ── 终端摘要 ────────────────────────────────────────────────────────
  console.log('━'.repeat(76));
  console.log('评分完成');
  console.log('━'.repeat(76));
  console.log(`数据日期 : ${latestDate}（共 ${dataDays} 天快照）`);
  console.log(`运行模式 : ${mode === 'growth' ? 'growth —— 使用真实每日增量' : 'bootstrap —— 暂用历史平均速度，明天起自动切换为真实增量'}`);
  console.log(`权重     : 增量 ${WEIGHTS.velocity} / 涨幅 ${WEIGHTS.relative} / 质量 ${WEIGHTS.quality} / 新鲜度 ${WEIGHTS.freshness}`);
  console.log(`已剔除   : 归档 ${excluded.archived} · Fork ${excluded.fork} · star<100 ${excluded.lowStars} · 噪音仓库 ${excluded.noise}`);

  const all = dirs.find((d) => d.id === 'all');
  if (all) {
    console.log('');
    console.log(`▸ 全站榜 Top 15${mode === 'bootstrap' ? '（按历史平均速度）' : '（按近 7 天增量）'}`);
    console.log(`  ${'#'.padEnd(3)} ${'项目'.padEnd(40)} ${'star'.padStart(7)} ${'日均'.padStart(8)} ${'质量'.padStart(6)} ${'总分'.padStart(6)}  语言`);
    all.top.slice(0, 15).forEach((r) => {
      console.log(
        `  ${String(r.rank).padEnd(3)} ${r.fullName.slice(0, 39).padEnd(40)} ${String(r.stars).padStart(7)} `
        + `${r.velocity.toFixed(0).padStart(8)} ${r.quality.toFixed(2).padStart(6)} ${r.score.toFixed(3).padStart(6)}  ${r.language ?? '—'}`,
      );
    });
  }

  console.log('');
  console.log('▸ 各方向候选量');
  dirs.filter((d) => d.id !== 'all').forEach((d) => {
    const leader = d.top[0];
    console.log(`  ${d.name.padEnd(12)} 候选 ${String(d.total).padStart(5)} 个   榜首: ${leader ? leader.fullName : '—'}`);
  });

  console.log(`\n✓ 已写入 ${OUTPUT}`);
  console.log('━'.repeat(76));

  db.close();
}

main();
