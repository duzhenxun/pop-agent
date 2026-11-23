/**
 * 顶栏入口的**默认勾选**（`web/src/ui-prefs.ts`）。
 *
 * 钉住一条产品决定（用户 2026-11-23）：「顶部默认只要 模型 / 定时任务 / 技能」。
 * 其余入口（推送 / 语音 / 插件 / MCP / 子代理 / 设置 / 临时会话）默认不显示 ——
 * 它们按需在 设置 → 界面 → 顶栏 里勾回来。
 *
 * 顺序也被钉住了：`APPBAR_ITEMS` 的顺序就是顶栏从左到右的顺序，
 * 用户要的是「模型 → 定时任务 → 技能」，所以这三项排在最前。
 *
 * 这里只测**默认值**本身：存过值的优先级在 `readStoredBool` 里（存的值永远盖过默认），
 * 所以改这张表不会把老用户已经关掉的入口又打开。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	APPBAR_ITEMS,
	APPBAR_ITEM_DEFAULT_ON,
	APPBAR_TEMPCHAT_DEFAULT,
	appbarItemDefault,
} from "../../web/src/ui-prefs.ts";

describe("顶栏默认勾选", () => {
	it("默认勾上的正好是模型 / 定时任务 / 技能（按这个顺序）", () => {
		const on = APPBAR_ITEMS.filter((item) => appbarItemDefault(item));
		assert.deepEqual(on, ["models", "cron", "skills"]);
	});

	it("顶栏默认从左到右就是 模型 → 定时任务 → 技能", () => {
		assert.deepEqual(APPBAR_ITEMS.slice(0, 3), ["models", "cron", "skills"]);
	});

	it("推送 / 语音 / 插件 / MCP / 子代理 / 设置 默认不勾", () => {
		for (const item of ["push", "voice", "plugins", "mcp", "agents", "settings"] as const) {
			assert.equal(appbarItemDefault(item), false, `${item} 不该默认勾上`);
		}
	});

	it("Cron 提供独立的可配置顶栏入口", () => {
		assert.ok(APPBAR_ITEMS.includes("cron"));
	});

	it("「临时会话」默认不显示（它不是面板入口，单独一个 key）", () => {
		assert.equal(APPBAR_TEMPCHAT_DEFAULT, false);
	});

	it("默认表里不出现表外的 key（改漏了会当场炸）", () => {
		for (const item of APPBAR_ITEM_DEFAULT_ON) {
			assert.ok((APPBAR_ITEMS as readonly string[]).includes(item), `${item} 不在 APPBAR_ITEMS 里`);
		}
	});
});
