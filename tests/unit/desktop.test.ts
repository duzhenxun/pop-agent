/**
 * 桌面 App 模式（`server/util/desktop.ts`，ADR-0051）。
 *
 * 这一层的错法都很安静：PATH 没注进去 = 用户机器上「终端里敲 codex 找不到」，
 * `ELECTRON_RUN_AS_NODE` 没带 = `mcp login` 报一个跟业务无关的 Electron 参数错。
 * 两个都不会崩，只会让人查半天，所以按纯函数逐个钉住。
 *
 * 文件系统一律用注入的 `exists`，测试不造目录。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyDesktopEnv,
	isDesktopMode,
	nodeExec,
	parseReadyLine,
	pathSeparator,
	prependToPath,
	readyLine,
	READY_MARKER,
	runtimeBinDirs,
	withRuntimeEnv,
} from "../../server/util/desktop.js";

describe("isDesktopMode", () => {
	it("真值写法都算开", () => {
		for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
			assert.equal(isDesktopMode({ POP_AGENT_APP: value }), true, value);
		}
	});
	it("没设 / 空串 / 假值都算关（不能用空串把 npm 安装的版本变成桌面模式）", () => {
		assert.equal(isDesktopMode({}), false);
		assert.equal(isDesktopMode({ POP_AGENT_APP: "" }), false);
		assert.equal(isDesktopMode({ POP_AGENT_APP: "0" }), false);
		assert.equal(isDesktopMode({ POP_AGENT_APP: "false" }), false);
		assert.equal(isDesktopMode({ POP_AGENT_APP: "no" }), false);
	});
});

describe("pathSeparator", () => {
	it("跟着目标平台走，不是跟着宿主", () => {
		assert.equal(pathSeparator("win32"), ";");
		assert.equal(pathSeparator("darwin"), ":");
		assert.equal(pathSeparator("linux"), ":");
	});
});

describe("runtimeBinDirs", () => {
	const env = (value: string) => ({ POP_AGENT_RUNTIME_DIR: value });

	it("没配就是不注入（npm 安装的用户不该被动改 PATH）", () => {
		assert.deepEqual(runtimeBinDirs({}), []);
		assert.deepEqual(runtimeBinDirs(env("   ")), []);
	});

	it("POSIX：官方 node 布局 <dir>/bin 存在就取 bin", () => {
		const dirs = runtimeBinDirs(env("/opt/pop/runtime"), {
			platform: "darwin",
			exists: (path) => path === "/opt/pop/runtime/bin",
		});
		assert.deepEqual(dirs, ["/opt/pop/runtime/bin"]);
	});

	it("POSIX：没有 bin 层（打包后平铺）就直接用目录本身", () => {
		const dirs = runtimeBinDirs(env("/opt/pop/runtime"), { platform: "darwin", exists: () => false });
		assert.deepEqual(dirs, ["/opt/pop/runtime"]);
	});

	it("Windows 不存在 bin 这一层，node.exe 就平铺在目录里", () => {
		const checked: string[] = [];
		const dirs = runtimeBinDirs(env("C:\\pop\\runtime"), {
			platform: "win32",
			exists: (path) => {
				checked.push(path);
				return false;
			},
		});
		assert.deepEqual(dirs, ["C:\\pop\\runtime"]);
		assert.deepEqual(checked, [], "不该去试 C:\\pop\\runtime\\bin");
	});

	it("多个目录按顺序、去重（尾斜杠和大小写都算同一个）", () => {
		const dirs = runtimeBinDirs(env("C:\\a;c:/A\\;C:\\b"), { platform: "win32", exists: () => false });
		assert.deepEqual(dirs, ["C:\\a", "C:\\b"]);
	});

	it("POSIX 用冒号分隔（不能用分号，否则整串被当成一个目录）", () => {
		const dirs = runtimeBinDirs(env("/a:/b"), { platform: "linux", exists: () => false });
		assert.deepEqual(dirs, ["/a", "/b"]);
	});
});

describe("prependToPath", () => {
	it("新目录在前、原有顺序保持不变", () => {
		assert.equal(prependToPath("/usr/bin:/bin", ["/opt/pop/bin"], "darwin"), "/opt/pop/bin:/usr/bin:/bin");
	});

	it("原本为空 / undefined 也不产出前导分隔符", () => {
		assert.equal(prependToPath("", ["/opt/pop/bin"], "darwin"), "/opt/pop/bin");
		assert.equal(prependToPath(undefined, ["/opt/pop/bin"], "darwin"), "/opt/pop/bin");
		assert.equal(prependToPath(":/usr/bin:", ["/opt/pop/bin"], "darwin"), "/opt/pop/bin:/usr/bin");
	});

	it("已经在 PATH 里的不重复加（幂等）", () => {
		const once = prependToPath("/usr/bin", ["/opt/pop/bin"], "darwin");
		const twice = prependToPath(once, ["/opt/pop/bin"], "darwin");
		assert.equal(twice, "/opt/pop/bin:/usr/bin");
	});

	it("Windows 大小写与斜杠方向都不敏感：同一个目录换写法不算新目录", () => {
		// 断言「只留一份」而不是具体拼写：两种写法谁是原样都无所谓，重复才是问题
		for (const existing of ["c:\\windows", "c:/WINDOWS/", "C:\\Windows\\"]) {
			const joined = prependToPath("C:\\Windows", [existing], "win32");
			assert.equal(joined.split(";").length, 1, `${existing} → ${joined}`);
		}
	});
});

describe("withRuntimeEnv", () => {
	it("不改入参（调用方可能是 process.env 的浅拷贝）", () => {
		const original = { POP_AGENT_RUNTIME_DIR: "/opt/pop", PATH: "/usr/bin" };
		const next = withRuntimeEnv(original, { platform: "darwin", exists: () => false });
		assert.equal(next.PATH, "/opt/pop:/usr/bin");
		assert.equal(original.PATH, "/usr/bin");
	});

	it("其它变量原样保留", () => {
		const next = withRuntimeEnv(
			{ POP_AGENT_RUNTIME_DIR: "/opt/pop", FOO: "bar" },
			{ platform: "linux", exists: () => false },
		);
		assert.equal(next.FOO, "bar");
	});

	it("Windows 上真实变量叫 Path：顺着已有的那个键写，不造第二份", () => {
		const next = withRuntimeEnv(
			{ POP_AGENT_RUNTIME_DIR: "C:\\pop", Path: "C:\\Windows" },
			{ platform: "win32", exists: () => false },
		);
		assert.equal(next.Path, "C:\\pop;C:\\Windows");
		assert.equal(next.PATH, undefined);
	});

	it("没配运行时目录 → 什么都不动", () => {
		const next = withRuntimeEnv({ PATH: "/usr/bin" }, { platform: "darwin", exists: () => false });
		assert.equal(next.PATH, "/usr/bin");
	});
});

describe("applyDesktopEnv", () => {
	// 单测里一律 `shellPath: []`：不去起用户真实的登录 shell（慢、且结果随人变）
	it("不是桌面模式 → 空操作（npm 安装的用户 PATH 不能被改）", () => {
		const env = { PATH: "/usr/bin", POP_AGENT_RUNTIME_DIR: "/opt/pop" };
		assert.deepEqual(applyDesktopEnv(env, { platform: "darwin", exists: () => false, shellPath: [] }), {
			applied: false,
			dirs: [],
			fromShell: [],
		});
		assert.equal(env.PATH, "/usr/bin");
	});

	it("桌面模式 → 真的写进 env，并回报注了哪些目录（给启动日志）", () => {
		const env = { POP_AGENT_APP: "1", POP_AGENT_RUNTIME_DIR: "/opt/pop", PATH: "/usr/bin" };
		const result = applyDesktopEnv(env, { platform: "darwin", exists: () => false, shellPath: [] });
		assert.deepEqual(result, { applied: true, dirs: ["/opt/pop"], fromShell: [] });
		assert.equal(env.PATH, "/opt/pop:/usr/bin");
	});

	/**
	 * 用户 2026-11-24（「我本机安装过 codex 了」，切引擎却提示没装）：
	 * App 从 Finder 起时 PATH 只有系统目录，nvm 里的 codex 根本不在里面。
	 * 所以要把登录 shell 的 PATH 也合进来 —— 但**运行时必须仍排在最前面**（node 得是包里那颗）。
	 */
	it("桌面模式 → 合并登录 shell 的 PATH，且内置运行时排在它前面", () => {
		const env = { POP_AGENT_APP: "1", POP_AGENT_RUNTIME_DIR: "/opt/pop", PATH: "/usr/bin:/bin" };
		const result = applyDesktopEnv(env, {
			platform: "darwin",
			exists: () => false,
			shellPath: ["/Users/me/.nvm/versions/node/v22.22.0/bin", "/opt/homebrew/bin", "/usr/bin"],
		});
		assert.deepEqual(result.fromShell, ["/Users/me/.nvm/versions/node/v22.22.0/bin", "/opt/homebrew/bin", "/usr/bin"]);
		assert.equal(
			env.PATH,
			"/opt/pop:/Users/me/.nvm/versions/node/v22.22.0/bin:/opt/homebrew/bin:/usr/bin:/bin",
			"运行时第一，用户命令紧随，已有的系统目录去重后仍在末尾",
		);
	});

	it("重复调用幂等（cli → index 两段启动都会调）", () => {
		const env = { POP_AGENT_APP: "1", POP_AGENT_RUNTIME_DIR: "/opt/pop", PATH: "/usr/bin" };
		applyDesktopEnv(env, { platform: "darwin", exists: () => false, shellPath: [] });
		applyDesktopEnv(env, { platform: "darwin", exists: () => false, shellPath: [] });
		assert.equal(env.PATH, "/opt/pop:/usr/bin");
	});

	it("桌面模式但壳没给运行时目录 → applied=false（不假装注入了）", () => {
		const env = { POP_AGENT_APP: "1", PATH: "/usr/bin" };
		assert.deepEqual(applyDesktopEnv(env, { platform: "darwin", exists: () => false, shellPath: [] }), {
			applied: false,
			dirs: [],
			fromShell: [],
		});
		assert.equal(env.PATH, "/usr/bin");
	});
});

