/**
 * 页面构建 —— 闭环第 ④ 步
 *
 * 把 data/ranking.json 瘦身之后内联进 HTML 模板，产出一个自带数据的单文件页面：
 * 双击就能打开，不需要起服务器；也可以直接丢到 GitHub Pages。
 *
 * 用法：node scripts/build.mjs
 * 产出：dist/index.html
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_JSON = path.join(ROOT, 'data/ranking.json');
const TEMPLATE = path.join(ROOT, 'web/index.template.html');
const OUT = path.join(ROOT, 'dist/index.html');

/** 页面上用不到的字段一律剥掉，控制内联体积 */
function slimItem(r) {
  return {
    rank: r.rank,
    id: r.id,
    fullName: r.fullName,
    owner: r.owner,
    ownerAvatar: r.ownerAvatar,
    name: r.name,
    description: (r.description || '').slice(0, 220),
    url: r.url,
    language: r.language,
    license: r.license,
    topics: (r.topics || []).slice(0, 3),
    stars: r.stars,
    forks: r.forks,
    ageDays: r.ageDays,
    velocity: r.velocity,
    relativeGrowth: r.relativeGrowth,
    quality: r.quality,
    noise: r.noise,
    components: r.components,
    score: r.score,
    history: r.history,
  };
}

function main() {
  if (!fs.existsSync(SRC_JSON)) {
    console.error('✗ 找不到 data/ranking.json，请先运行 npm run score');
    process.exit(1);
  }

  const src = JSON.parse(fs.readFileSync(SRC_JSON, 'utf8'));
  const payload = {
    generatedAt: src.generatedAt,
    asOf: src.asOf,
    mode: src.mode,
    dataDays: src.dataDays,
    weights: src.weights,
    excluded: src.excluded,
    classic: src.classic.map((r) => ({
      rank: r.rank, owner: r.owner, ownerAvatar: r.ownerAvatar, name: r.name,
      fullName: r.fullName, url: r.url, stars: r.stars, noise: r.noise,
    })),
    directions: src.directions.map((d) => ({
      id: d.id, name: d.name, total: d.total,
      top: d.top.map(slimItem),
    })),
  };

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const html = template.replace('__PAYLOAD__', json);

  if (html.includes('__PAYLOAD__')) {
    console.error('✗ 模板占位符未被替换，请检查 web/index.template.html');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  const total = payload.directions.reduce((n, d) => n + d.top.length, 0);

  console.log('━'.repeat(64));
  console.log('页面构建完成 · 闭环第 ④ 步');
  console.log('━'.repeat(64));
  console.log(`数据日期   : ${payload.asOf}   模式: ${payload.mode}`);
  console.log(`榜单条目   : ${total} 条（${payload.directions.length} 个方向）+ 对比榜 ${payload.classic.length} 条`);
  console.log(`产出文件   : dist/index.html  (${kb} KB，数据已内联，双击即可打开)`);
  console.log('━'.repeat(64));
}

main();
