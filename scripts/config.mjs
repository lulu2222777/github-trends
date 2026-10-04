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

/**
 * 降噪规则 —— 分四类，命中任意一类即标记为 noise。
 *
 * 设计原则：只标记不丢弃（评分层可以 --include-noise 查看），
 * 但要把「名字看起来像正经项目、本质是清单/教程/资料堆」的仓库抓出来，
 * 这类是榜单最大的污染源。
 */
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
  // 资料收集类 —— 只匹配「列表/合集」的明确表达。
  // 不能用 collection / resources / guides 这类泛词，否则会误伤
  // Inquirer.js、react-spectrum 这种描述里带 "a collection of libraries" 的正经开源库。
  /\bcurated\b[^.]{0,40}\b(list|collection|guide)\b/i,
  /\b(list|collection)\s+of\s+(the\s+)?(best|awesome|top|free|open[- ]source)\b/i,
  /\blist\s*of\b/i,
  /\bgreat[-_]?list/i,
  /编程|面试|教程|指南|笔记|大全|入门|速查/i,
];

/** 明显的「收集型」组织：它们名下的仓库几乎都是资料堆，不看名字直接标记 */
export const NOISE_OWNERS = new Set([
  'freecodecamp',
  'public-apis',
  'publicapis',
  'ossu',
  'codecrafters-io',
  'practical-tutorials',
  'kamranahmedse',
  'donnemartin',
  'mtdvio',
  'vinta',
  'jwasham',
  'sindresorhus',   // awesome-* 的重度生产者，个人库里噪音密度极高
]);

/**
 * 「巨无霸但已停止生长」特征：star 极高 + 很久没推送。
 * 这类仓库在任何时间窗口里都排前面，但早已不再活跃。
 */
export const STALE_GIANT = {
  minStars: 20000,
  minIdleDays: 180,
};

/** 把仓库的文本特征拼成可匹配的串 */
export function noiseHaystack(repo) {
  return `${repo.fullName} ${repo.description ?? ''} ${(repo.topics ?? []).join(' ')}`;
}
