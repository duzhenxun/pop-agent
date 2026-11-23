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
import { app, BrowserWindow, Menu, Tray, clipboard, dialog, nativeImage, shell } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND_NAME } from "../server/brand.js";
import { DEFAULT_DATA_DIR_NAME } from "../server/util/env.js";
import { parseReadyLine, type ReadyInfo } from "../server/util/desktop.js";

const isMac = process.platform === "darwin";
/** 等服务的上限：装机 / 首次索引会话可能慢，但超过这个数就是真出问题了 */
const READY_TIMEOUT_MS = 60_000;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverChild: ChildProcess | null = null;
/** 服务真正在用的地址（复用别人的实例时也是它） */
let serverUrl: string | null = null;
/** 主动退出（托盘「退出」/ Cmd+Q）：用来区分「关窗」和「真的要走」 */
let quitting = false;

function dataDir(): string {
	const fromEnv = process.env.POP_AGENT_DATA_DIR;
	return fromEnv && fromEnv !== "" ? resolve(fromEnv) : join(homedir(), DEFAULT_DATA_DIR_NAME);
}

/** 打包后资源在 `process.resourcesPath`（见 electron-builder.yml 的 extraResources）；开发态在仓库根 */
function resourcesRoot(): string {
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
	list.push({ label: "PATH 里的 node", file: process.platform === "win32" ? "node.exe" : "node", env: { ...process.env } });

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
	if (result.status !== 0) return { ok: false, reason: (result.stderr || "").trim().split("\n").slice(-1)[0] || `退出码 ${result.status}` };
	try {
		const info = JSON.parse(result.stdout) as { node: string; zstd: boolean; pty: boolean; ptyError: string | null };
		const [major = 0, minor = 0] = info.node.split(".").map((part) => Number.parseInt(part, 10));
		if (major < 22 || (major === 22 && minor < 19)) return { ok: false, reason: `node ${info.node} 太旧（要 ≥ 22.19）` };
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
			// 前端目录显式给：打包后的层级和源码不一样，不让服务去猜
			POP_AGENT_WEB_DIST: webDist(),
			// 别让服务把启动 banner 打进管道后不分行 —— 它本来就一行一行打印
			FORCE_COLOR: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	serverChild = child;
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
	const window = new BrowserWindow({
		width: 1320,
		height: 880,
		minWidth: 900,
		minHeight: 600,
		title: BRAND_NAME,
		backgroundColor: "#141414",
		// mac 上让红绿灯嵌进顶栏；其它平台保持系统默认
		...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 16 } } : {}),
		show: false,
		// 没有 preload、没有 node 集成：页面只是访问本机服务的一个普通网页
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	window.once("ready-to-show", () => window.show());
	void window.loadURL(url);

	// 页面里的外链（README、MCP 文档…）交给系统浏览器，不要在壳里再开一个没有地址栏的窗口
	window.webContents.setWindowOpenHandler(({ url: target }) => {
		if (target.startsWith("http://") || target.startsWith("https://")) void shell.openExternal(target);
		return { action: "deny" };
	});

	window.on("close", (event) => {
		// mac：关窗只是收起窗口（服务继续跑，托盘还在）；真退出走 Cmd+Q / 托盘「退出」
		if (isMac && !quitting) {
			event.preventDefault();
			window.hide();
		}
	});
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});
	return window;
}

function showWindow(): void {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.show();
		mainWindow.focus();
		return;
	}
	if (serverUrl) mainWindow = createWindow(serverUrl);
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

function buildAppMenu(): void {
	const template: Electron.MenuItemConstructorOptions[] = [
		...(isMac ? [{ role: "appMenu" as const }] : []),
		{ role: "editMenu" },
		{
			label: "视图",
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
		{ role: "windowMenu" },
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

		// mac：点 Dock 图标回来（关窗只是 hide）
		app.on("activate", showWindow);
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
