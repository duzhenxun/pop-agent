# 素材定稿：hero、三张功能图、45 秒 demo

> 这份文件解决一个问题：**只看图、不听声音、不认识这个项目的人，能不能在 3 秒内说出它是干什么的。**
> 现有素材的描述都停在「面板里有什么」（`Voice panel: four event cues…`），没有一句说「这东西对我有什么用」。
> 下面是可以直接照着录、照着粘的成品，不是思路。

---

## 0. 验收标准（三条，任何一条不过就不算定稿）

| 检查 | 怎么做 | 不过的表现 |
|---|---|---|
| **3 秒测试** | 把图/视频第 3 秒截给一个不在项目里的人看，问「这是干什么的」 | 答「一个聊天界面」「一个看板」——说明差异点没露出来 |
| **静音测试** | 关掉声音、不看文字说明看完 45 秒 | 不知道发生了什么、不知道和自己有什么关系 |
| **320px 测试** | 把成品缩到手机宽度看 | 字幕小于 2 行读不完、字挤成一片 |

三条的共同前提：**任何一帧里最多只讲一件事。** 想在一张图里同时说「多引擎 + 画布 + 语音」，结果就是什么都没说。

---

## 1. 45 秒 demo：分镜表

**主线排序**（对应 `promotion-copy.md` 三个渠道的差异点，视频只打中间这一条最直观的）：

`看不见过程` → `跑到一半能插话` → `说不清的步骤画成图` → `人走开了有推送`

| 时间 | 画面（用什么素材/怎么录） | 烧在画面上的字幕 | 录制备注 |
|---|---|---|---|
| 0:00–0:03 | 标题卡：深底，一行大字 + 底部小 logo | **「agent 在干活，你看不见过程」** | 不要做片头动画，第一帧就是这句话 |
| 0:03–0:07 | 硬切 `docs/screenshots/01-chat.png` 的真实会话，光标平滑下移 | 「思考、命令、读了哪些文件，全在对话里」 | 这一段就让人看到「过程被摊开」 |
| 0:07–0:14 | 同一会话，**真实输入**一句纠正：「404 直接返回 null 不行，把『接口挂了』和『订单不存在』分开，改完告诉我动了哪几行」 | 「跑到一半，直接插一句纠正」 | 逐字打，不要粘贴；打字速度 ≈ 6 字/秒 |
| 0:14–0:20 | 回车后同一个 turn 继续，新的工具调用出现，没有中断重来 | 「不用等它跑完，也不用重开一轮」 | 关键帧：证明「同一轮里」接住了 |
| 0:20–0:23 | 右栏源码视图滚到改动处，行级红绿 | 「改了哪几行，当场能看」 | 停 2 秒就够，不要长 |
| 0:23–0:31 | 切到画布：输入「用画布把这件事拆成 7 个节点」，右侧节点依次落位、依赖线连上 | 「说不清的步骤，让它画成节点和依赖」 | 节点出现用**真实生成**，不要后期做假动画 |
| 0:31–0:36 | 点其中一个节点 → 状态变「已完成」，连线跟着变色 | 「哪一步容易翻车、哪一步要你拍板，图上分得出来」 | 这是整个视频唯一需要一次点击的动作 |
| 0:36–0:42 | 手机（设备边框）单栏界面 + 顶部弹出推送横幅「demo-app · 订单导出 已完成」，点击横幅 → 回到那个会话 | 「人已经离开电脑，跑完会推到你手机上」 | 这一镜需要补拍，见 §4 |
| 0:42–0:45 | 收尾卡：logo + `npm -g install pop-agent` + 一行网址 | **开源 · MIT · 只跑在 127.0.0.1** | 不要把整段 README 塞进结尾 |

三段结构对得上 45 秒：**15 秒反差（0–15）→ 20 秒能力（15–35）→ 10 秒收尾（35–45）。**

### 字幕写法（静音可读的硬约束）

