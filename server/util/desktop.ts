/**
 * 桌面 App 模式（Electron 壳内置运行时）—— ADR-0051。
 *
 * 要解决的问题只有一个：**用户装完 App 就该能用，机器上不能有 node / npm**。
 * 于是壳会把一份 node 运行时（含 npm / npx）打进包里，通过 `POP_AGENT_RUNTIME_DIR`
 * 告诉服务端它在哪；服务端要做两件事：
 *
 *   1. 把那个目录**前置**进 PATH —— codex / opencode / npx 这些全靠 PATH 找；
 *   2. 起「node 子进程」时不能直接用 `process.execPath`：Electron 里那个是 Electron 本体，
 *      必须带 `ELECTRON_RUN_AS_NODE=1` 它才当纯 node 跑。
 *
 * 两件事都做成纯函数（平台 / 环境 / exists 全是参数），因为单测要能不依赖真实文件系统验证；
 * 只有 `applyDesktopEnv` 会碰 `process.env`，而且只该在进程启动时调一次（幂等）。
 *
 * 与 `pop` 启动方式的关系：桌面模式**不改变任何服务行为**，只是「运行时从哪来」变了一个来源。
 * 网页访问、密码、局域网、`server.lock` 单实例复用全都照旧 —— 别人用 `pop` 起、App 起的
 * 是同一种进程，谁先起谁占锁。
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type EnvLike = Record<string, string | undefined>;

/** 桌面模式开关：`POP_AGENT_APP=1`（壳负责设它，用户不用管） */
const DESKTOP_FLAG_ENV = "POP_AGENT_APP";
/** 内置运行时目录（可给多个，按平台路径分隔符分隔；前面的优先） */
const RUNTIME_DIR_ENV = "POP_AGENT_RUNTIME_DIR";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** `POP_AGENT_APP` 是不是开着（没设 / 空串 / 0 / false 都算关） */
export function isDesktopMode(env: EnvLike = process.env): boolean {
	const raw = env[DESKTOP_FLAG_ENV];
	if (raw === undefined) return false;
	return TRUTHY.has(raw.trim().toLowerCase());
}

/** PATH 的分隔符跟着**目标平台**走，不是跟着宿主走（Win 上是 `;`） */
export function pathSeparator(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? ";" : ":";
}

/**
 * 目录比较用：去掉尾部分隔符；Windows 上不区分大小写，且 `/` 与 `\` 视为同一个分隔符。
 *
 * 为什么要管分隔符：Windows 的 PATH 里混着两种写法很常见（Git Bash、手改的环境变量、
 * 各种安装器），不归一化的话同一个目录会被当成两个，PATH 里就会出现在两处。
 */
