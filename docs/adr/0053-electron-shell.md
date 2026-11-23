# ADR-0053：Electron 壳 —— 只负责「起服务、等它说行、开窗口、托盘」

> **分叉说明**：本 ADR 写于上游 oh-my-agent-web（当时 1.5.x），随分叉原样带过来；PopAgent 的版本号从 **0.1.0** 重新起，文中出现的版本号均指上游。

- **状态**：Accepted（2026-11-23 实现；**未**签名公证、未出安装包）
- **日期**：2026-11-23
- **相关**：ADR-0051（桌面模式与内置运行时）、ADR-0052（引擎检测/安装）、ADR-0007（进程与锁）、ADR-0031（远程访问与密码）
- **代码**：`electron/main.ts`、`electron/tsconfig.json`、`electron-builder.yml`、`package.json`（`main` / `app` 脚本）、`.npmrc`（放行 electron 的安装脚本）

## 背景

ADR-0051 把服务端改成了「桌面模式」，ADR-0052 把引擎缺失处理完了。这一片是把它们装进一个
双击就能开的窗口里：用户 2026-11-23「想双击 App 打开」「网页访问要留着」。

## 决策

### 1. 壳只做四件事，没有 preload、没有 IPC

1. spawn `dist/server/cli.js`；
2. 读它 stdout 里的 `__POP_AGENT_READY__ {json}`；
3. `BrowserWindow.loadURL(url)`；
4. 托盘（本来在浏览器里得自己去找的东西：地址、密码、数据目录）。

**刻意不写 preload**：页面需要的一切都走它自己的 HTTP/WS。少一层 IPC 就少一类可被页面利用的面
—— 这个页面会渲染 agent 输出的内容，能少给一点权限就少给一点。真要加特权接口，再按最小面开，
不要为了「以后方便」先铺一层通用的 `invoke`。

### 2. Electron 自带的 node **不能**用来跑服务（实测踩出来的）

