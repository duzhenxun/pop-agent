# 投放文案（三篇定稿，一篇只打一个差异点）

> 用法：**每个渠道只发对应那一篇**，不要把三篇揉在一起。三篇分别打三个不同人群：
> 中文社区打「混用多个 agent」，Show HN 打「local-first / 不用数据库」，X 打「中途插话」。
> 链接里的 UTM 按 `docs/promotion-links.md` 的约定替换（`utm_medium` / `utm_campaign` 别省），
> 两周后才能回答「哪条带来了真实安装」。
>
> 状态：已按 **v0.1.8** 核对（5 个引擎、Node ≥ 22.19、dmg 仅 Apple Silicon）。

---

## 一、中文社区（V2EX 分享创造 / Linux.do / 掘金）

**差异点：多引擎同框，不用给每个 agent 各装一个界面**

**标题**：`[开源] 我给本机在跑的 coding agent 做了个统一网页：pi / Codex / Claude Code / opencode 一个界面管`

**正文**：

事情是这样的：我现在手上同时用着 pi 和 Codex，偶尔还开 Claude Code。每个 agent 都有自己的一套终端界面，切来切去很烦——想看某个会话跑到哪了，得先想起来它是在哪个工具里开的。

所以就写了 pop-agent：一个跑在本机的网页工作台，把这几个 agent 放进同一个界面。

几个我觉得还不错的点：

- **各跑各的原生 loop**，不是套壳。pi 走原生 SDK，Codex 走 app-server，DeepSeek Harness / opencode / Claude Code 走 ACP。引擎没有的功能界面直接隐藏，不装。
- **过程摊开给你看**：思考块、工具调用（完整命令可复制）、改了哪些文件、token 和花费，都在对话流里。
- **能插话**：pi 引擎下，回合跑到一半可以直接插一句纠正，立刻作为下一条指令；其它引擎走「中断后重发」，效果类似但不是原生 steer。
- **会话就是引擎自己的落盘文件**，不引数据库、不建账号。你 `ls` 一下数据目录，看到的就是引擎写的那些文件。

技术栈 Node + React，MIT 协议。装之前需要 **Node ≥ 22.19**（macOS 也可以直接下 App，里面自带运行时）：

```
npm -g install pop-agent
cd ~/你的项目
pop
```

> 如果你是 macOS 下 App 那份：第一次打开可能被拦（「无法验证开发者」或是「已损坏」），
> 前者右键 →「打开」即可；后者**不要丢进废纸篓**，它没坏，是临时签名和资源对不上，
> `xattr -dr com.apple.quarantine /Applications/PopAgent.app` 就好（README 里有完整两条命令）。

截图和完整文档在 GitHub（默认英文，有中文版）：https://github.com/duzhenxun/pop-agent

想听听大家的意见，尤其是「你还希望它支持哪个 agent」、「不引数据库这件事在你那儿是不是硬需求」。

> 备选标题（更口语）：`受够了一堆 agent 终端切来切去，我做了个统一网页管它们`

**发布前 30 秒检查**：链接用 `utm_source=v2ex`（或 `linuxdo` / `juejin`）+ `utm_medium=post` + `utm_campaign=launch-2026-11`；
贴一张首屏截图；**两个渠道不要同一分钟发**——V2EX 和 Linux.do 的评论区同时炸了你回不过来，间隔 4 小时。

---

## 二、Show HN（英文，周二 UTC 上午发）

**差异点：local-first，会话就是引擎的落盘文件，不引数据库**

**标题**：`Show HN: A local-first web UI for your coding agents – sessions stay on disk, no database`

**正文**：

I run several coding agents on my machine (pi, Codex, DeepSeek Harness, opencode, Claude Code). I wanted a single web page to watch them work, but everything I tried either moved my sessions into its own database or wanted me to sign up for a cloud account.

So I built pop-agent with one hard rule: **the engine's own on-disk files are the only source of truth for a conversation.** The web UI reads them, renames them, deletes them — that's it. No SQLite, no account system, no second copy of your session in our store. `ls` the data directory and you'll see exactly the files your engine wrote.

