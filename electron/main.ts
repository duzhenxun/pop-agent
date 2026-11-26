/**
 * Electron 壳的主进程（ADR-0053）。
 *
 * 这个壳很薄，只有四件事：
 *   1. **起服务**：spawn `dist/server/cli.js`（桌面模式下，ADR-0051）；
 *   2. **等它说行**：读 stdout 里那行 `__POP_AGENT_READY__ {json}`，拿到真正可用的 URL 再加载
 *      —— 不轮询锁文件、不反复打健康接口，也不会白屏；
 *   3. **开窗口**：`BrowserWindow` 直接加载 `http://127.0.0.1:<port>`。UI 就是**那个网页**，
 *      一份代码同时服务 App 和浏览器（用户要求「网页访问要留着」）；
 *   4. **托盘**：本来该在浏览器里做的事（复制局域网地址/密码、打开数据目录）挪到托盘里。
 *
 * 刻意**没有 preload / IPC**：页面需要的一切都走它自己的 HTTP/WS 接口，壳不需要给渲染进程
 * 开任何特权通道。少一层 IPC 就少一类可被网页利用的面（这页面跑的是本机服务，但它会渲染
 * agent 输出的内容，能少给一点权限就少给一点）。
 *
 * 单实例：第二次双击只把已有窗口拉到前台（`requestSingleInstanceLock`），而不是再起一个服务
 * —— 服务层也有 `server.lock` 兜着（ADR-0007），两层都挡是故意的：这里挡的是「体验」，
 * 那里挡的是「数据」。
 */
import { app, BrowserWindow, Menu, Tray, clipboard, dialog, nativeImage, screen, shell } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND_NAME } from "../server/brand.js";
import { DEFAULT_DATA_DIR_NAME } from "../server/util/env.js";
import { parseReadyLine, type ReadyInfo } from "../server/util/desktop.js";
import { packageMeta } from "../server/util/version.js";

const isMac = process.platform === "darwin";
/** 等服务的上限：装机 / 首次索引会话可能慢，但超过这个数就是真出问题了 */
const READY_TIMEOUT_MS = 60_000;

/** 所有还活着的窗口（多窗口：每个窗口一个独立的客户端会话，见 ADR-0033） */
const windows = new Set<BrowserWindow>();
/** 最后聚焦的那个：托盘「打开主窗口」、第二个实例、`activate` 都找它 */
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverChild: ChildProcess | null = null;
/** 服务真正在用的地址（复用别人的实例时也是它） */
let serverUrl: string | null = null;
/** 主动退出（托盘「退出」/ Cmd+Q）：用来区分「关窗」和「真的要走」 */
let quitting = false;

/**
 * 加载失败 / 服务掉了时给的「说人话」页面 —— 不要留一片黑。
 *
 * 为什么要有（用户 2026-11-25：「这个项目 app 老黑屏是怎么回事」）：
 * 壳里窗口的底色是 #141414，页面没加载出来时就是一块深灰，既没报错也没提示；
 * 而最常见的触发条件是 **服务进程不在了** —— 桌面模式会复用已在跑的实例（POP_AGENT_APP=1），
 * 那个实例往往是用户在终端里敲的 `pop`，一按 Ctrl-C 服务就没了，窗口还开着。
 *
 * 这里不弹对话框（弹了也没法自己恢复），直接换成一个会自动重试的提示页。
 */