Electron 33 内嵌 node **20.18**，而工作台 `engines` 要求 ≥ 22.19。第一版壳直接用
`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 起服务，表现是：**窗口开了、服务没起、什么都没有**
—— 子进程崩了，壳在等 ready 行，用户看到一片空白。

**到底要不要把 node 打进包里？** 用户 2026-11-23 追问过两次（「为什么要把 node 打包进去」
「用户电脑有 node 24 也应该可以吧」）。结论：**不是非带不可**，但要有兜底，于是做成
「先实测、后选择」：

`nodeCommand()` 会拿候选逐个**真跑一句自检**（`node -e`：版本 ≥22.19、`zlib.zstdDecompressSync`
在、`node-pty` 能 require），谁能跑用谁：

| 顺序 | 来源 | 备注 |
|---|---|---|
| 1 | `POP_AGENT_NODE_BIN` | 用户 / 脚本显式指定 |
| 2 | `resources/node-runtime`（包里带的） | 由 `npm run runtime:fetch` 准备 |
| 3 | `~/.pop-agent/node` | install.sh 装的那份 |
| 4 | PATH 里的 `node`（**用户自己的**） | 有就不必再多带一份 |
| 5 | Electron 自己 | 兜底，版本多半不够，报错里会写清原因 |

为什么要自检而不是只看版本号：`node:zlib` 的 zstd 是 22.15 才有的 API，光比版本号会漏掉
「版本够但 API 不在」；`node-pty` 虽然能跨版本加载（N-API），但实测一次最踏实 ——
真的加载不进来时，报错会指向「node-pty 加载不了」而不是笼统的启动失败。

于是产物有两种，功能完全一样，区别只在「机器上没有合格 node 时能不能起来」：

| 命令 | 带运行时 | dmg | 装好占用 |
|---|---|---|---|
| `npm run app:dist` | 是 | **153MB** | 471MB |
| `npm run app:dist:thin` | 否 | **115MB** | 350MB |

Node 运行时在下载体积上值 **38MB**（解压 124MB）。用户机器上普遍有 node 22+（Node 24 也行，
自检会认），所以 thin 版对大多数人是够的；「下载即用、不管用户环境」的正式分发用带运行时那版。

### 8. 瘦身：三刀下去从 185MB 到 153MB（另有 thin 到 115MB）

| 动作 | 省多少（解压） | 怎么做的 |
|---|---|---|
| 裁 sourcemap + 类型声明 | 49MB | `scripts/prepare-package.mjs` 只删 `.map` / `.d.ts` / `.tsbuildinfo` |
| node-pty 只留当前平台 | 44MB | 它默认带 4 个平台的预编译二进制 |
| **排除 asar 里重复的 node_modules** | 94MB | `files: ["!node_modules/**/*"]` |
| Electron 语言包只留中英 | 27MB | `electronLanguages: [en, zh_CN]` |

两条教训（都是实测踩出来的）：

- **裁剪不能碰目录**：第一版连 `doc/`、`test/`、`*.md` 一起删，服务直接起不来 ——
  `yaml` 包里有个 `doc/` 目录是**真代码**（`require("../doc/directives.js")`），pi 也可能读自己的
  `.md` 模板。现在只删「绝对是构建产物」的东西，目录一个不动（省下的 4MB 不值得）。
- **打包脚本要能自己发现这类错**：`prepare-package.mjs` 最后会按打包后的布局
  （`dist` + `web/dist` + `node_modules` 同级）**真起一次服务**，看到 ready 行才算过。
  20 秒代价，换掉「窗门开了服务没起」这一类只有用户才会碰到的事故。

**Electron 的体积地板 ≈ 105–115MB（thin）**：其中 ~90MB 是 Chromium 压缩后的固定成本，
我们自己那部分（依赖 + 前端 + 服务代码）只占 ~25MB。要把安装包压到 100MB 以内，
只能换掉 Chromium —— 即回到 Tauri / Wails 那类「用系统 WebView」的壳
（同一份 node_modules + node 运行时，估 thin ~40MB、带运行时 ~75MB）。

这条也顺便解决了一个原本的担忧：**服务跑在真 node 进程里，`node-pty` 的 ABI 跟着 node 走，
不需要 `electron-rebuild`**。原生模块只要跟运行时同版本就行，跟 Electron 无关。

### 3. 单实例，两层挡

`app.requestSingleInstanceLock()`：第二次双击只把已有窗口拿到前面。服务层还有 `server.lock`
（ADR-0007）。两层都留着是故意的 —— 壳挡的是体验（别开两个窗口），服务挡的是数据（别写两遍）。

另外，如果锁在**别的进程**手里（用户先敲过 `pop`），服务会打 `reused: true` 的 ready 行然后退出 0
（ADR-0051 §6）。壳照着那行 `loadURL` 就行，不把「已有实例」当失败。

### 4. 托盘承担「浏览器里才做得到的事」

打开主窗口 / 在浏览器里打开 / 复制本机地址 / 复制访问密码（读 `<dataDir>/password`，ADR-0031）/
打开数据目录 / 退出。Windows 上单击托盘图标直接开窗；mac 上保持点开菜单。

### 5. 关窗语义：mac 收起、其它退出

mac 关窗只是 `hide()`（服务继续跑，托盘还在），Cmd+Q / 托盘「退出」才真的走；
Windows / Linux 关窗即退出（没有托盘常驻的习惯，留着服务反而让人以为没关掉）。
退出前 `SIGTERM` 服务进程，5 秒不退就 `SIGKILL` —— 它有锁和 pty 子进程，直接断电会留孤儿。

### 6. 打包：服务和前端放 asar 外

`electron-builder.yml` 里 `dist/` 与 `web/dist/` 走 `extraResources`：服务是 spawn 出去的独立进程，
让它从 asar 里读前端属于给自己找麻烦，也让用户看得见文件在哪。整份**生产** `node_modules`
也放进去（`resources/node_modules`），从 `resources/dist/server/cli.js` 往上找正好命中 ——
只拷 `@earendil-works` 是不够的，pi 自己还有一堆传递依赖。

不出 universal 包：arm64 / x64 各出一份（合并会翻到 ~250MB）。

### 7. npm 11 的安装脚本策略

npm 11 起安装期脚本默认不放行，而 electron 的 `postinstall` 必须下载运行时二进制。
放行名单同时写在两处：项目 `.npmrc`（npm 自己指的那条路，带注释说明为什么只有这几个）与
`package.json` 的 `allowScripts`（另一条路，兼容不同 npm 版本）。两处都只列
`electron` / `electron-builder` / `app-builder-bin`（外加本来就要跑脚本的 `esbuild` / `node-pty`），
不写成全局放开。

另外：这台开发环境的 `npm_config_allow_scripts` 环境变量会让**项目内**安装直接报
`EALLOWSCRIPTS`（npm 认为命令行参数只该用于全局/npx）。跑安装时用
`env -u npm_config_allow_scripts npm install …` 绕开即可，与仓库本身无关。

## 未做的事（下一步）

- **签名与公证**：mac（Developer ID + notarytool）与 Windows（Authenticode）。
  不做的话用户双击就被 Gatekeeper / SmartScreen 拦下，等于不能分发。
- **自动更新**：electron-updater + dmg/nsis feed（`update-check.ts` 在桌面模式已经不查 npm 了）。
- **CI 出包**：mac arm64/x64 + win x64，带签名 secrets 与干净机器冒烟。
- **Windows 实测**：本次只在 macOS 上跑通（服务起来、页面 200、退出不留孤儿）。

## 验证

- `npx tsc -p electron/tsconfig.json` 通过；`electron .` 在 macOS 上：ready 行解析成功 →
  窗口加载 `http://127.0.0.1:<port>` → `GET /` 200、`GET /api/engines` 正常返回。
- 关掉壳之后端口不再响应（服务被一起收掉，没有孤儿进程）。
- 踩到的坑已在 §2 固化：换成 PATH 里的 node 之后一次就通。
- **打包实跑**（未签名 dmg，`CSC_IDENTITY_AUTO_DISCOVERY=false`）：
  - 带运行时版 185MB：挂载后直接开 App → `GET /` 200，进程树里服务用的是
    `Contents/Resources/node-runtime/bin/node`（确认走的是包里那份）；
  - thin 版 147MB：同样 200，服务用的是 **用户自己的 `node`**（PATH），确认候选链生效。
- 打包时踩到两个坑，都已写进配置：electron-builder 默认按 Electron ABI 重编原生模块
  （会卡在 node-gyp / distutils），必须 `npmRebuild: false`；`extends` 会**合并**数组，
  导致 node_modules 被拷两遍并撞 EEXIST，所以 thin 版用完整配置而不是 extends。
