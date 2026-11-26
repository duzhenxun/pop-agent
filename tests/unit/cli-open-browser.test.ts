/**
 * `pop` 启动时要不要自己开浏览器（用户 2026-11-26：「发现 pop 启动时没有自动打开网页」）。
 *
 * 根因不是 isTTY：是从 PopAgent App 里起的终端继承了 `POP_AGENT_APP=1`，
 * 而旧代码的开关是 `if (parsed.open && !isDesktopMode())` —— 一看这个变量就当成
 * 「壳 spawn 的子进程，窗口由壳开」，于是把浏览器静默跳过。
 *
 * 现在只认「stdout 是不是终端」：壳 spawn 时 stdio 是管道，本来就会跳过；
 * 用户自己的终端是 tty，照常开。不开的时候还要把原因打出来（见 `openBrowser`）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserOpenDecision } from "../../server/cli.ts";

describe("pop 启动时开不开浏览器", () => {
	it("普通终端：开", () => {
		assert.deepEqual(browserOpenDecision({ open: true, isTTY: true, ci: false }), { open: true });
	});

	it("管道 / 被别的程序拉起：不开，并说清原因", () => {
		const decision = browserOpenDecision({ open: true, isTTY: false, ci: false });
		assert.equal(decision.open, false);
		assert.match(decision.open === false ? decision.why : "", /不是终端/);
	});

	it("CI 环境：不开", () => {
		const decision = browserOpenDecision({ open: true, isTTY: true, ci: true });
		assert.equal(decision.open, false);
		assert.match(decision.open === false ? decision.why : "", /CI/);
	});

	it("--no-open 最高优先", () => {
		const decision = browserOpenDecision({ open: false, isTTY: true, ci: false });
		assert.equal(decision.open, false);
		assert.match(decision.open === false ? decision.why : "", /--no-open/);
	});
});
