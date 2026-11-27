# 截图

README（中英两版）里用的图都在这。**都是真实运行实例的截图** —— 截自一个 `demo-app` 演示工作区
（pi 引擎 + DeepSeek V4.1 Flash），不是 mock，也没有拼图：目录、命令、`+14 −2` 的改动、token 与花费
都是那次真实运行留下的。

> 为什么用演示工作区而不是日常项目：README 是公开的，侧栏里那些项目名和会话标题属于私人工作内容。
> 演示工作区只有两个项目（`demo-app` / `ledger-api`）和几条准备过的会话标题，看起来和真实使用没有区别。

| 文件 | 内容 |
|---|---|
| `0.png` | 首页主图：一个会话的全景 —— 左边项目与会话、中间对话与用量脚注、输入框上方的建议胶囊、右边同一件事的任务画布 |
| `01-chat.png` | 主图：左侧项目与会话、中间过程里的 8 段思考 + 13 次工具 + 24s、右侧同一个仓库里被改过的 `api.ts`（`+14 −2`） |
| `02-answer.png` | 一条回复的完整尾注：markdown 表格、改动文件 chip、这一轮的 in / out / cache / 花费 |
| `03-diff.png` | 文件预览的「改动」视图（与 HEAD 对比，行级红绿） |
| `04-terminal.png` | 内嵌终端（真 PTY）跑 `git status -s` / `git diff --stat` / `ls -l src` |
| `05-models.png` | 模型与供应商：有 key / 已登录的服务商列表 |
| `06-skills.png` | 技能：已装 59 / 启用 29 / 禁用 30，右边是单个技能的摘要与目录文件 |
| `07-mcp.png` | MCP：全局 / 项目两份配置、启停、exposure 档位 |
| `08-subagents.png` | 子代理模板 + 启用开关 + 默认并发 |
| `09-plugins.png` | 插件（pi package）的加载状态与按包停用 |
| `10-voice.png` | 语音：四类事件提示音 + 本地 TTS + 语音输入设置 |
| `11-push.png` | 推送：本机推送状态、目标设备、测试推送 |
| `12-settings.png` | 设置 → 界面：顶栏名称可选**产品名 / 引擎名**，以及顶栏入口勾选 |
| `13-tempchat.png` | 右栏的临时会话：独立通道、不落盘、带「保存为正式对话」 |
| `14-selection-toolbar.png` | 选中一段回复后浮出的工具条（添加到会话 / 标注 / 在临时会话中提问） |
| `15-annotations.png` | 标注之后：正文留 ① 编号徽标，输入框里多出「1 条注释」 |
| `16-mobile.png` | 手机单栏：顶栏入口只留图标、内容满宽、输入框 18px |
| `17-mobile-drawer.png` | 手机上的项目侧栏是覆盖式抽屉 |
| `18-canvas.png` | 画布：agent 把「给 demo-app 加订单导出」拆成 7 个节点 + 7 条依赖 |
| `19-cron.png` | 定时任务面板：任务列表、cron 表达式、下一次触发 |
| `20-computer.png` | 电脑控制：helper 状态、辅助功能与屏幕录制授权 |
| `21-remote.png` | 设置 → 远程：访问密码、登录保护、登录活动 |
| `想想.png` | 「想想」跑完之后的输入框：上方多出建议胶囊，下面是工具行（想想 / 提示词 / 继续 / 总结一下） |

## 怎么重新拍

1. **起一个用演示数据的实例**（不要用日常实例：会把你真实的项目名、会话标题拍进去）。

   ```bash
   # 演示工作区：两个小仓库，其中一个有未提交改动（diff 要用）
   mkdir -p /tmp/pop-agent-demo/{demo-app,ledger-api}

   # 会话目录指向演示目录，真实 ~/.pi 的配置用软链接接回来（面板才有真实数据）
   mkdir -p /tmp/pop-agent-agent/sessions
   for f in models.json models-store.json auth.json provider-keys.json settings.json mcp.json; do
     ln -sf ~/.pi/agent/$f /tmp/pop-agent-agent/$f
   done

   PI_AGENT_DIR=/tmp/pop-agent-agent \
   POP_AGENT_DATA_DIR=/tmp/pop-agent-shots \
   POP_AGENT_CWD=/tmp/pop-agent-demo/demo-app \
   POP_AGENT_ENGINE=pi POP_AGENT_APPROVAL_MODE=allow \
   node dist/server/cli.js -f --no-open -p 25902
   ```

   > `PI_AGENT_DIR` 只把「会话清单」指到演示目录；`~/.pi/agent/*.json` 用软链接接回真实文件，
   > 这样模型 / 技能 / MCP / 插件面板显示的是本机真实配置，而侧栏里只有演示项目。

