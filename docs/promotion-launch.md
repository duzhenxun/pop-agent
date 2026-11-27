# 首发排期：两周，三个渠道，一个目标

> 目标不是「发出去」，是**拿到第一批「跑不起来」的真实反馈**，并且在 24 小时内接住。
> 首发当天回帖的那个人，直接决定这个仓库后面的口碑。
>
> 稿子在 `docs/promotion-copy.md`（已按 v0.1.8 定稿），渠道链接约定在 `docs/promotion-links.md`。

---

## 0. 一条硬依赖：X / 小红书 排在 demo 录屏之后

短视频渠道看的是画面，不是文字。`docs/promotion-assets.md` §1 里那支 45 秒 demo 没录完之前，
**不要发 X**——发一张静态首屏图等于浪费这条渠道的第一印象。

所以顺序是：先中文本地社区（文字能自证）→ Show HN → 录完 demo 再发 X。

---

## 1. 排期表

| 时间 | 动作 | 产出 / 检查 |
|---|---|---|
| **D-3** | 按 `docs/promotion-assets.md` 录 45 秒 demo；补「手机上收到推送」那张图 | 1600×1000 ≤5MB mp4 + 720p 社媒版 + poster |
| **D-3** | 把 `docs/promotion.md` §4 的自查清单走一遍 | topics / About / Discussions / issue 模板 / dmg 稳定副本 / utm 全绿 |
| **D-2** | ~~在 Discussions 发第一帖：`装机问题集中帖`~~ **已发**：<https://github.com/duzhenxun/pop-agent/discussions/2> | issue 模板的 config.yml 已指向它；首发当天所有「跑不起来」都往这里导，不要让它们散在 issue 里 |
| **D-1** | 自己用一台干净环境（或新用户）走一遍三行安装 | 记录实际摩擦点，写进 FAQ；**这一步会改变你的回帖模板** |
| **D-day 10:00** | V2EX 分享创造 发中文稿 | 链接带 `utm_source=v2ex&utm_medium=post&utm_campaign=launch-2026-11` |
| **D-day 14:00** | Linux.do 发同一篇（间隔 4 小时） | `utm_source=linuxdo`；两个区同时炸你回不过来 |
| **D-day 全天** | 4 小时内守帖；每 2 小时看一次 | 见 §3 回复模板 |
| **D+1 09:00** | Show HN（周二/周三 UTC 08:00–10:00 最佳） | `utm_source=hn`；发完 3 分钟内自己补第一条评论 |
| **D+2** | 录完的 demo 发 X + 小红书/即刻 | `utm_source=x` / `xiaohongshu` |
| **D+3** | 把三天内所有重复问题收进 FAQ + Discussions | 第二波的转化率全靠这一步 |
| **D+7** | 第一轮复盘：三个数 | 见 §4；无效渠道直接砍 |
| **D+14** | 双周版本发出去（把反馈里最痛的一条做掉） | release notes 顺手改写成一条短帖，这是最便宜的内容 |

**别做的事**：同一天发三个渠道（回不过来）、发完不回帖（比不发更伤）、
把同一篇稿子粘贴到所有渠道（每个渠道的人重合度比你想象的高）。

---

## 2. 当日 checklist（每发一条之前 30 秒）

- [ ] 链接点开是**带 utm 的**，落地页首屏能看懂这是什么
- [ ] 帖子里写了**前置条件**：Node ≥ 22.19 / macOS App 仅 Apple Silicon
- [ ] 帖子里预埋了 Gatekeeper 那句（能挡掉一半「跑不起来」）
- [ ] 配图/视频是当前版本（0.1.8）的界面，不是旧截图
- [ ] 自己那条「安装 + 装坏了怎么办」的补充评论已经写好，发完 3 分钟内贴上
- [ ] 手机上看一眼排版（大部分人是手机刷到的）

---

## 3. 回复模板（直接粘贴，改两句就能用）

### ① macOS 打不开（最高频，占一半以上）

```
这俩提示是两个不同的修法：

「无法验证开发者」→ 右键图标 →「打开」，一次就行（macOS 15 之后也可以在
系统设置 → 隐私与安全性 → 仍要打开）。

「已损坏，应移到废纸篓」→ 不要丢，它没坏。是临时签名和资源对不上，跑这两条就好：

codesign --force --deep --sign - /Applications/PopAgent.app
xattr -dr com.apple.quarantine /Applications/PopAgent.app

（目前没做 Apple 开发者签名，所以每次大版本装完可能还要来一次。这是我的取舍，不是你的问题。）
```

### ② Node 版本 / 命令找不到

```
先看版本：node -v
需要 ≥ 22.19（引擎的 SDK 用到了新版 Node 的 API）。低于这个版本 `pop` 会直接报错而不是降级运行。

不想动全局 npm 的话：
curl -fsSL https://raw.githubusercontent.com/duzhenxun/pop-agent/main/scripts/install.sh | sh
（装到 ~/.pop-agent，不需要 sudo）
```

### ③ 端口被占 / 起不来

```
默认只听 127.0.0.1:9090。换个端口：
pop -p 9191

看看当前状态（pid / 端口 / 引擎 / 会话数 / 工作区）：
pop status

还有残留进程就 pop stop 再起。
```

### ④ 面板是空的 / 某些按钮没有

```
面板空着通常是那个引擎还没登录或没配 key：切到 Codex，面板读的就是 Codex 自己的配置，
不会借 pi 的（这条是刻意的设计，免得你以为是同一份数据）。

按钮不存在而不是灰掉，是能力矩阵：那个引擎没这个能力，界面就不画。
比如子代理面板只有 pi 有，steer 只有 pi 是原生的（其它引擎是中断后重发）。
```

### ⑤ Intel Mac 装了打不开 / Linux 终端报错

```
dmg 只有 arm64（Apple Silicon）。Intel 机器走 npm 那条：
npm -g install pop-agent

Linux 上内嵌终端要现场编译 node-pty，缺 make/g++/python3：
curl -fsSL .../scripts/install.sh | sh -s -- --with-build-tools
```

### ⑥ 「这和 XX 有什么区别」

```
我在 docs/compare.md 里按四个维度核对过（会话的事实源放哪、要不要账号、支持几个引擎、
本机还是云），结论是「没有全方位的赢家」：
只用 Claude Code 想要功能全的界面 → CloudCLI 更合适；
混用多个引擎、或不想引数据库 → 这个更合适。
```

> 模板的作用是**别在现场组织语言**。真遇到没准备过的问题，先回一句「收到，我查一下」，
> 24 小时内给结论——这比硬编一个答案强。

---

## 4. 三天后看什么（只回答一个问题：值得再发一次吗）

| 数 | 在哪 | 看什么 |
|---|---|---|
| 落地页 UV | 百度统计 · 流量分析 | 渠道有没有把人带来 |
| CTA 点击 | 百度统计 · 事件分析 → 类别 `cta` → 按 label 分组 | **哪条渠道的人真的动手装了** |
| npm 周下载 | `curl -s https://api.npmjs.org/downloads/point/last-week/pop-agent` | 基线 960/周，涨幅要能看出来 |

判读规则写在 `docs/promotion-links.md` §3，别现场发明标准。

**结束条件**：三个渠道都发完、D+14 复盘做完、无效渠道已砍 —— 这一波才算结束。
首发只是把门打开，能不能留住人看的是 D+3 那个动作（把重复问题收进 FAQ）。
