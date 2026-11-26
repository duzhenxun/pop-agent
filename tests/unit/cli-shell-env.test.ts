/**
 * 从 App 里起的终端会继承壳的环境变量（实测 2026-11-26）：
 * `POP_AGENT_APP=1` / `POP_AGENT_WEB_DIST=/Applications/PopAgent.app/…/web/dist` / `POP_AGENT_VERSION=0.1.3`。
 *
 * 后果全在「看着像没反应」这一档：
 *   - 不开浏览器、不问升级、只打一行 READY JSON（桌面模式的行为）；
 *   - 抬头写成 App 的版本（「我明明升了怎么还是 0.1.3」）；
 *   - 后端去读 App 里那份**旧前端**（「改了 web/src 没生效」）。
 *
 * 判据：壳 spawn 服务时 stdio 是管道；人在终端里敲 `pop` 时 stdout 是 tty。
 * 所以「带桌面标记 + 没有终端」才算壳的子进程，其余一律撕掉标记。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isShellChild } from "../../server/cli.ts";

const cli = readFileSync(new URL("../../server/cli.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
const dev = readFileSync(new URL("../../scripts/dev.mjs", import.meta.url), "utf8");

describe("继承来的桌面壳环境", () => {
	it("壳的真子进程（有标记、无终端）才算桌面模式", () => {
		assert.equal(isShellChild({ desktop: true, stdoutIsTTY: false }), true);
	});

	it("终端里敲 pop（有标记、但有 tty）不算 —— 这就是那次「没开浏览器」", () => {
		assert.equal(isShellChild({ desktop: true, stdoutIsTTY: true }), false);
	});

	it("没有桌面标记时与终端无关", () => {
		assert.equal(isShellChild({ desktop: false, stdoutIsTTY: true }), false);
		assert.equal(isShellChild({ desktop: false, stdoutIsTTY: false }), false);
	});

	it("cli.ts 在终端里会撕掉三个会误导的变量", () => {
		for (const key of ["POP_AGENT_APP", "POP_AGENT_WEB_DIST", "POP_AGENT_VERSION"]) {
			assert.match(cli, new RegExp(`delete process\\.env\\.${key}`), `没有清理 ${key}`);
		}
	});

	it("前台终端只放 error 出来，warn 也不再刷", () => {
		// quietConsole 的过滤条件里只允许 error；再加回 warn 就会又出现那堆 JSON
		assert.match(index, /if \(!quietConsole \|\| level === "error"\)/);
		assert.doesNotMatch(index, /level === "warn" \|\| level === "error"/);
	});

	it("dev 不继承 App 的前端目录与版本号", () => {
		assert.match(dev, /function cleanEnv/);
		for (const key of ["POP_AGENT_APP", "POP_AGENT_WEB_DIST", "POP_AGENT_VERSION"]) {
			assert.match(dev, new RegExp(`"${key}"`), `dev 没有摘掉 ${key}`);
		}
	});
});
