/**
 * 采集脚本 —— 闭环第 ① 步
 *
 * 用 GitHub Search API 发现候选仓库，落成 data/repos.json。
 * 一条搜索查询即可返回 100 个仓库的完整元数据（star/语言/license/topics/创建时间），
 * 因此无需再逐个仓库调用详情接口，速率压力极小。
 *
 * 用法：
 *   node scripts/collect.mjs                  # 抓全部方向
 *   node scripts/collect.mjs --only=all,ai    # 只抓指定方向（冒烟测试）
 *   GITHUB_TOKEN=xxx node scripts/collect.mjs # 带 token 可以跑得更快
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIRECTIONS,
  WINDOWS,
  PER_PAGE,
  PACING_MS,
  MAX_RETRY,
  OUTPUT_JSON,
  NOISE_PATTERNS,
  NOISE_OWNERS,
  STALE_GIANT,
  noiseHaystack,
} from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 10);
}

function parseArgs() {
  const only = process.argv.find((a) => a.startsWith('--only='));
  if (!only) return { onlyIds: null };
  const ids = only.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
  return { onlyIds: new Set(ids) };
}

/** 生成本轮要执行的搜索查询 */
function buildQueries(onlyIds) {
  const queries = [];
  for (const dir of DIRECTIONS) {
    if (onlyIds && !onlyIds.has(dir.id)) continue;
    for (const win of WINDOWS) {
      for (const q of dir.qualifiers) {
        queries.push({
          direction: dir.id,
          directionName: dir.name,
          window: win.id,
          windowLabel: win.label,
          q: [q, `${win.field}:>${daysAgo(win.days)}`, `stars:>${win.minStars}`]
            .filter(Boolean)
            .join(' '),
        });
      }
    }
  }
  return queries;
}

/** 单次搜索请求，带重试与限流等待 */
async function searchOnce(query, attempt = 1) {
  const url = new URL('https://api.github.com/search/repositories');
  url.searchParams.set('q', query.q);
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(PER_PAGE));

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-trends-collector',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    if (attempt >= MAX_RETRY) throw err;
    const wait = attempt * 3000;
    console.log(`   ⚠ 网络异常，${wait / 1000}s 后重试（${attempt}/${MAX_RETRY}）: ${err.message}`);
    await sleep(wait);
    return searchOnce(query, attempt + 1);
  }

  if (res.ok) return res.json();

  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
  const body = await res.text();

  const isRateLimit = (res.status === 403 || res.status === 429) &&
    (/rate limit/i.test(body) || remaining === '0');

  if (isRateLimit && attempt < MAX_RETRY) {
    const wait = reset > Date.now() ? reset - Date.now() + 2000 : attempt * 8000;
    console.log(`   ⏳ 触发限流，等待 ${Math.ceil(wait / 1000)}s 后重试（${attempt}/${MAX_RETRY}）`);
    await sleep(wait);
    return searchOnce(query, attempt + 1);
  }

  throw new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
}

/** 把 GitHub 返回的仓库对象收敛成我们自己的字段集合 */
function normalize(item) {
  return {
    id: item.id,
    fullName: item.full_name,
    owner: item.owner?.login ?? null,
    ownerAvatar: item.owner?.avatar_url ?? null,
    name: item.name,
    description: item.description ?? '',
    url: item.html_url,
    homepage: item.homepage || null,
    stars: item.stargazers_count ?? 0,
    forks: item.forks_count ?? 0,
    watchers: item.watchers_count ?? 0,
    openIssues: item.open_issues_count ?? 0,
    language: item.language ?? null,
    license: item.license?.spdx_id && item.license.spdx_id !== 'NOASSERTION'
      ? item.license.spdx_id
      : null,
    topics: Array.isArray(item.topics) ? item.topics : [],
    createdAt: item.created_at,
    pushedAt: item.pushed_at,
    updatedAt: item.updated_at,
    archived: Boolean(item.archived),
    isFork: Boolean(item.fork),
    sizeKb: item.size ?? 0,
  };
}