What it does:
- Multi-engine, each on its native loop (pi via SDK, Codex via app-server JSON-RPC, DeepSeek Harness / opencode / Claude Code via ACP). A capability matrix hides buttons an engine doesn't support instead of faking them.
- Watch the process: thinking blocks, tool calls (full commands, copyable), changed files, tokens and cost.
- Steer a running turn on pi — your message becomes the next instruction, no abort, no restart. Other engines fall back to stop-and-resend.
- Single user, loopback-only by default; remote access requires a password set on the machine first.

Node + React, MIT. `npm -g install pop-agent` (Node ≥ 22.19), or a macOS app that ships its own runtime (Apple Silicon only; it's ad-hoc signed, so the first launch needs right-click → Open).

Repo: https://github.com/duzhenxun/pop-agent
Comparison with other approaches (CloudCLI, Codex WebUI, Pi Web): https://github.com/duzhenxun/pop-agent/blob/main/docs/compare.md

Happy to hear which agent you'd want supported next, or where the "no database" tradeoff breaks down for you.

> **两条评论区纪律**：
> 1. **诚实是最优策略**。多引擎但每个引擎定制不深、单用户不做协作、dmg 只有 arm64 且没做 Apple 签名 ——
>    这些被问到时直接承认，比解释为什么「其实也算支持」加分得多。
> 2. **第一条评论自己补**（发完 3 分钟内）：贴一条「怎么装 + 装坏了怎么办」的短评，
>    把 Gatekeeper 与 Node 版本两个高频问题先讲掉，省下一半回帖成本。

**发布前 30 秒检查**：标题不含感叹号、不含「Show HN: Show HN」；链接 `utm_source=hn&utm_medium=post`；
时间选**周二或周三 UTC 08:00–10:00**（美西前一天晚上、欧洲早上）；别和中文本地社区同日发。

---

## 三、X / 即刻 / 小红书（短内容，一条只讲一个点）

**差异点：回合中途插话（steer），不用等它跑完**

**主推（英文，配 45 秒 demo 或首屏截图）**：

> Your agent is mid-turn going the wrong direction. You can either wait 2 minutes for it to finish, or… just cut in.
>
> pop-agent lets you steer a running turn on pi — your message becomes the next instruction, immediately. No abort, no restart.
>
> Local-first, no database, sessions stay in your engine's own files.
>
> npm -g install pop-agent

**中文短版（即刻 / 微博）**：

> agent 跑到一半发现方向不对，你只能干等它跑完？
> 我写的这个网页工作台在 pi 引擎下支持「插队」：回合进行中直接插一句，立刻作为下一条指令生效，不用中断重开。
> 本机运行、不引数据库，会话就是引擎自己的文件。
> GitHub 搜 pop-agent

**配图**：优先用 45 秒 demo 视频（见 `docs/promotion-assets.md`），退而求其次用 `docs/site/assets/zh/hero.webp`。
**不要**引用历史文案里那个 `selection.webp`——那个文件不存在，是上一版留下的死链。

**发布前 30 秒检查**：`utm_source=x&utm_medium=social`（小红书 `xiaohongshu`+`feed`）；
视频要能静音看懂（字幕已烧），否则这条渠道的完播率会很低。

---

## 附：UTM 链接（发之前照抄，别自己拼）

| 渠道 | 链接 |
|---|---|
| V2EX | `https://pop.xs25.cn/zh?utm_source=v2ex&utm_medium=post&utm_campaign=launch-2026-11` |
| Linux.do | `https://pop.xs25.cn/zh?utm_source=linuxdo&utm_medium=post&utm_campaign=launch-2026-11` |
| 掘金 | `https://pop.xs25.cn/zh?utm_source=juejin&utm_medium=post&utm_campaign=launch-2026-11` |
| Show HN | `https://pop.xs25.cn/?utm_source=hn&utm_medium=post&utm_campaign=launch-2026-11` |
| X | `https://pop.xs25.cn/?utm_source=x&utm_medium=social&utm_campaign=launch-2026-11` |
| 小红书 | `https://pop.xs25.cn/zh?utm_source=xiaohongshu&utm_medium=feed&utm_campaign=launch-2026-11` |

> 上一版这里写的是「落地页是纯静态，UTM 不会被记录」——**这条已经过时**。
> 现在落地页会记首次触达的 `utm_*` 并把它带进每次 CTA 点击（`docs/site/assets/site.js`）。
> 所以带参不再是装饰，而是唯一能让「哪条渠道真的有人装」这件事有答案的手段。