function offlinePage(reason: string): string {
	const safe = reason.replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char] ?? char);
	const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>${BRAND_NAME}</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #141414; color: #e8e8e8; font: 14px/1.7 -apple-system, "PingFang SC", system-ui, sans-serif }
  .box { max-width: 560px; padding: 0 28px }
  h1 { font-size: 17px; margin: 0 0 10px; font-weight: 600 }
  p { margin: 0 0 8px; color: #b9b9b9 }
  code { background: #ffffff14; padding: 1px 6px; border-radius: 5px; font-size: 12.5px }
  .reason { color: #ff9f7a; word-break: break-all }
  .tip { margin-top: 14px; font-size: 13px; color: #8d8d8d }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #4f7cff;
         margin-right: 6px; animation: blink 1.2s ease-in-out infinite }
  @keyframes blink { 50% { opacity: .2 } }
</style>
<div class="box">
  <h1>工作台没连上后端服务</h1>
  <p class="reason">${safe}</p>
  <p class="tip"><span class="dot"></span>正在自动重试，服务回来后会自动打开…</p>
  <p class="tip">常见原因：在终端里跑着的 <code>pop</code> 被 Ctrl-C 关掉了；或者服务启动失败（看 <code>~/.pop-agent/logs/pop-agent.log</code>）。</p>
</div></html>`;
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** 重试定时器：一个窗口一个 */
const retries = new WeakMap<BrowserWindow, NodeJS.Timeout>();

/** 把窗口换到「没连上」页，并开始每 1.5 秒重试一次（成功就停） */
function showOffline(window: BrowserWindow, reason: string): void {
	if (quitting || window.isDestroyed()) return;
	void window.loadURL(offlinePage(reason));
	if (retries.has(window)) return;
	const timer = setInterval(() => {
		if (quitting || window.isDestroyed()) {
			clearInterval(timer);
			retries.delete(window);
			return;
		}
		const target = serverUrl;
		if (!target) return;
		window.webContents
			.executeJavaScript(
				`fetch(${JSON.stringify(target)}, { method: "GET" }).then((r) => r.ok).catch(() => false)`,
				true,
			)
			.then(
				(ok: unknown) => {
					if (ok === true) {
						clearInterval(timer);
						retries.delete(window);
						void window.loadURL(target);
					}
				},
				() => undefined,
			);
	}, 1500);
	retries.set(window, timer);
}

function dataDir(): string {
	const fromEnv = process.env.POP_AGENT_DATA_DIR;
	return fromEnv && fromEnv !== "" ? resolve(fromEnv) : join(homedir(), DEFAULT_DATA_DIR_NAME);
}

/**
 * 打包后资源在 `process.resourcesPath`（见 electron-builder.yml 的 extraResources）；开发态在仓库根。
 *
 * **不能只信 `app.getAppPath()`**（2026-11-23 踩到）：为了让 Dock 显示 PopAgent，我们把开发态的壳
 * 从 `Electron.app` 改名成了 `PopAgent.app`（见 `scripts/app-name.mjs`）。改名之后 Electron
 * 把「应用路径」认成了包里的 `Contents/Resources`，于是 `app.getAppPath()` 指向一个没有
 * `dist/` 的目录 —— 启动时报「没找到服务入口 …/PopAgent.app/Contents/Resources/dist/server/cli.js」。
 *
 * 现在按**文件位置**推开发态的仓库根：本文件编译后在 `<repo>/electron-dist/electron/main.js`，
 * 往上两级就是仓库根；那里确实有 `dist/server/cli.js` 就用它，否则才回落到 `process.resourcesPath`。
 */
function resourcesRoot(): string {
	const devRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	if (existsSync(join(devRoot, "dist", "server", "cli.js"))) return devRoot;
	return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

function serverEntry(): string {
	return join(resourcesRoot(), "dist", "server", "cli.js");
}

function webDist(): string {
	return join(resourcesRoot(), "web", "dist");
}

/**
 * 用哪个 node 跑服务 —— **不猜，逐个实测**。
 *
 * 为什么不能只看版本号：工作台用到 Node 22 才有的 API（`node:zlib` 的 zstd 解码就是硬依赖），
 * 而 Electron 自带的是 20.18；用户机器上还可能是 18、20、23… 光比版本号容易漏掉
 * 「版本够但 API 不在」的情况。所以这里让候选者**自己跑一句**再说：
 *   - `node` 版本 ≥ 22.19；
 *   - `node:zlib` 的 `zstdDecompressSync` 在（否则 DSH 会话读不出来）；
 *   - `node-pty` 能 `require` 进去（原生模块；好在它是 N-API 编的，跨 node 版本可加载）。
 *
 * 候选顺序（前面优先）：
 *   1. `POP_AGENT_NODE_BIN`：用户/脚本显式指定；
 *   2. 打包内置的运行时（`resources/node-runtime`，由 scripts/fetch-node-runtime.mjs 准备）；
 *   3. `~/.pop-agent/node`：install.sh 装的那份；
 *   4. PATH 里的 `node`：**用户自己的**（用户 2026-11-23：能用自己的就别再多带一份）；
 *   5. Electron 自己（最后兜底，版本多半不够）。
 *
 * 全都不行时把「谁、什么版本、为什么不行」一起报出去 —— 这种错最怕只有一句「启动失败」。
 */
type NodeCandidate = { label: string; file: string; env: NodeJS.ProcessEnv };

/** 让候选 node 自报家门：版本、zstd、node-pty（顺便验证原生模块能加载） */
const PROBE_SCRIPT = `
const out = { node: process.versions.node, zstd: false, pty: false, ptyError: null };
try { out.zstd = typeof require("node:zlib").zstdDecompressSync === "function"; } catch {}
try { require("node-pty"); out.pty = true; } catch (error) { out.ptyError = String(error && error.message); }
process.stdout.write(JSON.stringify(out));
`;

function runtimeDirNode(runtimeDir: string): NodeCandidate | null {
	const candidates = [
		join(runtimeDir, "bin", "node"),
		join(runtimeDir, "node"),
		join(runtimeDir, "node.exe"),
		join(runtimeDir, "bin", "node.exe"),
	];
	for (const file of candidates) {
		if (existsSync(file)) return { label: `内置运行时（${runtimeDir}）`, file, env: { ...process.env } };
	}
	return null;
}

function nodeCandidates(): NodeCandidate[] {
	const list: NodeCandidate[] = [];
	const explicit = process.env.POP_AGENT_NODE_BIN?.trim();
	if (explicit) list.push({ label: "POP_AGENT_NODE_BIN", file: explicit, env: { ...process.env } });

	// 打包后：我们带的那份（可选用：见 electron-builder.yml 的 runtime 开关）
	const bundled = runtimeDirNode(join(resourcesRoot(), "node-runtime"));
	if (bundled) list.push(bundled);

	const installed = runtimeDirNode(join(dataDir(), "node"));
	if (installed) list.push(installed);

	// 用户自己的 node（PATH）：最省体积，也最符合「用户已有的就别再带一份」
	list.push({
		label: "PATH 里的 node",
		file: process.platform === "win32" ? "node.exe" : "node",
		env: { ...process.env },
	});

	// 最后兜底：Electron 自己（node 20 起不来，但有它总比什么都不试强，报错里会写清原因）
	list.push({
		label: `Electron 自带（${process.versions.node}）`,
		file: process.execPath,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
	return list;
}

/** 跑一次自检；超时/失败都当作「不能用」，但把原因留下 */
function probeNode(candidate: NodeCandidate): { ok: boolean; reason: string } {
	const result = spawnSync(candidate.file, ["-e", PROBE_SCRIPT], {
		env: candidate.env,
		// 在当前项目根跑：`require("node-pty")` 才能解析到随包的 node_modules
		cwd: resourcesRoot(),
		timeout: 8000,
		encoding: "utf8",
	});
	if (result.error) return { ok: false, reason: result.error.message };
	if (result.status !== 0)
		return { ok: false, reason: (result.stderr || "").trim().split("\n").slice(-1)[0] || `退出码 ${result.status}` };
	try {
		const info = JSON.parse(result.stdout) as { node: string; zstd: boolean; pty: boolean; ptyError: string | null };
		const [major = 0, minor = 0] = info.node.split(".").map((part) => Number.parseInt(part, 10));
		if (major < 22 || (major === 22 && minor < 19))
			return { ok: false, reason: `node ${info.node} 太旧（要 ≥ 22.19）` };
		if (!info.zstd) return { ok: false, reason: `node ${info.node} 没有 zlib.zstdDecompressSync` };
		if (!info.pty) return { ok: false, reason: `node ${info.node} 加载不了 node-pty：${info.ptyError ?? ""}` };
		return { ok: true, reason: `node ${info.node}` };
	} catch {
		return { ok: false, reason: `自检输出看不懂：${result.stdout.slice(0, 120)}` };
	}
}

/**
 * 选一个能真正跑起来的 node；全都不能就抛错（错误信息里带完整的逐条原因）。
 */
function nodeCommand(): { file: string; env: NodeJS.ProcessEnv; label: string } {
	const rejected: string[] = [];
	for (const candidate of nodeCandidates()) {
		const probed = probeNode(candidate);
		if (probed.ok) return { file: candidate.file, env: candidate.env, label: `${candidate.label} · ${probed.reason}` };
		rejected.push(`${candidate.label} → ${probed.reason}`);
	}
	throw new Error(
		`找不到能用的 Node（工作台要 ≥ 22.19，且要能加载 node-pty）。试过：\n  ${rejected.join("\n  ")}\n\n` +
			`装一个 Node 22+ 就行；或者把 build 时的 \`node-runtime\` 目录一起打进包里（npm run runtime:fetch）。`,
	);
}

/**
 * 起服务并等 ready 行。
 *
 * 失败时把最后几十行输出一起抛出去 —— 「双击没反应」最难查的就是没有现场，
 * 而服务的日志在 daemon.log 里，用户根本不知道去哪儿看。
 */
function startServer(): Promise<ReadyInfo> {
	const entry = serverEntry();
	if (!existsSync(entry)) {
		return Promise.reject(new Error(`没找到服务入口：${entry}\n先跑一次 \`npm run build\``));
	}
	const runtime = nodeCommand();
	const child = spawn(runtime.file, [entry], {
		env: {
			...runtime.env,
			// 桌面模式（ADR-0051）：关掉 npm 自更新、打 ready 行、锁被别人占着时复用而不是报错
			POP_AGENT_APP: "1",
			// 版本号显式给：打包后服务在 Resources/dist 下，往上找不到 package.json，
			// 不传就会把抬头显示成 vunknown（这个值本来就来自 package.json，由 electron-builder 写进 Info.plist）
			POP_AGENT_VERSION: app.getVersion(),
			// 前端目录显式给：打包后的层级和源码不一样，不让服务去猜
			POP_AGENT_WEB_DIST: webDist(),
			// 别让服务把启动 banner 打进管道后不分行 —— 它本来就一行一行打印
			FORCE_COLOR: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	serverChild = child;
	/**
	 * 服务挂了而窗口还开着：以前就是一片黑（用户反复碰到的就是这个）。
	 * 把「还在跑的那个孩子」退出了告诉窗口，换成带自动重试的提示页。
	 */
	child.on("exit", (code) => {
		if (quitting || serverChild !== child) return;
		serverChild = null;
		for (const window of windows) {
			showOffline(window, `后端服务已退出（退出码 ${code ?? "未知"}）`);
		}
	});
	const tail: string[] = [];
	const remember = (chunk: Buffer) => {
		for (const line of chunk.toString().split("\n")) {
			const text = line.trimEnd();
			if (text !== "") tail.push(text);
		}
		while (tail.length > 40) tail.shift();
	};
	child.stdout?.on("data", remember);
	child.stderr?.on("data", remember);

	return new Promise<ReadyInfo>((resolve, reject) => {
		let buffer = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => {
			finish(() => reject(new Error(`${READY_TIMEOUT_MS / 1000} 秒内服务没起来。最后的输出：\n${tail.join("\n")}`)));
		}, READY_TIMEOUT_MS);

		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				const ready = parseReadyLine(line);
				if (ready) finish(() => resolve(ready));
				index = buffer.indexOf("\n");
			}
		});

		child.on("error", (error) => finish(() => reject(error)));
		child.on("exit", (code, signal) => {
			// 正常退出只有一种可能：锁在别人手里，服务把地址说出来就走了（reused）
			if (settled) return;
			finish(() =>
				reject(
					new Error(
						`服务进程退出了（code=${code ?? "null"} signal=${signal ?? "null"}），没给出可用地址。最后的输出：\n${tail.join("\n")}`,
					),
				),
			);
		});
	});
}