- 中文单行 **≤ 12 字**，最多两行；英文 **≤ 40 字符**一行。
- 位置固定在画面**底部安全区**（下边距 12%），不要跟界面里的输入框抢位置。
- 字号：在 1920 宽的成片里 ≥ 44px，描边或半透明底板二选一，保证压在浅色界面上也读得清。
- 每条字幕停留 ≥ 2.5 秒——比语速慢，才能被读完。
- **不写形容词**：「强大」「丝滑」「极致」直接删；只写画面里正在发生什么。

### 英文版字幕（同一条时间轴直接换）

| 时间 | 字幕 |
|---|---|
| 0:00 | **Your agent is working. You can't see it.** |
| 0:03 | Thinking, commands, the files it read — all in the transcript |
| 0:07 | **Cut in mid-turn with a correction** |
| 0:14 | No waiting for it to finish, no restarting the turn |
| 0:20 | Which lines changed, right there |
| 0:23 | **Steps it can't say in prose, it draws as nodes and edges** |
| 0:31 | The risky step and the one that needs your call look different |
| 0:36 | You walked away — the finished turn pushes to your phone |
| 0:42 | Open source · MIT · loopback only |

---

## 2. 录制规格与出片

**录制**

- 浏览器窗口固定 1600×1000（`pop` 默认端口 9090），系统显示缩放 100%，不要 Retina 2x 直接录——文件会大到没法用。
- 60fps 录、24/30fps 出；**不要鼠标拖影和点击高亮圈**（看起来像教程，不像产品）。
- 一条 demo 一个干净工作目录（用 `pop-agent-demo/demo-app`），关掉无关通知、书签栏、其他标签页。
- 输入的那句话提前写进 `docs/promotion-copy.md` 的渠道稿里，视频和文案说同一件事。

**出片（一个源，三种裁切）**

| 用途 | 规格 | 说明 |
|---|---|---|
| README / 落地页 | 1600×1000 · H.264 MP4 · **≤ 5 MB** · 无音轨 | 首屏要秒开；另出 poster 静态帧（0:24 那帧最像封面） |
| X / 即刻 | 1280×720 · ≤ 15 MB · ≤ 45s | 静音自动播放，字幕必须已经烧进去 |
| 小红书 / 抖音 | 1080×1920 竖版 · 需单独录一版 | 横版硬转竖版会留巨大黑边；竖版只讲 0:07–0:20 那一段 |

**文件放哪**

```
docs/brand/demo-45s.mp4        # 主片（README / 官网）
docs/brand/demo-45s-720.mp4    # 社媒小体积版
docs/brand/demo-poster.png     # 首帧封面 / 视频 poster
docs/brand/captions-zh.srt     # 字幕（另存一份，别只烧在画面里）
docs/brand/captions-en.srt
```

**README 里怎么放**：GitHub 的 README 不认 `<video src="docs/...">` 这种相对路径。
做法是把 `demo-45s.mp4` 拖进一个 issue（或本次 release 的说明）拿到 `user-attachments` 直链，再写：

```html
<video src="https://github.com/user-attachments/assets/xxx" muted loop playsinline controls width="100%"></video>
```

直链在 issue 里删掉会失效——所以那个 issue 建好之后别关、别删。
退路：README 首屏先放 poster（可点开视频），视频放 release 资产 + 官网。

---

## 3. 图与 alt 文案

验收口径：**alt 不是图注，是「图挂了之后这句还能替图说话」。**
下面每条都同时给出「画面里有什么」和「所以它对我有什么用」。

### 3.1 Hero（`docs/brand/hero-zh.png` / `hero-en.png`）

| | |
|---|---|
| **ZH（现）** | 给你正在跑的 agent，配一个外部操作页：开源 · MIT · 单用户 · 本地优先；右边是同一次真实会话，思考、工具、改动、用量都在同一屏里 |
| **ZH（定稿）** | PopAgent 的界面截屏，地址栏是 127.0.0.1:9090：左栏会话列表，中间一次真实对话——思考块、已跑完的命令、读了哪些文件；右边把同一件事摊成任务画布，跑完的步骤当场标成「已完成」。agent 还是你原本那个，只是过程被搬到了网页里。 |
| **EN（定稿）** | PopAgent at 127.0.0.1:9090: the session list on the left, one real turn in the middle streaming its thinking blocks, finished commands and the files it read, and the same work laid out as a task canvas on the right where finished steps read "已完成". Same agent as before — the process just lives in a web page now. |

