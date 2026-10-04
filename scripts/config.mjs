/**
 * 采集配置：关注方向 + 时间窗口 + 抓取节奏
 *
 * 说明：GitHub Search API 的多个 topic 之间是「与」关系，不是「或」，
 * 所以每个方向用多个 qualifier 拼成多条独立查询，最后按 repo id 去重合并。
 */

/** 榜单可切换的技术方向 */
export const DIRECTIONS = [
  { id: 'all', name: '全站', qualifiers: [''] },
  { id: 'ai', name: 'AI / LLM', qualifiers: ['topic:llm', 'topic:ai-agents'] },
  { id: 'frontend', name: '前端', qualifiers: ['topic:react', 'topic:frontend'] },
  { id: 'backend', name: '后端基建', qualifiers: ['topic:kubernetes', 'language:go'] },
  { id: 'database', name: '数据库', qualifiers: ['topic:database', 'topic:vector-database'] },
  { id: 'mobile', name: '移动端', qualifiers: ['topic:android', 'topic:flutter'] },
  { id: 'devtools', name: '开发工具', qualifiers: ['topic:cli', 'topic:developer-tools'] },
];

/**
 * 时间窗口
 * - new    : 最近创建 + 已经拿到不少 star  → 抓「新星」
 * - active : 最近仍在推送 + 高星            → 抓「还在热的老项目」
 */
export const WINDOWS = [
  { id: 'new', label: '近 30 天新项目', days: 30, minStars: 300, field: 'created' },
  { id: 'active', label: '近 7 天活跃', days: 7, minStars: 3000, field: 'pushed' },
];

/** 每个查询返回条数（Search API 单页上限 100） */
export const PER_PAGE = 100;

/** 请求节奏：有 token 可以快，没 token 必须慢（未认证 Search 限 10 次/分钟） */
export const PACING_MS = process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? 2200 : 6500;

/** 网络重试 */
export const MAX_RETRY = 4;

/** 输出路径（相对项目根目录） */
export const OUTPUT_JSON = 'data/repos.json';
export const DB_FILE = 'data/trends.db';

/** 明显低质的仓库特征，用于第一道降噪（黑名单字面匹配，命中即标记，不直接丢弃） */
export const NOISE_PATTERNS = [
  /awesome[-_]/i,
  /\bawesome\b/i,
  /interview/i,
  /\bcheatsheet\b/i,
  /\bcheat-sheet\b/i,
  /roadmap/i,
  /tutorial/i,
  /\bcourse\b/i,
  /learning[-_]?(path|notes)/i,
  /\bbooks?\b/i,
  /samples?$/i,
  /\bdotfiles\b/i,
  /mirror/i,
  /\bnotes\b/i,
];