function createWindow(url: string): BrowserWindow {
	/**
	 * 初始尺寸 / 位置（用户 2026-11-23：「app 打开时默认不用全屏，屏幕居中，可以调整大小，可以移动位置」）。
	 *
	 * 以前写死 1320×880 且没给位置：MacBook（1512×982）上它几乎铺满整屏，看着就像「默认全屏」，
	 * 而位置又由系统随手放。现在：
	 *   - 尺寸取 `min(1320×880, 工作区 90%)` —— 小屏上自然留出边距，不会顶到菜单栏/程序坞；
	 *   - `center: true` 落在屏幕正中；
	 *   - `resizable` / `maximizable` 显式打开（无标题栏也照样能从窗口四边拖大小）；
	 *   - `fullscreen: false`：**绝不**一上来就全屏。
	 * 移动窗口靠页面里那几条 `-webkit-app-region: drag`（顶栏 / 侧栏顶部 / 顶栏上沿 5px）。
	 */
	const { workArea } = screen.getPrimaryDisplay();
	const width = Math.min(1320, Math.round(workArea.width * 0.9));
	const height = Math.min(880, Math.round(workArea.height * 0.9));
	const window = new BrowserWindow({
		width,
		height,
		minWidth: 900,
		minHeight: 600,
		center: true,
		resizable: true,
		maximizable: true,
		/* 绿钮要能真的进全屏（用户 2026-11-24：「第三个绿色的按钮，点击后是全屏才对」）：
		 * 实测这个 Electron 版本**不写它时 `isFullScreenable()` 是 false**，绿钮只会「缩放」到
		 * 标准尺寸、永远进不了全屏。写死成 true，剩下的交给 macOS 自己（点一次进、再点一次出）。 */
		fullscreenable: true,
		fullscreen: false,
		title: BRAND_NAME,
		backgroundColor: "#141414",
		// mac 上让红绿灯嵌进顶栏；其它平台保持系统默认。
		// 这里的 y 只是**首帧的起点**：建窗时还不知道顶栏多高（页面还没加载），
		// 真正的位置由 `watchTrafficLights()` 按页面量到的顶栏高度重新摆（见下面）。
		...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: 12 } } : {}),
		show: false,
		// 没有 preload、没有 node 集成：页面只是访问本机服务的一个普通网页
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			/**
			 * 唯一的 preload：只给渲染层一个函数（把拖进来的 File 换成真实路径）。
			 * 拖文件/文件夹进输入框时要的是那个路径，而 Electron 32+ 删了 `File.path`，
			 * 只能靠 `webUtils.getPathForFile`，它只在有 preload 的渲染进程里存在。
			 * 产物和 main.js 同级（`electron-dist/electron/preload.js`，见 electron/tsconfig.json 的 outDir）。
			 */
			preload: fileURLToPath(new URL("./preload.js", import.meta.url)),
		},
	});

	/**
	 * 语音输入要麦克风。**Electron 不像浏览器那样自动弹授权框** —— 不在壳里明确放行，
	 * getUserMedia 会被直接拒绝，表现就是「点了麦克风、红点在闪，但一个字都不出」。
	 * 只放行音频：摄像头、地理位置、通知这些页面根本用不到，一律拒绝。
	 */
	const session = window.webContents.session;
	session.setPermissionRequestHandler((_contents, permission, callback, details) => {
		if (permission !== "media") return callback(false);
		const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
		callback(!mediaTypes.includes("video"));
	});
	// Chromium 有时先走 check 而不是 request，两个都要答，否则仍会被拒
	session.setPermissionCheckHandler((_contents, permission, _origin, details) => {
		if (permission !== "media") return false;
		const mediaType = (details as { mediaType?: string }).mediaType;
		return mediaType !== "video";
	});
	window.once("ready-to-show", () => {
		// `center: true` 在这条 `show: false` 的路径上偶尔不生效（实测窗口落在 (1, 30)），
		// 所以在真正显示之前再居中一次：只居中、不改尺寸，用户看不到跳。
		window.center();
		window.show();
	});
	void window.loadURL(url);
	/**
	 * 页面没加载出来（服务挂了 / 端口不对）时，Electron 只会留一块底色 —— 就是用户说的「黑屏」。
	 * 换成能读懂的提示页 + 自动重试。「-3」是 ERR_ABORTED（下一次导航把它打断），不算错。
	 */
	window.webContents.on("did-fail-load", (_event, code, description, _validatedUrl, isMainFrame) => {
		if (!isMainFrame || code === -3) return;
		showOffline(window, `加载失败：${description}（${code}）`);
	});
	/**
	 * 渲染进程**自己挂了**（内存爆了 / Chromium 内部崩溃）：页面不会报错，窗口就只剩一块白底 ——
	 * 用户看到的就是「白屏了」。这种情况前端再怎么兜（错误边界）也接不到，只能在壳这一层重载。
	 *
	 * 只自动重载**一次**：如果重载完立刻又崩（同一个必崩的页面 / 会话），
	 * 那就说明不是偶发，转成能读懂的提示页，别让窗口在「白屏 ↔ 崩」之间反复闪。
	 */
	let revived = false;
	window.webContents.on("render-process-gone", (_event, details) => {
		if (quitting || window.isDestroyed() || details.reason === "clean-exit") return;
		if (!revived) {
			revived = true;
			window.webContents.reload();
			return;
		}
		showOffline(window, `界面崩溃：${details.reason}`);
	});
	// 用**系统**那三颗红绿灯（用户 2026-11-23：「这个不好，不要自己写，用系统的」）。
	// 位置随顶栏高度自动居中：见下面 `watchTrafficLights`。
	if (isMac) window.setWindowButtonVisibility(true);
	watchTrafficLights(window);

	// 页面里的外链（README、MCP 文档…）交给系统浏览器，不要在壳里再开一个没有地址栏的窗口
	window.webContents.setWindowOpenHandler(({ url: target }) => {
		if (target.startsWith("http://") || target.startsWith("https://")) void shell.openExternal(target);
		return { action: "deny" };
	});

	/**
	 * 关窗 = 关掉**这一个**窗口（多窗口之后不再「只隐藏」：隐藏会留下一堆看不见还占内存的窗口）。
	 * 应用本身不退 —— mac 上服务与托盘照旧，Dock 图标 / 菜单「新建窗口」随时能再开。
	 */
	window.on("closed", () => {
		windows.delete(window);
		if (mainWindow === window) mainWindow = [...windows].at(-1) ?? null;
	});
	window.on("focus", () => {
		mainWindow = window;
	});
	windows.add(window);
	mainWindow = window;
	return window;
}