describe("nodeExec", () => {
	it("普通 node：原样，不加任何标记", () => {
		const result = nodeExec({
			execPath: "/usr/local/bin/node",
			versions: { node: "22.19.0" },
			env: { PATH: "/usr/bin" },
		});
		assert.equal(result.file, "/usr/local/bin/node");
		assert.equal(result.electronNode, false);
		assert.equal(result.env.ELECTRON_RUN_AS_NODE, undefined);
	});

	it("Electron 里 process.execPath 是 Electron 本体 → 必须补 ELECTRON_RUN_AS_NODE", () => {
		const result = nodeExec({
			execPath: "/Applications/PopAgent.app/Contents/MacOS/PopAgent",
			versions: { node: "22.19.0", electron: "33.2.0" },
			env: { PATH: "/usr/bin" },
		});
		assert.equal(result.electronNode, true);
		assert.equal(result.env.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(result.env.PATH, "/usr/bin", "其它变量要保留");
	});

	it("已经被 Electron 用 ELECTRON_RUN_AS_NODE 起的子进程：标记要传下去", () => {
		const result = nodeExec({
			execPath: "/Applications/App.app/Contents/MacOS/App",
			versions: { node: "22.19.0" },
			env: { ELECTRON_RUN_AS_NODE: "1" },
		});
		assert.equal(result.electronNode, true);
		assert.equal(result.env.ELECTRON_RUN_AS_NODE, "1");
	});
});

describe("readyLine / parseReadyLine", () => {
	const info = { port: 25257, pid: 4242, url: "http://127.0.0.1:25257", reused: false };

	it("打出来能原样解回去", () => {
		assert.deepEqual(parseReadyLine(readyLine(info)), info);
	});

	it("复用别人的实例时 reused=true 也要能解出来（壳据此知道别起新服务）", () => {
		const reused = { port: 25258, pid: 1, url: "http://127.0.0.1:25258", reused: true };
		assert.deepEqual(parseReadyLine(readyLine(reused)), reused);
	});

	it("普通日志行解出来是 null（壳不该因为日志内容崩）", () => {
		assert.equal(parseReadyLine("pop-agent 已启动"), null);
		assert.equal(parseReadyLine(""), null);
	});

	it("标记在但内容坏了 → null", () => {
		assert.equal(parseReadyLine(`${READY_MARKER} {oops`), null);
		assert.equal(parseReadyLine(`${READY_MARKER} {"port":"25257"}`), null);
		assert.equal(parseReadyLine(`${READY_MARKER} {"port":25257,"url":"http://x"}`), null);
	});
});