/** 打上降噪标记（只标记不丢弃，是否过滤留给评分层决定） */
function markNoise(repo) {
  const hits = [];

  // ① 文本特征
  const haystack = noiseHaystack(repo);
  for (const re of NOISE_PATTERNS) {
    if (re.test(haystack)) hits.push(re.source);
  }

  // ② 收集型组织
  if (repo.owner && NOISE_OWNERS.has(String(repo.owner).toLowerCase())) {
    hits.push(`owner:${repo.owner}`);
  }

  // ③ 巨无霸但已停止生长
  if (repo.stars >= STALE_GIANT.minStars && repo.pushedAt) {
    const idleDays = (Date.now() - new Date(repo.pushedAt).getTime()) / 86400_000;
    if (idleDays >= STALE_GIANT.minIdleDays) {
      hits.push(`stale-giant(${Math.round(idleDays)}d)`);
    }
  }

  return { noise: hits.length > 0, noiseHits: hits };
}

async function main() {
  const { onlyIds } = parseArgs();
  const queries = buildQueries(onlyIds);

  console.log('━'.repeat(64));
  console.log('GitHub 高价值项目采集 · 闭环第 ① 步');
  console.log('━'.repeat(64));
  console.log(`认证方式 : ${TOKEN ? 'GITHUB_TOKEN（5000 次/小时）' : '未认证（Search 限 10 次/分钟）'}`);
  console.log(`查询条数 : ${queries.length}   请求间隔: ${PACING_MS}ms`);
  console.log(`预计耗时 : ~${Math.ceil((queries.length * PACING_MS) / 1000)}s`);
  console.log('─'.repeat(64));

  const merged = new Map();
  const stats = [];
  let queryIndex = 0;

  for (const query of queries) {
    queryIndex += 1;
    const tag = `[${queryIndex}/${queries.length}] ${query.directionName} / ${query.windowLabel}`;
    let data;
    try {
      data = await searchOnce(query);
    } catch (err) {
      console.log(`${tag}  ✗ 失败: ${err.message}`);
      stats.push({ ...query, error: err.message, returned: 0 });
      continue;
    }

    const items = data.items ?? [];
    let added = 0;

    for (const item of items) {
      if (item.fork || item.archived) continue;
      const repo = normalize(item);
      const existing = merged.get(repo.id);
      if (existing) {
        if (!existing.matchedDirections.includes(query.direction)) {
          existing.matchedDirections.push(query.direction);
        }
        if (!existing.matchedWindows.includes(query.window)) {
          existing.matchedWindows.push(query.window);
        }
      } else {
        merged.set(repo.id, {
          ...repo,
          ...markNoise(repo),
          matchedDirections: [query.direction],
          matchedWindows: [query.window],
        });
        added += 1;
      }
    }

    console.log(`${tag}  ✓ 命中 ${data.total_count} 条，取回 ${items.length}，新增 ${added}`);
    stats.push({ ...query, totalCount: data.total_count, returned: items.length, added });

    if (queryIndex < queries.length) await sleep(PACING_MS);
  }

  const repos = [...merged.values()];
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'github-search-api',
    authenticated: Boolean(TOKEN),
    queryCount: queries.length,
    uniqueRepos: repos.length,
    repos,
  };

  const outPath = path.join(ROOT, OUTPUT_JSON);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');

  // 终端摘要
  const now = Date.now();
  const ageDays = (r) => Math.max((now - new Date(r.createdAt).getTime()) / 86400_000, 0.5);
  const velocity = (r) => r.stars / ageDays(r);

  const topStars = [...repos].sort((a, b) => b.stars - a.stars).slice(0, 8);
  const topNew = [...repos]
    .filter((r) => (now - new Date(r.createdAt).getTime()) / 86400_000 <= 60)
    .sort((a, b) => velocity(b) - velocity(a))
    .slice(0, 8);

  console.log('─'.repeat(64));
  console.log(`去重后仓库总数: ${repos.length}`);
  console.log(`其中疑似低质（awesome/教程等关键词命中）: ${repos.filter((r) => r.noise).length}`);
  console.log(`语言分布 Top5: ${Object.entries(
    repos.reduce((acc, r) => { const k = r.language ?? '未知'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
  ).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}(${v})`).join('  ')}`);

  console.log(`\n▸ star 总量 Top 8`);
  topStars.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.fullName.padEnd(38)} ${String(r.stars).padStart(7)} ★  ${r.language ?? '—'}`);
  });

  console.log(`\n▸ 新星速度 Top 8（60 天内创建，按 star/天 排序）`);
  topNew.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.fullName.padEnd(38)} ${velocity(r).toFixed(0).padStart(5)} ★/天  ${r.language ?? '—'}`);
  });

  console.log(`\n✓ 已写入 ${OUTPUT_JSON}`);
  console.log('━'.repeat(64));
}

main().catch((err) => {
  console.error('\n✗ 采集失败:', err.message);
  process.exit(1);
});