/** 红绿灯的横向位置（跟页面里顶栏左段的 76px 让位对齐：14 + 52 + 10 ≈ 76） */
const TRAFFIC_LIGHT_X = 14;
/** macOS 圆点直径：`trafficLightPosition.y` 指的是这组按钮的**顶边**，居中要减掉这一格 */
const TRAFFIC_LIGHT_DIAMETER = 12;

/**
 * 让红绿灯始终在顶栏里**垂直居中**（用户 2026-11-23：「如果后台改高度的话，左边的三个按钮要一直保持居中」）。
 *
 * 为什么不能写死一个 y：红绿灯的位置只在建窗时给一次，而顶栏高度是**页面里可调的**
 * （设置 → 外观 → 顶栏高度，60%~120%）。写死之后每次调高度，三个圆点就偏上或偏下 —— 只能反过来量页面。
 *
 * 怎么量（不加 preload、不加 IPC）：页面加载完后注入一个常驻 `ResizeObserver` 盯住 `.appbar`，
 * 高度一变就 `console.log("__POP_AGENT_APPBAR_H__=36")`；这边听 `console-message` 换算成 y 再摆。
 * 页面不动的时候一个请求都没有。
 */
/**
 * 绿钮 = 真全屏。
 *
 * 实测（2026-11-24，Electron 33）：**不写 `fullscreenable` 时 `isFullScreenable()` 返回 false** ——
 * 绿钮于是只能做「缩放」（窗口在你那块屏上是 1496×874 → 1152×621，只是回到标准尺寸），
 * 永远进不了系统全屏。用户 2026-11-24：「第三个绿色的按钮，点击后是全屏才对」。
 *
 * 用一个同选项的最小 Electron 窗（不碰本应用）验证过：显式 `fullscreenable: true` 后点绿钮，
 * 立刻发出 `enter-full-screen`、窗口变成整块屏幕。所以这里的做法就是把它显式打开
 * （见 `createWindow` 的窗口选项），不再自己用几何判据去「猜」用户点了绿钮。
 *
 * 已知取舍：全屏后从全屏退出来是 macOS 自己的行为（回到进全屏前的矩形），不需要额外代码。
 */