### 3.2 功能图一：跑到一半插话（`docs/screenshots/01-chat.png`）

- **ZH**：一回合并未结束：已经跑过 8 段思考、13 次工具调用，底部输入框里刚敲进一句新的纠正；右栏源码同时停在她刚改的那几行上。**说明的是「不用等它说完就能改方向」。**
- **EN**：A turn that is still running: 8 thinking segments and 13 tool calls already done, and a new corrective instruction typed into the composer before the turn ends, with the source pane already on the lines it changed. The point: you can change direction without waiting for the turn to finish.

### 3.3 功能图二：画布（`docs/screenshots/18-canvas.png`）

- **ZH**：对话框里一句「用画布把步骤画出来」，右侧就摊成 7 个节点、7 条依赖：每个节点是一步能做完的动作并自带说明，已经开始的那步挂着待办状态。**说明的是「说不清的步骤，能变成看得见的图」。**
- **EN**：Ask for a plan in chat and the right pane lays it out as 7 nodes and 7 dependencies, each node one concrete action with its own note and its own status. The point: steps that are hard to say in prose become a graph you can check.

### 3.4 功能图三：手机 + 推送（`docs/screenshots/16-mobile.png`）

- **ZH**：手机上的同一套界面：单栏、顶栏只留图标、输入框 18px 所以 iOS 不会自动放大，项目侧栏收成抽屉。**说明的是「出门在外也能接着看同一场会话」。**
- **EN**：The same workbench on a phone: single column, icon-only top bar, 18px composer so iOS doesn't zoom, project sidebar collapsed into a drawer. The point: the same session, away from the desk.

> ⚠️ 这一张**只拍到布局，没拍到推送本身**。而视频 0:36 那一镜要的是「手机上弹出通知」——这是本次素材里唯一**必须补拍**的图。补拍要求：真机锁屏或应用内横幅，通知标题是项目名、正文是会话名，点开能落到那个会话；不要用设计稿合成。

### 3.5 现有 alt 的通病（顺手对照）

| | 写法 | 问题 |
|---|---|---|
| ✗ | `Voice panel: four event cues and local TTS settings` | 描述控件，不说明为什么值得看 |
| ✓ | 「语音面板：开始/结束/出错/等审批各有提示音，语音走 macOS 本地，不出网也不花钱」 | 同上画面，但说清了代价和收益 |

规则：**alt ≤ 160 字（中）/ ≤ 240 字符（英）**，第一句说「这是什么」，第二句说「所以呢」。品牌名不进 alt 开头的图，前面已经出现过就不重复。

---

## 4. 待办（本步的收尾清单）

- [x] 分镜表 + 中英烧录字幕定稿（已落成 `docs/brand/captions-{zh,en}.srt`）
- [x] 四张图的中英 alt 已粘回 `README.md` / `README.zh.md` / `docs/site/index.html` / `docs/site/zh.html`
- [x] 英站 hero 用错图已修：从 `docs/brand/hero-en.png` 转出 `docs/site/assets/en/hero.webp`（2400×1025），`index.html` 的 `src` 与 `width/height` 同步改了
- [ ] **录 45 秒主片**（照 §1 分镜表逐条对），出 1600×1000 ≤5MB + 720p 社媒版
- [ ] 拖进 issue 拿 `user-attachments` 直链，换到 README hero 图下面（hero 图保留）
- [ ] **补拍「手机上收到推送」这一张**（§3.4）——本次素材里唯一必须新拍的图
- [ ] 三篇渠道稿（`promotion-copy.md`）里的截图引用换成新图

> 剩下三项都要真实运行、真实录屏，属于「必须人坐在电脑前做」的部分；
> 文案和规格已经封版，录的时候直接照表对，不要再改字幕。
