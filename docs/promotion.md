# 推广：仓库设置填写清单

这份文件只放**能直接复制粘贴**的东西。策略与渠道排期见讨论记录，不在这里重复。

> 每次发版 / 改定位时回来看一眼：About 和 topics 是仓库**唯一**的被动搜索入口，
> 一次填好之后长期带量，填错或空着等于把流量让给别人的 fork 与镜像。

---

## 0. 现在线上是什么（2026-11-27 已生效，别重复填）

以下均已通过 `gh api` 落地，可以用 §5 那条命令复核：

| 项 | 现在 |
|---|---|
| topics | 10 个：`pi-agent` `coding-agent` `agent-ui` `claude-code` `codex` `opencode` `llm` `local-first` `self-hosted` `web-ui` |
| About | 英文，见 §2 —— **没按下面那个中文推荐版填**，理由见 §2 的说明 |
| Website | `https://pop.xs25.cn/`（带结尾斜杠） |
| Discussions | 已开启 |
| Issue 模板 | `.github/ISSUE_TEMPLATE/` 下 bug.yml / engine.yml / config.yml，`blank_issues_enabled: false` |

两个 API 上的坑（下次换仓库时直接看这里，别再试一遍）：

- **Discussions 没有 GraphQL mutation**：`enableRepositoryDiscussions` 这个字段在 `Mutation` 上不存在。
  能用的是 REST 的**未公开字段**：`gh api -X PATCH repos/OWNER/REPO -F has_discussions=true`。
- **topics 是整组覆盖**：`PUT .../topics` 传 10 个就是这 10 个，不会追加。少传等于删掉。


---

## 1. GitHub Topics（10 个位子，建议填满）

仓库首页右栏齿轮 → Topics。一行一个，粘贴时 GitHub 会按空格/回车切分。

**推荐组合（直接复制这行）：**

```
pi-agent coding-agent agent-ui claude-code codex opencode llm local-first self-hosted web-ui
```

取舍理由：

| topic | 为什么留 |
|---|---|
| `pi-agent` | 差异化最大的一条：pi 引擎深度适配，搜这个的人少但对得上 |
| `coding-agent` / `agent-ui` / `web-ui` | 品类词，Explore 与话题页的主入口 |
| `claude-code` / `codex` / `opencode` | **蹭成熟生态的搜索词**——大家搜的是这些 CLI 的 Web UI，而本仓库确实支持它们 |
| `llm` | 大池子，只做兜底 |
| `local-first` / `self-hosted` | 打「不上云、不建数据库」的人群，也是 awesome-selfhosted 的门槛 |
| `web-ui` | 英文侧常见搜法 |

**不要加的**：`oh-my-zsh` `oh-my-posh` `zsh`（同名前缀但完全无关，反而拉低相关度）、
`vscode`（不是编辑器插件）、`chatbot`（定位不符，来的人会失望）。

---

## 2. About 栏

**Description（仓库首页显示的就是它，2026-11-27 已生效）：**

```
A local web UI for your coding agents: watch the reasoning stream, cut in with a correction mid-turn, manage models and tools. Works with pi, Codex, Claude Code, opencode and DSH. Sessions stay the engine's own files — no database, no account.
```

为什么最终用了英文而不是下面那个中文版：README 是英文优先（中文版是镜像），
GitHub 的搜索与 Explore 面向全球，About 是它唯一吃到的文本。中文版留给中文社区帖子的第一段，
它承担的是「点进来之后」而不是「搜到之前」。

**中文备选（要换的话一条命令，中文社区优先时才用）：**

```
给你正在跑的 coding agent 配一个本地 Web 工作台：看过程、插话纠正、管模型与工具。支持 pi / Codex / Claude Code / opencode，会话就是引擎的落盘文件，不引数据库。
```

```bash
# 换回中文版（或任何版本）：描述直接替换成上面那段即可
gh api -X PATCH repos/duzhenxun/pop-agent -f description="给你正在跑的 coding agent 配一个本地 Web 工作台：看过程、插话纠正、管模型与工具。支持 pi / Codex / Claude Code / opencode，会话就是引擎的落盘文件，不引数据库。"
```

写 About 的两条硬约束：**第一句必须是「品类词 + 给谁用」**（`A local web UI for your coding agents`），
**引擎名字要全**（pi / Codex / Claude Code / opencode / DSH）——搜这些词的人才是会装的人。

**Website 字段（填这个）：**

```
https://pop.xs25.cn/
```

> 别填 npm 页或 README 锚点：这里放**落地页**，落地页上有截图、有安装命令、有 GitHub 链接，
> 从这里进来的人不会直接跳走。Pages 由 `.github/workflows/pages.yml` 发布
> （Settings → Pages → Source 必须选 **GitHub Actions**）。

**要不要勾 Topics / Discussions：**

- Discussions：**开**（Settings → General → Features）。0 issue 的仓库看起来像没人用，
  Discussions 至少给「装了但用不明白」的人一个比 issue 低的门槛。
- Issues：保持开，但**先加两个模板**（Bug、引擎适配请求），否则第一波反馈会全是
  「跑不起来」+ 没版本号没系统信息，回起来很贵。

---

## 3. Social Preview（分享卡片）

路径：Settings → General → Social preview → Upload image

- 用 **`docs/site/assets/og.png`**（1280×630，由 `node scripts/make-og.mjs` 从 `og.svg` 生成）
- 改图：编辑 `docs/site/assets/og.svg`（版式/文案/配色）→ `node scripts/make-og.mjs` → 提交 PNG
- 改完顺手刷新落地页的 `og:image` 绝对地址（`docs/site/index.html`，换域名时一起改）