function watchTrafficLights(win: BrowserWindow): void {
	if (!isMac) return;
	let lastY = -1;

	const apply = (height: number): void => {
		if (!Number.isFinite(height) || height < 20) return;
		const y = Math.max(0, Math.round((height - TRAFFIC_LIGHT_DIAMETER) / 2));
		if (y === lastY) return;
		lastY = y;
		try {
			win.setWindowButtonPosition({ x: TRAFFIC_LIGHT_X, y });
		} catch {
			// 老 Electron / 非 hiddenInset 时这个方法可能不可用：静默跳过，顶栏照常用
		}
	};

	win.webContents.on("console-message", (...args: unknown[]) => {
		// Electron 33 还是 (event, level, message, line, sourceId)；新版本改成单个对象，两种都认
		const fromArgs = args[2];
		const fromEvent = (args[0] as { message?: unknown } | undefined)?.message;
		const text = typeof fromArgs === "string" ? fromArgs : typeof fromEvent === "string" ? fromEvent : "";
		const match = /__POP_AGENT_APPBAR_H__=(\d+)/.exec(text);
		if (match) apply(Number(match[1]));
	});

	win.webContents.on("did-finish-load", () => {
		void win.webContents
			.executeJavaScript(
				`
				(() => {
					if (window.__popAgentAppbarWatch) return;
					window.__popAgentAppbarWatch = true;
					let tries = 0;
					const attach = () => {
						const bar = document.querySelector(".appbar");
						if (!bar) {
							if (tries++ > 50) return;
							setTimeout(attach, 200);
							return;
						}
						const report = () => {
							const height = Math.round(bar.getBoundingClientRect().height);
							if (height === window.__popAgentAppbarH) return;
							window.__popAgentAppbarH = height;
							console.log("__POP_AGENT_APPBAR_H__=" + height);
						};
						new ResizeObserver(report).observe(bar);
					};
					attach();
				})()
			`,
			)
			.catch(() => {
				// 页面正在导航 / 已销毁：下次 did-finish-load 会再来一次
			});
	});
}

