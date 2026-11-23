# ADR-0051：桌面 App 模式 —— 内置运行时接进现有服务，不动服务行为

> **分叉说明**：本 ADR 写于上游 oh-my-agent-web（当时 1.5.x），随分叉原样带过来；PopAgent 的版本号从 **0.1.0** 重新起，文中出现的版本号均指上游。

- **状态**：Accepted（2026-11-23 实现，壳未接入）
- **日期**：2026-11-23
- **相关**：ADR-0007（进程与锁）、ADR-0011（数据目录命名）、ADR-0031（CLI `pop` 与远程访问）、ADR-0006（工作区约束）
- **代码**：`server/util/desktop.ts`（纯函数 + 唯一的 `process.env` 写入点）、`server/util/env.ts`（`app` / `runtimeDir`）、`server/index.ts`（PATH 注入、`POP_AGENT_WEB_DIST`、ready 行、锁复用）、`server/cli.ts`、`server/mcp/mcp-auth.ts`、`server/update-prompt.ts`、`server/cli-info.ts`、`server/update-check.ts`

## 背景

用户 2026-11-23：

> 我想让用户下载这个 app，安装后直接能使用。就不需要再从 npm 里下载各种包了。
> 目前网页访问的我需要留着，不动。

把现有工作台塞进一个双击就开的壳，同时**网页访问能力一行都不能变**。两条约束合起来只留下一件事要做：
**运行时从「用户机器上装的 node/npm」变成「壳打进包里的那份」**，而服务逻辑完全照旧。

之前评估过壳的几种形态（Electron / Tauri + node sidecar / node SEA / 瘦启动器）。最后选 Electron：

- 自带 Node，子进程用 `ELECTRON_RUN_AS_NODE` 复用它，不用额外带一份；
- 现有纯 Web 栈零改造（`BrowserWindow.loadURL('http://127.0.0.1:25257')`）；
- 代价是安装包 ~130MB。**壳将来可以换**（Tauri + sidecar 约 45MB），因为这次改造把
  「运行时从哪来」和「服务怎么跑」拆开了，换壳不用碰业务代码。

## 决策

### 1. 三个环境变量，一个开关

| 变量 | 谁设 | 作用 |
|---|---|---|
| `POP_AGENT_APP=1` | 壳 | 桌面模式。**只用来关掉「只对 npm 安装有意义」的动作**，不改变服务行为 |
| `POP_AGENT_RUNTIME_DIR` | 壳 | 内置运行时目录（可多个，按平台分隔符分隔）。POSIX 上认 `<dir>/bin/`，Windows 上直接认 `<dir>` |
| `POP_AGENT_WEB_DIST` | 壳 | 前端目录。App 这边**不猜层级**，壳说在哪就在哪 |

不给这三个变量时，一切与今天完全一致（`npm i -g` / 源码直跑）。

### 2. PATH 必须改 `process.env`，不能只算一个 env 传下去

子进程散在十几处：引擎传输层、终端 pty、MCP、cron、子 agent…… 还有 pty 会继承**整份**环境。
漏一处的表现是「终端里敲 `codex` 找不到」，而各条路径根本不走同一个入口。
所以 `applyDesktopEnv()` 在 `cli.ts`（main 开头）与 `index.ts`（模块顶层）各调一次，直接写
`process.env.PATH`；**幂等**（`prependToPath` 会去重），非桌面模式是空操作。

Windows 上真实变量名是 `Path`：顺着已存在的那个键写，不造第二份。

### 3. `process.execPath` 在 Electron 里是 Electron 本体

`server/cli.ts`（detach 重起）、`server/mcp/mcp-auth.ts`（`pi mcp login`）、
`server/update-prompt.ts`（升级后重跑）都用 `process.execPath` 起「一个 node 进程」。
在 Electron 里那个可执行文件是 Electron：不补 `ELECTRON_RUN_AS_NODE=1`，
`electron cli.js mcp login` 会被 Electron 当成它自己的命令行参数解析，报一个跟业务毫无关系的错。

三处统一换成 `nodeExec()`：有 `process.versions.electron` 或环境里已有该标记时补上它。
两种运行形态都覆盖（server 跑在 main 里 / server 是 `ELECTRON_RUN_AS_NODE` 起的子进程）。

### 4. 关掉三处「npm 自更新」，App 更新归壳

App 的版本由安装包决定：`npm i -g` 既装不到也升不了它，跑完只会让人以为升级失败。于是：

- `checkForUpdate()` 在桌面模式直接返回 `null`（`index.ts` 的启动提示、`cli.ts` 的交互升级都自动跟着停）；
- `pop upgrade` 在桌面模式**明确拒绝**，并指向「App 内检查更新 / 重新下载安装包覆盖安装」；
- `update-prompt.ts` 那条「现在升级吗？」因此不会触发。

### 5. ready 行：壳不用轮询

服务 listen 成功后打一行：

```
__POP_AGENT_READY__ {"port":25257,"pid":1234,"url":"http://127.0.0.1:25257","reused":false}
```

壳读这一行再 `loadURL`，不必轮询 `server.lock` 也不反复打 `/api/health`。
`parseReadyLine` 对脏数据返回 `null`（一行日志不该让壳崩）。**只在桌面模式打**，`pop` 的输出保持原样。

### 6. 锁在别人手里 = 服务已经在了，不是失败

桌面模式启动时如果 `server.lock` 被一个活着的进程持有（用户先敲过 `pop`、或上次关窗没退出），
不再像 CLI 那样报错退出，而是打 `reused:true` 的 ready 行并**退出码 0**：
壳拿到的地址就是那个已在跑的实例。多开窗口共用同一个服务，正是桌面 App 该有的样子。

## 影响与取舍

- **网页 / 局域网访问完全不变**：这只是「运行时从哪来」多了一个来源。`pop` 起的和 App 起的是同一种进程，
  谁先起谁占锁；密码、远程访问、PWA / push 全照旧。
- **`node-pty` 未处理**：Electron 下需要 `electron-rebuild` 对齐 ABI —— 这是壳那边的活，不在本次范围。
- **外部引擎（codex / claude / opencode / dsh）默认不在包里**：见 ADR-0052 ——
  用户机器上已有那份就直接用（不复制、不升级、不改配置）；没有的话**不主动打扰**，
  只在他切换引擎时弹一次界面，点了按钮才装到 `<dataDir>` 这个 npm prefix。
  MCP 的 `npx -y` 是另一回事：那是 npx 自己的缓存行为，前提是内置运行时里必须有 npx，否则 MCP 功能整套不可用。

## 验证

- `tests/unit/desktop.test.ts`：28 条（开关解析、PATH 前置与去重、Windows 的 `Path` / 分隔符差异、
  `ELECTRON_RUN_AS_NODE`、ready 行编解码）。实现被这些用例纠出两个真问题：Windows 不该去试 `bin` 子目录、
  `/` 与 `\` 必须当成同一个分隔符。
- 手工启动两次（`POP_AGENT_APP=1` + 假运行时目录）：第一次 `reused:false` 并输出端口，
  `POP_AGENT_LOG=info` 下能看到「内置运行时已前置进 PATH」及注入的目录；第二次（已有实例）
  `reused:true`、退出码 0。
