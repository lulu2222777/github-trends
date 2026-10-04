#!/usr/bin/env node
/**
 * publish.mjs —— 把本项目首次发布到 GitHub（全程只走 api.github.com）
 *
 * 为什么不用 git push：
 *   本机到 github.com 的 TCP 通道不稳定（走代理隧道被 502 拒绝、直连 TCP 超时），
 *   而 api.github.com 稳定可达。因此改用 Git Data API 一次性把全部文件提交上去，
 *   完全不触碰 github.com。
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish.mjs
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish.mjs --repo=my-name --private
 *
 * 需要的 token 权限（classic PAT）：repo、workflow
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : def;
};
const REPO = getArg('repo', 'github-trends');
const PRIVATE = args.includes('--private');
const BRANCH = getArg('branch', 'main');
const DESC = getArg(
  'desc',
  '自动追踪 GitHub 上「涨得快且干净」的项目：每日快照 + 加权评分 + 榜单页面',
);

// 被排除的路径（与 .gitignore 保持一致，避免把中间产物推上去）
const IGNORE = [
  /^\.git\//,
  /^node_modules\//,
  /^\.shots\//,
  /^\.probe\//,
  /^data\/repos\.json$/,
  /^data\/ranking\.json$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.log$/,
  // 安全兜底：任何形似凭证的文件都绝不允许进入公开仓库
  /token/i,
  /credential/i,
  /secret/i,
  /^\.env/,
];

// --dry-run：只预览会上传哪些文件，不联网、不需要 token
if (args.includes('--dry-run')) {
  const files = collectFiles().sort((a, b) => a.relPath.localeCompare(b.relPath));
  console.log(`将上传 ${files.length} 个文件（中间产物与凭证已被过滤）：\n`);
  let total = 0;
  for (const f of files) {
    const size = fs.statSync(f.full).size;
    total += size;
    console.log(`  ${f.relPath.padEnd(40)} ${(size / 1024).toFixed(0).padStart(6)} KB`);
  }
  console.log(`\n  合计 ${(total / 1024 / 1024).toFixed(2)} MB`);
  process.exit(0);
}

if (!TOKEN) {
  console.error('✗ 缺少 GITHUB_TOKEN 环境变量');
  process.exit(1);
}

/** 带重试的 API 调用：api.github.com 存在间歇性连接失败，重试可以兜住 */
async function api(method, endpoint, body, { retries = 5 } = {}) {
  const url = endpoint.startsWith('http') ? endpoint : API + endpoint;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'github-trends-publisher',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* 响应不是 JSON，保持 null */
      }

      if (res.ok) return json;

      // 这几类是明确的业务语义错误，交给调用方决定怎么处理，不重试
      if ([404, 409, 422].includes(res.status)) {
        const err = new Error(json?.message || text || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }

      // 其余（5xx、限流、网络抖动）走重试
      if (attempt === retries) {
        throw new Error(`[${method} ${endpoint}] HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
    } catch (e) {
      if (e.status) throw e; // 业务错误直接上抛
      if (attempt === retries) throw new Error(`[${method} ${endpoint}] ${e.message}`);
    }

    const wait = attempt * 1500;
    console.log(`      · 连接抖动，${wait}ms 后重试（第 ${attempt}/${retries - 1} 次）`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** 递归收集要上传的文件 */
function collectFiles(dir = ROOT, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (IGNORE.some((re) => re.test(relPath))) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full, relPath));
    else if (entry.isFile()) out.push({ relPath, full });
  }
  return out;
}

async function main() {
  console.log('=== 1. 校验 token ===');
  const me = await api('GET', '/user');
  console.log(`   已认证：${me.login}${me.name ? `（${me.name}）` : ''}`);

  console.log(`\n=== 2. 准备仓库 ${me.login}/${REPO} ===`);
  let repo;
  try {
    repo = await api('POST', '/user/repos', {
      name: REPO,
      description: DESC,
      private: PRIVATE,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    });
    console.log(`   已创建：${repo.html_url}`);
  } catch (e) {
    if (e.status === 422) {
      repo = await api('GET', `/repos/${me.login}/${REPO}`);
      console.log(`   仓库已存在，直接复用：${repo.html_url}`);
    } else {
      throw e;
    }
  }

  // 全新空仓库里还没有任何 Git 对象，此时无法创建 blob（会报 "Git Repository is empty."）。
  // 所以先用 Contents API 落一个初始提交，把分支建起来，后续再在其上追加正式提交。
  let parentSha = null;
  try {
    const ref = await api('GET', `/repos/${me.login}/${REPO}/git/ref/heads/${BRANCH}`);
    parentSha = ref.object.sha;
    console.log(`   分支 ${BRANCH} 已存在（${parentSha.slice(0, 7)}），将在其后追加提交`);
  } catch (e) {
    if (e.status === 404 || e.status === 409 || e.status === 422) {
      console.log(`   仓库为空，先落一个初始提交以初始化 ${BRANCH} 分支`);
      const readme = path.join(ROOT, 'README.md');
      const content = fs.existsSync(readme)
        ? fs.readFileSync(readme).toString('base64')
        : Buffer.from(`# ${REPO}\n`).toString('base64');
      const init = await api('PUT', `/repos/${me.login}/${REPO}/contents/README.md`, {
        message: 'chore: 初始化仓库',
        content,
      });
      parentSha = init.commit.sha;
      console.log(`   ✓ 初始提交 ${parentSha.slice(0, 7)}`);
    } else {
      throw e;
    }
  }

  console.log('\n=== 3. 上传文件（Git Data API） ===');
  const files = collectFiles().sort((a, b) => a.relPath.localeCompare(b.relPath));

  const treeEntries = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    const blob = await api('POST', `/repos/${me.login}/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    treeEntries.push({ path: f.relPath, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`   ✓ ${f.relPath.padEnd(40)} ${(buf.length / 1024).toFixed(0).padStart(6)} KB`);
  }

  console.log('\n=== 4. 生成提交 ===');
  const tree = await api('POST', `/repos/${me.login}/${REPO}/git/trees`, {
    tree: treeEntries,
  });
  const commit = await api('POST', `/repos/${me.login}/${REPO}/git/commits`, {
    message: 'feat: 每日 GitHub 热门项目榜单（采集 → 快照 → 评分 → 页面）',
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  });

  try {
    await api('POST', `/repos/${me.login}/${REPO}/git/refs`, {
      ref: `refs/heads/${BRANCH}`,
      sha: commit.sha,
    });
  } catch (e) {
    if (e.status === 422) {
      await api('PATCH', `/repos/${me.login}/${REPO}/git/refs/heads/${BRANCH}`, {
        sha: commit.sha,
        force: true,
      });
    } else {
      throw e;
    }
  }
  console.log(`   ✓ 提交 ${commit.sha.slice(0, 7)} 已写入分支 ${BRANCH}`);

  console.log('\n=== 5. 开启 GitHub Pages ===');
  try {
    await api('POST', `/repos/${me.login}/${REPO}/pages`, { build_type: 'workflow' });
    console.log('   ✓ Pages 已启用（构建方式：GitHub Actions）');
  } catch (e) {
    if (e.status === 409) {
      console.log('   ℹ Pages 之前已经启用过，跳过');
    } else {
      console.log(`   ⚠ 自动启用未成功（HTTP ${e.status}）：${e.message}`);
      console.log('     可手动开启：仓库 Settings → Pages → Source 选 “GitHub Actions”');
    }
  }

  console.log('\n=== 完成 ===');
  console.log(`   仓库地址：${repo.html_url}`);
  console.log(`   榜单地址：https://${me.login}.github.io/${repo.name}/`);
  console.log('\n   首次部署需 1–3 分钟，Actions 跑完后榜单链接即可打开。');
}

main().catch((e) => {
  console.error('\n✗ 发布失败：', e.message);
  process.exit(1);
});
