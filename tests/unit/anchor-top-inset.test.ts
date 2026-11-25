/**
 * 「刚发出去的消息自己顶到上方」时，别把它顶到**浮起来的顶栏**后面。
 *
 * 桌面壳里顶栏是浮在对话列之上的（`app-bar.css`：`:root[data-shell] .app > .appbar`），
 * 正文从 y=0 起滚、从它后面滑过去。锚点以前只退 10px 呼吸带，于是那条消息正好落在
 * 顶栏后面、上半截被切掉（用户 2026-11-25 的截图）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { anchorOffsetFor } from "../../web/src/stick-to-bottom.ts";

const appBar = readFileSync(new URL("../../web/src/styles/app-bar.css", import.meta.url), "utf8");

function rule(css: string, selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	assert.notEqual(start, -1, `找不到 CSS 规则：${selector}`);
	const end = css.indexOf("\n}", start);
	assert.notEqual(end, -1, `规则没有结束：${selector}`);
	return css.slice(start, end);
}

describe("锚点让开浮起来的顶栏", () => {
	it("浏览器里（视口顶部没被盖住）还是原来的 10px 呼吸带", () => {
		assert.equal(anchorOffsetFor(400), 390);
		assert.equal(anchorOffsetFor(400, 0), 390);
	});

	it("壳里再退一整个顶栏高，消息落在顶栏下面而不是后面", () => {
		// 顶栏 33px（--appbar-h 实量）→ 消息顶边落在视口往下 33 + 10 = 43px 处
		assert.equal(anchorOffsetFor(400, 33), 357);
		assert.equal(anchorOffsetFor(400, 33) + 33 + 10, 400);
	});

	it("第一条消息本来就贴着顶（offset 小于要退的量）时不滚成负数", () => {
		assert.equal(anchorOffsetFor(20, 33), 0);
		assert.equal(anchorOffsetFor(0, 33), 0);
	});

	it("顶栏高度是脏值（负数 / NaN）时按没盖住算，不至于滚到反方向", () => {
		assert.equal(anchorOffsetFor(400, -30), 390);
		assert.equal(anchorOffsetFor(400, Number.NaN), 400 - 10 - 0);
	});

	it("壳里把「被盖住的高度」写成 scroll-padding-top，浏览器不写", () => {
		const shellMain = rule(appBar, ":root[data-shell] .workspace .main");
		assert.match(shellMain, /scroll-padding-top:\s*var\(--appbar-h/);
		// 正文的上内边距仍在（静止时第一行不被挡），两条不能互相顶掉
		assert.match(shellMain, /padding-top:\s*calc\(var\(--gap\) \+ var\(--appbar-h/);
		// 兜底：「顶栏隐藏时是 0」靠 var 的第二参数，别写成裸的 var(--appbar-h)
		assert.doesNotMatch(shellMain, /scroll-padding-top:\s*var\(--appbar-h\)/);
	});
});