function sameDir(a: string, b: string, platform: NodeJS.Platform): boolean {
	const strip = (value: string) => {
		let text = value.trim();
		while (text.length > 1 && (text.endsWith("/") || text.endsWith("\\"))) text = text.slice(0, -1);
		return platform === "win32" ? text.replace(/\//g, "\\").toLowerCase() : text;
	};
	return strip(a) === strip(b);
}

/**
 * `POP_AGENT_RUNTIME_DIR` → 真正该放进 PATH 的目录列表。
 *
 * 两种布局都认（省得壳那边为了「是不是要多一层 bin」跟这里对齐）：
 *   - 官方 node 发行版：`<dir>/bin/node`（POSIX）→ 取 `<dir>/bin`
 *   - 打包后平铺：`<dir>/node`、`<dir>/npm` → 取 `<dir>` 本身
 *
 * 不做「找不到就把 dir 塞进去」的猜测：目录里到底有没有 node 由壳保证，这里只挑形状。
 */
export function runtimeBinDirs(
	env: EnvLike,
	options: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): string[] {
	const platform = options.platform ?? process.platform;
	const exists = options.exists ?? existsSync;
	const raw = env[RUNTIME_DIR_ENV];
	if (raw === undefined || raw.trim() === "") return [];

	const dirs: string[] = [];
	for (const piece of raw.split(pathSeparator(platform))) {
		const dir = piece.trim();
		if (dir === "") continue;
		// Windows 上 node.exe / npm.cmd 就平铺在目录里，没有 bin 这一层 —— 不去试不存在的路径
		if (platform === "win32") {
			if (!dirs.some((existing) => sameDir(existing, dir, platform))) dirs.push(dir);
			continue;
		}
		// 官方 node 发行版是 <dir>/bin/node；打包后可能平铺在 <dir> 下 —— 两种都认
		const binDir = join(dir, "bin");
		const chosen = exists(binDir) ? binDir : dir;
		if (!dirs.some((existing) => sameDir(existing, chosen, platform))) dirs.push(chosen);
	}
	return dirs;
}

/**
 * 把 `dirs` 前置进 PATH 字符串（纯函数，不碰 env）。
 *
 * 去重是必须的：`applyDesktopEnv` 可能被调多次（cli → index 两段启动），
 * 不去重的话 PATH 会长出一串同样的目录，子进程排查时看着像配错了。
 */
export function prependToPath(
	pathValue: string | undefined,
	dirs: string[],
	platform: NodeJS.Platform = process.platform,
): string {
	const separator = pathSeparator(platform);
	const result: string[] = [];
	const push = (dir: string) => {
		const trimmed = dir.trim();
		if (trimmed === "") return;
		if (result.some((existing) => sameDir(existing, trimmed, platform))) return;
		result.push(trimmed);
	};
	for (const dir of dirs) push(dir);
	for (const dir of (pathValue ?? "").split(separator)) push(dir);
	return result.join(separator);
}

/**
 * 把 dirs **追加**到 PATH 末尾（与 `prependToPath` 相反）。
 *
 * 为什么引擎装好的目录要追加：用户自己也可能装过同名命令（codex / pi…），
 * 他那份必须优先 —— 从他终端跑的和在 App 里跑的应该是同一个二进制，否则同一句话两种行为。
 */
export function appendToPath(
	pathValue: string | undefined,
	dirs: string[],
	platform: NodeJS.Platform = process.platform,
): string {
	const separator = pathSeparator(platform);
	const result: string[] = [];
	const push = (dir: string) => {
		const trimmed = dir.trim();
		if (trimmed === "") return;
		if (result.some((existing) => sameDir(existing, trimmed, platform))) return;
		result.push(trimmed);
	};
	for (const dir of (pathValue ?? "").split(separator)) push(dir);
	for (const dir of dirs) push(dir);
	return result.join(separator);
}

/**
 * 返回「把内置运行时接进 PATH 之后」的 env —— **不修改入参**。
 *
 * 顺带处理 Windows 的大小写差异：真实的进程环境里那个变量叫 `Path`，
 * 而我们在代码里一律写 `PATH`。两个键都认，指向已经存在的那个，别造出第二份。
 */
export function withRuntimeEnv(
	env: EnvLike,
	options: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): EnvLike {
	const platform = options.platform ?? process.platform;
	const dirs = runtimeBinDirs(env, options);
	const next: EnvLike = { ...env };
	if (dirs.length === 0) return next;
	const key = env.PATH !== undefined ? "PATH" : env.Path !== undefined ? "Path" : "PATH";
	next[key] = prependToPath(env[key], dirs, platform);
	return next;
}

/**
 * 进程启动时调一次：把内置运行时真的写进 `process.env.PATH`。
 *
 * 为什么必须改 `process.env` 而不是「算好一个 env 传下去」：子进程散在十几处
 * （引擎传输层、终端 pty、MCP、cron…），还有 pty 会继承整份环境。漏一处就是
 * 「终端里敲 codex 找不到」，而大家并不走同一个入口。统一改当前进程环境最省心。
 *
 * 除了内置运行时，还会把**用户登录 shell 的 PATH** 合进来（见 `loginShellPathDirs`）。
 * 返回值给启动日志用（打印「运行时来自哪」比让人猜要值钱）。
 */
export function applyDesktopEnv(
	env: NodeJS.ProcessEnv = process.env,
	options: {
		platform?: NodeJS.Platform;
		exists?: (path: string) => boolean;
		/** 测的时候注入：不真的去起登录 shell */
		shellPath?: string[] | null;
	} = {},
): { applied: boolean; dirs: string[]; fromShell: string[] } {
	if (!isDesktopMode(env)) return { applied: false, dirs: [], fromShell: [] };
	const platform = options.platform ?? process.platform;
	const runtime = runtimeBinDirs(env, options);
	// 用户自己的命令（codex / claude / nvm 装的东西）也要能找到：App 从 Finder 起时 PATH 很窄
	const fromShell =
		options.shellPath !== undefined
			? options.shellPath
			: loginShellPathDirs(env, { ...options, platform });
	const shellDirs = fromShell ?? [];
	const dirs = [...runtime, ...shellDirs];
	if (dirs.length === 0) return { applied: false, dirs: [], fromShell: shellDirs };
	const key = env.PATH !== undefined ? "PATH" : env.Path !== undefined ? "Path" : "PATH";
	// 运行时在前的顺序是故意的：`node` 必须是包里那颗；用户命令靠后面的 shell 目录补上
	const merged: string[] = [];
	const push = (dir: string) => {
		const trimmed = dir.trim();
		if (trimmed === "") return;
		if (merged.some((existing) => sameDir(existing, trimmed, platform))) return;
		merged.push(trimmed);
	};
	for (const dir of runtime) push(dir);
	for (const dir of shellDirs) push(dir);
	for (const dir of (env.PATH ?? env.Path ?? "").split(pathSeparator(platform))) push(dir);
	env[key] = merged.join(pathSeparator(platform));
	return { applied: true, dirs: runtime, fromShell: shellDirs };
}

/** 写在输出里的标记：登录 shell 可能先吐一堆 banner / 提示，只认标记之后那段 */
const SHELL_PATH_MARKER = "__POP_PATH__";
/** 登录 shell 的上限：用户 .zshrc 里可能有 nvm 那种慢初始化，但不能让它把启动拖死 */
const SHELL_TIMEOUT_MS = 4000;

/**
 * 用户登录 shell 的 PATH（目录列表）。
 *
 * 为什么要这么干（用户 2026-11-24：「我本机安装过 codex 了」，但切引擎时提示「还没装」）：
 * App 从 Finder / Dock 启动时，进程拿到的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` ——
 * nvm、homebrew、bun、volta 这些**靠 shell 初始化注入**的目录全都不在里面，
 * 于是「用户终端里能跑的 codex」在 App 里就是「没装」。
 *
 * 做法与 VS Code 一致：起一个登录 shell，让它自己把 PATH 算出来。
 * 拿不到（shell 不存在 / 超时 / .zshrc 报错）就回退到 `fallbackBinDirs()`，不吞错也不阻塞。
 *
 * `run` 可注入：单测不该真去跑用户的 shell。
 */
export function loginShellPathDirs(
	env: EnvLike,
	options: {
		platform?: NodeJS.Platform;
		home?: string;
		shell?: string;
		timeoutMs?: number;
		run?: (shell: string, timeoutMs: number) => string | null;
	} = {},
): string[] {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") return []; // Windows 的 PATH 不从登录 shell 来
	const home = options.home ?? env.HOME ?? homedir();
	const shell = options.shell ?? env.SHELL ?? "/bin/zsh";
	const timeoutMs = options.timeoutMs ?? SHELL_TIMEOUT_MS;
	const run = options.run ?? readLoginShellPath;
	const raw = run(shell, timeoutMs);
	const fromShell = (raw ?? "")
		.split(pathSeparator(platform))
		.map((dir) => dir.trim())
		.filter((dir) => dir !== "");
	const dirs: string[] = [];
	const push = (dir: string) => {
		if (dir === "") return;
		if (dirs.some((existing) => sameDir(existing, dir, platform))) return;
		dirs.push(dir);
	};
	// shell 给的那串优先（里面已经含 nvm / brew 等），再用兜底目录补齐漏网的
	for (const dir of fromShell) push(dir);
	for (const dir of fallbackBinDirs(home, platform)) push(dir);
	return dirs;
}

/** 真去跑一次登录 shell，把 PATH 取回来（失败一律 null，调用方回退） */
function readLoginShellPath(shell: string, timeoutMs: number): string | null {
	try {
		const result = spawnSync(shell, ["-lic", `printf '%s' "${SHELL_PATH_MARKER}$PATH"`], {
			encoding: "utf8",
			timeout: timeoutMs,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const stdout = typeof result.stdout === "string" ? result.stdout : "";
		const at = stdout.lastIndexOf(SHELL_PATH_MARKER);
		if (at < 0) return null;
		return stdout.slice(at + SHELL_PATH_MARKER.length).trim();
	} catch {
		return null;
	}
}

/**
 * 兜底目录：登录 shell 读不到时（shell 坏了 / 超时 / 非交互环境）还能找到常见安装位置。
 * 顺序按「用户自己装的」优先排：nvm 各版本 → homebrew → 通用本地目录。
 *
 * nvm 要扫目录而不是写死版本号：用户升级 node 之后路径就变了。
 */
function fallbackBinDirs(home: string, platform: NodeJS.Platform): string[] {
	const dirs: string[] = [];
	const nvmRoot = join(home, ".nvm", "versions", "node");
	try {
		if (existsSync(nvmRoot)) {
			// 版本目录按名字倒序：v22 > v20，新版本排前面
			const versions = readdirSync(nvmRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
			for (const version of versions) dirs.push(join(nvmRoot, version, "bin"));
		}
	} catch {
		// 读不到就当没有 nvm
	}
	for (const dir of [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(home, ".local", "bin"),
		join(home, "bin"),
		join(home, ".bun", "bin"),
		join(home, ".volta", "bin"),
		join(home, ".asdf", "shims"),
		join(home, ".local", "share", "mise", "shims"),
	]) {
		if (existsSync(dir)) dirs.push(dir);
	}
	return dirs;
}

/**
 * 「服务已经在了」这一行的标记。
 *
 * 壳（Electron main）起服务后要等它真的能接请求才能 `loadURL`，以前只能轮询 `server.lock`
 * 或反复打 `/api/health`。既然服务自己知道什么时候 listen 成功，就让它直接说一声：
 * 壳读一行 JSON 就行，不用猜、不用轮询，还能拿到「已经有一个在跑，你直接用它」这种情形。
 */
export const READY_MARKER = "__POP_AGENT_READY__";

export type ReadyInfo = {
	/** 实际监听的端口（被复用时就别人的端口） */
	port: number;
	pid: number;
	/** 壳应该 loadURL 的地址（已经处理过 0.0.0.0 → 127.0.0.1） */
	url: string;
	/** true = 数据目录上已经有一个在跑，本次进程不提供服务 */
	reused: boolean;
};

/** 序列化成壳能读的一行（前面带标记，方便在日志里 grep） */
export function readyLine(info: ReadyInfo): string {
	return `${READY_MARKER} ${JSON.stringify(info)}`;
}

/** 从一行输出里解出来；不是这一行 / 内容坏了就 null（壳不该因为一行脏日志就崩） */
export function parseReadyLine(line: string): ReadyInfo | null {
	const text = line.trim();
	if (!text.startsWith(READY_MARKER)) return null;
	try {
		const parsed = JSON.parse(text.slice(READY_MARKER.length).trim()) as Partial<ReadyInfo>;
		if (typeof parsed.port !== "number" || typeof parsed.url !== "string") return null;
		if (typeof parsed.pid !== "number" || typeof parsed.reused !== "boolean") return null;
		return { port: parsed.port, pid: parsed.pid, url: parsed.url, reused: parsed.reused };
	} catch {
		return null;
	}
}

/**
 * 起「一个 node 进程」时该用哪个可执行文件、带什么 env。
 *
 * 两种运行形态都要覆盖：
 *   - server 跑在 **Electron main 里**：`process.execPath` 是 Electron 本体，`process.versions.electron`
 *     有值 → 必须补 `ELECTRON_RUN_AS_NODE=1`，否则 `electron cli.js mcp login` 会被 Electron
 *     当成它自己的命令行参数解析（报一个跟业务毫无关系的错）；
 *   - server 是 **Electron 用 ELECTRON_RUN_AS_NODE 起的子进程**：此时它就是 node，
 *     `versions.electron` 不存在，但环境里那份标记会被子进程自然继承 —— 这条不用额外做事，
 *     但这里仍然把它显式写出来，免得将来有人清环境时漏掉。
 */
export function nodeExec(
	options: {
		execPath?: string;
		versions?: Record<string, string | undefined>;
		env?: EnvLike;
	} = {},
): { file: string; env: EnvLike; electronNode: boolean } {
	const file = options.execPath ?? process.execPath;
	const versions = options.versions ?? process.versions;
	const env: EnvLike = { ...(options.env ?? process.env) };
	const electronNode = (versions.electron ?? "") !== "" || env.ELECTRON_RUN_AS_NODE === "1";
	if (electronNode) env.ELECTRON_RUN_AS_NODE = "1";
	return { file, env, electronNode };
}
