# 转化路径与渠道归因

> 这份文件回答两个问题：**每条渠道的链接怎么写**，以及**两周后怎么知道它到底带没带量**。
> 落地页能自证的部分已经做进代码里（UTM 首次触达 + CTA 事件），不用每次手改页面。

---

## 0. 当前基线（2026-11-27，改之前先记住这四个数）

| 指标 | 现在 | 在哪看 |
|---|---|---|
| npm 周下载 | **960** | `curl -s https://api.npmjs.org/downloads/point/last-week/pop-agent` |
| dmg 下载 | 每个版本 **1–4 次**（0.1.1→0.1.8 累计约 13 次） | `gh api repos/duzhenxun/pop-agent/releases` |
| GitHub star | 127 | 仓库首页 |
| 落地页 UV | 只有百度统计，没记基线 | 百度统计 → 流量分析 |

**204 倍差**：npm 一周 960，dmg 一个版本 1–4 次。这说明真实的安装路径是**那条命令**，
安装包只是少数人的选择。所以：

- 讲「三行安装」比讲「下载 App」更接近真实用户；
- dmg 下载数**不足以当渠道指标**（1 次也是 1 次，噪声级别）——归因主要看 CTA 点击与 npm 趋势。

> 这也意味着别急着把 npm 命令调成视觉上的主按钮：那是个假设，先用两周的 CTA 事件验证
> `copy-install-command` 和 `download-mac` 的真实比例，再决定要不要换。

---

## 1. 渠道链接怎么写

固定三段：`https://pop.xs25.cn/?utm_source=<渠道>&utm_medium=<形式>&utm_campaign=<批次>`

**`utm_source` 只从下表里选，不要自由发挥**（同一个渠道写出两种拼法，等于两个渠道）：

| 渠道 | utm_source | utm_medium |
|---|---|---|
| V2EX | `v2ex` | `post` |
| Linux.do | `linuxdo` | `post` |
| 掘金 | `juejin` | `post` |
| 小红书 | `xiaohongshu` | `feed` |
| 即刻 | `jike` | `feed` |
| X / Twitter | `x` | `social` |
| Hacker News | `hn` | `post` |
| Reddit | `reddit` | `post` |
| 微信群 / 钉钉群 | `wechat` / `dingtalk` | `im` |
| 邮件签名 / 转发 | `email` | `email` |
| 二维码（海报、PPT） | `qr` | `qr` |

`utm_campaign` 用「批次 + 主题」：`launch-2026-11`、`cn-engines-2026-12`。同一批内容共用一个 campaign，
换稿子只换 content（可选第四段 `utm_content=post-a`），方便对比两版标题。

**现成链接（直接复制）：**

```
V2EX       https://pop.xs25.cn/?utm_source=v2ex&utm_medium=post&utm_campaign=launch-2026-11
Linux.do   https://pop.xs25.cn/?utm_source=linuxdo&utm_medium=post&utm_campaign=launch-2026-11
掘金        https://pop.xs25.cn/?utm_source=juejin&utm_medium=post&utm_campaign=launch-2026-11
X          https://pop.xs25.cn/?utm_source=x&utm_medium=social&utm_campaign=launch-2026-11
Show HN    https://pop.xs25.cn/?utm_source=hn&utm_medium=post&utm_campaign=launch-2026-11
小红书      https://pop.xs25.cn/?utm_source=xiaohongshu&utm_medium=feed&utm_campaign=launch-2026-11
```

> 中文页面同理，把路径换成 `/zh` 即可（`https://pop.xs25.cn/zh?utm_source=...`）。
> **发 GitHub / npm / 微信群时也尽量用带参链接**：不带参的访问全部落到 `(direct)`，那堆数字解释不了。

---

## 2. 埋点做了什么（代码在 `docs/site/assets/site.js` 顶部）

三条约束：不新增第三方脚本、不发新请求、被拦截时静默失效。

| 能力 | 行为 |
|---|---|
| **首次触达归因** | 读 `utm_*` 存 `localStorage["pop.attribution"]`，含 `source/medium/campaign/landing/referrer/firstSeen`。**只记第一次**，老访客换渠道只写 `lastSource` |
| **CTA 事件** | 点 `[data-cta]` 就往百度统计推 `_trackEvent("cta", action, 渠道)` |
| **可读接口** | 页面上任何脚本都能 `window.popAttr().source`；手动补点用 `window.popTrack(action, label)` |

现在标了 `data-cta` 的位置（加新按钮就照这个加属性，不用改 JS）：

| data-cta | 在哪 | 含义 |
|---|---|---|
| `download-mac` | 首屏 .dmg 按钮 | 走安装包 |
| `copy-install-command` | 首屏命令旁的复制键 | 走命令行（**主路径**） |
| `copy-quickstart` | `#install` 的终端块 | 复制了完整三行 |
| `github` | 顶栏 | 去仓库看代码 |
| `nav-install` | 顶栏「开始使用」 | 只想看安装步骤 |

**验证埋点没坏**（本地就能跑，不依赖线上）：

```bash
# 用文件协议打开并带参数，控制台应打印 [cta] copy-install-command v2ex
open -a "Google Chrome" "file://$PWD/docs/site/index.html?utm_source=v2ex&utm_medium=post"
# 然后在 Console 里执行 window.popAttr()
```

---

## 3. 每周怎么看（10 分钟，四个数）

```bash
# 1) npm 周下载（趋势比绝对值重要）
curl -s https://api.npmjs.org/downloads/point/last-week/pop-agent

# 2) dmg 下载（含稳定文件名那个副本）
gh api repos/duzhenxun/pop-agent/releases \
  --jq '.[] | {tag: .tag_name, assets: [.assets[] | {name, d: .download_count}]}'

# 3) star
gh api repos/duzhenxun/pop-agent --jq .stargazers_count
```

4) 百度统计 → **事件分析** → 事件类别 `cta` → 按 **label（= 渠道）** 分组
　（这就是「哪条渠道的人真的动手装了」）

**判读规则（提前定好，免得每周重新争论）：**

| 现象 | 结论 | 动作 |
|---|---|---|
| 某渠道 UV 有、`copy-install-command` 接近 0 | 人不信「装得上」 | 换文案：给终端截图、写清 Node 版本要求 |
| CTA 点击有、npm 周下载不动 | 装了但没跑起来 / 装了没用 | 这比没流量更严重：先补首启引导与 FAQ |
| npm 涨、star 不涨 | 只有下载没有人愿意留证据 | 内容侧问题，去写「为什么值得 star」的帖 |
| 连续两周 0 CTA | 渠道无效 | 砍掉，力气挪到还在涨的那条 |

---

## 4. 已知局限（别自我欺骗）

- **gitee 镜像、Homebrew、别人转发的包**：这些下载进不了上面任何一个数。
- **npm 数字含镜像与 CI**：960/周不等于 960 个人，只能看趋势。
- **first-touch 会被清缓存/无痕抹掉**：那部分落到 `(direct)`，所以 `(direct)` 高不一定代表「自然流量」。
- **不做跨设备归因**：人在电脑上看、在手机上装，链路断在这里；这层成本不值得为一个单用户开源工具付。
  → 结论只下到「哪条渠道的 CTA 点击值得加投」，不下到「某个用户来自哪」。