2. **让对话内容是真实的**：在演示项目里真发一条指令，比如

   ```
   帮我看看 src/api.ts 与 src/store.ts 的接口是否一致，有出入就直接改掉；改完用一句话说明你动了什么。
   ```

   这一轮会留下思考段、工具卡、耗时和花费；再补一句让它改 `src/store.ts`，就有了「改动 1 个文件」chip。
   拍完把这条会话的 jsonl 复制进 `/tmp/pop-agent-agent/sessions/<演示项目>/`，刷新后侧栏能重新点开它。

3. **视口 1440×900、`deviceScaleFactor: 2`**（手机图用 390×844 + iPhone UA），截图前把鼠标移开、
   并临时藏掉右下角浮动的「回到最新」按钮：

   ```js
   await page.addStyleTag({ content: ".jump-bottom{display:none!important}" });
   ```

4. **压图：PNG 量化到 256 色**，文字仍然锐利，体积约为原来的 40%（17 张合计约 2.6 MB）：

   ```bash
   python3 - <<'PY'
   from PIL import Image
   from pathlib import Path
   for p in sorted(Path("docs/screenshots").glob("*.png")):
       Image.open(p).convert("RGB").quantize(
           colors=256, method=Image.MEDIANCUT, dither=Image.NONE
       ).save(p, optimize=True)
   PY
   ```

> 为什么不转 WebP：无损 WebP 反而比 256 色 PNG 大（UI 截图色数本来就少），有损 WebP 会让小字号正文发虚。

几个容易踩的坑（都是拍这一版时踩过的）：

- **面板是模态的**：拍完一个面板要关掉再开下一个，否则顶栏那颗按钮被灰底挡住点不到（脚本里每个面板开一个新页面最省事）。
- **终端要先等 PTY 起来**：`page.keyboard.type(cmd, { delay: 40 })`，否则 `git status` 会变成 `gig tstatus`。
- **别用拖选**：正文里的路径是自动识别的链接，按住拖会变成链接拖拽；三击选整段才能稳定浮出工具条。
- **`git` 要关掉分页器**：`export GIT_PAGER=cat PAGER=cat`，否则截图里是一个 `[END]`。
- **改图必须重拍**：图里的版本号、面板文案、状态栏字段都会随版本变，别只改剪裁。

## 英文版（`en/`）

`README.md` 里那 7 张图在 `en/` 子目录，编号和中文版一一对应，内容也是同一次运行 ——
**只有界面语言不同**：

| 文件 | 用在 |
|---|---|
| `en/10-voice.png` · `en/19-cron.png` · `en/20-computer.png` · `en/11-push.png` · `en/21-remote.png` | 六件能力的语音 / 定时 / 电脑控制 / 推送 / 远程 |
| `en/18-canvas.png` | 画布（同一版计划，节点文案是模型用英文写的） |
| `en/16-mobile.png` | 手机单栏 |

拍法同上，只多两步：

1. **界面语言切成英文**：`localStorage["pop-agent.language"] = "en"`（等价于 设置 → 语言 → English），
   顺手设 `pop-agent.onboarded = "1"` 跳过首启向导 —— 两个都在 `addInitScript` 里做，别指望点 UI。
2. **面板入口**：面板都是**设置弹窗里的 tab**（Voice / Cron / Computer / Push …），
   从底部状态栏最左边那颗「Settings」进去，再点 tab；tab 的英文名见 `SidebarMenu.tsx` 的 `PANEL_LABEL_EN`
   （注意「电脑控制」的 tab 叫 `Computer`，不是 `Computer control`）。

压图没有 PIL 时用 ImageMagick，效果一样：

```bash
magick "$f" -colors 256 -type Palette -define png:compression-level=9 "$f"
```

> 中文版那套 `docs/site/assets/{zh,en}/*.webp` 里，`en/` 曾经是 `zh/` 的逐字节拷贝（英文官网其实一直在用中文截图）。
> 要更新官网英文图，从这里的 `en/*.png` 重新裁切压缩，别再直接 copy 中文那份。
> `en/hero.webp` 已按这条规则从 `docs/brand/hero-en.png` 单独转出（2400×1025，和中文版比例不同，
> 换图时记得连同 `index.html` 里的 `width`/`height` 一起改，否则首屏会跳一下）。

## alt 文案

每张图的替代文本（中英两版、含验收标准）统一在 [`../promotion-assets.md`](../promotion-assets.md) §3。
改图时 alt 要跟着改：**alt 不是图注，是图挂了之后替图说话的那句。**