function showWindow(): void {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.show();
		mainWindow.focus();
		return;
	}
	if (serverUrl) createWindow(serverUrl);
}

/**
 * 再开一个窗口（Dock 右键「新建窗口」/ Cmd-N / 菜单）。
 *
 * 每个窗口是一个**独立的客户端**：它自己选会话、自己滚、自己分栏（ADR-0033：
 * 「每个客户端各看各的会话」）。服务还是同一个 —— 多开不会起第二个进程，也不会复制会话。
 */
function newWindow(): void {
	if (!serverUrl) return;
	createWindow(serverUrl);
}

/** `<dataDir>/password`：托盘里「复制访问密码」用（唯一来源，ADR-0031） */
function currentPassword(): string | null {
	try {
		const text = readFileSync(join(dataDir(), "password"), "utf8").trim();
		return text === "" ? null : text;
	} catch {
		return null;
	}
}

function buildTray(): void {
	const iconPath = join(webDist(), "favicon-32.png");
	const image = existsSync(iconPath)
		? nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
		: nativeImage.createEmpty();
	tray = new Tray(image);
	tray.setToolTip(BRAND_NAME);

	const openInBrowser = () => {
		if (serverUrl) void shell.openExternal(serverUrl);
	};
	const copyPassword = () => {
		const password = currentPassword();
		// 没设密码不是错：本机回环免密，远程才需要
		clipboard.writeText(password ?? "");
	};
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "新建窗口", click: newWindow },
			{ label: "打开主窗口", click: showWindow },
			{ label: "在浏览器里打开", click: openInBrowser },
			{ type: "separator" },
			{ label: "复制本机地址", click: () => serverUrl && clipboard.writeText(serverUrl) },
			{ label: "复制访问密码", click: copyPassword },
			{ label: "打开数据目录", click: () => void shell.openPath(dataDir()) },
			{ type: "separator" },
			{ label: "退出", click: () => app.quit() },
		]),
	);
	// Windows / Linux 上习惯单击就开窗口；mac 上保持「点开菜单」的默认行为
	if (!isMac) tray.on("click", showWindow);
}

/**
 * 原生菜单的文案语言：跟**系统**走（macOS 自己那套就是这样），不跟 App 内的界面语言偏好走 ——
 * 菜单是系统画的，一半英文一半中文比全英文更难看。没翻译到的项一律用 role，让系统自己出词。
 */
function menuLabel(zh: string, en: string): string {
	const locale = (app.getSystemLocale?.() ?? app.getLocale()).toLowerCase();
	return locale.startsWith("zh") ? zh : en;
}

/**
 * 发布页：App 的升级就是**下新的安装包**（不走 npm —— 见 `update-check.ts` 里 desktop 那条）。
 *
 * 现在（2026-11-24）这个仓库和 npm 包都还没发布，所以菜单里的升级**不去联网查版本**：
 * 查了也只会回 404，然后说一句「查不到」—— 那比不查更让人困惑。这里就做两件实事：
 *   1. 在终端里跑升级命令（命令行装的用户，跟网页抬头那颗「↑ 有新版」是同一行）；
 *   2. 打开发布页（App 用户下安装包）。
 * 等真有了 release，想在菜单里显示「当前 vX → 最新 vY」时，
 * 把 `fetchLatestRelease()`（git 历史里有）接回来即可。
 */
