# GitHub 趋势榜

自动追踪 GitHub 上**涨得快且干净**的项目。每天定时采集，产出静态榜单页。

**在线榜单 →** https://lulu2222777.github.io/github-trends/

---

## 为什么不看「star 最多」

按 star 总数排序，榜首永远是 `free-programming-books`、`developer-roadmap`、`awesome-*`
这类教程与清单仓库 —— 它们的沉淀量碾压一切，却回答不了「最近有什么值得看」。

本项目换一个口径：**只看增速，并且先把噪音清洗掉。**

页面顶部有一个「按 star 总数排」的对比开关，点开就能直观看到这个差异。

## 它是怎么跑起来的

```
GitHub Search API  ──►  每日快照(SQLite)  ──►  加权评分  ──►  单文件页面
     采集发现              按天留痕             排序去噪         数据内联
```

1. **采集**
   用 GitHub 官方 Search API，按 7 个技术方向 × 2 个时间窗口展开，共 26 条查询拉取候选仓库。
   一次查询即返回 100 个仓库的完整元数据（star / forks / language / license / topics /
   创建时间），无需再逐个补详情。

2. **快照**
   每个仓库每天写一行 `(repo_id, stars, forks, captured_at)` 到时序表。
   「近 7 天涨了多少」由相邻快照相减得出 —— 所以**必须按天留痕**，只存当前值是算不出趋势的。
   同一天重复运行是幂等的（主键 UPSERT）。

3. **评分**
   四个维度先做分位数归一化，再加权合成：

   ```
   总分 = 0.42×日均涨速 + 0.23×相对增幅 + 0.20×项目质量 + 0.15×新鲜度
          命中噪音黑名单则 ×0.3
   ```

   | 维度 | 含义 | 作用 |
   |---|---|---|
   | 日均涨速 | 近 7 天 star 增量 ÷ 天数 | 主信号 |
   | 相对增幅 | 增量 ÷ 当前 star 数 | 让小项目有机会冒头 |
   | 项目质量 | license、topics 数、主页、star/fork 比、活跃度 | 过滤空壳仓库 |
   | 新鲜度 | `1 / (1 + 项目年龄天数 / 180)` | 让新东西有机会出头 |

   分位数归一化是必须的：star 是长尾分布，直接加权会被头部项目碾压。

4. **构建**
   页面的数据与脚本全部内联进单个 `dist/index.html`，零依赖、双击即可打开。

## 目录结构

```
scripts/config.mjs         方向与时间窗配置
scripts/collect.mjs        采集   → data/repos.json
scripts/ingest.mjs         入库   → data/trends.db（SQLite 快照表）
scripts/score.mjs          评分   → data/ranking.json
scripts/build.mjs          构建   → dist/index.html
scripts/publish.mjs        首次发布到 GitHub（走 api.github.com）
web/index.template.html    页面模板
.github/workflows/update.yml   每日定时 + Pages 部署
```

## 本地运行

需要 **Node 22+**（依赖内置的 `node:sqlite`，**不需要 `npm install`**）：

```bash
npm run pipeline      # 采集 → 入库 → 评分 → 构建，一键跑完
```

也可以单步执行：

```bash
npm run collect       # 只采集
npm run store         # 只入库
npm run score         # 只评分
npm run build         # 只构建页面
npm run collect:quick # 只跑「全站」方向，用于快速验证
```

## 自动更新

`.github/workflows/update.yml` 每天 **UTC 01:00（北京时间 09:00）** 自动执行完整流程，
把新的快照与页面提交回仓库，并重新部署到 GitHub Pages。
也可以在仓库的 Actions 页面手动触发一次。

工作流使用仓库自带的 `secrets.GITHUB_TOKEN`，无需配置任何额外密钥。

## 已知限制

- **冷启动**
  首次运行只有 1 天快照，真实的每日增量还无法计算，此时用「star 总数 ÷ 项目年龄」
  作为速度代理（页面顶部会显示提示条）。累计 **2 天以上**快照后自动切换为真实的近 7 天增量，
  star 曲线也会一并出现。

- **数据源单一**
  目前仅使用 GitHub Search API。原计划的 OSS Insight 增长榜接口自 2026-03 起因
  事件采集中断而失效（接口标注 `unavailable_since: 2026-03-01`），不再可用。

- **噪音清洗仍在完善**
  `public-apis`、`freeCodeCamp` 这类「名字不像清单、但本质是清单」的仓库尚未完全覆盖，
  后续计划补充「star 极高但长期未推送」这类特征。

- **不做历史回填**
  历史数据从本项目首次运行开始积累。若需要更长的曲线，可接入 GH Archive
  （BigQuery 公开数据集）补齐。

## 数据来源

全部来自 GitHub 公开 API，仅供学习与研究使用。