**验证卡片效果**（发出去之前，别靠想象）：

- X / Telegram / 飞书 等：用 <https://cards-dev.twitter.com/validator> 或直接在群里贴链接看预览
- 微信：贴到「文件传输助手」看缩略图（微信不读 og，会抓第一张图——所以 README 第一张图也别乱放）

---

## 3.5 落地页：能搜到，且第一屏就看懂

路径：`docs/site/`。改页面 = 改这两个 HTML，推到 main 后 `pages.yml` 直接发（没有构建步骤）。

已就位的：

| 件 | 位置 | 为什么 |
|---|---|---|
| `<title>` + `description` | 两个 HTML 的 `<head>` | 搜索引擎结果里显示的只有这两行 |
| 双向 `hreflang` + `x-default` | 两个 HTML + `sitemap.xml` | 只写单向时，另一边会被当作重复内容 |
| `JSON-LD`（SoftwareApplication） | 两个 HTML，**中英各一份** | 让搜索方知道这是免费的开发者工具，不是一个博客；也影响部分富结果展示 |
| `robots.txt` + `sitemap.xml` | `docs/site/` 根 | 告诉爬虫入口在哪，不用它自己猜 |
| 首屏那把 `.lede`（h1 下面那句） | 两个 HTML | **h1 是品牌口号，不是说明**；冷访客靠这一句知道这是什么 |

三条容易被忽略的约束：

- **h1 不负责说清楚产品是什么**。「An external control surface」是语气，不是信息；
  信息交给 `.lede` 和 meta description。所以这两处必须写白话，不写形容词。
- **JSON-LD 两份都要写**，搜索引擎不会拿英文页的结构化数据去描述中文页。
- **`sitemap.xml` 里的 `lastmod` 要跟着改**，改了页面却留着旧日期，重抓会慢一拍。

自检（改完页面后，本地跑一遍）：

```bash
# 结构化数据能解析 + sitemap 是合法 XML
node -e "const fs=require('fs');for(const f of ['docs/site/index.html','docs/site/zh.html']){const m=[...fs.readFileSync(f,'utf8').matchAll(/<script type=\"application\/ld\\+json\">([\s\S]*?)<\/script>/g)];m.forEach(x=>JSON.parse(x[1]));console.log(f,'ld+json ok',m.length)}"
xmllint --noout docs/site/sitemap.xml
```

> `/zh` 这个无扩展名地址在 GitHub Pages 上是 **200**（`/zh.html` 会 308 跳过去），
> 所以 canonical / hreflang 里写 `/zh` 是对的，不用改成 `.html`。

### 部署有两条路，只有一条对着真域名

| 目标 | 怎么发 | 谁会看到 |
|---|---|---|
| `pop.xs25.cn`（真域名） | `wrangler pages deploy docs/site --project-name=pop-agent --branch=main --commit-dirty=true` | 所有人 |
| `duzhenxun.github.io/pop-agent` | 推 main，`pages.yml` 自动跑 | 几乎没人（备份） |

**坑**：推 main 之后 `pages.yml` 显示 ✅，很容易以为上线了——其实真域名一个字没变。
改完页面必须再跑一次 wrangler（或先确认 wrangler 还没接进 CI）。

### 百度现在收不进来（不是本仓库的问题，但会毁掉国内渠道）

`https://pop.xs25.cn/robots.txt` 前面被 Cloudflare 注入了一段托管内容，里面：

```
User-agent: Baiduspider
Disallow: /
```

后果：**百度一条都抓不到**，而落地页只有百度统计，等于国内渠道的数据永远是零。
这是 Cloudflare 后台的开关，改文件没用：

> Cloudflare Dashboard → 选 `xs25.cn` 这个 zone → **Security → Bots / AI Crawl Control**
> → 找到 managed robots.txt（Content Signals / AI crawler blocking）→ 把 **Baiduspider 解除拦截**，
> 或直接关掉这个托管 robots 注入（自己的 `docs/site/robots.txt` 会接管）。

验证（改完应该只看到自己那 6 行）：

```bash
curl -s https://pop.xs25.cn/robots.txt
```

---

## 4. 发版前 5 分钟自查

- [ ] README 顶部的 npm 下载徽章数字在涨（不涨说明渠道没带量，别急着发下一条）
- [ ] About 里的 Website 打得开、且是**最新**落地页
- [ ] topics 里没有拼错（GitHub 不会自动纠错，`selfhosted` ≠ `self-hosted`）
- [ ] 落地页 `og:image` 是绝对地址且能直接打开
- [ ] Issues 模板在位；Discussions 已开
- [ ] 传了 `PopAgent-macOS-arm64.dmg` 这份稳定文件名副本，且官网下载按钮真的 302 到了新版本（见 `docs/release.md` §七）
- [ ] 渠道链接都带 `utm_source`（没带的访问全落 `(direct)`，见 `docs/promotion-links.md`）

---

## 5. 一条命令验证仓库设置（可选的自动检查）

`gh` 已登录时，下面这条能直接确认（只读）：

```bash
gh api repos/duzhenxun/pop-agent \
  --jq '{topics: .topics, about: .description, home: .homepage, has_discussions: .has_discussions}'
ls .github/ISSUE_TEMPLATE/
```

期望：`topics` 有 10 条、`home` 是带结尾斜杠的落地页 URL、`has_discussions` 为 `true`、
templates 目录里有 bug.yml / engine.yml / config.yml。

> 别用 `gh repo view --json repositoryTopics`：那个字段在 CLI 里常常返回 `null`，看不出到底填没填。