const RELEASES_URL = "https://github.com/duzhenxun/pop-agent/releases";

/** 命令行那条升级命令：跟网页抬头那颗「↑ 有新版」敲的是同一行（`web/src/brand.ts`） */
const UPGRADE_COMMAND = "npm -g install pop-agent@latest";

/**
 * 在 Terminal.app 里跑一条命令（用 osascript，因为 `open -a Terminal` 不能带命令）。
 *
 * 为什么不在壳里直接 spawn npm：升级要装全局包，可能卡网络 / 需要权限，用户在终端里
 * 看得见全过程、能自己重试 —— 跟网页那边「点一下在底部终端敲进去」同一个理由。
 */
function runInTerminal(command: string): void {
	const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	try {
		spawn(
			"osascript",
			["-e", `tell application "Terminal" to do script "${escaped}"`, "-e", 'tell application "Terminal" to activate'],
			{ detached: true, stdio: "ignore" },
		).unref();
	} catch (error) {
		console.warn("[upgrade] 打开终端失败：", error);
	}
}

/**
 * 菜单里的「版本升级…」（用户 2026-11-24：「window 中加一个版本升级」）。
 *
 * 只做**查不到的也不算错**的那件事：弹窗告诉你现在是什么版本、升级有哪两条路，
 * 然后按你选的去执行。不自己下载替换 App —— 那需要签名/公证过的增量包与 electron-updater，
 * 半套自动升级比没有更危险。
 */
async function upgradeFromMenu(): Promise<void> {
	const current = packageMeta().version;
	const { response } = await dialog.showMessageBox({
		type: "info",
		title: menuLabel("版本升级", "Upgrade PopAgent"),
		message: `PopAgent v${current}`,
		detail: menuLabel(
			`App：发布页下载新安装包，覆盖安装即可（会话与设置都在）。\n命令行装的：执行 ${UPGRADE_COMMAND}，装完重启服务端生效。`,
			`App: download the new build from the releases page and install over this one (sessions and settings are kept).\nInstalled via npm: run ${UPGRADE_COMMAND}, then restart the server.`,
		),
		// 「打开发布页」放第一个（App 用户的升级路径）；命令行那条留第二颗，不抢默认
		buttons: [
			menuLabel("打开发布页", "Open releases page"),
			menuLabel("在终端中升级", "Upgrade in Terminal"),
			menuLabel("取消", "Cancel"),
		],
		defaultId: 0,
		cancelId: 2,
		noLink: true,
	});
	if (response === 0) {
		void shell.openExternal(RELEASES_URL);
	} else if (response === 1) {
		if (isMac) runInTerminal(UPGRADE_COMMAND);
		else clipboard.writeText(UPGRADE_COMMAND); // 别的平台没有 Terminal.app：给命令，自己贴
	}
}

function buildAppMenu(): void {
	const template: Electron.MenuItemConstructorOptions[] = [
		...(isMac ? [{ role: "appMenu" as const }] : []),
		/**
		 * 「文件」菜单：多窗口之后这里必须有「新建窗口」（Cmd-N，macOS 惯例）。
		 * 新窗口是**独立客户端**：各自选会话、各自滚动、各自分栏（ADR-0033）。
		 * 注意别和页面里的快捷键冲突 —— App 自己的「新会话」是 ⌘⌥N（shortcuts.ts），Cmd-N 空着。
		 */
		{
			label: menuLabel("文件", "File"),
			submenu: [
				{ label: menuLabel("新建窗口", "New window"), accelerator: "CmdOrCtrl+N", click: newWindow },
				{ type: "separator" },
				{ role: "close" },
			],
		},
		/**
		 * 「编辑」**手写而不是 `role: "editMenu"`**（用户 2026-11-24：「这些菜单没有用的可以删掉」）。
		 *
		 * `editMenu` 会把 macOS 塞进来的整批系统项一起带上：Substitutions / Speech /
		 * 自动填充 / 开始听写 / 表情与符号 —— 这些跟「在输入框里改字」没关系，还各占一个子菜单。
		 * 这里只留真正会用的七个，其它一律不出现；每一项仍然是 role，所以快捷键与系统语言照旧。
		 */
		{
			label: menuLabel("编辑", "Edit"),
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "delete" },
				{ type: "separator" },
				{ role: "selectAll" },
			],
		},
		{
			label: menuLabel("视图", "View"),
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		/**
		 * 「窗口」：系统那三件（最小化 / 缩放 / 前置全部）照旧，中间插一条**版本升级**
		 * （用户 2026-11-24：「window 中加一个版本升级」）。放在这里而不是「视图」，
		 * 是因为它是个「对这台 App 做一次动作」的入口，跟最小化/缩放同一类。
		 */
		{
			label: menuLabel("窗口", "Window"),
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				{ type: "separator" },
				{ label: menuLabel("版本升级…", "Upgrade PopAgent…"), click: () => void upgradeFromMenu() },
				{ type: "separator" },
				{ role: "front" },
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 退出前把服务收掉：它有锁文件与子进程（pty / 引擎），直接被杀会留下孤儿 */
async function stopServer(): Promise<void> {
	const child = serverChild;
	if (!child || child.exitCode !== null) return;
	serverChild = null;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			// 5 秒还不走就硬杀：宁可留一点脏状态，也不要「点了退出窗口还在」
			try {
				child.kill("SIGKILL");
			} catch {
				// 已经没了
			}
			resolve();
		}, 5000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function boot(): Promise<void> {
	const ready = await startServer();
	serverUrl = ready.url;
	mainWindow = createWindow(ready.url);
	buildTray();
	buildAppMenu();
}

// ---- 应用生命周期 ----

// 第二个实例：把已有窗口拿到前面，然后自己退出（不再起第二个服务）
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWindow?.isMinimized()) mainWindow.restore();
		showWindow();
	});

	void app.whenReady().then(async () => {
		app.setName(BRAND_NAME);
		/**
		 * 「关于 PopAgent」面板里的版本号：**必须是我们自己的版本**。
		 *
		 * 那个面板是 macOS 原生的（`role: "appMenu"` 里的 About 项），数字直接读 `.app` 的
		 * `Info.plist`（`CFBundleShortVersionString` / `CFBundleVersion`）。开发态跑的是
		 * 改名后的 Electron 壳（见 `scripts/app-name.mjs`），plist 里还写着 Electron 自己的
		 * 版本 —— 用户 2026-11-24 看到的就是「版本 33.4.11 (33.4.11)」。
		 *
		 * 所以在这里显式覆盖一次，值取**唯一来源** `package.json`（`packageMeta()`）：
		 * 打包版同样走这一段，跟 electron-builder 写进 plist 的那个值本来就一致，覆盖无害。
		 * plist 那边也在 `app-name.mjs` 里一并改成同一个值（Finder 的「显示简介」也跟着对）。
		 */
		const { version } = packageMeta();
		if (version !== "unknown") {
			try {
				app.setAboutPanelOptions({ applicationName: BRAND_NAME, applicationVersion: version, version });
			} catch (error) {
				console.warn("[about] 设置关于面板失败（不影响运行）：", error);
			}
		}
		/**
		 * 开发态把 Dock 图标也换成产品图标：直接跑壳时 macOS 用的是 Electron.app 里的
		 * electron.icns，跟我们 `web/public/icons/icon-512.png` 不是一张图；
		 * 打包版则由 electron-builder 直接把这张 512 打进 `.icns`，不需要这一步。
		 */
		/**
		 * 开发态把 Dock 图标也换成产品图标。
		 *
		 * 判据**不能**用 `!app.isPackaged`：为了让 Dock 名字显示 PopAgent，我们把开发态的壳
		 * 改名成了真正的 `PopAgent.app`（见 scripts/app-name.mjs），Electron 因此认为自己
		 * 是「已打包」—— 那个条件永远不成立，Dock 里一直是 Electron 自带的原子 logo
		 * （用户 2026-11-23 截图问「这里怎么样换掉呢」就是这个）。
		 * 现在只要 `web/dist/icons/icon-512.png` 存在就设一次；打包态那是同一张图，重复设置无害。
		 */
		if (isMac) {
			// **圆角那张**（`icon-1024.png` 是圆角 + 透明角）；`icon-512.png` 是 PWA 用的满幅版，
			// 拿它设 Dock 会得到一个直角方块（macOS 不会替第三方图标补圆角）。
			const dockIcon = [join(webDist(), "icons", "icon-1024.png"), join(webDist(), "icons", "icon-512.png")].find(
				(candidate) => existsSync(candidate),
			);
			if (dockIcon) {
				try {
					app.dock.setIcon(dockIcon);
				} catch (error) {
					console.warn("[dock] 设置图标失败（不影响运行）：", error);
				}
			}
		}
		try {
			await boot();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			dialog.showErrorBox(
				`${BRAND_NAME} 启动失败`,
				`${message}\n\n日志：${join(dataDir(), "daemon.log")}\n如果已经有一个窗口在跑，关掉它再试一次。`,
			);
			app.exit(1);
		}

		// mac：点 Dock 图标回来（没有窗口就新开一个）
		app.on("activate", showWindow);
		/**
		 * Dock 右键菜单：macOS 会在系统项（选项 / 显示所有窗口 / 隐藏 / 退出）中间插我们的项，
		 * 这里补一条「新建窗口」——跟 Trae / Cursor 那种「右键 Dock 就能再开一个」一致。
		 */
		if (isMac) {
			app.dock.setMenu(Menu.buildFromTemplate([{ label: "新建窗口", click: newWindow }]));
		}
	});

	app.on("before-quit", () => {
		quitting = true;
		void stopServer();
	});
	// 窗口全关：mac 留在托盘；其它平台就是退出（服务跟着收掉）
	app.on("window-all-closed", () => {
		if (!isMac) app.quit();
	});
}
